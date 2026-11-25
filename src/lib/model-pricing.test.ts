import { describe, expect, it } from "vitest";
import {
  calculateUsageCost,
  findModelPricing,
  formatUsdCost,
  modelPricingCandidates,
  normalizeModelIdForPricing,
  parseModelPricing,
  validatePricingEntry,
} from "@/lib/model-pricing";

function pricing(patch: Record<string, string> = {}) {
  return {
    modelId: "claude-sonnet-4-5",
    displayName: "Claude Sonnet 4.5",
    inputCostPerMillion: "3",
    outputCostPerMillion: "15",
    cacheReadCostPerMillion: "0.30",
    cacheCreationCostPerMillion: "3.75",
    ...patch,
  };
}

describe("model pricing", () => {
  it("按 cc-switch 口径计算 fresh 输入、缓存读与缓存写成本", () => {
    const parsed = parseModelPricing(pricing())!;
    const cost = calculateUsageCost({
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 2000,
      cacheCreationTokens: 1000,
      inputTokenSemantics: "fresh",
    }, parsed);
    expect(cost.inputCostUsd).toBeCloseTo(0.003, 12);
    expect(cost.outputCostUsd).toBeCloseTo(0.0075, 12);
    expect(cost.cacheReadCostUsd).toBeCloseTo(0.0006, 12);
    expect(cost.cacheCreationCostUsd).toBeCloseTo(0.00375, 12);
    expect(cost.totalCostUsd).toBeCloseTo(0.01485, 12);
  });

  it("total 输入语义先扣除缓存读写再按输入价计费", () => {
    const parsed = parseModelPricing(pricing())!;
    const cost = calculateUsageCost({
      inputTokens: 5000,
      outputTokens: 0,
      cacheReadTokens: 2000,
      cacheCreationTokens: 1000,
      inputTokenSemantics: "total",
    }, parsed);
    expect(cost.inputCostUsd).toBeCloseTo(0.006, 12);
  });

  it("1 小时缓存写入按 5 分钟写入价的 1.6 倍计费", () => {
    const parsed = parseModelPricing(pricing())!;
    const cost = calculateUsageCost({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 1000,
      cacheCreation1hTokens: 500,
      inputTokenSemantics: "fresh",
    }, parsed);
    expect(cost.cacheCreationCostUsd).toBeCloseTo(0.004875, 12);
  });

  it("模型名归一化与日期/命名空间/推理强度候选符合 cc-switch", () => {
    expect(normalizeModelIdForPricing("OpenAI/GPT-5@Latest:free[1m]")).toBe("gpt-5-latest");
    expect(modelPricingCandidates("anthropic/claude-sonnet-4-5-20250929")).toContain("claude-sonnet-4-5");
    expect(modelPricingCandidates("openai.gpt-5-mini-20250807")).toContain("gpt-5-mini");
    expect(modelPricingCandidates("claude-gpt-5-high")).toContain("gpt-5");
  });

  it("价格查找先精确候选再受控前缀匹配", () => {
    const rows = [pricing({ modelId: "claude-sonnet-4-5" })];
    expect(findModelPricing(rows, "anthropic/claude-sonnet-4-5-20250929")?.matchedModelId).toBe("claude-sonnet-4-5");
    expect(findModelPricing(rows, "unknown")).toBeNull();
  });

  it("价格输入只接受非负普通十进制", () => {
    expect(validatePricingEntry(pricing())).toBeNull();
    expect(validatePricingEntry(pricing({ inputCostPerMillion: "-1" }))).toMatch(/非负/);
    expect(validatePricingEntry(pricing({ outputCostPerMillion: "1e2" }))).toMatch(/十进制/);
  });

  it("美元成本紧凑格式化", () => {
    expect(formatUsdCost(0)).toBe("$0");
    expect(formatUsdCost(1.2)).toBe("$1.2");
    expect(formatUsdCost(0.0123456)).toBe("$0.0123");
    expect(formatUsdCost(undefined, false)).toBe("—");
  });
});
