import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncrementalUsageResult } from "@/lib/incremental-core";
import type { UsageResponse } from "@/lib/usage";
import { UsageStore } from "@/lib/usage-store";
import { readCodeBuddyUsage } from "@/lib/codebuddy";
import { readCodeBuddyUsageIncremental } from "@/lib/wholefile-incremental";
import { readPiDesktopUsage } from "@/lib/pi-desktop";
import { readPiDesktopUsageIncremental } from "@/lib/wholefile-incremental";
import { readWorkBuddyUsage } from "@/lib/workbuddy";
import { readWorkBuddyUsageIncremental } from "@/lib/wholefile-incremental";
import { readKcodeUsage } from "@/lib/kcode";
import { readKcodeUsageIncremental } from "@/lib/wholefile-incremental";
import type { SessionRecord } from "@/lib/codebuddy-session";
import type { WorkBuddySessionRecord } from "@/lib/workbuddy-session";

const BASE_MS = 1_794_000_000_000;

function jsonl(...items: unknown[]): string {
  return items.map((item) => JSON.stringify(item)).join("\n") + "\n";
}

/** CodeBuddy：带 usage 的 assistant 消息（真实形态，见 codebuddy-session.test.ts）。 */
function codebuddyItem(messageId = "assistant-1", overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: messageId,
    parentId: "user-1",
    timestamp: BASE_MS,
    type: "message",
    role: "assistant",
    status: "completed",
    sessionId: "session-a",
    providerData: {
      conversationRequestId: "req-1",
      messageId,
      model: "kimi-k3.1-pro",
      rawUsage: {
        prompt_tokens: 1000,
        completion_tokens: 300,
        total_tokens: 1300,
        prompt_cache_hit_tokens: 800,
        credit: 1.5,
      },
      usage: { inputTokens: 1000, outputTokens: 300, totalTokens: 1300 },
    },
    message: {
      usage: {
        input_tokens: 1000,
        output_tokens: 300,
        total_tokens: 1300,
        cache_read_input_tokens: 800,
      },
    },
    ...overrides,
  };
}

/** WorkBuddy：带 usage 的 function_call 行（真实形态，见 workbuddy.test.ts）。 */
function workbuddyItem(overrides: Partial<WorkBuddySessionRecord> = {}): WorkBuddySessionRecord {
  return {
    id: "09614b72e0da4e3b9cab93eb8a9534b8",
    parentId: "3a9c3121-f3f5-4d57-ad2b-2ebd4cb17581",
    timestamp: BASE_MS + 5_000,
    type: "function_call",
    callId: "call_01_3e3Fh4BNiDIHfqWFv4KH9433",
    name: "Bash",
    arguments: "{}",
    sessionId: "cc8799da-e917-4f3b-9fe7-d98480b17157",
    cwd: "c:\\code\\anynote",
    message: {
      usage: {
        input_tokens: 59_145,
        output_tokens: 992,
        total_tokens: 60_137,
        cache_read_input_tokens: 6_400,
      },
    },
    providerData: {
      messageId: "09614b72e0da4e3b9cab93eb8a9534b8",
      model: "deepseek-v4.1-flash",
      rawUsage: {
        prompt_tokens: 59_145,
        completion_tokens: 992,
        total_tokens: 60_137,
        prompt_cache_hit_tokens: 6_400,
        credit: 0.81,
      },
    },
    ...overrides,
  };
}

/** KCode：子 agent 一个带 usage 的 step（step.begin → llm.request → step.end）。 */
function kcodeSubStep(messageId: string, start: number, agentId = "agent-0"): string[] {
  return [
    JSON.stringify({
      type: "context.append_loop_event",
      agentId,
      time: start - 10,
      event: { type: "step.begin", uuid: `step-${messageId}`, turnId: "0", step: 1 },
    }),
    JSON.stringify({ type: "llm.request", agentId, kind: "loop", turnStep: "0.1", model: "kimi-k3-highspeed", time: start }),
    JSON.stringify({
      type: "context.append_loop_event",
      agentId,
      time: start + 1500,
      event: {
        type: "step.end",
        uuid: `step-${messageId}`,
        turnId: "0",
        step: 1,
        messageId,
        llmFirstTokenLatencyMs: 300,
        llmStreamDurationMs: 1500,
        usage: { inputOther: 972, output: 522, inputCacheRead: 12800, inputCacheCreation: 0 },
      },
    }),
  ];
}

describe("整读型增量引擎（CodeBuddy / WorkBuddy / KCode）", () => {
  let root: string;
  let databasePath: string;
  let store: UsageStore;
  const previousEnv = new Map<string, string | undefined>();
  let now = 1_794_000_100_000;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "wholefile-incremental-"));
    databasePath = path.join(root, "usage.sqlite");
    store = new UsageStore(databasePath);
  });

  afterEach(async () => {
    store.close();
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    previousEnv.clear();
    await rm(root, { recursive: true, force: true });
  });

  function stubEnv(key: string, value: string): void {
    if (!previousEnv.has(key)) previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }

  function restartStore(): void {
    store.close();
    store = new UsageStore(databasePath);
  }

  async function sync(
    incremental: (store: UsageStore) => Promise<IncrementalUsageResult>,
  ): Promise<IncrementalUsageResult> {
    const result = await incremental(store);
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

  // -----------------------------------------------------------------------
  // CodeBuddy
  // -----------------------------------------------------------------------

  describe("CodeBuddy", () => {
    beforeEach(() => {
      stubEnv("CODEBUDDY_DATA_DIR", path.join(root, "codebuddy"));
    });

    async function projectDir(name = "p--code-demo"): Promise<string> {
      const directory = path.join(root, "codebuddy", name);
      await mkdir(directory, { recursive: true });
      return directory;
    }

    it("冷导入与旧 reader 一致；未变化零读取；追加整读并保持一致", async () => {
      const directory = await projectDir();
      const filePath = path.join(directory, "session-a.jsonl");
      await writeFile(
        filePath,
        jsonl(
          codebuddyItem(),
          codebuddyItem("assistant-2", { parentId: "assistant-1", timestamp: BASE_MS + 4000 }),
        ),
      );
      const baseline = await readCodeBuddyUsage();
      const imported = await sync(readCodeBuddyUsageIncremental);
      expect(imported.usage).toEqual(baseline);
      expect(imported.stats.rebuilds).toBe(1);
      expect(store.getSessionLogStates("codebuddy")).toHaveLength(1);

      const unchanged = await sync(readCodeBuddyUsageIncremental);
      expect(unchanged.stats).toMatchObject({
        bodyBytesRead: 0,
        verificationBytesRead: 0,
        unchangedFiles: 1,
        incrementalFilesRead: 0,
      });
      expect(store.getSnapshot()?.revision).toBe(1);

      const appended = codebuddyItem("assistant-3", {
        parentId: "assistant-2",
        timestamp: BASE_MS + 9000,
      });
      await appendFile(filePath, jsonl(appended));
      const incremental = await sync(readCodeBuddyUsageIncremental);
      expect(incremental.stats).toMatchObject({ incrementalFilesRead: 1, rebuilds: 0 });
      expect(incremental.stats.bodyBytesRead).toBeGreaterThan(0);
      expect(incremental.usage.records).toHaveLength(3);
      const afterAppend = await readCodeBuddyUsage();
      expect(incremental.usage.records).toEqual(afterAppend.records);

      await sync(readCodeBuddyUsageIncremental);
      expect(store.readNormalizedRecords("codebuddy")).toHaveLength(3);
    });

    it("半行补全、重启恢复与同尺寸重写重建", async () => {
      const directory = await projectDir();
      const filePath = path.join(directory, "session-a.jsonl");
      const first = jsonl(codebuddyItem());
      const second = JSON.stringify(codebuddyItem("assistant-2"));
      await writeFile(
        filePath,
        Buffer.concat([Buffer.from(first), Buffer.from(second).subarray(0, 20)]),
      );
      const half = await sync(readCodeBuddyUsageIncremental);
      expect(half.usage.records).toHaveLength(1);
      expect(store.getSessionLogStates("codebuddy")[0]?.cursorOffset).toBe(Buffer.byteLength(first));

      await appendFile(filePath, Buffer.from(second).subarray(20) + "\n");
      restartStore();
      const completed = await sync(readCodeBuddyUsageIncremental);
      expect(completed.usage.records).toHaveLength(2);
      const baseline = await readCodeBuddyUsage();
      expect(completed.usage.records).toEqual(baseline.records);

      const future = new Date(Date.now() + 2000);
      await utimes(filePath, future, future);
      const touched = await sync(readCodeBuddyUsageIncremental);
      expect(touched.stats.rebuilds).toBe(1); // 同尺寸 mtime 变化 → 重建
      expect(touched.usage.records).toHaveLength(2);
      expect(store.getSnapshot()?.revision).toBe(2);
    });

    it("新增与删除文件触发来源级重建", async () => {
      const directory = await projectDir();
      await writeFile(path.join(directory, "a.jsonl"), jsonl(codebuddyItem()));
      await sync(readCodeBuddyUsageIncremental);

      await writeFile(
        path.join(directory, "b.jsonl"),
        jsonl(codebuddyItem("assistant-9", { timestamp: BASE_MS + 6000 })),
      );
      const grown = await sync(readCodeBuddyUsageIncremental);
      expect(grown.stats.rebuilds).toBe(1);
      expect(grown.usage.records).toHaveLength(2);
      expect(await readCodeBuddyUsage()).toMatchObject({ records: grown.usage.records });

      await rm(path.join(directory, "b.jsonl"));
      const shrunk = await sync(readCodeBuddyUsageIncremental);
      expect(shrunk.stats.rebuilds).toBe(1);
      expect(shrunk.usage.records).toHaveLength(1);
      expect(store.getDedupKeys("codebuddy")).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // WorkBuddy
  // -----------------------------------------------------------------------

  describe("WorkBuddy", () => {
    beforeEach(() => {
      stubEnv("WORKBUDDY_DATA_DIR", path.join(root, "workbuddy"));
    });

    async function projectDir(name = "c--code-anynote"): Promise<string> {
      const directory = path.join(root, "workbuddy", "projects", name);
      await mkdir(directory, { recursive: true });
      return directory;
    }

    it("冷导入一致（主会话 + 子 agent）；未变化零读取", async () => {
      const directory = await projectDir();
      const main = path.join(directory, "cc8799da.jsonl");
      await writeFile(main, jsonl(workbuddyItem()));
      const subagents = path.join(directory, "cc8799da", "subagents");
      await mkdir(subagents, { recursive: true });
      await writeFile(
        path.join(subagents, "agent-0.jsonl"),
        jsonl(workbuddyItem({ id: "sub-1", providerData: { messageId: "sub-1" }, timestamp: BASE_MS + 8000 })),
      );

      const baseline = await readWorkBuddyUsage();
      const imported = await sync(readWorkBuddyUsageIncremental);
      expect(imported.usage).toEqual(baseline);
      expect(imported.stats.rebuilds).toBe(1);

      const unchanged = await sync(readWorkBuddyUsageIncremental);
      expect(unchanged.stats).toMatchObject({ bodyBytesRead: 0, unchangedFiles: 2 });
      expect(store.getSnapshot()?.revision).toBe(1);
    });

    it("last-wins 补写：追加 model-usage 后行覆盖已入库的同 ID 记录", async () => {
      const directory = await projectDir();
      const filePath = path.join(directory, "cc8799da.jsonl");
      const inline = workbuddyItem({ type: "message", role: "assistant" });
      await writeFile(filePath, jsonl(inline));
      await sync(readWorkBuddyUsageIncremental);
      const before = store.readNormalizedRecords("workbuddy")[0];
      expect(before).toMatchObject({ outputTokens: 992, credits: 0.81 });

      // 同 messageId 的 model-usage 事实条目后行胜出：官方口径 rawUsage 优先，
      // 权威数值（output 1200）要覆盖已入库的内联条目快照（output 992）。
      const fact = workbuddyItem({
        type: "model-usage",
        providerData: {
          messageId: "09614b72e0da4e3b9cab93eb8a9534b8",
          model: "deepseek-v4.1-flash",
          rawUsage: {
            prompt_tokens: 59_145,
            completion_tokens: 1200,
            total_tokens: 60_345,
            prompt_cache_hit_tokens: 6_400,
            credit: 0.81,
          },
        },
      });
      await appendFile(filePath, jsonl(fact));
      const second = await sync(readWorkBuddyUsageIncremental);
      expect(second.stats.rebuilds).toBe(0);
      expect(second.usage.records).toHaveLength(1);
      expect(second.usage.records[0]).toMatchObject({ outputTokens: 1200 });
      const baseline = await readWorkBuddyUsage();
      expect(second.usage.records).toEqual(baseline.records);

      await sync(readWorkBuddyUsageIncremental);
      expect(store.readNormalizedRecords("workbuddy")).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // KCode
  // -----------------------------------------------------------------------

  describe("KCode", () => {
    beforeEach(() => {
      stubEnv("KIMI_CODE_HOME", path.join(root, "kimi-code"));
    });

    async function agentDir(workspace = "wd_demo_180b664743fa"): Promise<string> {
      const directory = path.join(root, "kimi-code", "sessions", workspace, "session-a", "agents", "agent-0");
      await mkdir(directory, { recursive: true });
      return directory;
    }

    it("冷导入与旧 reader 一致；追加整读；projects.json 变化触发重建重贴标签", async () => {
      const directory = await agentDir();
      const wirePath = path.join(directory, "wire.jsonl");
      await writeFile(wirePath, kcodeSubStep("chatcmpl-1", BASE_MS).join("\n") + "\n");
      await writeFile(
        path.join(root, "kimi-code", "projects.json"),
        JSON.stringify({
          schema_version: 2,
          projects: { wd_demo_180b664743fa: { root: "D:\\code\\demo", name: "demo-named" } },
        }),
      );

      const baseline = await readKcodeUsage();
      const imported = await sync(readKcodeUsageIncremental);
      expect(imported.usage).toEqual(baseline);
      expect(imported.usage.records[0]).toMatchObject({
        project: "demo-named",
        model: "kimi-k3-highspeed",
        estimatedDurationMs: 1800,
      });
      expect(store.getSessionLogStates("kcode")).toHaveLength(2); // wire + projects.json

      const unchanged = await sync(readKcodeUsageIncremental);
      expect(unchanged.stats).toMatchObject({ bodyBytesRead: 0, unchangedFiles: 1 });
      expect(store.getSnapshot()?.revision).toBe(1);

      await appendFile(wirePath, kcodeSubStep("chatcmpl-2", BASE_MS + 10_000).join("\n") + "\n");
      const appended = await sync(readKcodeUsageIncremental);
      expect(appended.stats.rebuilds).toBe(0);
      expect(appended.usage.records).toHaveLength(2);
      const afterAppend = await readKcodeUsage();
      expect(appended.usage.records).toEqual(afterAppend.records);

      // 注册表改名：全部记录（含未变化 wire 的记录）都要重贴项目标签 → 重建。
      await writeFile(
        path.join(root, "kimi-code", "projects.json"),
        JSON.stringify({
          schema_version: 2,
          projects: { wd_demo_180b664743fa: { root: "D:\\code\\demo", name: "renamed" } },
        }),
      );
      const relabeled = await sync(readKcodeUsageIncremental);
      expect(relabeled.stats.rebuilds).toBe(1);
      expect(relabeled.usage.records.every((record) => record.project === "renamed")).toBe(true);
      const finalBaseline = await readKcodeUsage();
      expect(relabeled.usage.records).toEqual(finalBaseline.records);
    });

    it("projects.json 出现与消失都触发重建", async () => {
      const directory = await agentDir();
      await writeFile(path.join(directory, "wire.jsonl"), kcodeSubStep("chatcmpl-1", BASE_MS).join("\n") + "\n");
      // 不写 projects.json：注册表缺失，退回目录名解析。
      const imported = await sync(readKcodeUsageIncremental);
      expect(imported.usage.records[0]?.project).toBe("demo");

      await writeFile(
        path.join(root, "kimi-code", "projects.json"),
        JSON.stringify({
          projects: { wd_demo_180b664743fa: { root: "D:\\code\\demo", name: "appeared" } },
        }),
      );
      const appeared = await sync(readKcodeUsageIncremental);
      expect(appeared.stats.rebuilds).toBe(1);
      expect(appeared.usage.records[0]?.project).toBe("appeared");

      await rm(path.join(root, "kimi-code", "projects.json"));
      const disappeared = await sync(readKcodeUsageIncremental);
      expect(disappeared.stats.rebuilds).toBe(1);
      expect(disappeared.usage.records[0]?.project).toBe("demo");
    });
  });

  // -----------------------------------------------------------------------
  // PI-Desktop
  // -----------------------------------------------------------------------

  describe("Pi Desktop", () => {
    const sessionId = "82f94c45-6278-4c5b-a786-a7598cb78c3e";

    beforeEach(() => {
      stubEnv("PI_DESKTOP_DATA_DIR", path.join(root, "pi-desktop"));
    });

    /** 真实形态的 assistant 记录（见 pi-desktop-session.test.ts 工厂说明）。 */
    function piLine(
      operationId: string,
      at: number,
      overrides: { input?: number; output?: number; total?: number } = {},
    ): string {
      return JSON.stringify({
        type: "message",
        id: `${operationId}-message`,
        role: "assistant",
        createdAt: new Date(BASE_MS + at).toISOString(),
        blocks: [{ type: "text", text: "ok" }],
        meta: {
          modelId: "kimi-k3-1-pro-261024",
          providerId: "f39b8d71-e8ae-494c-b635-1088342678d4",
          responseDurationMs: 2908,
          responseModelId: "kimi-k3-1-pro-261024",
          status: "complete",
          usage: {
            aggregation: "operation",
            cacheReadTokens: 512,
            costStatus: "unknown",
            inputTokens: overrides.input ?? 8529,
            operationId,
            outputTokens: overrides.output ?? 353,
            reasoningTokens: 195,
            totalTokens: overrides.total ?? 9394,
            usageOrigin: "pi",
          },
        },
      });
    }

    function piFile(...lines: string[]): string {
      return piSessionFile(sessionId, ...lines);
    }

    function piSessionFile(fileSessionId: string, ...lines: string[]): string {
      const header = JSON.stringify({
        type: "session",
        createdAt: new Date(BASE_MS).toISOString(),
        schema: 2,
        sessionId: fileSessionId,
      });
      return lines.length > 0 ? `${header}\n${lines.join("\n")}\n` : `${header}\n`;
    }

    /** 造一个最小 pi.sqlite（只含查询用到的列），写入 sessionId → 项目名映射。 */
    async function writeProjectDatabase(mapping: Record<string, string>): Promise<void> {
      const { DatabaseSync } = await import("node:sqlite");
      const databasePath = path.join(root, "pi-desktop", "pi.sqlite");
      await rm(databasePath, { force: true });
      const db = new DatabaseSync(databasePath);
      try {
        db.exec(
          "CREATE TABLE projects (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL)",
        );
        db.exec(
          "CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL)",
        );
        const insertProject = db.prepare("INSERT INTO projects (id, path, name) VALUES (?, ?, ?)");
        const insertSession = db.prepare("INSERT INTO sessions (id, project_id) VALUES (?, ?)");
        const names = [...new Set(Object.values(mapping))];
        const ids = new Map(names.map((name, index) => [name, index + 1]));
        for (const [name, id] of ids) insertProject.run(id, `D:\\proj\\${id}`, name);
        for (const [mappedSessionId, name] of Object.entries(mapping)) {
          insertSession.run(mappedSessionId, ids.get(name)!);
        }
      } finally {
        db.close();
      }
    }

    async function sessionsDir(): Promise<string> {
      const directory = path.join(root, "pi-desktop", "sessions");
      await mkdir(directory, { recursive: true });
      return directory;
    }

    it("冷导入与全量 reader 一致；未变化零读取；追加只重读变化文件", async () => {
      const directory = await sessionsDir();
      const filePath = path.join(directory, `${sessionId}.jsonl`);
      await writeFile(filePath, piFile(piLine("op-0001", 0), piLine("op-0002", 4000)));
      const baseline = await readPiDesktopUsage();
      const imported = await sync(readPiDesktopUsageIncremental);
      expect(imported.usage).toEqual(baseline);
      expect(imported.stats.rebuilds).toBe(1);
      expect(store.getSessionLogStates("pidesktop")).toHaveLength(1);

      const unchanged = await sync(readPiDesktopUsageIncremental);
      expect(unchanged.stats).toMatchObject({
        bodyBytesRead: 0,
        verificationBytesRead: 0,
        unchangedFiles: 1,
        incrementalFilesRead: 0,
      });

      await appendFile(filePath, `${piLine("op-0003", 9000)}\n`);
      const incremental = await sync(readPiDesktopUsageIncremental);
      expect(incremental.stats).toMatchObject({ incrementalFilesRead: 1, rebuilds: 0 });
      expect(incremental.usage.records).toHaveLength(3);
      const afterAppend = await readPiDesktopUsage();
      expect(incremental.usage.records).toEqual(afterAppend.records);
    });

    it("消息编辑重写主文件后按 operationId 替换旧记录，不重复计数", async () => {
      const directory = await sessionsDir();
      const filePath = path.join(directory, `${sessionId}.jsonl`);
      await writeFile(filePath, piFile(piLine("op-0001", 0)));
      await sync(readPiDesktopUsageIncremental);
      expect(store.readNormalizedRecords("pidesktop")).toHaveLength(1);

      // replaceMessages 原子重写：既有请求数值被改写（operationId 不变），并追加新请求。
      await writeFile(
        filePath,
        piFile(piLine("op-0001", 0, { input: 4321, total: 5186 }), piLine("op-0002", 4000)),
      );
      const rewritten = await sync(readPiDesktopUsageIncremental);
      expect(rewritten.usage.records).toHaveLength(2);
      expect(
        rewritten.usage.records.find((record) => record.requestId === "op-0001"),
      ).toMatchObject({ inputTokens: 4321, totalTokens: 5186 });
      const baseline = await readPiDesktopUsage();
      expect(rewritten.usage.records).toEqual(baseline.records);
    });

    it("revisions / inflight 伴随文件不纳入扫描，不重复计数", async () => {
      const directory = await sessionsDir();
      await writeFile(path.join(directory, `${sessionId}.jsonl`), piFile(piLine("op-0001", 0)));
      // revisions 快照里带同 operationId 的完整消息，读入会造成双计。
      await writeFile(
        path.join(directory, `${sessionId}.revisions.jsonl`),
        [
          JSON.stringify({ type: "storage", schema: 2 }),
          JSON.stringify({ type: "revision", createdAt: new Date(BASE_MS).toISOString(), messages: [JSON.parse(piLine("op-0001", 0))] }),
        ].join("\n") + "\n",
      );
      await writeFile(
        path.join(directory, `${sessionId}.inflight.json`),
        JSON.stringify({ type: "message", role: "assistant" }),
      );
      const imported = await sync(readPiDesktopUsageIncremental);
      expect(imported.usage.records).toHaveLength(1);
      expect(imported.usage.scannedFiles).toBe(1);

      const unchanged = await sync(readPiDesktopUsageIncremental);
      expect(unchanged.stats.unchangedFiles).toBe(1);
    });

    it("新增与删除会话文件触发来源级重建", async () => {
      const directory = await sessionsDir();
      const fileA = path.join(directory, "aaaaaaaa-0000-0000-0000-000000000001.jsonl");
      await writeFile(fileA, piFile(piLine("op-0001", 0)));
      await sync(readPiDesktopUsageIncremental);

      const fileB = path.join(directory, "bbbbbbbb-0000-0000-0000-000000000002.jsonl");
      await writeFile(fileB, piFile(piLine("op-0002", 4000)));
      const grown = await sync(readPiDesktopUsageIncremental);
      expect(grown.stats.rebuilds).toBe(1);
      expect(grown.usage.records).toHaveLength(2);

      await rm(fileA);
      const shrunk = await sync(readPiDesktopUsageIncremental);
      expect(shrunk.stats.rebuilds).toBe(1);
      expect(shrunk.usage.records).toHaveLength(1);
      expect(shrunk.usage.records[0]?.requestId).toBe("op-0002");
    });

    it("项目标签取自 pi.sqlite 只读映射；重贴标签与改名都不重读会话文件", async () => {
      const directory = await sessionsDir();
      const sessionA = "aaaaaaaa-0000-0000-0000-000000000001";
      const sessionB = "bbbbbbbb-0000-0000-0000-000000000002";
      await writeFile(path.join(directory, `${sessionA}.jsonl`), piSessionFile(sessionA, piLine("op-0001", 0)));
      await writeFile(path.join(directory, `${sessionB}.jsonl`), piSessionFile(sessionB, piLine("op-0002", 4000)));
      const imported = await sync(readPiDesktopUsageIncremental);
      expect(imported.usage.records.every((record) => record.project === "未知项目")).toBe(true);

      // pi.sqlite 补上项目映射（应用先写转录、后补库行的真实时序）。
      await writeProjectDatabase({ [sessionA]: "y-token-panel", [sessionB]: "VideoLingo" });
      const relabeled = await sync(readPiDesktopUsageIncremental);
      expect(relabeled.stats).toMatchObject({
        unchangedFiles: 2,
        bodyBytesRead: 0,
        incrementalFilesRead: 0,
      });
      expect(
        relabeled.usage.records.map((record) => [record.requestId, record.project]),
      ).toEqual(
        expect.arrayContaining([
          ["op-0001", "y-token-panel"],
          ["op-0002", "VideoLingo"],
        ]),
      );
      expect(
        store.readNormalizedRecords("pidesktop").every((record) => record.project !== "未知项目"),
      ).toBe(true);
      const baseline = await readPiDesktopUsage();
      expect(relabeled.usage.records).toEqual(baseline.records);

      // 应用内项目改名：同样零文件重读。
      await writeProjectDatabase({ [sessionA]: "renamed", [sessionB]: "VideoLingo" });
      const renamed = await sync(readPiDesktopUsageIncremental);
      expect(renamed.stats.bodyBytesRead).toBe(0);
      expect(renamed.usage.records.find((record) => record.requestId === "op-0001")?.project).toBe(
        "renamed",
      );

      // 库暂时不可读：保留已入库标签，不回退未知项目。
      await rm(path.join(root, "pi-desktop", "pi.sqlite"));
      const kept = await sync(readPiDesktopUsageIncremental);
      expect(kept.stats.bodyBytesRead).toBe(0);
      expect(kept.usage.records.find((record) => record.requestId === "op-0001")?.project).toBe(
        "renamed",
      );
    });
  });
});
