import { describe, expect, it } from "vitest";
import {
  codexEventsToRecords,
  codexParentSignaturesBefore,
  codexThreadIdFromFilename,
  codexTimelineFromParsed,
  codexTokenSignature,
  leadingCodexThreadIdFromFilename,
  logicalCodexFileName,
  matchingCodexReplayPrefix,
  normalizeCodexModel,
  normalizeCodexUuid,
  CodexRequestTimer,
  CodexRolloutIntegrityError,
  parseCodexRollout,
  parseCodexTokenUsage,
  type CodexParsedEvent,
  type CodexTokenUsage,
} from "@/lib/codex-session";

const THREAD_ID = "01a090ff-afe1-7e23-8bf6-d531d4c1c3ce";
const PARENT_ID = "01a0a06c-adbe-73b3-860e-e15bc017f538";

function usage(overrides: Partial<CodexTokenUsage> = {}): CodexTokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    ...overrides,
  };
}

/** rollout 行工厂：字段顺序与本机真实文件一致（timestamp 在信封最前）。 */
function line(
  ordinal: number,
  timestamp: string,
  type: string,
  payload: Record<string, unknown>,
): string {
  return JSON.stringify({ timestamp, ordinal, type, payload });
}

function tokenCountLine(
  ordinal: number,
  timestamp: string,
  info: Record<string, unknown>,
  rateLimits: Record<string, unknown> = { limit_id: "codex" },
): string {
  return line(ordinal, timestamp, "event_msg", {
    type: "token_count",
    info,
    rate_limits: rateLimits,
  });
}

function tokenUsageFields(value: CodexTokenUsage): Record<string, number> {
  return {
    input_tokens: value.inputTokens,
    cached_input_tokens: value.cachedInputTokens,
    cache_write_input_tokens: value.cacheWriteInputTokens,
    output_tokens: value.outputTokens,
    reasoning_output_tokens: value.reasoningOutputTokens,
    total_tokens: value.totalTokens,
  };
}

const sessionMeta = (overrides: Record<string, unknown> = {}) =>
  line(0, "2026-11-01T10:00:00.000Z", "session_meta", {
    id: THREAD_ID,
    cwd: "D:\\code\\demo",
    originator: "codex_cli",
    ...overrides,
  });

describe("文件名与 UUID 工具", () => {
  it("codexThreadIdFromFilename 取尾部 UUID，.zst 形态同样支持", () => {
    expect(
      codexThreadIdFromFilename(`rollout-2026-11-01T10-00-00-${THREAD_ID}.jsonl`),
    ).toBe(THREAD_ID);
    expect(
      codexThreadIdFromFilename(`rollout-2026-11-01T10-00-00-${THREAD_ID}.jsonl.zst`),
    ).toBe(THREAD_ID);
    expect(
      codexThreadIdFromFilename("rollout-2026-11-01T10-00-00-not-a-uuid.jsonl"),
    ).toBeUndefined();
    expect(codexThreadIdFromFilename("notes.jsonl")).toBeUndefined();
  });

  it("双段文件名提取下划线前的线程本体 UUID", () => {
    const name = `rollout-2026-11-01T10-00-00-${PARENT_ID}_${THREAD_ID}.jsonl`;
    expect(leadingCodexThreadIdFromFilename(name)).toBe(PARENT_ID);
    expect(codexThreadIdFromFilename(name)).toBe(THREAD_ID);
    // 单段文件名没有前置线程 UUID
    expect(
      leadingCodexThreadIdFromFilename(`rollout-2026-11-01T10-00-00-${THREAD_ID}.jsonl`),
    ).toBeUndefined();
  });

  it("normalizeCodexUuid 归一大小写与 32 位紧凑写法", () => {
    expect(normalizeCodexUuid(THREAD_ID.toUpperCase())).toBe(THREAD_ID);
    expect(normalizeCodexUuid(THREAD_ID.replace(/-/g, ""))).toBe(THREAD_ID);
    expect(normalizeCodexUuid("zzzz")).toBeUndefined();
  });

  it("logicalCodexFileName 去掉 .zst 后缀", () => {
    expect(logicalCodexFileName("a/b.jsonl.zst")).toBe("b.jsonl");
    expect(logicalCodexFileName("a\\b.jsonl")).toBe("b.jsonl");
    expect(logicalCodexFileName("b.zst")).toBe("b.zst");
  });
});

describe("normalizeCodexModel", () => {
  it("转小写、剥 provider 前缀", () => {
    expect(normalizeCodexModel("GLM-4.6")).toBe("glm-4.6");
    expect(normalizeCodexModel("openai/gpt-5.4")).toBe("gpt-5.4");
    expect(normalizeCodexModel("azure/o3-pro")).toBe("o3-pro");
  });

  it("剥 ISO 日期与紧凑日期后缀", () => {
    expect(normalizeCodexModel("gpt-5.4-2026-03-05")).toBe("gpt-5.4");
    expect(normalizeCodexModel("gpt-5.4-20260305")).toBe("gpt-5.4");
    // 版本号里的数字段不是日期
    expect(normalizeCodexModel("gpt-5.4")).toBe("gpt-5.4");
  });
});

describe("parseCodexTokenUsage / codexTokenSignature", () => {
  it("至少含一个已知 token 字段才解析，缺失字段按 0 补", () => {
    expect(parseCodexTokenUsage({})).toBeUndefined();
    expect(parseCodexTokenUsage({ unrelated: 1 })).toBeUndefined();
    expect(parseCodexTokenUsage(null)).toBeUndefined();
    expect(parseCodexTokenUsage({ input_tokens: 10 })).toEqual(
      usage({ inputTokens: 10 }),
    );
  });

  it("cached_input_tokens 优先，cache_read_input_tokens 是旧别名", () => {
    expect(
      parseCodexTokenUsage({ input_tokens: 10, cache_read_input_tokens: 4 }),
    ).toEqual(usage({ inputTokens: 10, cachedInputTokens: 4 }));
    expect(
      parseCodexTokenUsage({
        input_tokens: 10,
        cached_input_tokens: 3,
        cache_read_input_tokens: 4,
      }),
    ).toEqual(usage({ inputTokens: 10, cachedInputTokens: 3 }));
  });

  it("非负整数字段才计入，其他形态视为缺失", () => {
    expect(parseCodexTokenUsage({ input_tokens: -1 })).toEqual(usage());
    expect(parseCodexTokenUsage({ input_tokens: 1.5 })).toEqual(usage());
    expect(parseCodexTokenUsage({ input_tokens: "12" })).toEqual(usage());
  });

  it("签名字段缺失与 0 是不同的值", () => {
    const withInput = codexTokenSignature({ total_token_usage: { input_tokens: 0 } });
    const empty = codexTokenSignature({ total_token_usage: {} });
    expect(withInput).not.toBe(empty);
    expect(withInput).toContain("0,");
    expect(empty).toContain("null,");
    // total / last 两组都没有时没有签名
    expect(codexTokenSignature({ unrelated: 1 })).toBeUndefined();
    expect(codexTokenSignature({})).toBeUndefined();
  });
});

describe("parseCodexRollout 主路径", () => {
  it("优先 last_token_usage：fresh 输入、缓存单列、模型与项目归因", () => {
    const u1 = usage({
      inputTokens: 28292,
      cachedInputTokens: 18944,
      outputTokens: 162,
      reasoningOutputTokens: 50,
      totalTokens: 28454,
    });
    const content = [
      sessionMeta(),
      line(1, "2026-11-01T10:00:01.000Z", "turn_context", {
        turn_id: "t1",
        cwd: "D:\\code\\demo",
        model: "GPT-6-Astra",
      }),
      line(2, "2026-11-01T10:00:02.000Z", "token_usage_record", {
        response_id: "resp_1",
        usage: tokenUsageFields(u1),
      }),
      tokenCountLine(3, "2026-11-01T10:00:14.000Z", {
        total_token_usage: tokenUsageFields(u1),
        last_token_usage: tokenUsageFields(u1),
        model_context_window: 258400,
      }),
    ].join("\n");
    const parsed = parseCodexRollout(content, {
      filenameThreadId: THREAD_ID,
    });
    expect(parsed.meta.threadId).toBe(THREAD_ID);
    expect(parsed.tokenEvents).toHaveLength(1);
    const event = parsed.tokenEvents[0];
    expect(event.delta).toEqual({
      inputTokens: 28292,
      cachedInputTokens: 18944,
      cacheWriteInputTokens: 0,
      outputTokens: 162,
    });
    expect(event.model).toBe("gpt-6-astra");
    expect(event.cwd).toBe("D:\\code\\demo");
    expect(parsed.usageRecordEvents).toHaveLength(0);

    const [record] = codexEventsToRecords(event ? [event] : [], {
      rolloutId: THREAD_ID,
      sessionId: THREAD_ID,
    });
    expect(record).toMatchObject({
      harness: "codex",
      project: "demo",
      model: "gpt-6-astra",
      provider: "OpenAI",
      inputTokens: 28292 - 18944,
      cacheReadTokens: 18944,
      cacheCreationTokens: 0,
      outputTokens: 162,
      totalTokens: 28454,
      inputTokenSemantics: "fresh",
      hasTokenUsage: true,
      credits: 0,
      hasCredit: false,
      status: "success",
    });
  });

  it("last_token_usage 缺失时按 total_token_usage 累计差推", () => {
    const content = [
      sessionMeta(),
      tokenCountLine(1, "2026-11-01T10:00:10.000Z", {
        total_token_usage: tokenUsageFields(usage({ inputTokens: 1000, outputTokens: 100, totalTokens: 1100 })),
      }),
      tokenCountLine(2, "2026-11-01T10:00:30.000Z", {
        total_token_usage: tokenUsageFields(
          usage({ inputTokens: 3000, cachedInputTokens: 2000, outputTokens: 300, totalTokens: 3300 }),
        ),
      }),
    ].join("\n");
    const parsed = parseCodexRollout(content, { filenameThreadId: THREAD_ID });
    expect(parsed.tokenEvents.map((event) => event.delta)).toEqual([
      { inputTokens: 1000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 100 },
      { inputTokens: 2000, cachedInputTokens: 2000, cacheWriteInputTokens: 0, outputTokens: 200 },
    ]);
  });

  it("缓存读与写夹进 input 的不相交份额", () => {
    const content = [
      sessionMeta(),
      tokenCountLine(1, "2026-11-01T10:00:10.000Z", {
        last_token_usage: tokenUsageFields(
          usage({ inputTokens: 1000, cachedInputTokens: 900, cacheWriteInputTokens: 200, outputTokens: 10 }),
        ),
      }),
    ].join("\n");
    const parsed = parseCodexRollout(content, { filenameThreadId: THREAD_ID });
    // cached=900，cache_write 只能占剩下 100
    expect(parsed.tokenEvents[0].delta).toEqual({
      inputTokens: 1000,
      cachedInputTokens: 900,
      cacheWriteInputTokens: 100,
      outputTokens: 10,
    });
  });

  it("限额刷新重发的相同快照去重（同源与跨源）", () => {
    const u1 = usage({ inputTokens: 1000, outputTokens: 100, totalTokens: 1100 });
    const content = [
      sessionMeta(),
      tokenCountLine(1, "2026-11-01T10:00:10.000Z", {
        total_token_usage: tokenUsageFields(u1),
        last_token_usage: tokenUsageFields(u1),
      }),
      // 同源重发
      tokenCountLine(2, "2026-11-01T10:00:11.000Z", {
        total_token_usage: tokenUsageFields(u1),
        last_token_usage: tokenUsageFields(u1),
      }),
      // 跨源（别的 limit_id）重发
      tokenCountLine(3, "2026-11-01T10:00:12.000Z", {
        total_token_usage: tokenUsageFields(u1),
        last_token_usage: tokenUsageFields(u1),
      }, { limit_id: "premium" }),
    ].join("\n");
    const parsed = parseCodexRollout(content, { filenameThreadId: THREAD_ID });
    expect(parsed.tokenEvents).toHaveLength(3);
    expect(parsed.tokenEvents[0].delta).not.toBeNull();
    expect(parsed.tokenEvents[1].delta).toBeNull();
    expect(parsed.tokenEvents[2].delta).toBeNull();
    const records = codexEventsToRecords(parsed.tokenEvents, {
      rolloutId: THREAD_ID,
      sessionId: THREAD_ID,
    });
    expect(records).toHaveLength(1);
  });

  it("token_usage_record 与 token_count.last 一致时不双计", () => {
    const u1 = usage({ inputTokens: 500, outputTokens: 50, totalTokens: 550 });
    const content = [
      sessionMeta(),
      line(1, "2026-11-01T10:00:05.000Z", "token_usage_record", {
        response_id: "resp_1",
        usage: tokenUsageFields(u1),
      }),
      tokenCountLine(2, "2026-11-01T10:00:06.000Z", {
        total_token_usage: tokenUsageFields(u1),
        last_token_usage: tokenUsageFields(u1),
      }),
    ].join("\n");
    const parsed = parseCodexRollout(content, { filenameThreadId: THREAD_ID });
    expect(parsed.usageRecordEvents).toHaveLength(0);
    expect(parsed.tokenEvents[0].delta).toEqual({
      inputTokens: 500,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 50,
    });
  });

  it("远程压缩：token_count.last 全 0 时按 token_usage_record 补记", () => {
    const u1 = usage({ inputTokens: 500, cachedInputTokens: 100, outputTokens: 50, totalTokens: 550 });
    const content = [
      sessionMeta(),
      line(1, "2026-11-01T10:00:05.000Z", "token_usage_record", {
        response_id: "resp_9",
        usage: tokenUsageFields(u1),
      }),
      tokenCountLine(2, "2026-11-01T10:00:06.000Z", {
        total_token_usage: tokenUsageFields(u1),
        last_token_usage: tokenUsageFields(usage()),
      }),
    ].join("\n");
    const parsed = parseCodexRollout(content, { filenameThreadId: THREAD_ID });
    // token_count 自身按 last 计出全 0 增量（不是重复快照的 null），没有 requestKey
    expect(parsed.tokenEvents[0].delta).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
    });
    expect(parsed.tokenEvents[0].requestKey).toBeUndefined();
    expect(parsed.usageRecordEvents).toHaveLength(1);
    expect(
      codexEventsToRecords(parsed.tokenEvents, {
        rolloutId: THREAD_ID,
        sessionId: THREAD_ID,
      }),
    ).toHaveLength(0);
    const [record] = codexEventsToRecords(parsed.usageRecordEvents, {
      rolloutId: THREAD_ID,
      sessionId: THREAD_ID,
    });
    expect(record.requestId).toContain("usage:resp_9");
    expect(record.inputTokens).toBe(400);
    expect(record.cacheReadTokens).toBe(100);
  });

  it("全 0 的 token_usage_record 不补记", () => {
    const content = [
      sessionMeta(),
      line(1, "2026-11-01T10:00:05.000Z", "token_usage_record", {
        response_id: "resp_0",
        usage: tokenUsageFields(usage()),
      }),
      tokenCountLine(2, "2026-11-01T10:00:06.000Z", {
        last_token_usage: tokenUsageFields(usage()),
      }),
    ].join("\n");
    const parsed = parseCodexRollout(content, { filenameThreadId: THREAD_ID });
    expect(parsed.usageRecordEvents).toHaveLength(0);
    expect(parsed.hasBillableTokens).toBe(false);
  });

  it("fork 文件复制的第二条 session_meta 不覆盖第一条", () => {
    const content = [
      sessionMeta({ forked_from_id: PARENT_ID }),
      line(1, "2026-11-01T10:00:00.200Z", "session_meta", {
        id: PARENT_ID,
        cwd: "D:\\other",
        source: "vscode",
      }),
      tokenCountLine(2, "2026-11-01T10:00:10.000Z", {
        last_token_usage: tokenUsageFields(usage({ inputTokens: 10, outputTokens: 1, totalTokens: 11 })),
      }),
    ].join("\n");
    const parsed = parseCodexRollout(content, { filenameThreadId: THREAD_ID });
    expect(parsed.meta.threadId).toBe(THREAD_ID);
    expect(parsed.meta.parentThreadId).toBe(PARENT_ID);
    // 第二条 meta 的 cwd 不影响项目归因
    expect(parsed.tokenEvents[0].cwd).toBe("D:\\code\\demo");
  });

  it("thread_settings_applied 更新模型归因（resume 后改模型）", () => {
    const content = [
      sessionMeta(),
      line(1, "2026-11-01T10:00:01.000Z", "turn_context", { model: "gpt-6-astra" }),
      tokenCountLine(2, "2026-11-01T10:00:10.000Z", {
        last_token_usage: tokenUsageFields(usage({ inputTokens: 10, outputTokens: 1, totalTokens: 11 })),
      }),
      line(3, "2026-11-01T10:01:00.000Z", "event_msg", {
        type: "thread_settings_applied",
        thread_settings: { model: "gpt-5.6-sol" },
      }),
      tokenCountLine(4, "2026-11-01T10:01:10.000Z", {
        last_token_usage: tokenUsageFields(usage({ inputTokens: 20, outputTokens: 2, totalTokens: 22 })),
      }),
    ].join("\n");
    const parsed = parseCodexRollout(content, { filenameThreadId: THREAD_ID });
    expect(parsed.tokenEvents.map((event) => event.model)).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol",
    ]);
  });

  it("token_count 上的模型覆盖 turn_context", () => {
    const content = [
      sessionMeta(),
      line(1, "2026-11-01T10:00:01.000Z", "turn_context", { model: "gpt-6-astra" }),
      tokenCountLine(2, "2026-11-01T10:00:10.000Z", {
        model: "gpt-5.6-sol",
        last_token_usage: tokenUsageFields(usage({ inputTokens: 10, outputTokens: 1, totalTokens: 11 })),
      }),
    ].join("\n");
    const parsed = parseCodexRollout(content, { filenameThreadId: THREAD_ID });
    expect(parsed.tokenEvents[0].model).toBe("gpt-5.6-sol");
  });
});

describe("parseCodexRollout 完整性防御", () => {
  const usageLine = tokenCountLine(2, "2026-11-01T10:00:10.000Z", {
    last_token_usage: tokenUsageFields(usage({ inputTokens: 10, outputTokens: 1, totalTokens: 11 })),
  });

  it("文件名线程 ID 与 root meta ID 不一致时抛出", () => {
    const content = [sessionMeta(), usageLine].join("\n");
    expect(() =>
      parseCodexRollout(content, {
        filenameThreadId: PARENT_ID,
      }),
    ).toThrow(CodexRolloutIntegrityError);
  });

  it("双段文件名的前置 UUID 与 meta 一致时通过", () => {
    const content = [
      sessionMeta({ history_mode: "paginated" }),
      usageLine,
    ].join("\n");
    expect(() =>
      parseCodexRollout(content, {
        filenameThreadId: THREAD_ID,
        filenameLeadingThreadId: PARENT_ID,
      }),
    ).not.toThrow();
  });

  it("parent_thread_id 指向文件名线程时抛出（自我引用）", () => {
    const content = [
      sessionMeta({ forked_from_id: THREAD_ID }),
      usageLine,
    ].join("\n");
    expect(() =>
      parseCodexRollout(content, { filenameThreadId: THREAD_ID }),
    ).toThrow(CodexRolloutIntegrityError);
  });

  it("parent_thread_id 不是 UUID 时抛出", () => {
    const content = [
      sessionMeta({ forked_from_id: "not-a-uuid" }),
      usageLine,
    ].join("\n");
    expect(() =>
      parseCodexRollout(content, { filenameThreadId: THREAD_ID }),
    ).toThrow(CodexRolloutIntegrityError);
  });

  it("forked_from_id 与 thread_spawn.parent_thread_id 不一致时抛出", () => {
    const content = [
      sessionMeta({
        forked_from_id: PARENT_ID,
        source: {
          subagent: {
            thread_spawn: { parent_thread_id: THREAD_ID, depth: 1 },
          },
        },
      }),
      usageLine,
    ].join("\n");
    expect(() =>
      parseCodexRollout(content, { filenameThreadId: THREAD_ID }),
    ).toThrow(CodexRolloutIntegrityError);
  });

  it("thread_spawn 与 forked_from_id 一致时识别为父线程", () => {
    const content = [
      sessionMeta({
        forked_from_id: PARENT_ID,
        source: {
          subagent: {
            thread_spawn: { parent_thread_id: PARENT_ID, depth: 1 },
          },
        },
      }),
      usageLine,
    ].join("\n");
    const parsed = parseCodexRollout(content, { filenameThreadId: THREAD_ID });
    expect(parsed.meta.parentThreadId).toBe(PARENT_ID);
  });
});

describe("parseCodexRollout 续写页基线", () => {
  const inherited = usage({
    inputTokens: 8_836_623,
    cachedInputTokens: 8_627_456,
    outputTokens: 21_235,
    totalTokens: 8_857_858,
  });
  const ownFirst = usage({ inputTokens: 188_546, cachedInputTokens: 19_584, outputTokens: 992, totalTokens: 189_538 });

  /** 双段文件名（<threadId>_<rolloutId>）的续写页 meta。 */
  const continuationMeta = (fileNameThreadId: string) =>
    parseCodexRollout(
      [
        line(0, "2026-11-01T11:00:00.000Z", "session_meta", {
          id: PARENT_ID,
          cwd: "D:\\code\\demo",
          history_mode: "paginated",
          history_base: { thread_id: PARENT_ID },
        }),
        // 续写页首条 token_count 只有继承来的累计，没有 last
        tokenCountLine(1, "2026-11-01T11:00:10.000Z", {
          total_token_usage: tokenUsageFields(
            usage({
              inputTokens: inherited.inputTokens + ownFirst.inputTokens,
              cachedInputTokens: inherited.cachedInputTokens + ownFirst.cachedInputTokens,
              outputTokens: inherited.outputTokens + ownFirst.outputTokens,
              totalTokens: inherited.totalTokens + ownFirst.totalTokens,
            }),
          ),
        }),
      ].join("\n"),
      { filenameThreadId: fileNameThreadId, filenameLeadingThreadId: PARENT_ID },
    );

  it("没有基线时继承的累计会被当成一次请求（防御不生效的对照组）", () => {
    const parsed = continuationMeta(THREAD_ID);
    const event = parsed.tokenEvents[0];
    expect(event.delta?.inputTokens).toBe(
      inherited.inputTokens + ownFirst.inputTokens,
    );
  });

  it("带基线解析时只计自身增量", () => {
    const parsed = parseCodexRollout(
      [
        line(0, "2026-11-01T11:00:00.000Z", "session_meta", {
          id: PARENT_ID,
          cwd: "D:\\code\\demo",
          history_mode: "paginated",
          history_base: { thread_id: PARENT_ID },
        }),
        tokenCountLine(1, "2026-11-01T11:00:10.000Z", {
          total_token_usage: tokenUsageFields(
            usage({
              inputTokens: inherited.inputTokens + ownFirst.inputTokens,
              cachedInputTokens: inherited.cachedInputTokens + ownFirst.cachedInputTokens,
              outputTokens: inherited.outputTokens + ownFirst.outputTokens,
              totalTokens: inherited.totalTokens + ownFirst.totalTokens,
            }),
          ),
        }),
      ].join("\n"),
      {
        filenameThreadId: THREAD_ID,
        filenameLeadingThreadId: PARENT_ID,
        resolveContinuationBaseline: () => inherited,
      },
    );
    expect(parsed.tokenEvents[0].delta).toEqual({
      inputTokens: ownFirst.inputTokens,
      cachedInputTokens: ownFirst.cachedInputTokens,
      cacheWriteInputTokens: 0,
      outputTokens: ownFirst.outputTokens,
    });
  });

  it("前序分段缺失时抛出（宁可少算不双算）", () => {
    expect(() =>
      parseCodexRollout(
        [
          line(0, "2026-11-01T11:00:00.000Z", "session_meta", {
            id: PARENT_ID,
            history_mode: "paginated",
            history_base: { thread_id: PARENT_ID },
          }),
          tokenCountLine(1, "2026-11-01T11:00:10.000Z", {
            total_token_usage: tokenUsageFields(inherited),
          }),
        ].join("\n"),
        {
          filenameThreadId: THREAD_ID,
          filenameLeadingThreadId: PARENT_ID,
          resolveContinuationBaseline: () => "missing-parent",
        },
      ),
    ).toThrow(CodexRolloutIntegrityError);
  });

  it("计数器重置（比基线小）时以当前快照为首轮基线", () => {
    const parsed = parseCodexRollout(
      [
        line(0, "2026-11-01T11:00:00.000Z", "session_meta", {
          id: PARENT_ID,
          history_mode: "paginated",
          history_base: { thread_id: PARENT_ID },
        }),
        tokenCountLine(1, "2026-11-01T11:00:10.000Z", {
          total_token_usage: tokenUsageFields(
            usage({ inputTokens: 500, outputTokens: 50, totalTokens: 550 }),
          ),
        }),
      ].join("\n"),
      {
        filenameThreadId: THREAD_ID,
        filenameLeadingThreadId: PARENT_ID,
        resolveContinuationBaseline: () => inherited,
      },
    );
    expect(parsed.tokenEvents[0].delta).toEqual({
      inputTokens: 500,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 50,
    });
  });

  it("history_base 指向自身的单段文件也算续写页", () => {
    const parsed = parseCodexRollout(
      [
        line(0, "2026-11-01T11:00:00.000Z", "session_meta", {
          id: THREAD_ID,
          cwd: "D:\\code\\demo",
          history_base: { thread_id: THREAD_ID },
        }),
        tokenCountLine(1, "2026-11-01T11:00:10.000Z", {
          total_token_usage: tokenUsageFields(usage({ inputTokens: 100, outputTokens: 10, totalTokens: 110 })),
        }),
      ].join("\n"),
      { filenameThreadId: THREAD_ID },
    );
    expect(parsed.meta.isContinuation).toBe(true);
    expect(parsed.meta.parentThreadId).toBeUndefined();
  });

  it("history_base 指向父线程的翻页 fork 不是续写页（保留父线程做重放匹配）", () => {
    const parsed = parseCodexRollout(
      [
        line(0, "2026-11-01T11:00:00.000Z", "session_meta", {
          id: THREAD_ID,
          cwd: "D:\\code\\demo",
          forked_from_id: PARENT_ID,
          history_mode: "paginated",
          history_base: { thread_id: PARENT_ID },
        }),
        tokenCountLine(1, "2026-11-01T11:00:10.000Z", {
          last_token_usage: tokenUsageFields(usage({ inputTokens: 100, outputTokens: 10, totalTokens: 110 })),
        }),
      ].join("\n"),
      { filenameThreadId: THREAD_ID },
    );
    expect(parsed.meta.isContinuation).toBe(false);
    expect(parsed.meta.parentThreadId).toBe(PARENT_ID);
  });
});

describe("matchingCodexReplayPrefix / codexParentSignaturesBefore", () => {
  const events = (signatures: string[]): Array<Pick<CodexParsedEvent, "signatureKey">> =>
    signatures.map((signatureKey) => ({ signatureKey }));

  it("子事件按序匹配父签名序列的前缀数", () => {
    const parent = ["a", "b", "c", "d"];
    expect(matchingCodexReplayPrefix(events(["a", "b"]), parent)).toBe(2);
    // 第一个就对不上：0
    expect(matchingCodexReplayPrefix(events(["x", "b"]), parent)).toBe(0);
    // 中断后不再跳
    expect(matchingCodexReplayPrefix(events(["a", "x", "b"]), parent)).toBe(1);
    // 子序列（跳着匹配）也算
    expect(matchingCodexReplayPrefix(events(["a", "c"]), parent)).toBe(2);
    expect(matchingCodexReplayPrefix(events([]), parent)).toBe(0);
  });

  it("父时间线没写到 fork 时刻或有无时间戳的 token 事件时返回 null", () => {
    const base = { events: [], hasTokenWithoutTimestamp: false, maxLineTimestampMs: 1000 };
    expect(codexParentSignaturesBefore(base, 2000)).toBeNull();
    expect(
      codexParentSignaturesBefore(
        { ...base, maxLineTimestampMs: 3000, hasTokenWithoutTimestamp: true },
        2000,
      ),
    ).toBeNull();
    expect(
      codexParentSignaturesBefore(
        {
          ...base,
          maxLineTimestampMs: 3000,
          events: [
            { timestampMs: 1000, signatureKey: "a" },
            { timestampMs: 2500, signatureKey: "b" },
            { timestampMs: 1500, signatureKey: "c" },
          ],
        },
        2000,
      ),
    ).toEqual(["a", "c"]);
  });

  it("codexTimelineFromParsed 丢弃无时间戳事件并打标记", () => {
    const parsed = parseCodexRollout(
      [
        sessionMeta(),
        tokenCountLine(1, "2026-11-01T10:00:10.000Z", {
          last_token_usage: tokenUsageFields(usage({ inputTokens: 10, outputTokens: 1, totalTokens: 11 })),
        }),
        // 无时间戳的 token_count：信封缺 timestamp 字段
        JSON.stringify({
          ordinal: 2,
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: tokenUsageFields(usage({ inputTokens: 20, outputTokens: 2, totalTokens: 22 })),
            },
          },
        }),
      ].join("\n"),
      { filenameThreadId: THREAD_ID },
    );
    const timeline = codexTimelineFromParsed(parsed);
    expect(timeline.hasTokenWithoutTimestamp).toBe(true);
    expect(timeline.events).toHaveLength(1);
    expect(timeline.maxLineTimestampMs).toBe(Date.parse("2026-11-01T10:00:10.000Z"));
  });
});

describe("CodexRequestTimer", () => {
  const ts = (seconds: number) =>
    `2026-11-01T10:00:${String(seconds).padStart(2, "0")}.000Z`;
  const ms = (seconds: number, millis: number) =>
    `2026-11-01T10:00:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}Z`;
  const at = (seconds: number, millis = 0) => Date.parse(ms(seconds, millis));

  const userMessage = (ordinal: number, time: string) =>
    line(ordinal, time, "response_item", { type: "message", role: "user" });
  const assistantMessage = (ordinal: number, time: string) =>
    line(ordinal, time, "response_item", { type: "message", role: "assistant" });
  const reasoning = (ordinal: number, time: string) =>
    line(ordinal, time, "response_item", { type: "reasoning" });
  const toolOutput = (ordinal: number, time: string) =>
    line(ordinal, time, "response_item", { type: "function_call_output" });
  const tokenCountAt = (ordinal: number, time: string) =>
    tokenCountLine(ordinal, time, {
      last_token_usage: tokenUsageFields(usage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })),
    });

  it("起点 = 用户消息，终点 = token_usage_record（早于 token_count）", () => {
    const timer = new CodexRequestTimer();
    timer.observeLine(sessionMeta());
    timer.observeLine(userMessage(1, ts(2)));
    timer.observeLine(reasoning(2, ts(3)));
    timer.observeLine(
      line(3, ts(13), "token_usage_record", {
        response_id: "resp_1",
        usage: tokenUsageFields(usage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })),
      }),
    );
    timer.observeLine(tokenCountAt(4, ts(44)));
    expect(
      timer.finishRequest(at(44), usage({ inputTokens: 10, outputTokens: 5 })),
    ).toBe(at(13) - at(2));
  });

  it("usage_record 与本次 last 对不上时不用它当终点", () => {
    const timer = new CodexRequestTimer();
    timer.observeLine(userMessage(1, ts(2)));
    timer.observeLine(reasoning(2, ts(3)));
    timer.observeLine(
      line(3, ts(13), "token_usage_record", {
        response_id: "resp_other",
        usage: tokenUsageFields(usage({ inputTokens: 999, outputTokens: 9 })),
      }),
    );
    timer.observeLine(tokenCountAt(4, ts(20)));
    expect(
      timer.finishRequest(at(20), usage({ inputTokens: 10, outputTokens: 5 })),
    ).toBe(at(20) - at(2));
  });

  it("token_count 等工具跑完才写时改用最后一个输出项的时刻", () => {
    const timer = new CodexRequestTimer();
    timer.observeLine(userMessage(1, ts(0)));
    timer.observeLine(assistantMessage(2, ts(10)));
    timer.observeLine(toolOutput(3, ts(20)));
    // token_count 与工具结果同批写出
    timer.observeLine(tokenCountAt(4, ts(20) /* +5ms 用整行时间 */));
    expect(
      timer.finishRequest(at(20), usage({ inputTokens: 10, outputTokens: 5 })),
    ).toBe(at(10) - at(0));
  });

  it("旧布局补写在 token_count 之后的输出项不属于下一次请求", () => {
    const timer = new CodexRequestTimer();
    timer.observeLine(userMessage(1, ts(0)));
    timer.observeLine(reasoning(2, ts(10)));
    timer.observeLine(tokenCountAt(3, ts(10)));
    // 解析器遇到有用量的 token_count 会先结算上一次请求
    timer.finishRequest(at(10), usage({ inputTokens: 10, outputTokens: 5 }));
    // 同毫秒补写的输出项：忽略
    timer.observeLine(assistantMessage(4, ts(10)));
    // 下一次真实请求
    timer.observeLine(userMessage(5, ts(50)));
    timer.observeLine(reasoning(6, ts(51)));
    expect(
      timer.finishRequest(at(52), usage({ inputTokens: 10, outputTokens: 5 })),
    ).toBe(at(52) - at(50));
  });

  it("task_started 清掉中断请求留下的起点", () => {
    const timer = new CodexRequestTimer();
    timer.observeLine(userMessage(1, ts(0)));
    timer.observeLine(reasoning(2, ts(1))); // 这次请求会中断
    timer.observeLine(
      line(3, ts(2), "event_msg", { type: "task_started", turn_id: "t2" }),
    );
    timer.observeLine(reasoning(4, ts(3)));
    expect(
      timer.finishRequest(at(4), usage({ inputTokens: 10, outputTokens: 5 })),
    ).toBe(at(4) - at(2));
  });

  it("估不出合理窗口（缺起点/过短）返回 undefined", () => {
    const timer = new CodexRequestTimer();
    // 没有任何起点行
    timer.observeLine(tokenCountAt(1, ts(30)));
    expect(
      timer.finishRequest(at(30), usage({ inputTokens: 10, outputTokens: 5 })),
    ).toBeUndefined();

    // 50ms 的窗口短于合理下限：起点取错了
    const short = new CodexRequestTimer();
    short.observeLine(userMessage(1, ms(1, 0)));
    short.observeLine(reasoning(2, ms(1, 10)));
    expect(
      short.finishRequest(at(1, 50), usage({ inputTokens: 10, outputTokens: 5 })),
    ).toBeUndefined();
  });
});

describe("codexEventsToRecords", () => {
  it("跳过零增量与无 requestKey 的事件，丢弃无时间戳事件", () => {
    const events: CodexParsedEvent[] = [
      {
        ordinal: 1,
        signatureKey: "s1",
        delta: null, // 重复快照
        timestampMs: 1000,
        model: "gpt-6-astra",
      },
      {
        ordinal: 2,
        signatureKey: "s2",
        delta: {
          inputTokens: 100,
          cachedInputTokens: 40,
          cacheWriteInputTokens: 0,
          outputTokens: 10,
        },
        // 无 requestKey（不应出现，防御）
        timestampMs: 1000,
        model: "gpt-6-astra",
      },
      {
        ordinal: 3,
        signatureKey: "s3",
        delta: {
          inputTokens: 100,
          cachedInputTokens: 40,
          cacheWriteInputTokens: 0,
          outputTokens: 10,
        },
        requestKey: "1",
        timestampMs: 1000,
        model: "gpt-6-astra",
        cwd: "C:\\Users\\u\\Documents\\Codex\\proj",
      },
      {
        ordinal: 4,
        signatureKey: "s4",
        delta: {
          inputTokens: 100,
          cachedInputTokens: 40,
          cacheWriteInputTokens: 0,
          outputTokens: 10,
        },
        requestKey: "2",
        // 没有时间戳：进不了趋势图，直接丢弃
        model: "gpt-6-astra",
      },
    ];
    const records = codexEventsToRecords(events, {
      rolloutId: THREAD_ID,
      sessionId: PARENT_ID,
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: `codex:${THREAD_ID}:3:1`,
      sessionId: PARENT_ID,
      project: "proj",
      timestamp: 1000,
    });
  });

  it("cwd 推不出项目时兜底「未知项目」，模型缺失兜底", () => {
    const records = codexEventsToRecords(
      [
        {
          ordinal: 1,
          signatureKey: "s",
          delta: { inputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1 },
          requestKey: "1",
          timestampMs: 1000,
          model: "unknown",
          cwd: "C:\\",
        },
      ],
      { rolloutId: THREAD_ID, sessionId: THREAD_ID },
    );
    expect(records[0].project).toBe("未知项目");
    expect(records[0].model).toBe("未知模型");
  });

  it("provider 按模型名推断，兜底 OpenAI", () => {
    const base = {
      ordinal: 1,
      signatureKey: "s",
      delta: { inputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1 },
      requestKey: "1",
      timestampMs: 1000,
    } as const;
    const kimi = codexEventsToRecords([{ ...base, model: "kimi-k3" }], {
      rolloutId: THREAD_ID,
      sessionId: THREAD_ID,
    });
    expect(kimi[0].provider).toBe("Moonshot AI");
    const unknown = codexEventsToRecords([{ ...base, model: "codex-auto-review" }], {
      rolloutId: THREAD_ID,
      sessionId: THREAD_ID,
    });
    expect(unknown[0].provider).toBe("OpenAI");
  });
});
