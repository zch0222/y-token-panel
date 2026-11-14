import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { devinConfigRoot, readDevinUsage, resolveDevinDatabasePath } from "@/lib/devin";

const ENV_KEYS = ["DEVIN_DATA_DIR", "DEVIN_SESSIONS_DIR", "DEVIN_CONFIG_HOME", "DEVIN_SESSION_STORE"] as const;
const original = new Map<string, string | undefined>();
let root: string;

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    if (!original.has(key)) original.set(key, process.env[key]);
    delete process.env[key];
  }
  root = await mkdtemp(path.join(tmpdir(), "devin-harness-"));
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** 与本机 sessions.db sqlite_master 提取的 DDL 一致（V5 消息森林形态）。 */
const DEVIN_DDL = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  working_directory TEXT NOT NULL,
  backend_type TEXT NOT NULL,
  model TEXT NOT NULL,
  agent_mode TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  title TEXT,
  main_chain_id INTEGER,
  shell_last_seen_index INTEGER DEFAULT 0,
  cogs_json TEXT,
  workspace_dirs TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  metadata TEXT
);
CREATE TABLE message_nodes (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  node_id INTEGER NOT NULL,
  parent_node_id INTEGER,
  chat_message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  metadata TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  UNIQUE(session_id, node_id)
);
`;

interface SessionFixture {
  id: string;
  workingDirectory: string;
  model?: string;
  hidden?: number;
}

interface NodeFixture {
  sessionId: string;
  nodeId: number;
  createdAt: number;
  chatMessage: string;
}

function assistantMessage(options: {
  requestId: string;
  metrics: Record<string, number | null>;
  generationModel?: string;
}): string {
  return JSON.stringify({
    message_id: `${options.requestId}-message`,
    role: "assistant",
    content: "…",
    metadata: {
      num_tokens: options.metrics.output_tokens ?? 0,
      request_id: options.requestId,
      metrics: options.metrics,
      finish_reason: "tool_calls",
      ...(options.generationModel ? { generation_model: options.generationModel } : {}),
      telemetry: { source: "assistant", operation: "inference" },
    },
  });
}

async function createDevinDatabase(
  sessions: SessionFixture[],
  nodes: NodeFixture[],
): Promise<string> {
  const cliDir = path.join(root, "cli");
  await mkdir(cliDir, { recursive: true });
  const db = new DatabaseSync(path.join(cliDir, "sessions.db"));
  try {
    db.exec(DEVIN_DDL);
    const insertSession = db.prepare(
      "INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at, hidden) VALUES (?, ?, 'windsurf', ?, 'smart', ?, ?, ?)",
    );
    for (const session of sessions) {
      insertSession.run(
        session.id,
        session.workingDirectory,
        session.model ?? "claude-sonnet-5-5-medium",
        1_794_600_000,
        1_794_600_900,
        session.hidden ?? 0,
      );
    }
    const insertNode = db.prepare(
      "INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?, ?, NULL, ?, ?)",
    );
    for (const node of nodes) {
      insertNode.run(node.sessionId, node.nodeId, node.chatMessage, node.createdAt);
    }
  } finally {
    db.close();
  }
  return path.join(cliDir, "sessions.db");
}

describe("resolveDevinDatabasePath", () => {
  it("默认为配置根下 cli/sessions.db（appData 注入）", () => {
    expect(
      resolveDevinDatabasePath({
        env: {},
        homeDir: "C:\\Users\\tester",
        appDataDir: "C:\\Users\\tester\\AppData\\Roaming",
      }),
    ).toBe(path.join("C:\\Users\\tester\\AppData\\Roaming", "devin", "cli", "sessions.db"));
  });

  it("面板 DEVIN_DATA_DIR 替换配置根且优先级最高", () => {
    process.env.DEVIN_SESSIONS_DIR = path.join("D:", "sessions-elsewhere");
    process.env.DEVIN_CONFIG_HOME = path.join("D:", "config-home");
    process.env.DEVIN_DATA_DIR = "  D:\\devin-root  ";
    expect(resolveDevinDatabasePath()).toBe(
      path.join("D:", "devin-root", "cli", "sessions.db"),
    );
  });

  it("官方 DEVIN_SESSIONS_DIR 直接指向含 sessions.db 的目录，优先于 DEVIN_CONFIG_HOME", () => {
    expect(
      resolveDevinDatabasePath({
        env: {
          DEVIN_SESSIONS_DIR: "D:\\sessions-dir",
          DEVIN_CONFIG_HOME: "D:\\config-home",
        },
      }),
    ).toBe(path.join("D:", "sessions-dir", "sessions.db"));
  });

  it("官方 DEVIN_CONFIG_HOME 覆盖配置根，空白按未设置", () => {
    expect(resolveDevinDatabasePath({ env: { DEVIN_CONFIG_HOME: "  D:\\cfg  " } })).toBe(
      path.join("D:", "cfg", "cli", "sessions.db"),
    );
    expect(
      resolveDevinDatabasePath({
        env: { DEVIN_CONFIG_HOME: "   " },
        homeDir: "C:\\Users\\tester",
        appDataDir: "C:\\Users\\tester\\AppData\\Roaming",
      }),
    ).toBe(path.join("C:\\Users\\tester\\AppData\\Roaming", "devin", "cli", "sessions.db"));
  });
});

describe("devinConfigRoot", () => {
  it("注入 appDataDir 时不再读平台默认", () => {
    expect(
      devinConfigRoot({ env: {}, homeDir: "C:\\Users\\tester", appDataDir: "D:\\appdata" }),
    ).toBe(path.join("D:", "appdata", "devin"));
  });
});

describe("readDevinUsage", () => {
  it("端到端读取：含 hidden 会话，过滤无 metrics 行，映射完整字段", async () => {
    const dbPath = await createDevinDatabase(
      [
        { id: "upbeat-crater", workingDirectory: "C:\\Users\\YXLMz\\code\\anynote" },
        { id: "internal-helper", workingDirectory: "C:\\Users\\YXLMz\\code\\anynote", hidden: 1 },
      ],
      [
        {
          sessionId: "upbeat-crater",
          nodeId: 1,
          createdAt: 1_794_600_100,
          chatMessage: JSON.stringify({
            role: "user",
            content: "hi",
            metadata: { num_tokens: null, is_user_input: true, metrics: null },
          }),
        },
        {
          sessionId: "upbeat-crater",
          nodeId: 3,
          createdAt: 1_794_600_300,
          chatMessage: assistantMessage({
            requestId: "8b1351cc-8b3c-4c04-9999-53b91c53e037",
            generationModel: "claude-opus-5-5-xhigh",
            metrics: {
              ttft_ms: 10_416,
              total_time_ms: 122_532,
              input_tokens: 4,
              output_tokens: 11_156,
              cache_read_tokens: 19_253,
              cache_creation_tokens: 237_504,
              context_input_tokens: 256_761,
            },
          }),
        },
        {
          sessionId: "internal-helper",
          nodeId: 1,
          createdAt: 1_794_600_500,
          chatMessage: assistantMessage({
            requestId: "summarizer-request",
            metrics: { input_tokens: 1_000, output_tokens: 50 },
          }),
        },
      ],
    );
    process.env.DEVIN_DATA_DIR = root;

    const usage = await readDevinUsage();
    expect(usage.source).toBe(dbPath);
    expect(usage.sourceAvailable).toBe(true);
    expect(usage.scannedFiles).toBe(2);
    expect(usage.skippedFiles).toBe(0);
    expect(usage.records).toHaveLength(2);

    // 时间倒序：hidden 会话（内部 summarizer，真实消耗照常计入）更晚。
    expect(usage.records.map((record) => record.requestId)).toEqual([
      "summarizer-request",
      "8b1351cc-8b3c-4c04-9999-53b91c53e037",
    ]);
    const main = usage.records[1];
    expect(main).toMatchObject({
      id: "devin:upbeat-crater:8b1351cc-8b3c-4c04-9999-53b91c53e037",
      harness: "devin",
      project: "anynote",
      model: "claude-opus-5-5-xhigh",
      provider: "Anthropic",
      timestamp: 1_794_600_300_000,
      inputTokens: 4,
      outputTokens: 11_156,
      cacheReadTokens: 19_253,
      cacheCreationTokens: 237_504,
      totalTokens: 267_917,
      inputTokenSemantics: "fresh",
      hasTokenUsage: true,
      credits: 0,
      hasCredit: false,
      firstTokenMs: 10_416,
      estimatedDurationMs: 122_532,
      status: "success",
    });
    expect(usage.records[0]?.project).toBe("anynote");
  });

  it("同一 request_id 的压缩副本（compact/prior_node_ids 血缘）只计一次且取生成时刻", async () => {
    const metrics = { input_tokens: 2, output_tokens: 1119, cache_read_tokens: 218_240, cache_creation_tokens: 11_954 };
    const message = assistantMessage({ requestId: "0867887e-8efb-4e5c-b5c2-df133246285b", metrics });
    const compactMeta = JSON.stringify({
      summarized_from: null,
      num_tokens_preceding: null,
      is_system_prefix: null,
      extensions: { "compact/prior_node_ids": [132] },
    });
    await createDevinDatabase(
      [{ id: "carnation-salute", workingDirectory: "C:\\Users\\YXLMz\\code\\anynote" }],
      [
        // 原始行（node 131）与压缩副本（node 245，row_id 更大、created_at 更晚）。
        { sessionId: "carnation-salute", nodeId: 131, createdAt: 1_794_647_731, chatMessage: message },
        { sessionId: "carnation-salute", nodeId: 245, createdAt: 1_794_648_232, chatMessage: message },
      ],
    );
    // 直接落一条带 compact 血缘的 message_nodes.metadata，模拟真实库形态。
    const db = new DatabaseSync(path.join(root, "cli", "sessions.db"));
    try {
      db.prepare("UPDATE message_nodes SET metadata = ? WHERE node_id = 245").run(compactMeta);
    } finally {
      db.close();
    }
    process.env.DEVIN_DATA_DIR = root;

    const usage = await readDevinUsage();
    expect(usage.records).toHaveLength(1);
    expect(usage.records[0]).toMatchObject({
      requestId: "0867887e-8efb-4e5c-b5c2-df133246285b",
      timestamp: 1_794_647_731_000,
      inputTokens: 2,
      outputTokens: 1_119,
      cacheReadTokens: 218_240,
      cacheCreationTokens: 11_954,
    });
  });

  it("库缺失时按来源不可用返回且不抛错", async () => {
    process.env.DEVIN_DATA_DIR = root;
    const usage = await readDevinUsage();
    expect(usage).toEqual({
      harness: "devin",
      records: [],
      scannedFiles: 0,
      skippedFiles: 0,
      source: path.join(root, "cli", "sessions.db"),
      sourceAvailable: false,
    });
  });

  it("非 SQLite 文件按不可用返回并记一次跳过", async () => {
    const cliDir = path.join(root, "cli");
    await mkdir(cliDir, { recursive: true });
    await writeFile(path.join(cliDir, "sessions.db"), "not a sqlite file");
    process.env.DEVIN_DATA_DIR = root;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const usage = await readDevinUsage();
    expect(usage.sourceAvailable).toBe(false);
    expect(usage.skippedFiles).toBe(1);
    expect(usage.records).toHaveLength(0);
  });

  it("空 schema（无 message_nodes 表）按不可用返回且不抛错", async () => {
    const cliDir = path.join(root, "cli");
    await mkdir(cliDir, { recursive: true });
    const db = new DatabaseSync(path.join(cliDir, "sessions.db"));
    db.close();
    process.env.DEVIN_DATA_DIR = root;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const usage = await readDevinUsage();
    expect(usage.sourceAvailable).toBe(false);
    expect(usage.skippedFiles).toBe(1);
  });

  it("config.json session_store=files 时 SQLite 库不再更新，按不可用处理", async () => {
    await createDevinDatabase(
      [{ id: "upbeat-crater", workingDirectory: "C:\\code\\anynote" }],
      [
        {
          sessionId: "upbeat-crater",
          nodeId: 1,
          createdAt: 1_794_600_100,
          chatMessage: assistantMessage({
            requestId: "r1",
            metrics: { input_tokens: 5, output_tokens: 5 },
          }),
        },
      ],
    );
    await writeFile(path.join(root, "config.json"), JSON.stringify({ session_store: "files" }));
    process.env.DEVIN_DATA_DIR = root;

    const usage = await readDevinUsage();
    expect(usage.sourceAvailable).toBe(false);
    expect(usage.records).toHaveLength(0);
  });

  it("env DEVIN_SESSION_STORE=files 同样生效，且优先于 config.json", async () => {
    await writeFile(path.join(root, "config.json"), JSON.stringify({ session_store: "sqlite" }));
    process.env.DEVIN_DATA_DIR = root;
    process.env.DEVIN_SESSION_STORE = "files";

    expect((await readDevinUsage()).sourceAvailable).toBe(false);

    delete process.env.DEVIN_SESSION_STORE;
    // config.json 为 sqlite（默认值同义）且库缺失时正常走不可用分支（无跳过）。
    const usage = await readDevinUsage();
    expect(usage.sourceAvailable).toBe(false);
    expect(usage.skippedFiles).toBe(0);
  });

  it("config.json 损坏或字段类型不对时按默认 sqlite 处理", async () => {
    await createDevinDatabase(
      [{ id: "upbeat-crater", workingDirectory: "C:\\code\\anynote" }],
      [
        {
          sessionId: "upbeat-crater",
          nodeId: 1,
          createdAt: 1_794_600_100,
          chatMessage: assistantMessage({
            requestId: "r1",
            metrics: { input_tokens: 5, output_tokens: 5 },
          }),
        },
      ],
    );
    process.env.DEVIN_DATA_DIR = root;

    await writeFile(path.join(root, "config.json"), "{ invalid json");
    expect((await readDevinUsage()).sourceAvailable).toBe(true);

    await writeFile(path.join(root, "config.json"), JSON.stringify({ session_store: 42 }));
    expect((await readDevinUsage()).sourceAvailable).toBe(true);
  });

  it("Devin 运行中（WAL 模式、写连接保持打开）并发只读读全", async () => {
    const cliDir = path.join(root, "cli");
    await mkdir(cliDir, { recursive: true });
    const dbPath = path.join(cliDir, "sessions.db");
    const writer = new DatabaseSync(dbPath);
    try {
      writer.exec(DEVIN_DDL);
      // WAL 模式 + 已提交数据驻留在 -wal，复现 Devin Desktop 常驻运行的生产形态。
      const mode = writer.prepare("PRAGMA journal_mode=WAL").get() as { journal_mode?: string };
      expect(mode.journal_mode).toBe("wal");
      writer
        .prepare(
          "INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at) VALUES ('upbeat-crater', 'C:\\code\\anynote', 'windsurf', 'claude-opus-5-5-xhigh', 'smart', 1794600000, 1794600900)",
        )
        .run();
      writer
        .prepare(
          "INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES ('upbeat-crater', 1, NULL, ?, 1794600100)",
        )
        .run(
          assistantMessage({
            requestId: "wal-request",
            metrics: { input_tokens: 7, output_tokens: 9 },
          }),
        );

      process.env.DEVIN_DATA_DIR = root;
      const usage = await readDevinUsage();
      expect(usage.sourceAvailable).toBe(true);
      expect(usage.records).toHaveLength(1);
      expect(usage.records[0]).toMatchObject({
        requestId: "wal-request",
        inputTokens: 7,
        outputTokens: 9,
      });
    } finally {
      writer.close();
    }
  });
});
