import { describe, expect, it } from "vitest";
import {
  RATE_LIMIT_COOLDOWN_MS,
  TRANSIENT_COOLDOWN_MS,
  MIN_QUERY_INTERVAL_MS,
  cooldownFor,
  decideQuery,
  extractHttpStatus,
  shouldRetryTransient,
} from "@/lib/balance-throttle";

describe("decideQuery", () => {
  it("冷却中拒绝外呼并给出剩余时间与原因", () => {
    const now = 100_000;
    const decision = decideQuery(
      {
        nextEligibleAt: now + 5_000,
        cooldownUntil: now + 30_000,
        cooldownReason: "供应商限流（HTTP 429），已暂停查询",
      },
      now,
    );
    expect(decision).toEqual({
      action: "skip-cooldown",
      waitMs: 30_000,
      reason: "供应商限流（HTTP 429），已暂停查询",
    });
  });

  it("冷却优先于最小间隔判定", () => {
    const now = 100_000;
    const decision = decideQuery(
      { nextEligibleAt: now + 999_999, cooldownUntil: now + 1, cooldownReason: null },
      now,
    );
    expect(decision.action).toBe("skip-cooldown");
  });

  it("最小间隔内拒绝外呼", () => {
    const now = 100_000;
    const decision = decideQuery(
      { nextEligibleAt: now + MIN_QUERY_INTERVAL_MS - 1, cooldownUntil: 0, cooldownReason: null },
      now,
    );
    expect(decision).toEqual({ action: "skip-throttled", waitMs: MIN_QUERY_INTERVAL_MS - 1 });
  });

  it("间隔与冷却都结束时放行", () => {
    const decision = decideQuery(
      { nextEligibleAt: 99_999, cooldownUntil: 99_999, cooldownReason: null },
      100_000,
    );
    expect(decision).toEqual({ action: "fetch" });
  });
});

describe("extractHttpStatus", () => {
  it("从错误信息提取 HTTP 状态码", () => {
    expect(extractHttpStatus("API error (HTTP 429): too many requests")).toBe(429);
    expect(extractHttpStatus("API error (HTTP 502)")).toBe(502);
    expect(extractHttpStatus("Network error: socket hang up")).toBeNull();
    expect(extractHttpStatus(null)).toBeNull();
  });
});

describe("shouldRetryTransient", () => {
  it("网络 / 5xx 瞬时失败可重试一次", () => {
    expect(
      shouldRetryTransient({ success: false, data: null, error: "Network error: timeout", errorKind: "transient" }),
    ).toBe(true);
    expect(
      shouldRetryTransient({ success: false, data: null, error: "API error (HTTP 502)", errorKind: "transient" }),
    ).toBe(true);
  });

  it("429 不重试（直接进入冷却）", () => {
    expect(
      shouldRetryTransient({ success: false, data: null, error: "API error (HTTP 429)", errorKind: "transient" }),
    ).toBe(false);
  });

  it("确定性失败与成功结果不重试", () => {
    expect(
      shouldRetryTransient({ success: false, data: null, error: "API error (HTTP 404)", errorKind: "deterministic" }),
    ).toBe(false);
    expect(shouldRetryTransient({ success: true, data: [], error: null, errorKind: null })).toBe(false);
  });
});

describe("cooldownFor", () => {
  it("429 冷却 5 分钟", () => {
    const now = 1_000_000;
    const cooldown = cooldownFor(
      { success: false, data: null, error: "API error (HTTP 429)", errorKind: "transient" },
      now,
    );
    expect(cooldown).toEqual({
      until: now + RATE_LIMIT_COOLDOWN_MS,
      reason: "供应商限流（HTTP 429），已暂停查询",
    });
  });

  it("其他瞬时失败冷却 60 秒", () => {
    const now = 1_000_000;
    const cooldown = cooldownFor(
      { success: false, data: null, error: "Network error: timeout", errorKind: "transient" },
      now,
    );
    expect(cooldown?.until).toBe(now + TRANSIENT_COOLDOWN_MS);
  });

  it("成功与确定性失败不冷却", () => {
    const now = 1_000_000;
    expect(cooldownFor({ success: true, data: [], error: null, errorKind: null }, now)).toBeNull();
    expect(
      cooldownFor(
        { success: false, data: null, error: "API error (HTTP 401)", errorKind: "deterministic" },
        now,
      ),
    ).toBeNull();
  });
});
