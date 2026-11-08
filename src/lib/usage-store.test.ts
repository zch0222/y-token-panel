import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { UsageRecord, UsageResponse, UsageSource } from "@/lib/usage";
import { UsageStore } from "@/lib/usage-store";

const temporaryDirectories: string[] = [];
const stores: UsageStore[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "y-token-usage-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

function openStore(databasePath = ":memory:"): UsageStore {
  const store = new UsageStore(databasePath);
  stores.push(store);
  return store;
}

function record(patch: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: "claude:message-1",
    requestId: "message-1",
    sessionId: "session-1",
    harness: "claude",
    project: "project-a",
    model: "claude-sonnet",
    provider: "Anthropic",
    timestamp: 1_700_000_000_000,
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 3,
    cacheCreationTokens: 4,
    totalTokens: 37,
    inputTokenSemantics: "fresh",
    hasTokenUsage: true,
    credits: 0,
    hasCredit: false,
    status: "success",
    ...patch,
  };
}

function source(patch: Partial<UsageSource> = {}): UsageSource {
  return {
    harness: "claude",
    recordCount: 1,
    scannedFiles: 1,
    skippedFiles: 0,
    source: "/tmp/claude",
    sourceAvailable: true,
    ...patch,
  };
}

function usage(patch: Partial<UsageResponse> = {}): UsageResponse {
  return {
    records: [record()],
    sources: [source()],
    scannedFiles: 1,
    skippedFiles: 0,
    syncedAt: 1_700_000_100_000,
    ...patch,
  };
}

afterEach(() => {
  while (stores.length) {
    const store = stores.pop();
    try {
      store?.close();
    } catch {
      // 构造失败或测试已显式关闭的实例无需重复关闭。
    }
  }
  while (temporaryDirectories.length) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("UsageStore", () => {
  it("空库明确标记没有快照，而不是伪造零用量", () => {
    const store = openStore();
    expect(store.getSnapshot()).toBeNull();
    expect(store.getStatus()).toMatchObject({
      phase: "empty",
      revision: 0,
      hasSnapshot: false,
      recordCount: 0,
    });
    expect(store.getEmptySnapshot()).toMatchObject({
      records: [],
      revision: 0,
      snapshotAvailable: false,
      sync: { phase: "empty", hasSnapshot: false },
    });
  });

  it("原子保存归一化记录、独立去重账本和预序列化快照", () => {
    const databasePath = path.join(temporaryDirectory(), "usage.sqlite");
    const store = openStore(databasePath);
    const optionalRecord = record({
      id: "claude:message-optional",
      reportedCredits: 1.25,
      billable: false,
      contextUsageRatio: 0.42,
      estimatedDurationMs: 1234.5,
    });
    const otherHarness = record({
      id: "claude:message-1",
      requestId: "shared-request-id",
      harness: "codebuddy",
    });
    const payload = usage({
      records: [record(), optionalRecord, otherHarness],
      sources: [source({ recordCount: 2 }), source({ harness: "codebuddy", recordCount: 1 })],
    });
    store.markSyncStarted(100);
    const result = store.commitSnapshot(payload, 250);

    expect(result).toEqual({ revision: 1, changed: true, recordCount: 3, syncedAt: payload.syncedAt });
    expect(store.getSnapshot()).toMatchObject({
      records: payload.records,
      revision: 1,
      snapshotAvailable: true,
      sync: { phase: "ready", revision: 1, durationMs: 150, recordCount: 3 },
    });
    expect(store.readNormalizedRecords()).toEqual(payload.records);
    expect(store.getSnapshotJson()).not.toContain("undefined");

    const db = new DatabaseSync(databasePath, { readOnly: true });
    expect(
      db.prepare("SELECT count(*) AS count FROM usage_dedup").get() as { count: number },
    ).toEqual({ count: 3 });
    expect(
      db
        .prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'session_log_sync'")
        .get() as { count: number },
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_usage_records_%'")
        .get() as { count: number },
    ).toEqual({ count: 5 });
    db.close();
  });

  it("内容未变化时只更新同步时间与状态，不提升 revision 或重写记录", () => {
    const databasePath = path.join(temporaryDirectory(), "usage.sqlite");
    const store = openStore(databasePath);
    const payload = usage();
    store.markSyncStarted(100);
    store.commitSnapshot(payload, 150);
    const firstJson = store.getSnapshotJson();
    const db = new DatabaseSync(databasePath, { readOnly: true });
    const firstRowId = (db.prepare("SELECT id FROM usage_records").get() as { id: number }).id;
    db.close();

    store.markSyncStarted(200);
    const unchanged = store.commitSnapshot({ ...payload, syncedAt: payload.syncedAt + 1000 }, 250);
    expect(unchanged).toMatchObject({ revision: 1, changed: false });
    expect(store.getSnapshot()?.syncedAt).toBe(payload.syncedAt + 1000);
    expect(store.getSnapshotJson()).not.toBe(firstJson);
    const unchangedVerify = new DatabaseSync(databasePath, { readOnly: true });
    expect((unchangedVerify.prepare("SELECT id FROM usage_records").get() as { id: number }).id).toBe(firstRowId);
    unchangedVerify.close();

    store.markSyncStarted(300);
    const changed = store.commitSnapshot(
      { ...payload, records: [record({ outputTokens: 21, totalTokens: 38 })] },
      350,
    );
    expect(changed).toMatchObject({ revision: 2, changed: true });
    expect(store.readNormalizedRecords()[0]).toMatchObject({ outputTokens: 21, totalTokens: 38 });
  });

  it("全量替换保留历史 dedup 键与首次见到时间", () => {
    const databasePath = path.join(temporaryDirectory(), "usage.sqlite");
    const store = openStore(databasePath);
    store.markSyncStarted(100);
    store.commitSnapshot(usage(), 150);
    store.markSyncStarted(200);
    store.commitSnapshot(
      usage({
        records: [record({ id: "claude:message-new" })],
        sources: [source()],
        syncedAt: 1_700_000_200_000,
      }),
      250,
    );

    const db = new DatabaseSync(databasePath, { readOnly: true });
    const rows = db
      .prepare("SELECT dedup_key, record_row_id, created_at FROM usage_dedup ORDER BY dedup_key")
      .all();
    expect(rows).toEqual([
      { dedup_key: "claude:message-1", record_row_id: null, created_at: 150 },
      { dedup_key: "claude:message-new", record_row_id: 1, created_at: 250 },
    ]);
    db.close();
  });

  it("同 Harness 重 ID 与非有限数值都会失败且不触碰旧快照", () => {
    const store = openStore();
    store.markSyncStarted(100);
    store.commitSnapshot(usage(), 150);
    const lastSuccess = store.getSnapshotJson();

    store.markSyncStarted(200);
    expect(() =>
      store.commitSnapshot(
        usage({ records: [record(), record()], sources: [source({ recordCount: 2 })] }),
        250,
      ),
    ).toThrow(/UNIQUE/);
    expect(store.getSnapshotJson()).toBe(lastSuccess);

    expect(() =>
      store.commitSnapshot(usage({ records: [record({ outputTokens: Number.NaN })] }), 300),
    ).toThrow(/非安全整数/);
    expect(store.getSnapshotJson()).toBe(lastSuccess);
  });

  it("批次中途失败会回滚记录、来源、快照与 revision", () => {
    const store = openStore();
    const payload = usage();
    store.markSyncStarted(100);
    store.commitSnapshot(payload, 150);
    const lastSuccess = store.getSnapshotJson();

    store.markSyncStarted(200);
    expect(() =>
      store.commitSnapshot(
        usage({
          records: [record({ id: "claude:new" })],
          sources: [source(), source()],
          syncedAt: payload.syncedAt + 1000,
        }),
        250,
      ),
    ).toThrow();
    expect(store.getSnapshotJson()).toBe(lastSuccess);
    expect(store.readNormalizedRecords()).toEqual(payload.records);
    expect(store.getStatus()).toMatchObject({ phase: "importing", revision: 1 });

    store.markSyncFailed(new Error("injected failure"), 300);
    expect(store.getSnapshotJson()).toBe(lastSuccess);
    expect(store.getStatus()).toMatchObject({
      phase: "error",
      revision: 1,
      hasSnapshot: true,
      error: "injected failure",
    });
  });

  it("记录、去重、快照与增量游标在同一事务中失败回滚", () => {
    const store = openStore();
    const initial = usage();
    const oldCursor = {
      harness: "dsh" as const,
      filePath: "/tmp/dsh/session.jsonl",
      fileSize: 10,
      mtimeMs: 100,
      cursorOffset: 5,
      parserStateJson: null,
      tailFingerprint: "old",
      lastError: null,
      updatedAt: 0,
    };
    store.markSyncStarted(100);
    store.commitSnapshot(initial, 150, [
      {
        harness: "dsh",
        resetCursors: true,
        resetDedup: false,
        cursors: [oldCursor],
      },
    ]);
    const lastSuccess = store.getSnapshotJson();

    store.markSyncStarted(200);
    expect(() =>
      store.commitSnapshot(
        usage({
          records: [record({ id: "claude:new" })],
          syncedAt: initial.syncedAt + 1000,
        }),
        250,
        [
          {
            harness: "dsh",
            resetCursors: false,
            resetDedup: false,
            cursors: [
              { ...oldCursor, fileSize: 20, cursorOffset: 15, tailFingerprint: "new" },
              { ...oldCursor, filePath: "/tmp/dsh/invalid.jsonl", fileSize: 1, cursorOffset: 2 },
            ],
          },
        ],
      ),
    ).toThrow(/游标范围非法/);

    expect(store.getSnapshotJson()).toBe(lastSuccess);
    expect(store.readNormalizedRecords()).toEqual(initial.records);
    expect(store.getDedupKeys("claude")).toEqual(["claude:message-1"]);
    expect(store.getSessionLogStates("dsh")).toEqual([
      expect.objectContaining({ filePath: oldCursor.filePath, cursorOffset: 5, tailFingerprint: "old" }),
    ]);
  });

  it("多来源增量事务在同一提交中各自重建，空 reset 不强制重写", () => {
    const store = openStore();
    const claudeCursor = {
      harness: "claude" as const,
      filePath: "/tmp/claude/a.jsonl",
      fileSize: 10,
      mtimeMs: 100,
      cursorOffset: 10,
      parserStateJson: null,
      tailFingerprint: "fp-claude",
      lastError: null,
      updatedAt: 0,
    };
    store.markSyncStarted(100);
    const committed = store.commitSnapshot(
      usage({ records: [record({ id: "claude:one" })] }),
      150,
      [
        { harness: "claude", resetCursors: true, resetDedup: true, cursors: [claudeCursor] },
        // 未安装来源的空 reset：无记录无账本，不应触发全量重写。
        { harness: "qoder", resetCursors: true, resetDedup: true, cursors: [] },
      ],
    );
    expect(committed).toMatchObject({ revision: 1, changed: true, recordCount: 1 });
    expect(store.getSessionLogStates("claude")).toEqual([
      expect.objectContaining({ filePath: claudeCursor.filePath, cursorOffset: 10 }),
    ]);
    expect(store.getSessionLogStates("qoder")).toEqual([]);

    // 内容不变 + 无非空 reset：不重写，revision 保持。
    const unchanged = store.commitSnapshot(
      usage({ records: [record({ id: "claude:one" })], syncedAt: 200 }),
      250,
      [
        { harness: "claude", resetCursors: false, resetDedup: false, cursors: [claudeCursor] },
        { harness: "qoder", resetCursors: true, resetDedup: true, cursors: [] },
      ],
    );
    expect(unchanged).toMatchObject({ revision: 1, changed: false });
    expect(store.getDedupKeys("claude")).toEqual(["claude:one"]);

    // 同一来源两个批次是程序错误，整批拒绝。
    expect(() =>
      store.commitSnapshot(usage(), 300, [
        { harness: "claude", resetCursors: false, resetDedup: false, cursors: [] },
        { harness: "claude", resetCursors: false, resetDedup: false, cursors: [] },
      ]),
    ).toThrow(/多个增量事务批次/);
  });

  it("Next 重启后可读取同一快照，中断导入会恢复为错误且保留数据", () => {
    const databasePath = path.join(temporaryDirectory(), "usage.sqlite");
    const first = openStore(databasePath);
    first.markSyncStarted(100);
    first.commitSnapshot(usage(), 150);
    const lastSuccess = first.getSnapshotJson();
    first.markSyncStarted(200);
    first.close();

    const restarted = openStore(databasePath);
    expect(restarted.getSnapshotJson()).toBe(lastSuccess);
    expect(restarted.getStatus()).toMatchObject({
      phase: "error",
      hasSnapshot: true,
      revision: 1,
      error: "上次同步在服务重启时中断；已保留最后成功快照。",
    });
  });

  it("schema v1 升级 v2 时补外键索引且保留快照与记录", () => {
    const databasePath = path.join(temporaryDirectory(), "usage.sqlite");
    const first = openStore(databasePath);
    first.markSyncStarted(100);
    first.commitSnapshot(usage(), 150);
    const lastSuccess = first.getSnapshotJson();
    first.close();

    const v1 = new DatabaseSync(databasePath);
    v1.exec(`
      DROP INDEX idx_usage_dedup_record_row_id;
      DELETE FROM usage_schema_migrations;
      INSERT INTO usage_schema_migrations (version, applied_at) VALUES (1, 100);
      PRAGMA user_version = 1;
    `);
    v1.close();

    const migrated = openStore(databasePath);
    expect(migrated.getSnapshotJson()).toBe(lastSuccess);
    expect(migrated.readNormalizedRecords()).toEqual(usage().records);
    const verify = new DatabaseSync(databasePath, { readOnly: true });
    expect(verify.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(
      verify.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_usage_dedup_record_row_id'").get(),
    ).toEqual({ name: "idx_usage_dedup_record_row_id" });
    expect(verify.prepare("SELECT version FROM usage_schema_migrations ORDER BY version").all()).toEqual([
      { version: 1 },
      { version: 2 },
    ]);
    verify.close();
  });

  it("实际 DDL 迁移失败会回滚且保留原有表和数据", () => {
    const databasePath = path.join(temporaryDirectory(), "usage.sqlite");
    const db = new DatabaseSync(databasePath);
    db.exec(`
      CREATE TABLE usage_records (id INTEGER PRIMARY KEY, existing_value TEXT);
      INSERT INTO usage_records (existing_value) VALUES ('keep');
      PRAGMA application_id = 0x59545031;
    `);
    db.close();

    expect(() => new UsageStore(databasePath)).toThrow(/迁移失败，已回滚/);
    const verify = new DatabaseSync(databasePath, { readOnly: true });
    expect(verify.prepare("SELECT existing_value FROM usage_records").get()).toEqual({
      existing_value: "keep",
    });
    expect(verify.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    expect(verify.prepare("SELECT name FROM sqlite_master WHERE name = 'usage_sources'").get()).toBeUndefined();
    verify.close();
  });

  it("拒绝更高 schema 版本且不破坏已有数据库", () => {
    const databasePath = path.join(temporaryDirectory(), "usage.sqlite");
    const db = new DatabaseSync(databasePath);
    db.exec("CREATE TABLE existing_data (value TEXT); INSERT INTO existing_data VALUES ('keep'); PRAGMA user_version = 99;");
    db.close();

    expect(() => new UsageStore(databasePath)).toThrow(/schema 版本 99/);
    const verify = new DatabaseSync(databasePath, { readOnly: true });
    expect(verify.prepare("SELECT value FROM existing_data").get()).toEqual({ value: "keep" });
    expect(verify.prepare("PRAGMA user_version").get()).toEqual({ user_version: 99 });
    expect(
      verify.prepare("SELECT name FROM sqlite_master WHERE name = 'usage_records'").get(),
    ).toBeUndefined();
    verify.close();
    expect(existsSync(`${databasePath}-wal`)).toBe(false);
  });
});
