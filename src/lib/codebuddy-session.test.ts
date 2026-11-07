import { describe, expect, it } from "vitest";
import {
  deriveEstimatedDurationMs,
  parseSessionFile,
  parseTimestamp,
  type SessionRecord,
} from "@/lib/codebuddy-session";

/** 造一条带 usage 的 assistant 消息（CodeBuddy 会话 jsonl 的真实形态）。 */
function assistantItem(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "assistant-1",
    parentId: "user-1",
    timestamp: 1_794_000_000_000,
    type: "message",
    role: "assistant",
    status: "completed",
    sessionId: "session-a",
    providerData: {
      conversationRequestId: "req-1",
      messageId: "assistant-1",
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

function userItem(id: string, timestamp: number, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    timestamp,
    type: "message",
    role: "user",
    sessionId: "session-a",
    ...overrides,
  };
}

function jsonl(...items: unknown[]): string {
  return items.map((item) => JSON.stringify(item)).join("\n") + "\n";
}

/** 真实毫秒级基准时间（2026-11-07 前后）；合成时间戳必须用这一量级，避免被当秒级放大。 */
const BASE_MS = 1_794_000_000_000;

describe("parseTimestamp", () => {
  it("秒级时间戳放大到毫秒，毫秒级原样保留", () => {
    expect(parseTimestamp(1_794_000_000)).toBe(1_794_000_000_000);
    expect(parseTimestamp(BASE_MS)).toBe(BASE_MS);
  });

  it("ISO 字符串可解析，非法值返回 undefined", () => {
    expect(parseTimestamp("2026-11-07T00:00:00.000Z")).toBe(Date.parse("2026-11-07T00:00:00.000Z"));
    expect(parseTimestamp("not-a-date")).toBeUndefined();
    expect(parseTimestamp(undefined)).toBeUndefined();
  });
});

describe("parseSessionFile（字段映射回归）", () => {
  it("解析 rawUsage / providerData.usage / message.usage 并保留原始行为", () => {
    const records = parseSessionFile(
      jsonl(assistantItem()),
      "demo",
      "session-a.jsonl",
    );
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record.harness).toBe("codebuddy");
    expect(record.inputTokens).toBe(1000);
    expect(record.outputTokens).toBe(300);
    expect(record.cacheReadTokens).toBe(800);
    expect(record.totalTokens).toBe(1300);
    expect(record.inputTokenSemantics).toBe("total");
    expect(record.hasTokenUsage).toBe(true);
    expect(record.credits).toBe(1.5);
    expect(record.hasCredit).toBe(true);
    expect(record.status).toBe("success");
    expect(record.model).toBe("kimi-k3.1-pro");
    expect(record.provider).toBe("Moonshot AI");
    expect(record.requestId).toBe("req-1");
  });

  it("providerData.usage（camelCase）单独存在时也能解析，totalTokens 回退 input+output", () => {
    const records = parseSessionFile(
      jsonl(
        assistantItem({
          message: undefined,
          providerData: {
            model: "deepseek-v4",
            usage: { inputTokens: 120, outputTokens: 80, inputTokensDetails: [{ cached_tokens: 100 }] },
          },
        }),
      ),
      "demo",
      "session-a.jsonl",
    );
    const record = records[0];
    expect(record.inputTokens).toBe(120);
    expect(record.outputTokens).toBe(80);
    expect(record.cacheReadTokens).toBe(100);
    expect(record.totalTokens).toBe(200);
    expect(record.hasCredit).toBe(false);
    expect(record.model).toBe("deepseek-v4");
  });

  it("没有 usage 的条目（user 消息、turn-metrics、session-meta）不产出记录", () => {
    const records = parseSessionFile(
      jsonl(
        userItem("user-1", 1),
        { type: "turn-metrics", id: "tm", timestamp: 2, durationMs: 3539, tokenDelta: 13883 },
        { type: "session-meta", id: "sm", timestamp: 3, meta: {} },
      ),
      "demo",
      "session-a.jsonl",
    );
    expect(records).toHaveLength(0);
  });

  it("失败状态映射为 error；时间戳非法的记录丢弃", () => {
    const failed = parseSessionFile(
      jsonl(assistantItem({ id: "a2", status: "cancelled" })),
      "demo",
      "s.jsonl",
    );
    expect(failed[0].status).toBe("error");

    const badTimestamp = parseSessionFile(
      jsonl(assistantItem({ id: "a3", timestamp: "oops" })),
      "demo",
      "s.jsonl",
    );
    expect(badTimestamp).toHaveLength(0);
  });

  it("坏行跳过，不影响其余行", () => {
    const records = parseSessionFile(
      "{broken json\n" + jsonl(assistantItem()),
      "demo",
      "session-a.jsonl",
    );
    expect(records).toHaveLength(1);
  });
});

describe("deriveEstimatedDurationMs（父链回溯）", () => {
  function mapOf(...items: SessionRecord[]): Map<string, SessionRecord> {
    return new Map(items.filter((item) => item.id).map((item) => [item.id as string, item]));
  }

  it("第一步：父级是 user 消息，窗口 = 消息完成 − 用户提交", () => {
    const message = assistantItem({ id: "a1", parentId: "u1", timestamp: BASE_MS + 4_000 });
    const user = userItem("u1", BASE_MS);
    expect(deriveEstimatedDurationMs(message, mapOf(message, user))).toBe(4_000);
  });

  it("后续步骤：跳过同响应的 reasoning，取最近的 function_call_result 作为起点", () => {
    // 真实数据形态：message 的直接父级是同响应的 reasoning（仅差几十毫秒）
    const message = assistantItem({ id: "a2", parentId: "r2", timestamp: BASE_MS + 30_000 });
    const reasoning = { id: "r2", parentId: "fcr1", timestamp: BASE_MS + 29_960, type: "reasoning" };
    const toolResult = {
      id: "fcr1",
      parentId: "fc1",
      timestamp: BASE_MS + 22_712,
      type: "function_call_result",
    };
    expect(deriveEstimatedDurationMs(message, mapOf(message, reasoning, toolResult))).toBe(7_288);
  });

  it("并行工具调用：取最近的那个 function_call_result", () => {
    const message = assistantItem({ id: "a3", parentId: "r3", timestamp: BASE_MS + 50_000 });
    const reasoning = { id: "r3", parentId: "fcrB", timestamp: BASE_MS + 49_950, type: "reasoning" };
    const nearestResult = { id: "fcrB", parentId: "fcB", timestamp: BASE_MS + 45_000, type: "function_call_result" };
    const middleCall = { id: "fcB", parentId: "fcrA", timestamp: BASE_MS + 40_000, type: "function_call" };
    const fartherResult = { id: "fcrA", parentId: "a1", timestamp: BASE_MS + 35_000, type: "function_call_result" };
    expect(
      deriveEstimatedDurationMs(message, mapOf(message, reasoning, nearestResult, middleCall, fartherResult)),
    ).toBe(5_000);
  });

  it("链中间的 function_call 不是起点，继续回溯", () => {
    const message = assistantItem({ id: "a4", parentId: "fc-x", timestamp: BASE_MS + 20_000 });
    const call = { id: "fc-x", parentId: "u4", timestamp: BASE_MS + 19_000, type: "function_call" };
    const user = userItem("u4", BASE_MS + 10_000);
    expect(deriveEstimatedDurationMs(message, mapOf(message, call, user))).toBe(10_000);
  });

  it("父级缺失 / 没有父级 / 时间戳非法 → 推不出窗口", () => {
    const message = assistantItem({ id: "a5", parentId: "ghost", timestamp: BASE_MS });
    expect(deriveEstimatedDurationMs(message, mapOf(message))).toBeUndefined();

    const orphan = assistantItem({ id: "a6", timestamp: BASE_MS });
    expect(deriveEstimatedDurationMs(orphan, mapOf(orphan))).toBeUndefined();

    const badBoundary = assistantItem({ id: "a7", parentId: "u7", timestamp: BASE_MS });
    const userBadTs = userItem("u7", Number.NaN);
    expect(deriveEstimatedDurationMs(badBoundary, mapOf(badBoundary, userBadTs))).toBeUndefined();
  });

  it("父链成环时安全返回 undefined", () => {
    const a = assistantItem({ id: "cycle-a", parentId: "cycle-b", timestamp: BASE_MS });
    const b = { id: "cycle-b", parentId: "cycle-a", timestamp: BASE_MS - 1_000, type: "reasoning" };
    expect(deriveEstimatedDurationMs(a, mapOf(a, b))).toBeUndefined();
  });

  it("差值非正（起点晚于完成时刻，脏数据）返回 undefined", () => {
    const message = assistantItem({ id: "a8", parentId: "u8", timestamp: BASE_MS });
    const lateUser = userItem("u8", BASE_MS + 500);
    expect(deriveEstimatedDurationMs(message, mapOf(message, lateUser))).toBeUndefined();

    const sameTime = userItem("u8", BASE_MS);
    expect(deriveEstimatedDurationMs(message, mapOf(message, sameTime))).toBeUndefined();
  });

  it("超过最大回溯步数（全是非起点条目）返回 undefined", () => {
    const items: SessionRecord[] = [];
    const child = assistantItem({ id: "head", parentId: "n0", timestamp: BASE_MS });
    items.push(child);
    for (let i = 0; i < 200; i += 1) {
      const item: SessionRecord = { id: `n${i}`, parentId: `n${i + 1}`, timestamp: BASE_MS, type: "reasoning" };
      items.push(item);
    }
    expect(deriveEstimatedDurationMs(child, mapOf(...items))).toBeUndefined();
  });

  it("字符串时间戳（ISO）也能算窗口", () => {
    const message = assistantItem({
      id: "a9",
      parentId: "u9",
      timestamp: "2026-11-07T00:00:10.000Z",
    });
    const user = userItem("u9", Date.parse("2026-11-07T00:00:04.500Z"));
    expect(deriveEstimatedDurationMs(message, mapOf(message, user))).toBe(5_500);
  });
});

describe("parseSessionFile（估算耗时注入）", () => {
  it("完整多步回合：每条 usage 记录拿到各自的请求窗口", () => {
    const content = jsonl(
      userItem("u1", BASE_MS),
      assistantItem({ id: "m1", parentId: "u1", timestamp: BASE_MS + 3_536 }),
      { id: "fc1", parentId: "m1", timestamp: BASE_MS + 3_540, type: "function_call" },
      { id: "fcr1", parentId: "fc1", timestamp: BASE_MS + 10_000, type: "function_call_result" },
      assistantItem({ id: "m2", parentId: "r1", timestamp: BASE_MS + 17_288 }),
      { id: "r1", parentId: "fcr1", timestamp: BASE_MS + 17_250, type: "reasoning" },
    );
    const records = parseSessionFile(content, "demo", "session-a.jsonl");
    expect(records).toHaveLength(2);
    const byId = new Map(records.map((record) => [record.id, record]));
    expect(byId.get("codebuddy:session-a:m1")?.estimatedDurationMs).toBe(3_536);
    expect(byId.get("codebuddy:session-a:m2")?.estimatedDurationMs).toBe(7_288);
  });

  it("推不出窗口的记录 estimatedDurationMs 为 undefined", () => {
    const records = parseSessionFile(
      jsonl(assistantItem({ id: "m3", parentId: "missing" })),
      "demo",
      "session-a.jsonl",
    );
    expect(records[0].estimatedDurationMs).toBeUndefined();
  });
});
