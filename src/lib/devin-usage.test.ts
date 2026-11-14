import { describe, expect, it } from "vitest";
import {
  clampDevinInteger,
  collectDevinUsage,
  devinProjectLabel,
  parseDevinMessageRow,
  type DevinMessageRow,
} from "@/lib/devin-usage";

/**
 * 便于覆盖字段的行工厂：数值取自本机 sessions.db 的实测 assistant 行
 * （input 4 + cache_read 19253 + cache_creation 237504 = context 256761，
 * ttft 10416 + 11156 tok × tpot 10.049ms ≈ total_time 122532）。
 */
function messageRow(overrides: Partial<DevinMessageRow> = {}): DevinMessageRow {
  return {
    row_id: 42,
    session_id: "upbeat-crater",
    node_id: 7,
    created_at: 1_794_605_525,
    chat_message: JSON.stringify({
      message_id: "6f0f3d1e-2f4b-4d67-9e61-a3ab6cb88f06",
      role: "assistant",
      content: "…",
      metadata: {
        num_tokens: 11_156,
        request_id: "8b1351cc-8b3c-4c04-9999-53b91c53e037",
        metrics: {
          ttft_ms: 10_416,
          total_time_ms: 122_532,
          input_tokens: 4,
          output_tokens: 11_156,
          cache_read_tokens: 19_253,
          cache_creation_tokens: 237_504,
          context_input_tokens: 256_761,
          tpot_ms: 10.049,
          tokens_per_sec: 99.5,
        },
        finish_reason: "tool_calls",
        generation_model: "claude-opus-5-5-xhigh",
        telemetry: { source: "assistant", operation: "inference" },
      },
    }),
    working_directory: "C:\\Users\\YXLMz\\code\\anynote",
    session_model: "claude-sonnet-5-5-medium",
    ...overrides,
  };
}

describe("clampDevinInteger", () => {
  it("非数值与负数截为 0，小数截断取整", () => {
    expect(clampDevinInteger(null)).toBe(0);
    expect(clampDevinInteger(Number.NaN)).toBe(0);
    expect(clampDevinInteger(-5)).toBe(0);
    expect(clampDevinInteger(3.9)).toBe(3);
    expect(clampDevinInteger(1000)).toBe(1000);
  });
});

describe("devinProjectLabel", () => {
  it("取目录叶子，兼容正反斜杠与结尾分隔符；缺失记未知项目", () => {
    expect(devinProjectLabel("C:\\Users\\YXLMz\\code\\anynote")).toBe("anynote");
    expect(devinProjectLabel("/home/user/project/")).toBe("project");
    expect(devinProjectLabel("  ")).toBe("未知项目");
    expect(devinProjectLabel(null)).toBe("未知项目");
    expect(devinProjectLabel(undefined)).toBe("未知项目");
  });
});

describe("parseDevinMessageRow", () => {
  it("完整映射本机实测行：新鲜输入口径、原生 TTFT/耗时、秒级时间戳", () => {
    expect(parseDevinMessageRow(messageRow())).toEqual({
      id: "devin:upbeat-crater:8b1351cc-8b3c-4c04-9999-53b91c53e037",
      requestId: "8b1351cc-8b3c-4c04-9999-53b91c53e037",
      sessionId: "upbeat-crater",
      harness: "devin",
      project: "anynote",
      model: "claude-opus-5-5-xhigh",
      provider: "Anthropic",
      timestamp: 1_794_605_525_000,
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
  });

  it("input_tokens 不含缓存（context = input + cache_read + cache_creation 实测恒等式的另一行）", () => {
    const row = messageRow({
      chat_message: JSON.stringify({
        role: "assistant",
        metadata: {
          request_id: "req-24603",
          metrics: {
            input_tokens: 24_603,
            output_tokens: 553,
            cache_read_tokens: 19_255,
            cache_creation_tokens: 9_078,
            context_input_tokens: 52_936,
          },
          finish_reason: "stop",
          generation_model: "claude-opus-5-5-max",
        },
      }),
    });
    const record = parseDevinMessageRow(row);
    // 24603 是新鲜输入而不是 52936 的总输入，总量按四项求和。
    expect(record?.inputTokens).toBe(24_603);
    expect(record?.totalTokens).toBe(24_603 + 553 + 19_255 + 9_078);
    expect(record?.inputTokenSemantics).toBe("fresh");
  });

  it("Gemini 行缓存字段为 null 时按 0 处理", () => {
    const row = messageRow({
      row_id: 43,
      chat_message: JSON.stringify({
        role: "assistant",
        metadata: {
          request_id: "req-gemini",
          metrics: {
            input_tokens: 31_915,
            output_tokens: 402,
            cache_read_tokens: null,
            cache_creation_tokens: null,
            context_input_tokens: 31_915,
          },
          generation_model: "gemini-3-8-flash-medium",
        },
      }),
    });
    const record = parseDevinMessageRow(row);
    expect(record?.inputTokens).toBe(31_915);
    expect(record?.cacheReadTokens).toBe(0);
    expect(record?.cacheCreationTokens).toBe(0);
    expect(record?.totalTokens).toBe(32_317);
    expect(record?.provider).toBe("Google");
  });

  it("request_id 缺失时回退 row_id", () => {
    const row = messageRow({
      row_id: 77,
      chat_message: JSON.stringify({
        role: "assistant",
        metadata: {
          metrics: { input_tokens: 10, output_tokens: 5 },
        },
      }),
    });
    const record = parseDevinMessageRow(row);
    expect(record?.id).toBe("devin:upbeat-crater:77");
    expect(record?.requestId).toBe("77");
  });

  it("模型回退链：generation_model 缺失用会话默认模型，都缺记未知模型", () => {
    const noGenerationModel = messageRow({
      chat_message: JSON.stringify({
        role: "assistant",
        metadata: {
          request_id: "req-1",
          metrics: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    });
    expect(parseDevinMessageRow(noGenerationModel)?.model).toBe(
      "claude-sonnet-5-5-medium",
    );
    expect(parseDevinMessageRow(noGenerationModel)?.provider).toBe("Anthropic");

    const noModel = parseDevinMessageRow(
      messageRow({
        session_model: null,
        chat_message: noGenerationModel.chat_message,
      }),
    );
    expect(noModel?.model).toBe("未知模型");
    expect(noModel?.provider).toBe("Devin");

    const kimi = parseDevinMessageRow(
      messageRow({
        chat_message: JSON.stringify({
          role: "assistant",
          metadata: {
            request_id: "req-kimi",
            metrics: { input_tokens: 1, output_tokens: 1 },
            generation_model: "kimi-k3-1-pro-max",
          },
        }),
      }),
    );
    expect(kimi?.provider).toBe("Moonshot AI");
  });

  it("ttft 缺失不提供首字；ttft 晚于完成时刻视为脏值丢弃；耗时缺失不影响首字", () => {
    const noTtft = parseDevinMessageRow(
      messageRow({
        chat_message: JSON.stringify({
          role: "assistant",
          metadata: {
            request_id: "req-2",
            metrics: { input_tokens: 1, output_tokens: 1, total_time_ms: 5_000 },
          },
        }),
      }),
    );
    expect(noTtft?.firstTokenMs).toBeUndefined();
    expect(noTtft?.estimatedDurationMs).toBe(5_000);

    const ttftAfterEnd = parseDevinMessageRow(
      messageRow({
        chat_message: JSON.stringify({
          role: "assistant",
          metadata: {
            request_id: "req-3",
            metrics: {
              input_tokens: 1,
              output_tokens: 1,
              ttft_ms: 9_000,
              total_time_ms: 5_000,
            },
          },
        }),
      }),
    );
    expect(ttftAfterEnd?.firstTokenMs).toBeUndefined();

    const noDuration = parseDevinMessageRow(
      messageRow({
        chat_message: JSON.stringify({
          role: "assistant",
          metadata: {
            request_id: "req-4",
            metrics: { input_tokens: 1, output_tokens: 1, ttft_ms: 800 },
          },
        }),
      }),
    );
    expect(noDuration?.firstTokenMs).toBe(800);
    expect(noDuration?.estimatedDurationMs).toBeUndefined();
  });

  it("时间戳非法、JSON 损坏、非 assistant 行或无 metrics 的行返回 null", () => {
    expect(parseDevinMessageRow(messageRow({ created_at: null }))).toBeNull();
    expect(parseDevinMessageRow(messageRow({ created_at: 0 }))).toBeNull();
    expect(parseDevinMessageRow(messageRow({ chat_message: "not json" }))).toBeNull();
    expect(parseDevinMessageRow(messageRow({ chat_message: null }))).toBeNull();

    // user 行的常态：role=user 且 metrics 为 null（实测全部如此）。
    expect(
      parseDevinMessageRow(
        messageRow({
          chat_message: JSON.stringify({
            role: "user",
            content: "hi",
            metadata: { num_tokens: null, is_user_input: true, metrics: null },
          }),
        }),
      ),
    ).toBeNull();

    // telemetry.source=tool_result 等非 inference 行没有 metrics 键。
    expect(
      parseDevinMessageRow(
        messageRow({
          chat_message: JSON.stringify({
            role: "assistant",
            metadata: { finish_reason: null },
          }),
        }),
      ),
    ).toBeNull();

    // 没有任何可用标识（request_id 与 row_id 都缺）的行丢弃。
    expect(
      parseDevinMessageRow(
        messageRow({
          row_id: null,
          chat_message: JSON.stringify({
            role: "assistant",
            metadata: { metrics: { input_tokens: 1, output_tokens: 1 } },
          }),
        }),
      ),
    ).toBeNull();
  });

  it("finish_reason 无 error 终态（DB 证据），content_filter 行也按 success 计", () => {
    const record = parseDevinMessageRow(
      messageRow({
        chat_message: JSON.stringify({
          role: "assistant",
          metadata: {
            request_id: "req-cf",
            metrics: { input_tokens: 3, output_tokens: 0 },
            finish_reason: "content_filter",
          },
        }),
      }),
    );
    expect(record?.status).toBe("success");
  });

  it("防御脏值：负数与小数 token 截断", () => {
    const record = parseDevinMessageRow(
      messageRow({
        chat_message: JSON.stringify({
          role: "assistant",
          metadata: {
            request_id: "req-dirty",
            metrics: {
              input_tokens: -3,
              output_tokens: 10.7,
              cache_read_tokens: Number.NaN,
              cache_creation_tokens: 2.2,
            },
          },
        }),
      }),
    );
    expect(record?.inputTokens).toBe(0);
    expect(record?.outputTokens).toBe(10);
    expect(record?.cacheReadTokens).toBe(0);
    expect(record?.cacheCreationTokens).toBe(2);
    expect(record?.totalTokens).toBe(12);
  });
});

describe("collectDevinUsage", () => {
  function rowFor(
    rowId: number,
    sessionId: string,
    requestId: string,
    createdAt: number,
    inputTokens: number,
  ): DevinMessageRow {
    return messageRow({
      row_id: rowId,
      session_id: sessionId,
      created_at: createdAt,
      chat_message: JSON.stringify({
        role: "assistant",
        metadata: {
          request_id: requestId,
          metrics: { input_tokens: inputTokens, output_tokens: 1 },
        },
      }),
    });
  }

  it("按时间倒序（同刻按 id 升序）并统计会话数", () => {
    const { records, sessionCount } = collectDevinUsage([
      rowFor(1, "a", "r1", 100, 10),
      rowFor(2, "a", "r2", 300, 30),
      rowFor(3, "b", "r3", 200, 20),
    ]);
    expect(records.map((record) => record.requestId)).toEqual(["r2", "r3", "r1"]);
    expect(records[1] && records[2] && records[1].timestamp === records[2].timestamp)
      .toBe(false);
    expect(sessionCount).toBe(2);
  });

  it("同刻按 id 升序稳定排序", () => {
    const { records } = collectDevinUsage([
      rowFor(1, "a", "r-b", 100, 1),
      rowFor(2, "a", "r-a", 100, 1),
    ]);
    expect(records.map((record) => record.requestId)).toEqual(["r-a", "r-b"]);
  });

  it("同一 request_id 的压缩副本去重为一次请求，保留最早行的生成时刻", () => {
    // 实测形态：原始行与 compact 副本 metrics 完全一致，created_at 是各自的
    // 落库时刻（压缩副本晚约 8 分钟）；SQL 升序 + first-wins 保留原始行。
    const { records, sessionCount } = collectDevinUsage([
      rowFor(1, "a", "dup", 1_794_647_731, 2),
      rowFor(2, "a", "dup", 1_794_647_735, 2),
      rowFor(3, "a", "dup", 1_794_648_232, 2),
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]?.timestamp).toBe(1_794_647_731_000);
    expect(records[0]?.inputTokens).toBe(2);
    expect(sessionCount).toBe(1);
  });

  it("非法行被跳过且不计入会话数", () => {
    const { records, sessionCount } = collectDevinUsage([
      rowFor(1, "a", "r1", 100, 10),
      messageRow({ row_id: 2, session_id: "broken", chat_message: "x" }),
    ]);
    expect(records).toHaveLength(1);
    expect(sessionCount).toBe(1);
  });
});
