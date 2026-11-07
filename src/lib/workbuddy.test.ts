import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readWorkBuddyUsage } from "@/lib/workbuddy";
import {
  parseWorkBuddySession,
  workbuddyCacheCreationTokens,
  workbuddyCacheReadTokens,
  workbuddyProjectLabel,
  type WorkBuddySessionRecord,
} from "@/lib/workbuddy-session";

/**
 * fixture 取自本机 ~/.workbuddy/projects 的真实记录形态（deepseek-v4.1-flash
 * 的 function_call 行，见 workbuddy-session.ts 文件头的字段考古）。
 */
const BASE_MS = 1_789_314_000_000;

function userMessage(overrides: Partial<WorkBuddySessionRecord> = {}): WorkBuddySessionRecord {
  return {
    id: "3a9c3121-f3f5-4d57-ad2b-2ebd4cb17581",
    parentId: null,
    timestamp: BASE_MS,
    type: "message",
    role: "user",
    sessionId: "cc8799da-e917-4f3b-9fe7-d98480b17157",
    cwd: "c:\\Users\\YXLMz\\code\\anynote",
    content: [{ type: "input_text", text: "重构前端" }],
    ...overrides,
  };
}

function functionCall(overrides: Partial<WorkBuddySessionRecord> = {}): WorkBuddySessionRecord {
  return {
    id: "09614b72e0da4e3b9cab93eb8a9534b8",
    parentId: "3a9c3121-f3f5-4d57-ad2b-2ebd4cb17581",
    timestamp: BASE_MS + 5_000,
    type: "function_call",
    callId: "call_01_3e3Fh4BNiDIHfqWFv4KH9433",
    name: "Bash",
    arguments: "{}",
    sessionId: "cc8799da-e917-4f3b-9fe7-d98480b17157",
    cwd: "c:\\Users\\YXLMz\\code\\anynote",
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
      requestModelId: "deepseek-v4.1-flash",
      requestModelName: "Deepseek-V4.1-Flash",
      traceId: "954a41117ea24818ba3955392515a2ed",
      conversationRequestId: "954a41117ea24818ba3955392515a2ed",
      agent: "cli",
      rawUsage: {
        prompt_tokens: 59_145,
        completion_tokens: 992,
        total_tokens: 60_137,
        completion_tokens_details: { reasoning_tokens: 798, cached_tokens: 0 },
        prompt_tokens_details: { cached_tokens: 6_400 },
        prompt_cache_hit_tokens: 6_400,
        prompt_cache_miss_tokens: 52_745,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        prompt_cache_write_tokens: 0,
        credit: 0.81,
      },
      usage: {
        requests: 1,
        inputTokens: 59_145,
        outputTokens: 992,
        totalTokens: 60_137,
        inputTokensDetails: [{ cached_tokens: 6_400 }],
        outputTokensDetails: [{ reasoning_tokens: 798 }],
      },
    },
    ...overrides,
  };
}

function jsonl(...items: unknown[]): string {
  return items.map((item) => JSON.stringify(item)).join("\n") + "\n";
}

describe("workbuddyCacheReadTokens（对齐 UsageUtils.getCacheReadTokens 回退链）", () => {
  it("按 cache_read_input_tokens → cacheReadInputTokens → inputTokensDetails → prompt_tokens_details.cached_tokens → prompt_cache_hit_tokens 取第一个正数", () => {
    // 官方实现取第一个「有限正数」，0 / 负数 / 缺失都跳过。
    expect(workbuddyCacheReadTokens({ cache_read_input_tokens: 7 })).toBe(7);
    expect(workbuddyCacheReadTokens({ cache_read_input_tokens: 0, cacheReadInputTokens: 8 })).toBe(8);
    expect(
      workbuddyCacheReadTokens({ inputTokensDetails: [{ cached_tokens: 100 }, { cached_tokens: 50 }] }),
    ).toBe(150);
    expect(workbuddyCacheReadTokens({ inputTokensDetails: { cached_tokens: 9 } })).toBe(9);
    expect(
      workbuddyCacheReadTokens({ prompt_tokens_details: { cached_tokens: 11 } }),
    ).toBe(11);
    expect(workbuddyCacheReadTokens({ prompt_cache_hit_tokens: 12 })).toBe(12);
    expect(workbuddyCacheReadTokens(undefined)).toBe(0);
    expect(workbuddyCacheReadTokens({})).toBe(0);
  });

  it("rawUsage 里的 anthropic 风格字段优先于 OpenAI 风格字段", () => {
    expect(
      workbuddyCacheReadTokens({
        cache_read_input_tokens: 3_156_48,
        prompt_tokens_details: { cached_tokens: 1 },
        prompt_cache_hit_tokens: 2,
      }),
    ).toBe(3_156_48);
  });
});

describe("workbuddyCacheCreationTokens（对齐 getCacheCreationTokens 回退链）", () => {
  it("cache_creation_input_tokens → cacheCreationInputTokens → prompt_cache_write_tokens → prompt_cache_miss_tokens", () => {
    expect(workbuddyCacheCreationTokens({ cache_creation_input_tokens: 5 })).toBe(5);
    expect(workbuddyCacheCreationTokens({ cacheCreationInputTokens: 6 })).toBe(6);
    expect(workbuddyCacheCreationTokens({ prompt_cache_write_tokens: 7 })).toBe(7);
    // DeepSeek 风格的 cache miss 在官方口径里计入缓存写入。
    expect(workbuddyCacheCreationTokens({ prompt_cache_miss_tokens: 52_745 })).toBe(52_745);
    expect(workbuddyCacheCreationTokens(undefined)).toBe(0);
  });
});

describe("workbuddyProjectLabel", () => {
  it("取 cwd 最后一段，正反斜杠与结尾分隔符都能处理", () => {
    expect(workbuddyProjectLabel("c:\\Users\\YXLMz\\code\\anynote")).toBe("anynote");
    expect(workbuddyProjectLabel("D:/code/y-token-panel/")).toBe("y-token-panel");
    expect(workbuddyProjectLabel("D:\\code")).toBe("code");
    expect(workbuddyProjectLabel("")).toBeUndefined();
    expect(workbuddyProjectLabel(undefined)).toBeUndefined();
  });
});

describe("parseWorkBuddySession", () => {
  it("解析真实形态的 function_call 行：token / 缓存 / credit / 模型 / 项目", () => {
    const records = parseWorkBuddySession(
      jsonl(userMessage(), functionCall()),
      "cc8799da-e917-4f3b-9fe7-d98480b17157.jsonl",
    );
    expect(records).toHaveLength(1);
    const record = records[0];
    // inputTokens 是含缓存的总输入（官方 getCurrentContextUsage 语义）。
    expect(record.inputTokens).toBe(59_145);
    expect(record.outputTokens).toBe(992);
    expect(record.totalTokens).toBe(60_137);
    expect(record.cacheReadTokens).toBe(6_400);
    // 官方 getCacheCreationTokens 回退链：前两位是 0 时落到
    // prompt_cache_miss_tokens（DeepSeek 风格 cache miss 计入缓存写入）。
    expect(record.cacheCreationTokens).toBe(52_745);
    expect(record.inputTokenSemantics).toBe("total");
    expect(record.credits).toBe(0.81);
    expect(record.hasCredit).toBe(true);
    expect(record.model).toBe("deepseek-v4.1-flash");
    expect(record.provider).toBe("DeepSeek");
    expect(record.project).toBe("anynote");
    expect(record.sessionId).toBe("cc8799da-e917-4f3b-9fe7-d98480b17157");
    expect(record.requestId).toBe("954a41117ea24818ba3955392515a2ed");
    expect(record.id).toBe(
      "workbuddy:cc8799da-e917-4f3b-9fe7-d98480b17157:09614b72e0da4e3b9cab93eb8a9534b8",
    );
    expect(record.status).toBe("success");
    expect(record.timestamp).toBe(BASE_MS + 5_000);
    // 沿父链回溯到 user 消息（请求边界）：5000ms 含首字等待。
    expect(record.estimatedDurationMs).toBe(5_000);
  });

  it("同一 id 先落无 usage 行、后补带 usage 行：后行覆盖（官方 loadLane 口径）", () => {
    const initial = functionCall({ message: undefined, providerData: undefined, timestamp: BASE_MS + 1_000 });
    const enriched = functionCall();
    const records = parseWorkBuddySession(
      jsonl(userMessage(), initial, enriched),
      "s.jsonl",
    );
    expect(records).toHaveLength(1);
    expect(records[0].inputTokens).toBe(59_145);
    expect(records[0].timestamp).toBe(BASE_MS + 5_000);
  });

  it("model-usage 事实条目与内联条目按 messageId 去重，只计一次", () => {
    // Responses API 路径：用量先落 model-usage 事实条目，最后一条响应条目
    // 补全 usage 后，两者共用 messageId —— 官方按 message:<messageId> 只计一次。
    const modelUsage: WorkBuddySessionRecord = {
      id: "fact-1",
      parentId: "3a9c3121-f3f5-4d57-ad2b-2ebd4cb17581",
      timestamp: BASE_MS + 4_000,
      type: "model-usage",
      sessionId: "cc8799da-e917-4f3b-9fe7-d98480b17157",
      cwd: "c:\\Users\\YXLMz\\code\\anynote",
      providerData: {
        messageId: "resp-msg-1",
        model: "gpt-6.1",
        conversationRequestId: "req-9",
        usage: {
          requests: 1,
          inputTokens: 2_000,
          outputTokens: 100,
          totalTokens: 2_100,
          inputTokensDetails: [{ cached_tokens: 1_500 }],
        },
        rawUsage: { prompt_tokens: 2_000, total_tokens: 2_100, credit: 0.5 },
      },
    };
    const inline = functionCall({
      id: "resp-msg-1",
      parentId: "fact-1",
      timestamp: BASE_MS + 4_500,
      message: undefined,
      // 真实形态：缓存分量由 rawUsage 携带（官方对 rawUsage 整体取用，
      // 不与归一化 usage 的明细合并），归一化 usage 只是派生视图。
      providerData: {
        messageId: "resp-msg-1",
        model: "gpt-6.1",
        conversationRequestId: "req-9",
        usage: {
          requests: 1,
          inputTokens: 2_000,
          outputTokens: 100,
          totalTokens: 2_100,
          inputTokensDetails: [{ cached_tokens: 1_500 }],
        },
        rawUsage: {
          prompt_tokens: 2_000,
          completion_tokens: 100,
          total_tokens: 2_100,
          prompt_tokens_details: { cached_tokens: 1_500 },
          credit: 0.5,
        },
      },
    });
    const records = parseWorkBuddySession(
      jsonl(userMessage(), modelUsage, inline),
      "s.jsonl",
    );
    expect(records).toHaveLength(1);
    // 后行（内联条目）胜出。
    expect(records[0].id.endsWith("resp-msg-1")).toBe(true);
    expect(records[0].credits).toBe(0.5);
    expect(records[0].cacheReadTokens).toBe(1_500);
  });

  it("非 usage 条目（user 消息 / reasoning / function_call_result / session-meta / ai-title）不产出记录", () => {
    const lines: WorkBuddySessionRecord[] = [
      userMessage(),
      {
        id: "reasoning-1",
        parentId: "3a9c3121-f3f5-4d57-ad2b-2ebd4cb17581",
        timestamp: BASE_MS + 1_000,
        type: "reasoning",
        sessionId: "s1",
      },
      {
        id: "fcr-1",
        parentId: "09614b72e0da4e3b9cab93eb8a9534b8",
        timestamp: BASE_MS + 6_000,
        type: "function_call_result",
        sessionId: "s1",
      },
      {
        id: "meta-1",
        timestamp: BASE_MS,
        type: "session-meta",
        sessionId: "s1",
        meta: { "codebuddy.ai/hostKind": "unopted" },
      },
      { id: "title-1", timestamp: BASE_MS, type: "ai-title", sessionId: "s1" },
    ];
    expect(parseWorkBuddySession(jsonl(...lines), "s1.jsonl")).toHaveLength(0);
  });

  it("时间戳缺失或非法的 usage 条目丢弃", () => {
    expect(
      parseWorkBuddySession(
        jsonl(functionCall({ timestamp: undefined }), functionCall({ timestamp: "not-a-date" })),
        "s.jsonl",
      ),
    ).toHaveLength(0);
  });

  it("status=failed 与 providerData.error 记为 error；credit 缺失记 hasCredit=false", () => {
    const failed = parseWorkBuddySession(
      jsonl(
        userMessage(),
        functionCall({
          status: "failed",
          providerData: {
            ...functionCall().providerData,
            rawUsage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
          },
        }),
      ),
      "s.jsonl",
    );
    expect(failed[0].status).toBe("error");
    // rawUsage 与 usage 都没有 credit。
    expect(failed[0].hasCredit).toBe(false);
    expect(failed[0].credits).toBe(0);

    const errored = parseWorkBuddySession(
      jsonl(userMessage(), functionCall({ providerData: { ...functionCall().providerData, error: { message: "x" } } })),
      "s.jsonl",
    );
    expect(errored[0].status).toBe("error");
  });

  it("rawUsage 缺 credit 时回退归一化 usage.credit（官方 tryBuildInputUsageDetail 顺序）", () => {
    const records = parseWorkBuddySession(
      jsonl(
        userMessage(),
        functionCall({
          providerData: {
            ...functionCall().providerData,
            usage: {
              requests: 1,
              inputTokens: 100,
              outputTokens: 10,
              totalTokens: 110,
              credit: 0.25,
            },
            rawUsage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
          },
        }),
      ),
      "s.jsonl",
    );
    expect(records[0].credits).toBe(0.25);
    expect(records[0].hasCredit).toBe(true);
  });

  it("服务端上报 credit=0 视为计量完整（hasCredit=true，credits=0）", () => {
    const records = parseWorkBuddySession(
      jsonl(
        userMessage(),
        functionCall({
          providerData: {
            ...functionCall().providerData,
            rawUsage: {
              prompt_tokens: 100,
              completion_tokens: 10,
              total_tokens: 110,
              credit: 0,
            },
          },
        }),
      ),
      "s.jsonl",
    );
    expect(records[0].hasCredit).toBe(true);
    expect(records[0].credits).toBe(0);
  });

  it("message.usage 兜底：providerData 缺失时仍能解析（老版本格式）", () => {
    const legacy = functionCall({ providerData: undefined });
    const records = parseWorkBuddySession(jsonl(userMessage(), legacy), "s.jsonl");
    expect(records).toHaveLength(1);
    expect(records[0].inputTokens).toBe(59_145);
    expect(records[0].outputTokens).toBe(992);
    expect(records[0].cacheReadTokens).toBe(6_400);
    expect(records[0].hasCredit).toBe(false);
  });

  it("项目名：条目自身 cwd 优先，缺失时回退文件级 cwd，再缺回退未知项目", () => {
    // 事实条目（model-usage）没有 cwd → 用文件内其他条目的 cwd。
    const fact: WorkBuddySessionRecord = {
      id: "f1",
      parentId: null,
      timestamp: BASE_MS,
      type: "model-usage",
      providerData: {
        messageId: "m1",
        model: "glm-5.3",
        usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
      },
    };
    const withFileCwd = parseWorkBuddySession(
      jsonl(userMessage({ cwd: "D:\\code\\demo" }), fact),
      "s.jsonl",
    );
    expect(withFileCwd[0].project).toBe("demo");

    const noCwdAnywhere = parseWorkBuddySession(jsonl(fact), "s.jsonl");
    expect(noCwdAnywhere[0].project).toBe("未知项目");
  });

  it("耗时估算：父链穿过同响应内条目直达 function_call_result 边界，成环或断链返回 undefined", () => {
    // user → function_call(无 usage，同响应内) → assistant message(带 usage)。
    const first = functionCall({
      id: "same-resp-1",
      parentId: "3a9c3121-f3f5-4d57-ad2b-2ebd4cb17581",
      timestamp: BASE_MS + 1_000,
      message: undefined,
      providerData: undefined,
    });
    const boundary: WorkBuddySessionRecord = {
      id: "fcr-0",
      parentId: "same-resp-1",
      timestamp: BASE_MS + 2_000,
      type: "function_call_result",
      sessionId: "s1",
    };
    const final = functionCall({
      id: "final-1",
      parentId: "fcr-0",
      timestamp: BASE_MS + 9_000,
    });
    const records = parseWorkBuddySession(
      jsonl(userMessage(), first, boundary, final),
      "s.jsonl",
    );
    expect(records).toHaveLength(1);
    expect(records[0].estimatedDurationMs).toBe(7_000);

    // 断链：父 id 不在文件里。
    const orphan = parseWorkBuddySession(
      jsonl(functionCall({ parentId: "missing-parent" })),
      "s.jsonl",
    );
    expect(orphan[0].estimatedDurationMs).toBeUndefined();
  });

  it("坏行（非法 JSON）与空行跳过，不中断解析", () => {
    const content = [
      "{ not json",
      "",
      JSON.stringify(userMessage()),
      JSON.stringify(functionCall()),
    ].join("\n");
    expect(parseWorkBuddySession(content, "s.jsonl")).toHaveLength(1);
  });
});

describe("readWorkBuddyUsage（fs 遍历）", () => {
  let tempRoot: string;
  const previousDataDir = process.env.WORKBUDDY_DATA_DIR;
  const previousConfigDir = process.env.WORKBUDDY_CONFIG_DIR;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "workbuddy-test-"));
    process.env.WORKBUDDY_DATA_DIR = tempRoot;
    delete process.env.WORKBUDDY_CONFIG_DIR;
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.WORKBUDDY_DATA_DIR;
    else process.env.WORKBUDDY_DATA_DIR = previousDataDir;
    if (previousConfigDir === undefined) delete process.env.WORKBUDDY_CONFIG_DIR;
    else process.env.WORKBUDDY_CONFIG_DIR = previousConfigDir;
    await rm(tempRoot, { recursive: true, force: true });
  });

  async function writeSession(
    relative: string,
    lines: unknown[],
  ): Promise<void> {
    const target = path.join(tempRoot, "projects", relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, jsonl(...lines), "utf8");
  }

  it("主会话 + 子 agent 会话都被读取，agent- 遗留文件与非 jsonl 跳过", async () => {
    await writeSession(
      "c-Users-YXLMz-code-anynote/cc8799da-e917-4f3b-9fe7-d98480b17157.jsonl",
      [userMessage(), functionCall()],
    );
    await writeSession(
      "c-Users-YXLMz-code-anynote/cc8799da-e917-4f3b-9fe7-d98480b17157/subagents/agent-task-1.jsonl",
      [
        userMessage({
          id: "sub-user-1",
          sessionId: "agent-task-1",
          cwd: "c:\\Users\\YXLMz\\code\\anynote",
        }),
        functionCall({
          id: "sub-call-1",
          parentId: "sub-user-1",
          sessionId: "agent-task-1",
          providerData: {
            ...functionCall().providerData,
            messageId: "sub-call-1",
            conversationRequestId: "sub-req-1",
            agent: "task",
          },
        }),
      ],
    );
    // 宿主绑定前的遗留 agent- 文件：官方扫描跳过。
    await writeSession("c-Users-YXLMz-code-anynote/agent-orphan.jsonl", [
      functionCall({ id: "orphan-1" }),
    ]);
    // meta / 回滚文件不是会话记录。
    await writeSession("c-Users-YXLMz-code-anynote/cc8799da.meta.json", [
      { codebuddy: 1 },
    ]);

    const usage = await readWorkBuddyUsage();
    expect(usage.harness).toBe("workbuddy");
    expect(usage.sourceAvailable).toBe(true);
    expect(usage.scannedFiles).toBe(2);
    expect(usage.skippedFiles).toBe(0);
    expect(usage.records).toHaveLength(2);
    expect(usage.records.map((record) => record.sessionId).sort()).toEqual([
      "agent-task-1",
      "cc8799da-e917-4f3b-9fe7-d98480b17157",
    ]);
    // 记录按时间倒序。
    expect(usage.records[0].timestamp).toBeGreaterThanOrEqual(usage.records[1].timestamp);
  });

  it("projects 目录不存在时 sourceAvailable=false，空结果", async () => {
    const usage = await readWorkBuddyUsage();
    expect(usage.sourceAvailable).toBe(false);
    expect(usage.records).toEqual([]);
    expect(usage.scannedFiles).toBe(0);
  });

  it("WORKBUDDY_CONFIG_DIR（官方变量）在 DATA_DIR 未设时生效", async () => {
    delete process.env.WORKBUDDY_DATA_DIR;
    process.env.WORKBUDDY_CONFIG_DIR = tempRoot;
    await writeSession("proj-1/s1.jsonl", [userMessage(), functionCall()]);
    const usage = await readWorkBuddyUsage();
    expect(usage.sourceAvailable).toBe(true);
    expect(usage.records).toHaveLength(1);
  });

  it("同一记录出现在多个文件时按 id 去重", async () => {
    const session = [userMessage(), functionCall()];
    await writeSession("proj-1/cc8799da.jsonl", session);
    await writeSession("proj-2/cc8799da.jsonl", session);
    const usage = await readWorkBuddyUsage();
    expect(usage.records).toHaveLength(1);
  });
});
