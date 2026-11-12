import { describe, expect, it } from "vitest";
import {
  collectFirstTokenMedians,
  estimatedFirstTokenMs,
  formatFirstTokenSeconds,
  medianOfSorted,
} from "@/lib/first-token";
import type { UsageRecord } from "@/lib/usage";

function record(
  harness: UsageRecord["harness"],
  firstTokenMs: number | undefined,
  status: UsageRecord["status"] = "success",
) {
  return { harness, firstTokenMs, status };
}

describe("estimatedFirstTokenMs", () => {
  it("落在 (0, 耗时] 内才有效（cc-switch estimated_first_token_ms 同款）", () => {
    expect(estimatedFirstTokenMs(1000, 3000, 5000)).toBe(2000);
    expect(estimatedFirstTokenMs(1000, 1000, 5000)).toBeUndefined(); // 非正
    expect(estimatedFirstTokenMs(1000, 7000, 5000)).toBeUndefined(); // 晚于耗时
    expect(estimatedFirstTokenMs(1000, 6000, 5000)).toBe(5000); // 恰等于耗时
  });
});

describe("medianOfSorted", () => {
  it("奇数取中间、偶数取中间均值、空为 null", () => {
    expect(medianOfSorted([1, 3, 5])).toBe(3);
    expect(medianOfSorted([1, 2, 3, 4])).toBe(2.5);
    expect(medianOfSorted([])).toBeNull();
  });
});

describe("collectFirstTokenMedians", () => {
  it("精确（zcode/kcode/antigravity/dsh）与估算（claude/codex）分开统计", () => {
    const medians = collectFirstTokenMedians([
      record("zcode", 100),
      record("zcode", 300),
      record("zcode", 200),
      record("claude", 900),
      record("codex", 700),
      // 失败请求不参与。
      record("zcode", 50, "error"),
      // 无首字的请求不参与。
      record("claude", undefined),
      // 无首字计时的 Harness 本就不会带 firstTokenMs（reader 不产出）。
      record("qoder", undefined),
    ]);
    expect(medians.firstTokenMedianMs).toBe(200);
    expect(medians.estFirstTokenMedianMs).toBe(800);
  });

  it("没有可统计请求时两个中位数都是 null", () => {
    expect(collectFirstTokenMedians([record("codebuddy", undefined)])).toEqual({
      firstTokenMedianMs: null,
      estFirstTokenMedianMs: null,
    });
  });
});

describe("formatFirstTokenSeconds", () => {
  it("毫秒换秒、一位小数；无值返回 null", () => {
    expect(formatFirstTokenSeconds(3154)).toBe("3.2s");
    expect(formatFirstTokenSeconds(0)).toBe("0.0s");
    expect(formatFirstTokenSeconds(null)).toBeNull();
    expect(formatFirstTokenSeconds(-1)).toBeNull();
  });
});
