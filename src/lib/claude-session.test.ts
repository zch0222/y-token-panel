import { describe, expect, it } from "vitest";
import {
  CLAUDE_MAX_CHAIN_HOPS,
  estimateClaudeLatencyMs,
  parseClaudeTranscriptFile,
  type ClaudeTranscriptLine,
  type ClaudeParseContext,
} from "@/lib/claude-session";

/**
 * 数值取自本机 ~/.claude/projects/D--code-y-token-panel 真实转录
 * （claude-opus-5-5 的一次响应，Claude Code 2.1.317）。
 */
const REAL_USAGE = {
  input_tokens: 2,
  cache_creation_input_tokens: 27634,
  cache_read_input_tokens: 45826,
  output_tokens: 694,
};

const T0 = Date.UTC(2026, 10, 7, 7, 8, 42);
const iso = (ms: number) => new Date(ms).toISOString();
const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;

const CONTEXT: ClaudeParseContext = {
  directory: "D--code-y-token-panel",
  sessionId: "sess-file",
  file: "sess.jsonl",
};

function jsonl(lines: unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

interface AssistantOptions {
  uuid: string;
  parentUuid?: string | null;
  timestampMs: number;
  messageId?: string;
  model?: string;
  stopReason?: string | null;
  apiBlockIndex?: number;
  usage?: Record<string, number> | null;
  cwd?: string;
  sessionId?: string;
}

function assistantLine(options: AssistantOptions): Record<string, unknown> {
  const message: Record<string, unknown> = {
    model: options.model ?? "claude-opus-5-5",
    id: options.messageId ?? `msg_${options.uuid}`,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "…" }],
    stop_reason: options.stopReason === undefined ? "end_turn" : options.stopReason,
    stop_sequence: null,
  };
  if (options.usage !== null) {
    message.usage = options.usage ?? REAL_USAGE;
  }
  return {
    parentUuid: options.parentUuid ?? null,
    isSidechain: false,
    message,
    ...(options.apiBlockIndex !== undefined
      ? { apiBlockIndex: options.apiBlockIndex }
      : {}),
    requestId: `req_${options.uuid}`,
    type: "assistant",
    uuid: options.uuid,
    timestamp: iso(options.timestampMs),
    cwd: options.cwd ?? "D:\\code\\y-token-panel",
    sessionId: options.sessionId ?? "sess-1",
    version: "2.1.317",
    gitBranch: "master",
  };
}

function userLine(
  uuid: string,
  timestampMs: number,
  parentUuid: string | null = null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    parentUuid,
    isSidechain: false,
    type: "user",
    message: { role: "user", content: "…" },
    uuid,
    timestamp: iso(timestampMs),
    cwd: "D:\\code\\y-token-panel",
    sessionId: "sess-1",
    ...extra,
  };
}

describe("parseClaudeTranscriptFile 字段映射", () => {
  it("assistant 行映射为一条记录，口径与真实转录一致", () => {
    const content = jsonl([
      userLine("u1", T0),
      assistantLine({ uuid: "a1", parentUuid: "u1", timestampMs: T0 + 3 * SECOND }),
    ]);
    const [record] = parseClaudeTranscriptFile(content, CONTEXT);
    expect(record).toMatchObject({
      id: "claude:msg_a1",
      requestId: "msg_a1",
      sessionId: "sess-1",
      harness: "claude",
      project: "y-token-panel",
      model: "claude-opus-5-5",
      provider: "Anthropic",
      timestamp: T0 + 3 * SECOND,
      inputTokens: 2,
      outputTokens: 694,
      cacheReadTokens: 45826,
      cacheCreationTokens: 27634,
      totalTokens: 2 + 694 + 45826 + 27634,
      inputTokenSemantics: "fresh",
      hasTokenUsage: true,
      credits: 0,
      hasCredit: false,
      status: "success",
    });
  });

  it("transcript 没有请求级错误标记，记录一律 success", () => {
    const content = jsonl([
      assistantLine({
        uuid: "a1",
        timestampMs: T0,
        stopReason: "tool_use",
      }),
    ]);
    expect(parseClaudeTranscriptFile(content, CONTEXT)[0].status).toBe("success");
  });

  it("mangle 后等于目录名的 cwd 是会话项目根，取叶子名", () => {
    // 目录名 = 会话启动 cwd 的非字母数字全部替换为 "-"（claude.exe 实测）。
    const parseWith = (
      line: ReturnType<typeof assistantLine>,
      directory: string,
    ) =>
      parseClaudeTranscriptFile(jsonl([line]), {
        ...CONTEXT,
        directory,
      })[0].project;

    expect(
      parseWith(assistantLine({ uuid: "a1", timestampMs: T0 }), "D--code-y-token-panel"),
    ).toBe("y-token-panel");
    expect(
      parseWith(
        assistantLine({
          uuid: "a2",
          timestampMs: T0,
          cwd: "/home/user/projects/ledger",
        }),
        // Unix 绝对路径的前导 "/" 同样被替换成 "-"。
        "-home-user-projects-ledger",
      ),
    ).toBe("ledger");
    // 非 X--code- 形态的目录也能靠 cwd 还原出干净叶子名。
    expect(
      parseWith(
        assistantLine({
          uuid: "a3",
          timestampMs: T0,
          cwd: "C:\\Users\\YXLMz\\code\\anynote",
        }),
        "C--Users-YXLMz-code-anynote",
      ),
    ).toBe("anynote");
  });

  it("指向子目录的 cwd 不作为项目名，回退目录名派生的标签", () => {
    const content = jsonl([
      // cd 进子目录后执行的请求：mangle 结果对不上目录名。
      assistantLine({
        uuid: "a1",
        timestampMs: T0,
        cwd: "D:\\code\\ledger-next\\src",
      }),
      assistantLine({
        uuid: "a2",
        timestampMs: T0,
        messageId: "msg_a2",
        cwd: "/home/user/projects/ledger/src",
      }),
      assistantLine({
        uuid: "a3",
        timestampMs: T0,
        messageId: "msg_a3",
        cwd: "D:\\",
      }),
    ]);
    const records = parseClaudeTranscriptFile(content, {
      ...CONTEXT,
      directory: "D--code-ledger-next",
    });
    expect(records.map((record) => record.project)).toEqual([
      "ledger-next",
      "ledger-next",
      "ledger-next",
    ]);
  });

  it("会话项目根以文件为单位：子目录行的记录归入同文件的会话根", () => {
    const content = jsonl([
      userLine("u1", T0, null, { cwd: "C:\\Users\\YXLMz\\code\\anynote\\src" }),
      assistantLine({
        uuid: "a1",
        parentUuid: "u1",
        timestampMs: T0 + SECOND,
        cwd: "C:\\Users\\YXLMz\\code\\anynote\\src",
      }),
      // 会话根 cwd 出现在文件后段（首条用户消息之后 cd 回项目根）。
      assistantLine({
        uuid: "a2",
        timestampMs: T0 + 2 * SECOND,
        messageId: "msg_a2",
        cwd: "C:\\Users\\YXLMz\\code\\anynote",
      }),
    ]);
    const records = parseClaudeTranscriptFile(content, {
      ...CONTEXT,
      directory: "C--Users-YXLMz-code-anynote",
    });
    expect(records.map((record) => record.project)).toEqual([
      "anynote",
      "anynote",
    ]);
  });

  it("cwd 缺失时回退目录名派生的项目标签，sessionId 缺失回退文件名", () => {
    const line = assistantLine({ uuid: "a1", timestampMs: T0 }) as ClaudeTranscriptLine;
    delete (line as Partial<ClaudeTranscriptLine>).cwd;
    delete (line as Partial<ClaudeTranscriptLine>).sessionId;
    const [record] = parseClaudeTranscriptFile(jsonl([line]), {
      ...CONTEXT,
      directory: "D--code-y-note",
      sessionId: "from-file-name",
    });
    expect(record.project).toBe("y-note");
    expect(record.sessionId).toBe("from-file-name");
  });

  it("user / system / cost-state / attachment 行不产生记录", () => {
    const content = jsonl([
      userLine("u1", T0),
      { type: "system", subtype: "stop_hook_summary", timestamp: iso(T0) },
      {
        type: "cost-state",
        sessionId: "sess-1",
        totalCostUSD: 5.33,
        timestamp: iso(T0),
      },
      {
        type: "attachment",
        uuid: "att1",
        parentUuid: "u1",
        timestamp: iso(T0 + 500),
      },
    ]);
    expect(parseClaudeTranscriptFile(content, CONTEXT)).toEqual([]);
  });

  it("usage 全零或缺失的 assistant 行不产生记录", () => {
    const content = jsonl([
      assistantLine({
        uuid: "a1",
        timestampMs: T0,
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
      assistantLine({ uuid: "a2", timestampMs: T0, usage: null }),
    ]);
    expect(parseClaudeTranscriptFile(content, CONTEXT)).toEqual([]);
  });

  it("message.id 缺失的 assistant 行忽略", () => {
    const content = jsonl([
      assistantLine({ uuid: "a1", timestampMs: T0, messageId: "" }),
    ]);
    expect(parseClaudeTranscriptFile(content, CONTEXT)).toEqual([]);
  });

  it("timestamp 缺失或不可解析时丢弃记录", () => {
    const broken = assistantLine({ uuid: "a1", timestampMs: T0 });
    delete (broken as Partial<ClaudeTranscriptLine>).timestamp;
    const content = jsonl([
      broken,
      { ...assistantLine({ uuid: "a2", timestampMs: T0 }), timestamp: "不是时间" },
    ]);
    expect(parseClaudeTranscriptFile(content, CONTEXT)).toEqual([]);
  });

  it("坏 JSON 行、空行、CRLF 均容忍", () => {
    const content = [
      "{ broken json",
      "",
      "   ",
      JSON.stringify(assistantLine({ uuid: "a1", timestampMs: T0 })),
    ].join("\r\n");
    const records = parseClaudeTranscriptFile(content, CONTEXT);
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe("claude:msg_a1");
  });
});

describe("按 message.id 去重（同一响应分块落多行）", () => {
  it("无 stop_reason 的中间快照让位于带 stop_reason 的最终块", () => {
    const content = jsonl([
      userLine("u1", T0),
      assistantLine({
        uuid: "b0",
        parentUuid: "u1",
        timestampMs: T0 + SECOND,
        messageId: "msg_shared",
        stopReason: null,
        apiBlockIndex: 0,
        usage: { ...REAL_USAGE, output_tokens: 100 },
      }),
      assistantLine({
        uuid: "b1",
        parentUuid: "b0",
        timestampMs: T0 + 2 * SECOND,
        messageId: "msg_shared",
        stopReason: "tool_use",
        apiBlockIndex: 1,
        usage: { ...REAL_USAGE, output_tokens: 694 },
      }),
    ]);
    const records = parseClaudeTranscriptFile(content, CONTEXT);
    expect(records).toHaveLength(1);
    expect(records[0].outputTokens).toBe(694);
    // 保留的是带 stop_reason 的最终块的时间戳。
    expect(records[0].timestamp).toBe(T0 + 2 * SECOND);
  });

  it("stop_reason 有无相同时保留 output_tokens 更大者，与出现顺序无关", () => {
    const content = jsonl([
      assistantLine({
        uuid: "b0",
        timestampMs: T0,
        messageId: "msg_shared",
        stopReason: "end_turn",
        usage: { ...REAL_USAGE, output_tokens: 700 },
      }),
      assistantLine({
        uuid: "b1",
        timestampMs: T0 + SECOND,
        messageId: "msg_shared",
        stopReason: "end_turn",
        usage: { ...REAL_USAGE, output_tokens: 694 },
      }),
      assistantLine({
        uuid: "b2",
        timestampMs: T0 + 2 * SECOND,
        messageId: "msg_shared",
        stopReason: null,
        usage: { ...REAL_USAGE, output_tokens: 999 },
      }),
    ]);
    const records = parseClaudeTranscriptFile(content, CONTEXT);
    expect(records).toHaveLength(1);
    expect(records[0].outputTokens).toBe(700);
  });

  it("只有 message_start 快照（无 stop_reason、output=1）也导入", () => {
    // Workflow / 子 agent 的并行短命请求常只写 message_start 快照，
    // 但其 input/cache 已真实计费（cc-switch 实测丢弃低估约 4.1%）。
    const content = jsonl([
      userLine("u1", T0),
      assistantLine({
        uuid: "b0",
        parentUuid: "u1",
        timestampMs: T0 + SECOND,
        stopReason: null,
        usage: { ...REAL_USAGE, output_tokens: 1 },
      }),
    ]);
    const records = parseClaudeTranscriptFile(content, CONTEXT);
    expect(records).toHaveLength(1);
    expect(records[0].outputTokens).toBe(1);
    expect(records[0].inputTokens).toBe(REAL_USAGE.input_tokens);
  });

  it("多个 message.id 各成一条记录", () => {
    const content = jsonl([
      assistantLine({ uuid: "a1", timestampMs: T0 + 2 * SECOND }),
      assistantLine({
        uuid: "a2",
        timestampMs: T0,
        messageId: "msg_a2",
        model: "claude-sonnet-4-5",
      }),
    ]);
    const records = parseClaudeTranscriptFile(content, CONTEXT);
    expect(records.map((record) => record.id)).toEqual([
      "claude:msg_a1",
      "claude:msg_a2",
    ]);
    expect(records[1].provider).toBe("Anthropic");
  });
});

describe("耗时估算（对齐 cc-switch session_usage.rs）", () => {
  const requestId = "msg_b0";

  function blocks(stopReason: string | null = "end_turn") {
    return [
      userLine("u1", T0),
      assistantLine({
        uuid: "b0",
        parentUuid: "u1",
        timestampMs: T0 + 2 * SECOND,
        messageId: requestId,
        stopReason: stopReason,
        apiBlockIndex: 0,
      }),
      assistantLine({
        uuid: "b1",
        parentUuid: "b0",
        timestampMs: T0 + 5 * SECOND,
        messageId: requestId,
        stopReason: stopReason,
        apiBlockIndex: 1,
      }),
      assistantLine({
        uuid: "b2",
        parentUuid: "b1",
        timestampMs: T0 + 9 * SECOND,
        messageId: requestId,
        stopReason: stopReason,
        apiBlockIndex: 2,
      }),
    ];
  }

  it("耗时 = 各块最晚时间戳 − 沿父链找到的请求起点时间戳", () => {
    const records = parseClaudeTranscriptFile(jsonl(blocks()), CONTEXT);
    expect(records).toHaveLength(1);
    expect(records[0].estimatedDurationMs).toBe(9 * SECOND);
  });

  it("起点回溯跳过时间戳不可靠的 attachment 行", () => {
    const content = jsonl([
      userLine("u1", T0),
      {
        type: "attachment",
        uuid: "att1",
        parentUuid: "u1",
        timestamp: iso(T0 + 30 * SECOND),
      },
      assistantLine({
        uuid: "b0",
        parentUuid: "att1",
        timestampMs: T0 + 4 * SECOND,
      }),
    ]);
    const [record] = parseClaudeTranscriptFile(content, CONTEXT);
    expect(record.estimatedDurationMs).toBe(4 * SECOND);
  });

  it("父行不在链上（链断裂）时不估", () => {
    const content = jsonl([
      assistantLine({
        uuid: "b0",
        parentUuid: "missing",
        timestampMs: T0 + 4 * SECOND,
      }),
    ]);
    const [record] = parseClaudeTranscriptFile(content, CONTEXT);
    expect(record.estimatedDurationMs).toBeUndefined();
  });

  it("父链成环时不估", () => {
    // 两条时间戳仅差 10ms：任一方向都进不了 100ms 合理区间。
    const content = jsonl([
      assistantLine({
        uuid: "b0",
        parentUuid: "b1",
        timestampMs: T0 + 4000,
      }),
      assistantLine({
        uuid: "b1",
        parentUuid: "b0",
        timestampMs: T0 + 4010,
        messageId: "msg_b1",
      }),
    ]);
    const records = parseClaudeTranscriptFile(content, CONTEXT);
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.estimatedDurationMs).toBeUndefined();
    }
  });

  it("全是 attachment 的父链超过最大回溯步数时不估", () => {
    const lines: Array<Record<string, unknown>> = [userLine("u1", T0)];
    const total = CLAUDE_MAX_CHAIN_HOPS + 2;
    for (let i = 1; i <= total; i += 1) {
      lines.push({
        type: "attachment",
        uuid: `att${i}`,
        parentUuid: i === 1 ? "u1" : `att${i - 1}`,
        timestamp: iso(T0 + i * SECOND),
      });
    }
    lines.push(
      assistantLine({
        uuid: "b0",
        parentUuid: `att${total}`,
        timestampMs: T0 + (total + 5) * SECOND,
      }),
    );
    const [record] = parseClaudeTranscriptFile(jsonl(lines), CONTEXT);
    // 起点要沿 attachment 链走到底，超过回溯上限，宁可不估。
    expect(record.estimatedDurationMs).toBeUndefined();
  });

  it("没有 stop_reason 的快照不估耗时", () => {
    const records = parseClaudeTranscriptFile(jsonl(blocks(null)), CONTEXT);
    expect(records).toHaveLength(1);
    expect(records[0].estimatedDurationMs).toBeUndefined();
  });

  it("首块不在文件里（apiBlockIndex 从 1 开始）时不估", () => {
    const content = jsonl([
      userLine("u1", T0),
      assistantLine({
        uuid: "b1",
        parentUuid: "b0",
        timestampMs: T0 + 5 * SECOND,
        apiBlockIndex: 1,
      }),
    ]);
    const [record] = parseClaudeTranscriptFile(content, CONTEXT);
    expect(record.estimatedDurationMs).toBeUndefined();
  });

  it("旧版日志没有 apiBlockIndex 时按首块处理", () => {
    const content = jsonl([
      userLine("u1", T0),
      assistantLine({ uuid: "b0", parentUuid: "u1", timestampMs: T0 + 3 * SECOND }),
    ]);
    const [record] = parseClaudeTranscriptFile(content, CONTEXT);
    expect(record.estimatedDurationMs).toBe(3 * SECOND);
  });

  it("中途夹着不带 stop_reason 的同消息块时仍以最晚块为准", () => {
    const content = jsonl([
      userLine("u1", T0),
      assistantLine({
        uuid: "b0",
        parentUuid: "u1",
        timestampMs: T0 + 2 * SECOND,
        messageId: "msg_shared",
        stopReason: null,
        apiBlockIndex: 0,
      }),
      assistantLine({
        uuid: "b1",
        parentUuid: "b0",
        timestampMs: T0 + 6 * SECOND,
        messageId: "msg_shared",
        apiBlockIndex: 1,
      }),
    ]);
    const [record] = parseClaudeTranscriptFile(content, CONTEXT);
    // 保留带 stop_reason 的最终块，计时线索仍记录过首块，起点可回溯。
    expect(record.estimatedDurationMs).toBe(6 * SECOND);
  });
});

describe("estimateClaudeLatencyMs 合理区间", () => {
  it("[100ms, 1h] 闭区间内保留，区间外丢弃", () => {
    expect(estimateClaudeLatencyMs(T0, T0 + 99)).toBeUndefined();
    expect(estimateClaudeLatencyMs(T0, T0 + 100)).toBe(100);
    expect(estimateClaudeLatencyMs(T0, T0 + HOUR)).toBe(HOUR);
    expect(estimateClaudeLatencyMs(T0, T0 + HOUR + 1)).toBeUndefined();
  });

  it("起点晚于终点（负值）丢弃", () => {
    expect(estimateClaudeLatencyMs(T0 + SECOND, T0)).toBeUndefined();
  });
});
