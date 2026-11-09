import { appendFile, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});
import { readClaudeUsage } from "@/lib/claude";
import { readClaudeUsageIncremental } from "@/lib/claude-incremental";
import type { IncrementalUsageResult } from "@/lib/incremental-core";
import type { UsageResponse } from "@/lib/usage";
import { UsageStore } from "@/lib/usage-store";

const BASE_MS = 1_794_000_000_000;
const DIRECTORY = "D--code-y-token-panel";
const PROJECT_CWD = "D:\\code\\y-token-panel";

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

interface LineOptions {
  uuid: string;
  parentUuid: string | null;
  timestamp: number;
  type?: string;
  sessionId?: string;
  cwd?: string;
  messageId?: string;
  apiBlockIndex?: number;
  stopReason?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

function line(options: LineOptions): string {
  return JSON.stringify({
    type: options.type ?? "assistant",
    uuid: options.uuid,
    parentUuid: options.parentUuid,
    timestamp: iso(options.timestamp),
    sessionId: options.sessionId ?? "session-a",
    cwd: options.cwd ?? PROJECT_CWD,
    ...(options.apiBlockIndex === undefined
      ? {}
      : { apiBlockIndex: options.apiBlockIndex }),
    ...(options.messageId === undefined
      ? {}
      : {
          message: {
            id: options.messageId,
            model: "claude-sonnet-4.6",
            stop_reason: options.stopReason ?? null,
            usage: {
              input_tokens: options.inputTokens ?? 100,
              output_tokens: options.outputTokens ?? 10,
              cache_read_input_tokens: options.cacheReadTokens ?? 0,
              cache_creation_input_tokens: 0,
            },
          },
        }),
  });
}

function userLine(uuid: string, timestamp: number, cwd?: string): string {
  return line({
    uuid,
    parentUuid: null,
    timestamp,
    type: "user",
    cwd,
    sessionId: "session-a",
  });
}

function jsonl(...lines: string[]): string {
  return lines.join("\n") + "\n";
}

describe("Claude 持久化字节游标增量导入", () => {
  let root: string;
  let databasePath: string;
  let store: UsageStore;
  let previousConfig: string | undefined;
  let now = 1_794_000_100_000;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "claude-incremental-"));
    databasePath = path.join(root, "usage.sqlite");
    previousConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = path.join(root, "home");
    store = new UsageStore(databasePath);
  });

  afterEach(async () => {
    store.close();
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfig;
    await rm(root, { recursive: true, force: true });
  });

  function restartStore(): void {
    store.close();
    store = new UsageStore(databasePath);
  }

  async function sync(): Promise<IncrementalUsageResult> {
    const result = await readClaudeUsageIncremental(store);
    const { records, ...source } = result.usage;
    const usage: UsageResponse = {
      records,
      sources: [{ ...source, recordCount: records.length }],
      scannedFiles: result.usage.scannedFiles,
      skippedFiles: result.usage.skippedFiles,
      syncedAt: now,
    };
    store.markSyncStarted(now);
    store.commitSnapshot(usage, now + 10, [result.transaction]);
    now += 1000;
    return result;
  }

  async function projectDir(name = DIRECTORY): Promise<string> {
    const directory = path.join(process.env.CLAUDE_CONFIG_DIR!, "projects", name);
    await mkdir(directory, { recursive: true });
    return directory;
  }

  async function subagentsDir(): Promise<string> {
    const directory = path.join(
      process.env.CLAUDE_CONFIG_DIR!,
      "projects",
      DIRECTORY,
      "session-a",
      "subagents",
    );
    await mkdir(directory, { recursive: true });
    return directory;
  }

  it("首次全量导入与旧 reader 一致（主会话 + 子 agent），并提交游标与账本", async () => {
    const directory = await projectDir();
    await writeFile(
      path.join(directory, "session-a.jsonl"),
      jsonl(
        userLine("u1", BASE_MS),
        line({
          uuid: "b0",
          parentUuid: "u1",
          timestamp: BASE_MS + 1000,
          messageId: "msg_a",
          apiBlockIndex: 0,
        }),
        line({
          uuid: "b1",
          parentUuid: "b0",
          timestamp: BASE_MS + 4000,
          messageId: "msg_a",
          apiBlockIndex: 1,
          stopReason: "end_turn",
          outputTokens: 50,
        }),
      ),
    );
    const subagents = await subagentsDir();
    await writeFile(
      path.join(subagents, "agent-1.jsonl"),
      jsonl(
        line({
          uuid: "s1",
          parentUuid: null,
          timestamp: BASE_MS + 9000,
          messageId: "msg_sub",
          stopReason: "end_turn",
          sessionId: "session-sub",
        }),
      ),
    );

    const baseline = await readClaudeUsage();
    const imported = await sync();
    expect(imported.usage).toEqual(baseline);
    expect(imported.stats.rebuilds).toBe(1);
    expect(imported.stats.fullFilesRead).toBe(2);
    expect(store.readNormalizedRecords("claude")).toEqual(baseline.records);
    expect(store.getSessionLogStates("claude")).toHaveLength(2);
    expect(store.getDedupKeys("claude").sort()).toEqual(["claude:msg_a", "claude:msg_sub"]);
    // 耗时沿父链估算成功（起点 u1，终点最晚块）。
    expect(imported.usage.records.find((r) => r.id === "claude:msg_a")?.estimatedDurationMs).toBe(4000);
  });

  it("全量导入 stat 后文件继续追加：游标保持一致，追加内容下一轮补入", async () => {
    const directory = await projectDir();
    const filePath = path.join(directory, "session-a.jsonl");
    const initial = jsonl(
      userLine("u1", BASE_MS),
      line({
        uuid: "b0",
        parentUuid: "u1",
        timestamp: BASE_MS + 1000,
        messageId: "msg_a",
        stopReason: "end_turn",
      }),
    );
    const appended = line({
      uuid: "c0",
      parentUuid: "b0",
      timestamp: BASE_MS + 2000,
      messageId: "msg_b",
      stopReason: "end_turn",
    }) + "\n";
    await writeFile(filePath, initial);

    const actualStat = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).stat;
    vi.mocked(stat).mockImplementationOnce(async (target) => {
      const metadata = await actualStat(target);
      // 模拟活跃 Claude writer：发现文件大小后、读取正文前追加完整一行。
      await appendFile(filePath, appended);
      return metadata;
    });

    const first = await sync();
    expect(first.usage.records.map((record) => record.id)).toEqual(["claude:msg_a"]);
    expect(store.getSessionLogStates("claude")[0]).toMatchObject({
      fileSize: Buffer.byteLength(initial),
      cursorOffset: Buffer.byteLength(initial),
    });

    const second = await sync();
    expect(second.usage.records.map((record) => record.id)).toEqual(["claude:msg_b", "claude:msg_a"]);
    expect(store.getSessionLogStates("claude")[0]).toMatchObject({
      fileSize: Buffer.byteLength(initial + appended),
      cursorOffset: Buffer.byteLength(initial + appended),
    });
    expect(second.usage).toEqual(await readClaudeUsage());
  });

  it("未变化零正文读取；追加块补齐 stop_reason 与耗时并只读新增字节", async () => {
    const directory = await projectDir();
    const filePath = path.join(directory, "session-a.jsonl");
    const first = jsonl(
      userLine("u1", BASE_MS),
      line({
        uuid: "b0",
        parentUuid: "u1",
        timestamp: BASE_MS + 1000,
        messageId: "msg_a",
        apiBlockIndex: 0,
        outputTokens: 5,
      }),
    );
    await writeFile(filePath, first);
    const firstResult = await sync();
    expect(firstResult.usage.records).toHaveLength(1);
    expect(firstResult.usage.records[0]?.outputTokens).toBe(5);
    expect(firstResult.usage.records[0]?.estimatedDurationMs).toBeUndefined();

    const unchanged = await sync();
    expect(unchanged.stats).toMatchObject({
      bodyBytesRead: 0,
      verificationBytesRead: 0,
      fullFilesRead: 0,
      incrementalFilesRead: 0,
      unchangedFiles: 1,
    });
    expect(store.getSnapshot()?.revision).toBe(1);

    const appended = line({
      uuid: "b1",
      parentUuid: "b0",
      timestamp: BASE_MS + 8000,
      messageId: "msg_a",
      apiBlockIndex: 1,
      stopReason: "end_turn",
      outputTokens: 20,
    }) + "\n";
    await appendFile(filePath, appended);
    const incremental = await sync();
    expect(incremental.stats).toMatchObject({
      bodyBytesRead: Buffer.byteLength(appended),
      fullFilesRead: 0,
      incrementalFilesRead: 1,
    });
    expect(incremental.stats.verificationBytesRead).toBeGreaterThan(0);
    expect(incremental.usage.records).toHaveLength(1);
    expect(incremental.usage.records[0]).toMatchObject({
      outputTokens: 20,
      estimatedDurationMs: 8000,
      timestamp: BASE_MS + 8000,
    });
    const baseline = await readClaudeUsage();
    expect(incremental.usage.records).toEqual(baseline.records);
    expect(store.getDedupKeys("claude")).toHaveLength(1);

    await sync();
    expect(store.readNormalizedRecords("claude")).toHaveLength(1);
    expect(store.getSnapshot()?.revision).toBe(2);
  });

  it("请求起点在游标之前：回看窗口重建对话链，跨轮仍能估算耗时", async () => {
    const directory = await projectDir();
    const filePath = path.join(directory, "session-a.jsonl");
    await writeFile(
      filePath,
      jsonl(
        userLine("u1", BASE_MS),
        line({
          uuid: "a1",
          parentUuid: "u1",
          timestamp: BASE_MS + 2000,
          messageId: "msg_a",
          apiBlockIndex: 0,
          stopReason: "end_turn",
        }),
      ),
    );
    await sync();

    // 新回复的首块父行是上一轮已提交的 a1；起点必须从回看窗口的链取。
    await appendFile(
      filePath,
      line({
        uuid: "c1",
        parentUuid: "a1",
        timestamp: BASE_MS + 7000,
        messageId: "msg_b",
        apiBlockIndex: 0,
        stopReason: "end_turn",
      }) + "\n",
    );
    const second = await sync();
    expect(second.usage.records.find((r) => r.id === "claude:msg_b")?.estimatedDurationMs).toBe(5000);
    expect(await (async () => {
      const baseline = await readClaudeUsage();
      return baseline.records.find((r) => r.id === "claude:msg_b")?.estimatedDurationMs;
    })()).toBe(5000);
  });

  it("sessionProject 持久化：回看窗口看不到项目根 cwd 时仍保持项目归组", async () => {
    const directory = await projectDir();
    const filePath = path.join(directory, "session-a.jsonl");
    await writeFile(
      filePath,
      jsonl(
        userLine("u1", BASE_MS, PROJECT_CWD),
        line({
          uuid: "b0",
          parentUuid: "u1",
          timestamp: BASE_MS + 1000,
          messageId: "msg_a",
          stopReason: "end_turn",
        }),
      ),
    );
    const first = await sync();
    expect(first.usage.records[0]?.project).toBe("y-token-panel");
    expect(store.getSessionLogStates("claude")[0]?.parserStateJson).toContain("sessionProject");

    // 追加行的 cwd 都指向子目录（mangle 后不等于目录名），窗口推不出项目根。
    await appendFile(
      filePath,
      line({
        uuid: "c1",
        parentUuid: "b0",
        timestamp: BASE_MS + 5000,
        messageId: "msg_b",
        stopReason: "end_turn",
        cwd: "D:\\code\\y-token-panel\\docs",
      }) + "\n",
    );
    const second = await sync();
    expect(second.usage.records.find((r) => r.id === "claude:msg_b")?.project).toBe("y-token-panel");
    const baseline = await readClaudeUsage();
    expect(second.usage.records).toEqual(baseline.records);
  });

  it("半行补全后不丢记录；UTF-8 多字节字符跨轮拆分仍一致", async () => {
    const directory = await projectDir();
    const filePath = path.join(directory, "session-a.jsonl");
    const firstLine = userLine("u1", BASE_MS);
    const secondLineRaw = line({
      uuid: "b0",
      parentUuid: "u1",
      timestamp: BASE_MS + 1000,
      messageId: "msg多字节",
      stopReason: "end_turn",
    });
    const secondLine = secondLineRaw.replace("claude-sonnet-4.6", "claude-сонnet-4.6");
    const splitAt = Buffer.byteLength(secondLine) - 30;
    await writeFile(
      filePath,
      Buffer.concat([
        Buffer.from(firstLine + "\n"),
        Buffer.from(secondLine).subarray(0, splitAt),
      ]),
    );
    const first = await sync();
    expect(first.usage.records).toHaveLength(0);
    expect(store.getSessionLogStates("claude")[0]).toMatchObject({
      cursorOffset: Buffer.byteLength(firstLine) + 1,
    });

    await appendFile(filePath, Buffer.from(secondLine).subarray(splitAt) + "\n");
    const second = await sync();
    const baseline = await readClaudeUsage();
    expect(second.usage.records).toEqual(baseline.records);
    expect(second.usage.records).toHaveLength(1);
    expect(store.getSessionLogStates("claude")[0]?.cursorOffset).toBe(
      Buffer.byteLength(firstLine) + 1 + Buffer.byteLength(secondLine) + 1,
    );
  });

  it("重启后恢复游标与 parser state，追加不重复导入", async () => {
    const directory = await projectDir();
    const filePath = path.join(directory, "session-a.jsonl");
    await writeFile(
      filePath,
      jsonl(
        userLine("u1", BASE_MS),
        line({
          uuid: "b0",
          parentUuid: "u1",
          timestamp: BASE_MS + 1000,
          messageId: "msg_a",
          stopReason: "end_turn",
        }),
      ),
    );
    await sync();

    restartStore();
    await appendFile(
      filePath,
      line({
        uuid: "c1",
        parentUuid: "b0",
        timestamp: BASE_MS + 9000,
        messageId: "msg_b",
        stopReason: "end_turn",
      }) + "\n",
    );
    const second = await sync();
    expect(second.stats.rebuilds).toBe(0);
    expect(second.usage.records.map((r) => r.id).sort()).toEqual(["claude:msg_a", "claude:msg_b"]);
    expect(store.getDedupKeys("claude")).toHaveLength(2);
    expect(store.readNormalizedRecords("claude")).toHaveLength(2);
  });

  it("同尺寸重写触发来源级重建并重算去重账本", async () => {
    const directory = await projectDir();
    const filePath = path.join(directory, "session-a.jsonl");
    const before = jsonl(
      userLine("u1", BASE_MS),
      line({ uuid: "b0", parentUuid: "u1", timestamp: BASE_MS + 1000, messageId: "msg_aa", stopReason: "end_turn" }),
    );
    const after = jsonl(
      userLine("u1", BASE_MS),
      line({ uuid: "b0", parentUuid: "u1", timestamp: BASE_MS + 1000, messageId: "msg_bb", stopReason: "end_turn" }),
    );
    expect(Buffer.byteLength(after)).toBe(Buffer.byteLength(before));
    await writeFile(filePath, before);
    await sync();

    await writeFile(filePath, after);
    const future = new Date(Date.now() + 2000);
    await utimes(filePath, future, future);
    const recovered = await sync();
    expect(recovered.stats.rebuilds).toBe(1);
    expect(recovered.transaction.resetCursors).toBe(true);
    expect(recovered.usage.records.map((r) => r.id)).toEqual(["claude:msg_bb"]);
    expect(store.getDedupKeys("claude")).toEqual(["claude:msg_bb"]);

    await sync();
    expect(store.readNormalizedRecords("claude")).toHaveLength(1);
  });

  it("截断与新增文件都触发来源级重建", async () => {
    const directory = await projectDir();
    const filePath = path.join(directory, "session-a.jsonl");
    await writeFile(
      filePath,
      jsonl(
        userLine("u1", BASE_MS),
        line({ uuid: "b0", parentUuid: "u1", timestamp: BASE_MS + 1000, messageId: "msg_a", stopReason: "end_turn" }),
      ),
    );
    await sync();

    await writeFile(filePath, "");
    const truncated = await sync();
    expect(truncated.stats.rebuilds).toBe(1);
    expect(truncated.usage.records).toHaveLength(0);
    expect(store.getDedupKeys("claude")).toHaveLength(0);

    await writeFile(
      filePath,
      jsonl(
        line({ uuid: "x1", parentUuid: null, timestamp: BASE_MS + 3000, messageId: "msg_x", stopReason: "end_turn" }),
      ),
    );
    const grown = await sync();
    // 重建后文件集未再变化：从空文件游标 0 续读，不需要再次重建。
    expect(grown.stats.rebuilds).toBe(0);
    expect(grown.usage.records.map((r) => r.id)).toEqual(["claude:msg_x"]);

    const another = path.join(directory, "session-b.jsonl");
    await writeFile(another, jsonl(line({
      uuid: "y1",
      parentUuid: null,
      timestamp: BASE_MS + 5000,
      messageId: "msg_y",
      stopReason: "end_turn",
    })));
    const withNew = await sync();
    expect(withNew.stats.rebuilds).toBe(1);
    const baseline = await readClaudeUsage();
    expect(withNew.usage).toEqual(baseline);
  });

  it("跨文件重复 message.id 保持 first-wins，不重复计数", async () => {
    const directory = await projectDir();
    const shared = jsonl(
      line({ uuid: "d1", parentUuid: null, timestamp: BASE_MS, messageId: "msg_dup", stopReason: "end_turn" }),
    );
    await writeFile(path.join(directory, "z-old.jsonl"), shared);
    await sync();

    await writeFile(path.join(directory, "a-new.jsonl"), shared);
    const second = await sync();
    expect(second.stats.rebuilds).toBe(1); // 文件集变化 → 重建并重算 winner
    expect(second.usage.records).toHaveLength(1);
    expect(store.getDedupKeys("claude")).toEqual(["claude:msg_dup"]);
  });
});
