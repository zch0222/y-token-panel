import { describe, expect, it } from "vitest";
import {
  formatAggregateTokensPerSecond,
  formatEstimatedTokensPerSecond,
  formatTokensPerSecond,
  getAggregateTokensPerSecond,
  getEstimatedTokensPerSecond,
  isSpeedEstimateEligible,
  SPEED_ESTIMATE_MIN_DURATION_MS,
  SPEED_ESTIMATE_MIN_OUTPUT_TOKENS,
  sumSpeedTotals,
  toSpeedInput,
} from "@/lib/speed";
import type { UsageRecord } from "@/lib/usage";

describe("isSpeedEstimateEligible", () => {
  it("达到输出与耗时双门槛的请求满足条件", () => {
    expect(
      isSpeedEstimateEligible({ outputTokens: 200, estimatedDurationMs: 1000 }),
    ).toBe(true);
    expect(
      isSpeedEstimateEligible({ outputTokens: 2000, estimatedDurationMs: 60_000 }),
    ).toBe(true);
  });

  it("输出少于 200 token 不算（短回复被首字等待带偏）", () => {
    expect(
      isSpeedEstimateEligible({ outputTokens: 199, estimatedDurationMs: 5000 }),
    ).toBe(false);
    expect(SPEED_ESTIMATE_MIN_OUTPUT_TOKENS).toBe(200);
  });

  it("估算耗时不足 1 秒不算（起点可能取晚了）", () => {
    expect(
      isSpeedEstimateEligible({ outputTokens: 500, estimatedDurationMs: 999 }),
    ).toBe(false);
    expect(SPEED_ESTIMATE_MIN_DURATION_MS).toBe(1000);
  });

  it("没有估算耗时（Qoder 等来源）或值非法时不算", () => {
    expect(isSpeedEstimateEligible({ outputTokens: 500 })).toBe(false);
    expect(
      isSpeedEstimateEligible({ outputTokens: 500, estimatedDurationMs: 0 }),
    ).toBe(false);
    expect(
      isSpeedEstimateEligible({ outputTokens: 500, estimatedDurationMs: -100 }),
    ).toBe(false);
    expect(
      isSpeedEstimateEligible({ outputTokens: 500, estimatedDurationMs: Number.NaN }),
    ).toBe(false);
    expect(
      isSpeedEstimateEligible({
        outputTokens: Number.POSITIVE_INFINITY,
        estimatedDurationMs: 5000,
      }),
    ).toBe(false);
  });
});

describe("getEstimatedTokensPerSecond", () => {
  it("单条速度 = 输出 ÷ (耗时 / 1000)", () => {
    expect(
      getEstimatedTokensPerSecond({ outputTokens: 400, estimatedDurationMs: 2000 }),
    ).toBe(200);
    expect(
      getEstimatedTokensPerSecond({ outputTokens: 962, estimatedDurationMs: 7288 }),
    ).toBeCloseTo(962 / 7.288, 10);
  });

  it("不满足门槛返回 null", () => {
    expect(
      getEstimatedTokensPerSecond({ outputTokens: 100, estimatedDurationMs: 500 }),
    ).toBeNull();
    expect(getEstimatedTokensPerSecond({ outputTokens: 300 })).toBeNull();
  });
});

describe("getAggregateTokensPerSecond", () => {
  it("汇总速度 = Σ输出 ÷ Σ耗时", () => {
    // 200 tok / 1s + 10000 tok / 10s → 10200 / 11
    expect(getAggregateTokensPerSecond(10_200, 11_000)).toBeCloseTo(927.27, 2);
  });

  it("分子分母必须都是有限正数", () => {
    expect(getAggregateTokensPerSecond(0, 1000)).toBeNull();
    expect(getAggregateTokensPerSecond(100, 0)).toBeNull();
    expect(getAggregateTokensPerSecond(-1, 1000)).toBeNull();
    expect(getAggregateTokensPerSecond(100, -1)).toBeNull();
    expect(getAggregateTokensPerSecond(Number.NaN, 1000)).toBeNull();
    expect(getAggregateTokensPerSecond(100, Number.NaN)).toBeNull();
  });

  it("Σ÷Σ 与逐条平均不同：短请求不会被等权放大", () => {
    // 逐条平均 = (200 + 1000) / 2 = 600；Σ÷Σ = 10200/11 ≈ 927.27
    const aggregate = getAggregateTokensPerSecond(10_200, 11_000);
    expect(aggregate).not.toBeCloseTo(600, 1);
    expect(aggregate).toBeCloseTo(927.2727, 3);
  });
});

describe("sumSpeedTotals", () => {
  it("只累加满足门槛的请求", () => {
    const totals = sumSpeedTotals([
      { outputTokens: 400, estimatedDurationMs: 2000 }, // 计入
      { outputTokens: 100, estimatedDurationMs: 2000 }, // 输出不足，不计
      { outputTokens: 500, estimatedDurationMs: 300 }, // 耗时不足，不计
      { outputTokens: 300 }, // 没有耗时，不计
      { outputTokens: 600, estimatedDurationMs: 3000 }, // 计入
    ]);
    expect(totals).toEqual({ speedOutputTokens: 1000, speedDurationMs: 5000 });
  });

  it("空列表返回零", () => {
    expect(sumSpeedTotals([])).toEqual({ speedOutputTokens: 0, speedDurationMs: 0 });
  });
});

describe("formatTokensPerSecond", () => {
  it("≥ 1 取整显示", () => {
    expect(formatTokensPerSecond(1)).toBe("1");
    expect(formatTokensPerSecond(1.4)).toBe("1");
    expect(formatTokensPerSecond(132.6)).toBe("133");
    expect(formatTokensPerSecond(927.27)).toBe("927");
  });

  it("小于 1 保留一位小数", () => {
    expect(formatTokensPerSecond(0.5)).toBe("0.5");
    expect(formatTokensPerSecond(0.04)).toBe("0.0");
  });

  it("null 与非正数返回 null（界面显示「—」）", () => {
    expect(formatTokensPerSecond(null)).toBeNull();
    expect(formatTokensPerSecond(0)).toBeNull();
    expect(formatTokensPerSecond(-3)).toBeNull();
    expect(formatTokensPerSecond(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("格式化组合", () => {
  it("formatEstimatedTokensPerSecond 输出带门槛的单条速度", () => {
    expect(
      formatEstimatedTokensPerSecond({ outputTokens: 400, estimatedDurationMs: 2000 }),
    ).toBe("200");
    expect(formatEstimatedTokensPerSecond({ outputTokens: 50, estimatedDurationMs: 2000 })).toBeNull();
  });

  it("formatAggregateTokensPerSecond 无可估算请求时返回 null", () => {
    expect(
      formatAggregateTokensPerSecond({ speedOutputTokens: 0, speedDurationMs: 0 }),
    ).toBeNull();
    expect(
      formatAggregateTokensPerSecond({ speedOutputTokens: 1000, speedDurationMs: 5000 }),
    ).toBe("200");
  });
});

describe("toSpeedInput", () => {
  it("从 UsageRecord 提取速度输入", () => {
    const record = {
      outputTokens: 500,
      estimatedDurationMs: 2500,
    } as UsageRecord;
    expect(toSpeedInput(record)).toEqual({
      outputTokens: 500,
      estimatedDurationMs: 2500,
    });
  });
});
