import { describe, expect, it } from "vitest";
import {
  filterUsageRecords,
  groupRecords,
  summarizeRecords,
  type UsageRecord,
} from "@/lib/usage";

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: "codebuddy:s1:r1",
    requestId: "r1",
    sessionId: "s1",
    harness: "codebuddy",
    project: "demo",
    model: "kimi-k3.1-pro",
    provider: "Moonshot AI",
    timestamp: 1_794_000_000_000,
    inputTokens: 1000,
    outputTokens: 400,
    cacheReadTokens: 800,
    cacheCreationTokens: 0,
    totalTokens: 1400,
    inputTokenSemantics: "total",
    hasTokenUsage: true,
    credits: 1,
    hasCredit: true,
    status: "success",
    ...overrides,
  };
}

describe("summarizeRecords 速度聚合", () => {
  it("速度分子分母只累加满足门槛的请求", () => {
    const summary = summarizeRecords([
      record({ id: "a", outputTokens: 400, estimatedDurationMs: 2000 }), // 计入
      record({ id: "b", outputTokens: 100, estimatedDurationMs: 9000 }), // 输出不足
      record({ id: "c", outputTokens: 500, estimatedDurationMs: 400 }), // 耗时不足
      record({ id: "d", outputTokens: 600, estimatedDurationMs: 3000 }), // 计入
      record({ id: "e", outputTokens: 700 }), // 无耗时（Qoder 形态）
    ]);
    expect(summary.speedOutputTokens).toBe(1000);
    expect(summary.speedDurationMs).toBe(5000);
  });

  it("没有可估算请求时速度字段为零", () => {
    const summary = summarizeRecords([record({ estimatedDurationMs: undefined }), record({ id: "x" })]);
    expect(summary.speedOutputTokens).toBe(0);
    expect(summary.speedDurationMs).toBe(0);
  });

  it("空记录集仍输出完整的速度字段", () => {
    const summary = summarizeRecords([]);
    expect(summary.requests).toBe(0);
    expect(summary.speedOutputTokens).toBe(0);
    expect(summary.speedDurationMs).toBe(0);
  });
});

describe("groupRecords 携带速度字段", () => {
  it("分组统计继承速度分子分母", () => {
    const stats = groupRecords(
      [
        record({ model: "kimi", outputTokens: 400, estimatedDurationMs: 1000 }),
        record({ model: "kimi", outputTokens: 600, estimatedDurationMs: 2000 }),
        record({ model: "deepseek", outputTokens: 250, estimatedDurationMs: 5000 }),
        record({ id: "q1", harness: "qoder", model: "qoder-coder", provider: "Qoder", outputTokens: 900 }),
      ],
      "model",
    );
    const byKey = new Map(stats.map((stat) => [stat.key, stat]));
    expect(byKey.get("kimi")).toMatchObject({
      speedOutputTokens: 1000,
      speedDurationMs: 3000,
    });
    expect(byKey.get("deepseek")).toMatchObject({
      speedOutputTokens: 250,
      speedDurationMs: 5000,
    });
    expect(byKey.get("qoder-coder")).toMatchObject({
      speedOutputTokens: 0,
      speedDurationMs: 0,
    });
  });
});

describe("filterUsageRecords 保留速度字段", () => {
  it("过滤后的记录仍带估算耗时", () => {
    const filtered = filterUsageRecords(
      [
        record({ estimatedDurationMs: 2500 }),
        record({ id: "old", timestamp: 1_700_000_000_000 }),
      ],
      "today",
      "all",
      "all",
      "all",
      new Date(1_794_000_000_000),
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0].estimatedDurationMs).toBe(2500);
  });
});
