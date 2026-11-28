import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOpenCodeUsage, resolveOpenCodeDatabasePath, resolveOpenCodeDataDir } from "@/lib/opencode";

const roots: string[] = [];
const keys = ["OPENCODE_DATA_DIR", "OPENCODE_DB", "XDG_DATA_HOME"] as const;
const original = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of keys) {
    if (!original.has(key)) original.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const key of keys) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-usage-test-"));
  roots.push(root);
  return root;
}

function assistantMessage(id: string, sessionId: string, created: number) {
  return JSON.stringify({
    model: { providerID: "opencode-go", id: "kimi-k2.5", variant: "default" },
    tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 4 } },
    cost: 0.001,
    finish: "stop",
    time: { created, firstToken: created + 100, streamed: created + 700, completed: created + 900 },
  });
}

function createV2Db(file: string): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT);
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        type TEXT,
        seq INTEGER,
        data TEXT,
        time_created INTEGER,
        time_updated INTEGER
      );
      INSERT INTO session_v2 VALUES ('ses-a', 'D:/work/demo');
      INSERT INTO session_message VALUES
        ('msg-a', 'ses-a', 'assistant', 0, '${assistantMessage("msg-a", "ses-a", 10_000)}', 10_000, 10_900),
        ('msg-user', 'ses-a', 'user', 1, '{}', 9_000, 9_000);
    `);
  } finally {
    db.close();
  }
}

describe("OpenCode SQLite reader", () => {
  it("默认遵循 XDG 数据目录；OPENCODE_DB 相对路径基于数据目录，绝对路径直接使用", async () => {
    const root = await tempRoot();
    process.env.XDG_DATA_HOME = path.join(root, "xdg");
    expect(resolveOpenCodeDataDir()).toBe(path.join(root, "xdg", "opencode"));
    expect(resolveOpenCodeDatabasePath()).toBe(path.join(root, "xdg", "opencode", "opencode.db"));

    process.env.OPENCODE_DATA_DIR = path.join(root, "panel-data");
    expect(resolveOpenCodeDatabasePath()).toBe(path.join(root, "panel-data", "opencode.db"));

    process.env.OPENCODE_DB = "nested/custom.db";
    expect(resolveOpenCodeDatabasePath()).toBe(path.join(root, "panel-data", "nested", "custom.db"));

    const absolute = path.join(root, "absolute.db");
    process.env.OPENCODE_DB = absolute;
    expect(resolveOpenCodeDatabasePath()).toBe(path.resolve(absolute));
  });

  it("读取 v2 session_message，并过滤非用量消息", async () => {
    const root = await tempRoot();
    process.env.OPENCODE_DATA_DIR = root;
    createV2Db(path.join(root, "opencode.db"));

    const usage = await readOpenCodeUsage();
    expect(usage.harness).toBe("opencode");
    expect(usage.sourceAvailable).toBe(true);
    expect(usage.scannedFiles).toBe(1);
    expect(usage.records).toHaveLength(1);
    expect(usage.records[0]).toMatchObject({
      id: "opencode:ses-a:msg-a",
      project: "demo",
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 3,
      cacheCreationTokens: 4,
      totalTokens: 20,
      firstTokenMs: 100,
      estimatedDurationMs: 700,
    });
  });

  it("兼容 v1 session/message 表", async () => {
    const root = await tempRoot();
    process.env.OPENCODE_DATA_DIR = root;
    const db = new DatabaseSync(path.join(root, "opencode.db"));
    const data = JSON.stringify({
      role: "assistant",
      providerID: "deepseek",
      modelID: "deepseek-v4-pro",
      tokens: { input: 5, output: 6, reasoning: 2, cache: { read: 1, write: 0 } },
      time: { created: 30_000, completed: 31_000 },
    });
    try {
      db.exec("CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT)");
      db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER, time_updated INTEGER)");
      db.exec(`INSERT INTO session VALUES ('ses-old', '/repo/old-project')`);
      db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run("msg-old", "ses-old", data, 30_000, 31_000);
    } finally {
      db.close();
    }

    const usage = await readOpenCodeUsage();
    expect(usage.records).toHaveLength(1);
    expect(usage.records[0]).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      project: "old-project",
      totalTokens: 14,
    });
  });

  it("数据库不存在或 schema 不兼容时返回空来源而不抛出", async () => {
    const root = await tempRoot();
    process.env.OPENCODE_DATA_DIR = root;
    const missing = await readOpenCodeUsage();
    expect(missing.sourceAvailable).toBe(false);
    expect(missing.records).toEqual([]);

    const db = new DatabaseSync(path.join(root, "opencode.db"));
    db.exec("CREATE TABLE unrelated (id TEXT)");
    db.close();
    const incompatible = await readOpenCodeUsage();
    expect(incompatible.sourceAvailable).toBe(true);
    expect(incompatible.records).toEqual([]);
    expect(incompatible.scannedFiles).toBe(0);
  });
});
