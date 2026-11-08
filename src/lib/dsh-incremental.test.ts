import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDshUsage } from "@/lib/dsh";
import {
  readDshUsageIncremental,
  type DshIncrementalResult,
} from "@/lib/dsh-incremental";
import type { UsageResponse } from "@/lib/usage";
import { UsageStore } from "@/lib/usage-store";

const BASE_MS = 1_794_000_000_000;

function jsonl(...events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

function frame(text: string): Buffer {
  return zlib.zstdCompressSync(Buffer.from(text.endsWith("\n") ? text : `${text}\n`));
}

function stepStart(time = BASE_MS, turn = 1, step = 1) {
  return { type: "step/start", time, data: { turn, step } };
}

function message(id: string, time = BASE_MS + 1500, turn = 1, step = 1) {
  return {
    type: "assistant/message",
    time,
    data: {
      turn,
      step,
      message: {
        id,
        source: { provider: "deepseek-account", model: "deepseek-v4.1-flash" },
      },
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 },
    },
  };
}

describe("DSH 持久化帧级/行级增量导入", () => {
  let root: string;
  let databasePath: string;
  let store: UsageStore;
  let previousHome: string | undefined;
  let now = 1_794_000_100_000;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "dsh-incremental-"));
    databasePath = path.join(root, "usage.sqlite");
    previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = path.join(root, "home");
    store = new UsageStore(databasePath);
  });

  afterEach(async () => {
    store.close();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });

  function restartStore(): void {
    store.close();
    store = new UsageStore(databasePath);
  }

  async function sync(): Promise<DshIncrementalResult> {
    const dsh = await readDshUsageIncremental(store);
    const { records, ...source } = dsh.usage;
    const usage: UsageResponse = {
      records,
      sources: [{ ...source, recordCount: records.length }],
      scannedFiles: dsh.usage.scannedFiles,
      skippedFiles: dsh.usage.skippedFiles,
      syncedAt: now,
    };
    store.markSyncStarted(now);
    store.commitSnapshot(usage, now + 10, dsh.transaction);
    now += 1000;
    return dsh;
  }

  async function sessionDirectory(session = "session-a"): Promise<string> {
    const directory = path.join(process.env.DSH_HOME!, "sessions", "--D-code-p--", session);
    await mkdir(directory, { recursive: true });
    return directory;
  }

  it("首次全量导入与旧 reader 一致，并提交归一化记录、游标和去重账本", async () => {
    const zstdDir = await sessionDirectory("session-zstd");
    const plainDir = await sessionDirectory("session-plain");
    await writeFile(
      path.join(zstdDir, "session.v4.jsonl.zstd"),
      Buffer.concat([frame(jsonl(stepStart())), frame(jsonl(message("zstd-1")))]),
    );
    await writeFile(path.join(plainDir, "session.v3.jsonl"), jsonl(message("plain-1")));

    const baseline = await readDshUsage();
    const imported = await sync();
    expect(imported.usage).toEqual(baseline);
    expect(imported.stats.rebuilds).toBe(1);
    expect(imported.stats.fullFilesRead).toBe(2);
    expect(imported.stats.bodyBytesRead).toBeGreaterThan(0);
    expect(store.readNormalizedRecords("dsh")).toEqual(baseline.records);
    expect(store.getSessionLogStates("dsh")).toHaveLength(2);
    expect(store.getDedupKeys("dsh").sort()).toEqual(["dsh:plain-1", "dsh:zstd-1"]);
  });

  it("未变化不读取正文；追加一帧只读取并解压新增帧", async () => {
    const directory = await sessionDirectory();
    const filePath = path.join(directory, "session.v4.jsonl.zstd");
    await writeFile(filePath, frame(jsonl(message("one"))));
    await sync();

    const unchanged = await sync();
    expect(unchanged.stats).toMatchObject({
      bodyBytesRead: 0,
      verificationBytesRead: 0,
      framesDecoded: 0,
      fullFilesRead: 0,
      incrementalFilesRead: 0,
      unchangedFiles: 1,
    });
    expect(store.getSnapshot()?.revision).toBe(1);

    const appended = frame(jsonl(stepStart(BASE_MS + 2000, 1, 2), message("two", BASE_MS + 4000, 1, 2)));
    await appendFile(filePath, appended);
    const incremental = await sync();
    expect(incremental.stats).toMatchObject({
      bodyBytesRead: appended.length,
      framesDecoded: 1,
      fullFilesRead: 0,
      incrementalFilesRead: 1,
    });
    expect(incremental.stats.verificationBytesRead).toBeLessThanOrEqual(64);
    expect(incremental.stats.verificationBytesRead).toBeGreaterThan(0);
    expect(incremental.usage.records).toHaveLength(2);
    expect(incremental.usage.records.find((record) => record.id === "dsh:two")?.estimatedDurationMs).toBe(2000);
    expect(store.getDedupKeys("dsh")).toHaveLength(2);

    await sync();
    expect(store.readNormalizedRecords("dsh")).toHaveLength(2);
  });

  it("step/start 与 assistant/message 跨同步且重启后仍计算耗时", async () => {
    const directory = await sessionDirectory();
    const filePath = path.join(directory, "session.v4.jsonl.zstd");
    await writeFile(filePath, frame(jsonl(stepStart())));
    await sync();
    expect(store.getSessionLogStates("dsh")[0]?.parserStateJson).toContain("stepStarts");

    restartStore();
    await appendFile(filePath, frame(jsonl(message("after-restart", BASE_MS + 4321))));
    await sync();
    expect(store.readNormalizedRecords("dsh")).toHaveLength(1);
    expect(store.readNormalizedRecords("dsh")[0]?.estimatedDurationMs).toBe(4321);
  });

  it("持久化 parser state 缺失时全量恢复，不在旧 offset 静默丢耗时", async () => {
    const directory = await sessionDirectory();
    const filePath = path.join(directory, "session.v4.jsonl.zstd");
    await writeFile(filePath, frame(jsonl(stepStart())));
    await sync();
    const db = new DatabaseSync(databasePath);
    db.prepare("UPDATE session_log_sync SET parser_state_json = NULL WHERE harness = 'dsh'").run();
    db.close();

    await appendFile(filePath, frame(jsonl(message("recovered", BASE_MS + 2345))));
    const recovered = await sync();
    expect(recovered.stats.rebuilds).toBe(1);
    expect(recovered.usage.records[0]?.estimatedDurationMs).toBe(2345);
  });

  it("半帧补全后不丢记录、不重复记录，游标不越过残缺尾帧", async () => {
    const directory = await sessionDirectory();
    const filePath = path.join(directory, "session.v4.jsonl.zstd");
    const completed = frame(jsonl(message("completed")));
    const partial = completed.subarray(0, 12);
    await writeFile(filePath, partial);
    const first = await sync();
    expect(first.usage.records).toHaveLength(0);
    expect(store.getSessionLogStates("dsh")[0]).toMatchObject({ cursorOffset: 0, fileSize: 12 });

    await appendFile(filePath, completed.subarray(partial.length));
    const second = await sync();
    expect(second.usage.records.map((record) => record.id)).toEqual(["dsh:completed"]);
    expect(second.stats.framesDecoded).toBe(1);
    expect(store.getSessionLogStates("dsh")[0]?.cursorOffset).toBe(completed.length);

    await sync();
    expect(store.readNormalizedRecords("dsh")).toHaveLength(1);
    expect(store.getDedupKeys("dsh")).toEqual(["dsh:completed"]);
  });

  it("普通 JSONL 半行补全后不丢记录，且只读取新增完整行", async () => {
    const directory = await sessionDirectory();
    const filePath = path.join(directory, "session.v3.jsonl");
    const firstLine = jsonl(message("plain-first"));
    const line = jsonl(message("plain-complete"));
    const splitAt = line.length - 20;
    await writeFile(filePath, firstLine + line.slice(0, splitAt));
    await sync();
    expect(store.getSessionLogStates("dsh")[0]?.cursorOffset).toBe(Buffer.byteLength(firstLine));

    const remainder = line.slice(splitAt);
    await appendFile(filePath, remainder);
    const second = await sync();
    expect(second.usage.records.map((record) => record.id).sort()).toEqual([
      "dsh:plain-complete",
      "dsh:plain-first",
    ]);
    // 游标位于上一条 LF，必须重读当时未提交的半行以及本次追加字节。
    expect(second.stats.bodyBytesRead).toBe(Buffer.byteLength(line));
    expect(store.getSessionLogStates("dsh")[0]?.cursorOffset).toBe(
      Buffer.byteLength(firstLine) + Buffer.byteLength(line),
    );

    await sync();
    expect(store.readNormalizedRecords("dsh")).toHaveLength(2);
  });

  it("截断到已提交游标之前会来源级重建，不保留失效记录", async () => {
    const directory = await sessionDirectory();
    const filePath = path.join(directory, "session.v4.jsonl.zstd");
    await writeFile(filePath, frame(jsonl(message("old"))));
    await sync();
    await writeFile(filePath, Buffer.alloc(4));

    const recovered = await sync();
    expect(recovered.stats.rebuilds).toBe(1);
    expect(recovered.transaction.resetCursors).toBe(true);
    expect(recovered.usage.records).toHaveLength(0);
    expect(store.readNormalizedRecords("dsh")).toHaveLength(0);
    expect(store.getDedupKeys("dsh")).toHaveLength(0);
    expect(store.getSessionLogStates("dsh")[0]?.cursorOffset).toBe(0);
  });

  it("同尺寸重写会来源级重建，并重新建立跨文件去重", async () => {
    const directory = await sessionDirectory();
    const filePath = path.join(directory, "session.v4.jsonl");
    const before = Buffer.from(jsonl(message("old-aa")));
    const after = Buffer.from(jsonl(message("new-bb")));
    expect(after.length).toBe(before.length);
    await writeFile(filePath, before);
    await sync();

    await writeFile(filePath, after);
    const future = new Date(Date.now() + 2000);
    await utimes(filePath, future, future);
    const recovered = await sync();
    expect(recovered.stats.rebuilds).toBe(1);
    expect(recovered.usage.records.map((record) => record.id)).toEqual(["dsh:new-bb"]);
    expect(store.getDedupKeys("dsh")).toEqual(["dsh:new-bb"]);

    await sync();
    expect(store.readNormalizedRecords("dsh")).toHaveLength(1);
  });

  it("非法续读帧边界会明确重建，重扫不会重复计数", async () => {
    const directory = await sessionDirectory();
    const filePath = path.join(directory, "session.v4.jsonl.zstd");
    await writeFile(filePath, frame(jsonl(message("stable"))));
    await sync();
    await appendFile(filePath, Buffer.from("definitely-not-a-zstd-frame"));

    const recovered = await sync();
    expect(recovered.stats.rebuilds).toBe(1);
    expect(recovered.usage.records.map((record) => record.id)).toEqual(["dsh:stable"]);
    expect(store.readNormalizedRecords("dsh")).toHaveLength(1);
    expect(store.getDedupKeys("dsh")).toEqual(["dsh:stable"]);

    const unchanged = await sync();
    expect(unchanged.stats.rebuilds).toBe(0);
    expect(unchanged.stats.bodyBytesRead).toBe(0);
    expect(store.readNormalizedRecords("dsh")).toHaveLength(1);
  });

  it("一行与 UTF-8 字符跨帧时保留原始字节及无 ID 行哈希口径", async () => {
    const directory = await sessionDirectory();
    const filePath = path.join(directory, "session.v4.jsonl.zstd");
    const event = message("temporary") as { data: { message: { id?: string } } };
    delete event.data.message.id;
    // 在 JSON 的 ASCII 文本中插入一个真实多字节字符，并从字符中间拆帧。
    const json = Buffer.from(JSON.stringify(event).replace('"provider":"deepseek-account"', '"provider":"深seek-account"') + "\n");
    const characterStart = json.indexOf(Buffer.from("深"));
    const splitAt = characterStart + 1;
    expect(splitAt).toBeGreaterThan(0);
    await writeFile(filePath, zlib.zstdCompressSync(json.subarray(0, splitAt)));
    const first = await sync();
    expect(first.usage.records).toHaveLength(0);
    expect(store.getSessionLogStates("dsh")[0]?.parserStateJson).toContain("pendingBytes");

    await appendFile(filePath, zlib.zstdCompressSync(json.subarray(splitAt)));
    const second = await sync();
    const baseline = await readDshUsage();
    expect(second.usage.records).toEqual(baseline.records);
    expect(second.usage.records).toHaveLength(1);
    expect(second.usage.records[0]?.id).toMatch(/^dsh:[0-9a-f]{64}$/);
  });

  it("新增副本文件会重算全局 winner，与旧全量 reader 一致", async () => {
    const oldDirectory = await sessionDirectory("z-old");
    await writeFile(path.join(oldDirectory, "session.v4.jsonl"), jsonl(message("shared")));
    await sync();

    const newDirectory = await sessionDirectory("a-new");
    await writeFile(path.join(newDirectory, "session.v4.jsonl"), jsonl(message("shared")));
    const incremental = await sync();
    const baseline = await readDshUsage();
    expect(incremental.stats.rebuilds).toBe(1);
    expect(incremental.usage).toEqual(baseline);
    expect(incremental.usage.records).toHaveLength(1);
  });

  it("同会话多个版本文件继续按全局消息 ID 去重", async () => {
    const directory = await sessionDirectory();
    const shared = frame(jsonl(message("shared")));
    await writeFile(path.join(directory, "session.v3.jsonl.zstd"), shared);
    const v4 = path.join(directory, "session.v4.jsonl.zstd");
    await writeFile(v4, shared);
    const first = await sync();
    expect(first.usage.records.map((record) => record.id)).toEqual(["dsh:shared"]);

    await appendFile(v4, frame(jsonl(message("unique-v4"))));
    const second = await sync();
    expect(second.usage.records.map((record) => record.id).sort()).toEqual([
      "dsh:shared",
      "dsh:unique-v4",
    ]);
    expect(second.stats.framesDecoded).toBe(1);
    expect(store.getDedupKeys("dsh")).toHaveLength(2);
  });
});
