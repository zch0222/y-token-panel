import { describe, expect, it } from "vitest";
import type { BalanceProviderConfig } from "@/lib/balance";
import {
  fetchBalance,
  parseCommandCodeQuota,
  parseKimiCodingBalance,
  parseMinimaxCodingBalance,
  parseOpencodeGoBalance,
  parseVolcengineAfpTiers,
  parseVolcengineCodingPlanTiers,
  parseZenmuxBalance,
  parseZhipuCodingBalance,
  volcengineCanonicalQuery,
  volcengineIsAuthErrorCode,
  volcengineRegion,
  volcengineResponseError,
  volcengineSign,
  zhipuCodingHasNoPlan,
} from "@/lib/balance-query";

// ── 测试工具 ─────────────────────────────────────────────────

function makeConfig(
  overrides: Partial<BalanceProviderConfig> & Pick<BalanceProviderConfig, "kind" | "baseUrl">,
): BalanceProviderConfig {
  return {
    id: "test-provider",
    name: "test",
    apiKey: "sk-test-key",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** 按调用次序返回预设响应的 fetch 桩，并记录每次请求的 url / headers / method。 */
function fetchQueue(responses: Array<{ match: RegExp; respond: (url: string, init?: RequestInit) => Response }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const target = typeof url === "string" ? url : url.toString();
    calls.push({ url: target, init });
    const hit = responses.find((entry) => entry.match.test(target));
    if (!hit) return Promise.resolve(jsonResponse({ error: `unexpected url: ${target}` }, 500));
    return Promise.resolve(hit.respond(target, init));
  };
  return { impl, calls };
}

// ── Kimi For Coding ──────────────────────────────────────────

describe("parseKimiCodingBalance", () => {
  it("limits[].detail 为 5 小时窗口、usage 为周窗口，绝对额度 + 重置时间", () => {
    const result = parseKimiCodingBalance({
      limits: [{ detail: { limit: 120, remaining: 90, resetTime: 1_000_000_000_000 } }],
      usage: { limit: 1000, remaining: 850, resetTime: "2026-12-01T00:00:00Z" },
    });
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
    const [fiveHour, weekly] = result.data!;
    expect(fiveHour.planName).toBe("5 小时窗口");
    expect(fiveHour.remaining).toBe(90);
    expect(fiveHour.total).toBe(120);
    expect(fiveHour.used).toBe(30);
    expect(fiveHour.resetsAt).toBe(new Date(1_000_000_000_000).toISOString());
    expect(weekly.planName).toBe("周窗口");
    expect(weekly.used).toBe(150);
    expect(weekly.resetsAt).toBe("2026-12-01T00:00:00Z");
  });

  it("字段缺失时给出确定性错误而不是空卡片", () => {
    const result = parseKimiCodingBalance({ foo: "bar" });
    expect(result.success).toBe(false);
    expect(result.errorKind).toBe("deterministic");
  });
});

// ── 智谱 GLM Coding Plan ─────────────────────────────────────

describe("zhipuCodingHasNoPlan", () => {
  it("识别按量账户的「不存在 coding plan」业务错误（2026-10-18 国内站实测文案）", () => {
    expect(
      zhipuCodingHasNoPlan({ code: 500, msg: "当前用户不存在coding plan", success: false }),
    ).toBe(true);
    expect(zhipuCodingHasNoPlan({ msg: "no coding plan found", success: false })).toBe(true);
  });

  it("其他业务错误 / 正常响应都不算无套餐", () => {
    expect(zhipuCodingHasNoPlan({ msg: "invalid api key", success: false })).toBe(false);
    expect(zhipuCodingHasNoPlan({ success: true, data: {} })).toBe(false);
    expect(zhipuCodingHasNoPlan({})).toBe(false);
  });
});

describe("parseZhipuCodingBalance", () => {
  const planBody = (limits: unknown[], level?: string) => ({
    success: true,
    data: { limits, ...(level ? { level } : {}) },
  });

  it("新套餐两条 TOKENS_LIMIT：无 unit 时按重置时间升序归 five_hour / weekly，不展示月额度", () => {
    const result = parseZhipuCodingBalance(
      planBody([
        { type: "TOKENS_LIMIT", percentage: 53.0, nextResetTime: 2_000_000_000_000 },
        { type: "TOKENS_LIMIT", percentage: 44.0, nextResetTime: 1_000_000_000_000 },
      ]),
    );
    expect(result.success).toBe(true);
    const rows = result.data!;
    expect(rows).toHaveLength(2);
    expect(rows[0].planName).toBe("5 小时窗口");
    expect(rows[0].used).toBe(44);
    expect(rows[0].unit).toBe("%");
    expect(rows[0].remaining).toBe(56);
    expect(rows[1].planName).toBe("周窗口");
    expect(rows[1].used).toBe(53);
    expect(rows.some((row) => row.planName === "月窗口")).toBe(false);
  });

  it("有 TIME_LIMIT 时展示 MCP 每月调用次数与重置时间", () => {
    const result = parseZhipuCodingBalance(
      planBody([
        { type: "TOKENS_LIMIT", percentage: 2.0, nextResetTime: 1_774_967_594_803 },
        {
          type: "TIME_LIMIT",
          unit: 5,
          number: 1,
          usage: 1000,
          currentValue: 250,
          remaining: 750,
          percentage: 25,
          nextResetTime: 2_000_000_000_000,
        },
      ]),
    );
    expect(result.data).toHaveLength(2);
    expect(result.data![0].planName).toBe("5 小时窗口");
    expect(result.data![1]).toMatchObject({
      planName: "MCP 每月额度",
      remaining: 750,
      total: 1000,
      used: 250,
      unit: "次",
      resetsAt: new Date(2_000_000_000_000).toISOString(),
    });
  });

  it("MCP 每月额度缺少次数字段时按百分比展示", () => {
    const result = parseZhipuCodingBalance(
      planBody([
        { type: "TOKENS_LIMIT", percentage: 2.0 },
        { type: "TIME_LIMIT", unit: 5, percentage: 40 },
      ]),
    );
    expect(result.data![1]).toMatchObject({
      planName: "MCP 每月额度",
      remaining: 60,
      total: 100,
      used: 40,
      unit: "%",
    });
  });

  it("unit 字段优先于重置时间排序（issue #3036：周期末尾周窗先重置）", () => {
    const result = parseZhipuCodingBalance(
      planBody([
        { type: "TOKENS_LIMIT", unit: 6, number: 7, percentage: 42.0, nextResetTime: 1_000_003_600_000 },
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 1.0, nextResetTime: 1_000_018_000_000 },
      ]),
    );
    const rows = result.data!;
    expect(rows[0].planName).toBe("5 小时窗口");
    expect(rows[0].used).toBe(1);
    expect(rows[1].planName).toBe("周窗口");
    expect(rows[1].used).toBe(42);
  });

  it("(unit:6, number:1) 也按周窗分类（z.ai 实测变体，只看 unit）", () => {
    const result = parseZhipuCodingBalance(
      planBody([
        { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 30.0, nextResetTime: 1_000_000_000_000 },
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 10.0, nextResetTime: 2_000_000_000_000 },
      ]),
    );
    const rows = result.data!;
    expect(rows[0].used).toBe(10);
    expect(rows[1].used).toBe(30);
  });

  it("5 小时桶 0% 无 nextResetTime 时不与周桶混淆", () => {
    const result = parseZhipuCodingBalance(
      planBody([
        { type: "TOKENS_LIMIT", percentage: 25.0, nextResetTime: 2_000_000_000_000 },
        { type: "TOKENS_LIMIT", percentage: 0.0 },
      ]),
    );
    const rows = result.data!;
    expect(rows).toHaveLength(2);
    expect(rows[0].planName).toBe("5 小时窗口");
    expect(rows[0].used).toBe(0);
    expect(rows[0].resetsAt).toBeNull();
    expect(rows[1].planName).toBe("周窗口");
    expect(rows[1].used).toBe(25);
  });

  it("type 大小写不敏感；percentage 非法时按 0 处理且不做范围裁剪", () => {
    const result = parseZhipuCodingBalance(
      planBody([
        { type: "tokens_limit", percentage: "invalid", nextResetTime: 1_000_000_000_000 },
        { type: "Tokens_Limit", percentage: 150.0, nextResetTime: 2_000_000_000_000 },
      ]),
    );
    const rows = result.data!;
    expect(rows).toHaveLength(2);
    expect(rows[0].used).toBe(0);
    expect(rows[1].used).toBe(150);
  });

  it("未识别的 unit 枚举回落重置时间启发式；超过两条时丢弃多余", () => {
    const fallback = parseZhipuCodingBalance(
      planBody([
        { type: "TOKENS_LIMIT", unit: 9, percentage: 44.0, nextResetTime: 1_000_000_000_000 },
        { type: "TOKENS_LIMIT", unit: 9, percentage: 53.0, nextResetTime: 2_000_000_000_000 },
      ]),
    );
    expect(fallback.data![0].used).toBe(44);
    expect(fallback.data![1].used).toBe(53);

    const overflow = parseZhipuCodingBalance(
      planBody([
        { type: "TOKENS_LIMIT", percentage: 1.0, nextResetTime: 1_000_000_000_000 },
        { type: "TOKENS_LIMIT", percentage: 2.0, nextResetTime: 2_000_000_000_000 },
        { type: "TOKENS_LIMIT", percentage: 3.0, nextResetTime: 3_000_000_000_000 },
      ]),
    );
    expect(overflow.data).toHaveLength(2);
  });

  it("套餐等级（level）挂在第一行窗口名后", () => {
    const result = parseZhipuCodingBalance(
      planBody([{ type: "TOKENS_LIMIT", percentage: 10.0, nextResetTime: 1_000_000_000_000 }], "Lite"),
    );
    expect(result.data![0].planName).toBe("5 小时窗口 · Lite");
  });

  it("业务错误透出 msg；缺 TOKENS_LIMIT 条目时确定性报错", () => {
    const business = parseZhipuCodingBalance({ success: false, msg: "服务繁忙" });
    expect(business.success).toBe(false);
    expect(business.error).toContain("服务繁忙");

    const empty = parseZhipuCodingBalance(planBody([{ type: "TIME_LIMIT", percentage: 5.0 }]));
    expect(empty.success).toBe(false);
    expect(empty.errorKind).toBe("deterministic");
  });
});

// ── MiniMax Coding Plan ──────────────────────────────────────

describe("parseMinimaxCodingBalance", () => {
  const body = (item: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    model_remains: [
      item,
      { model_name: "video", current_interval_remaining_percent: 100, current_weekly_remaining_percent: 100 },
    ],
    base_resp: { status_code: 0, status_msg: "success" },
    ...extra,
  });

  it("general 桶剩余百分比反转为已用；video 桶跳过", () => {
    const result = parseMinimaxCodingBalance(
      body({
        model_name: "general",
        current_interval_remaining_percent: 98.0,
        current_weekly_remaining_percent: 95.0,
        current_weekly_status: 1,
        end_time: 1_780_329_600_000,
        weekly_end_time: 1_780_848_000_000,
      }),
    );
    const rows = result.data!;
    expect(rows).toHaveLength(2);
    expect(rows[0].planName).toBe("5 小时窗口");
    expect(rows[0].used).toBe(2);
    expect(rows[0].resetsAt).toBe(new Date(1_780_329_600_000).toISOString());
    expect(rows[1].planName).toBe("周窗口");
    expect(rows[1].used).toBe(5);
  });

  it("current_weekly_status=3 无周限额，跳过周桶；=2 已耗尽照常展示", () => {
    const noWeekly = parseMinimaxCodingBalance(
      body({ model_name: "general", current_interval_remaining_percent: 99, current_weekly_status: 3, current_weekly_remaining_percent: 100 }),
    );
    expect(noWeekly.data).toHaveLength(1);

    const exhausted = parseMinimaxCodingBalance(
      body({ model_name: "general", current_interval_remaining_percent: 80, current_weekly_status: 2, current_weekly_remaining_percent: 0 }),
    );
    expect(exhausted.data).toHaveLength(2);
    expect(exhausted.data![1].used).toBe(100);
  });

  it("缺 general 条目或 base_resp 报错时确定性失败", () => {
    const videoOnly = parseMinimaxCodingBalance({
      model_remains: [{ model_name: "video", current_interval_remaining_percent: 50 }],
    });
    expect(videoOnly.success).toBe(false);

    const businessError = parseMinimaxCodingBalance({
      model_remains: [],
      base_resp: { status_code: 1004, status_msg: "invalid api key" },
    });
    expect(businessError.success).toBe(false);
    expect(businessError.error).toContain("1004");
  });
});

// ── OpenCode Go ──────────────────────────────────────────────

describe("parseOpencodeGoBalance", () => {
  it("三窗口映射 five_hour / weekly / monthly", () => {
    const result = parseOpencodeGoBalance({
      usage: {
        rolling: { status: "ok", percent: 37, resetsAt: "2026-08-26T14:12:03.000Z" },
        weekly: { status: "ok", percent: 62, resetsAt: "2026-08-31T00:00:00.000Z" },
        monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-09-11T00:00:00.000Z" },
      },
    });
    const rows = result.data!;
    expect(rows).toHaveLength(3);
    expect(rows[0].planName).toBe("5 小时窗口");
    expect(rows[0].used).toBe(37);
    expect(rows[0].resetsAt).toBe("2026-08-26T14:12:03.000Z");
    expect(rows[2].planName).toBe("月窗口");
    expect(rows[2].used).toBe(100);
  });

  it("percent=0 丢弃占位 resetsAt；坏窗口跳过、percent 兼容字符串", () => {
    const zero = parseOpencodeGoBalance({
      usage: { rolling: { status: "ok", percent: 0, resetsAt: "2026-08-26T15:00:00.000Z" } },
    });
    expect(zero.data![0].resetsAt).toBeNull();

    const partial = parseOpencodeGoBalance({
      usage: { rolling: { status: "ok" }, weekly: { status: "ok", percent: "12" }, monthly: null },
    });
    expect(partial.data).toHaveLength(1);
    expect(partial.data![0].planName).toBe("周窗口");
    expect(partial.data![0].used).toBe(12);
  });

  it("旧扁平形态不认识 → 明确报错", () => {
    const legacy = parseOpencodeGoBalance({ useBalance: false, rollingUsage: { usagePercent: 37 } });
    expect(legacy.success).toBe(false);
    expect(legacy.error).toContain("Unexpected usage response shape");
  });
});

// ── ZenMux ───────────────────────────────────────────────────

describe("parseZenmuxBalance", () => {
  it("两窗口：有美元金额走绝对值，否则按 usage_percentage（0-1 小数）", () => {
    const result = parseZenmuxBalance({
      success: true,
      data: {
        quota_5_hour: { usage_percentage: 0.25, resets_at: "2026-08-26T14:12:03Z" },
        quota_7_day: { usage_percentage: 0.5, used_value_usd: 15, max_value_usd: 30, resets_at: "2026-08-31T00:00:00Z" },
        plan: { tier: "pro" },
        account_status: "active",
      },
    });
    const rows = result.data!;
    expect(rows).toHaveLength(2);
    expect(rows[0].unit).toBe("%");
    expect(rows[0].used).toBe(25);
    expect(rows[1].unit).toBe("USD");
    expect(rows[1].remaining).toBe(15);
    expect(rows[1].total).toBe(30);
    expect(rows[0].planName).toBe("5 小时窗口 · pro（active）");
  });

  it("success:false 透出 message；缺 data 确定性报错", () => {
    const failure = parseZenmuxBalance({ success: false, message: "quota exceeded" });
    expect(failure.success).toBe(false);
    expect(failure.error).toContain("quota exceeded");

    const missing = parseZenmuxBalance({ success: true });
    expect(missing.success).toBe(false);
  });
});

// ── Command Code ─────────────────────────────────────────────

describe("parseCommandCodeQuota", () => {
  it("月度池 = totalCost / (totalCost + 剩余 credits)，窗口额度按 used/cap", () => {
    const result = parseCommandCodeQuota(
      {
        credits: {
          planId: "provider",
          monthlyCredits: 12.5,
          purchasedCredits: 3.0,
          freeCredits: 0.5,
          windowLimits: {
            limited: true,
            fiveHour: { used: 4.0, cap: 14.0, resetAt: "2026-09-12T18:00:00.000Z" },
            weekly: { used: 12.0, cap: 40.0, resetAt: "2026-09-16T00:00:00.000Z" },
          },
        },
      },
      {
        data: {
          planId: "goat",
          status: "active",
          currentPeriodStart: "2026-09-01T00:00:00.000Z",
          currentPeriodEnd: "2026-10-01T00:00:00.000Z",
        },
      },
      { totalCost: 7.0 },
    );
    const rows = result.data!;
    expect(rows).toHaveLength(3);
    expect(rows[0].planName).toBe("5 小时窗口");
    expect(rows[0].used).toBe(4);
    expect(rows[0].total).toBe(14);
    expect(rows[1].planName).toBe("周窗口");
    expect(rows[2].planName).toBe("月窗口 · goat");
    // totalPool = 7 + 16 = 23
    expect(rows[2].total).toBe(23);
    expect(rows[2].remaining).toBe(16);
    expect(rows[2].resetsAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("真实形态：windowLimits 与 credits 同级、订阅缺失也能出月度行", () => {
    const result = parseCommandCodeQuota(
      {
        credits: { planId: "provider", monthlyCredits: 70, purchasedCredits: 0, freeCredits: 0 },
        windowLimits: {
          limited: true,
          fiveHour: { used: 0, cap: 14, exceeded: false, resetAt: 0 },
          weekly: { used: 0, cap: 35, exceeded: false, resetAt: 0 },
        },
      },
      null,
      { totalCost: 0 },
    );
    const rows = result.data!;
    expect(rows).toHaveLength(3);
    expect(rows[0].resetsAt).toBeNull(); // resetAt=0 视为无重置时间
    expect(rows[2].used).toBe(0);
    expect(rows[2].planName).toBe("月窗口 · provider"); // 回落 credits.planId
  });
});

// ── 火山方舟 ─────────────────────────────────────────────────

describe("volcengine 基础函数", () => {
  it("region 从数据面域名提取，识别不到回落 cn-beijing", () => {
    expect(volcengineRegion("https://ark.cn-beijing.volces.com/api/coding")).toBe("cn-beijing");
    expect(volcengineRegion("https://ark.cn-shanghai.volces.com/api/coding/v3")).toBe("cn-shanghai");
    expect(volcengineRegion("https://example.com/api/coding")).toBe("cn-beijing");
  });

  it("canonical query 按 key 字母序排列", () => {
    expect(volcengineCanonicalQuery("GetAFPUsage", "cn-beijing")).toBe(
      "Action=GetAFPUsage&Region=cn-beijing&Version=2024-01-01",
    );
  });

  it("签名结构契约与确定性（无服务端金标准向量，锁定结构防回归）", () => {
    const now = new Date("2024-06-21T00:00:00Z");
    const query = volcengineCanonicalQuery("GetAFPUsage", "cn-beijing");
    const first = volcengineSign("AKLTtest", "secretkey", "cn-beijing", query, new Uint8Array(0), now);
    // 空 body SHA-256 固定值
    expect(first.xContentSha256).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(first.xDate).toBe("20240621T000000Z");
    expect(first.authorization.startsWith("HMAC-SHA256 Credential=AKLTtest/20240621/cn-beijing/ark/request,")).toBe(
      true,
    );
    expect(first.authorization).toContain("SignedHeaders=host;x-date;x-content-sha256;content-type,");
    const signature = first.authorization.split("Signature=")[1];
    expect(signature).toMatch(/^[0-9a-f]{64}$/);

    const second = volcengineSign("AKLTtest", "secretkey", "cn-beijing", query, new Uint8Array(0), now);
    expect(second.authorization).toBe(first.authorization);
  });

  it("鉴权类错误码识别与 ResponseMetadata.Error 抽取", () => {
    expect(volcengineIsAuthErrorCode("AccessDenied")).toBe(true);
    expect(volcengineIsAuthErrorCode("SignatureDoesNotMatch")).toBe(true);
    expect(volcengineIsAuthErrorCode("InvalidAuthorization")).toBe(true);
    expect(volcengineIsAuthErrorCode("InvalidParameter.Action")).toBe(false);
    expect(volcengineIsAuthErrorCode("InternalError")).toBe(false);

    expect(
      volcengineResponseError({
        ResponseMetadata: { RequestId: "x", Error: { Code: "AccessDenied", Message: "no permission" } },
      }),
    ).toEqual({ code: "AccessDenied", message: "no permission" });
    expect(volcengineResponseError({ ResponseMetadata: { RequestId: "x" }, Result: {} })).toBeNull();
  });
});

describe("parseVolcengineAfpTiers", () => {
  it("官方示例：5h/周/月三窗口，AFPDaily 被隐藏跳过", () => {
    const rows = parseVolcengineAfpTiers({
      PlanType: "Large",
      AFPFiveHour: { Quota: 50.0, Used: 12.5, ResetTime: 1_778_806_800_000 },
      AFPDaily: { Quota: 100.0, Used: 22.5, ResetTime: 1_778_803_200_000 },
      AFPWeekly: { Quota: 500.0, Used: 150.0, ResetTime: 1_779_062_400_000 },
      AFPMonthly: { Quota: 2000.0, Used: 850.5, ResetTime: 1_780_531_200_000 },
    });
    expect(rows).toHaveLength(3);
    expect(rows[0].planName).toBe("5 小时窗口");
    expect(rows[0].used).toBe(12.5);
    expect(rows[0].total).toBe(50);
    expect(rows[0].remaining).toBe(37.5);
    expect(rows[2].planName).toBe("月窗口");
    expect(rows[2].used).toBe(850.5);
  });

  it("Quota=0 的窗口视为未订阅（用于回落 Coding Plan 探测）", () => {
    const rows = parseVolcengineAfpTiers({
      PlanType: "",
      AFPFiveHour: { Quota: 0.0, Used: 0.0 },
      AFPWeekly: { Quota: 0.0, Used: 0.0 },
      AFPMonthly: { Quota: 0.0, Used: 0.0 },
    });
    expect(rows).toHaveLength(0);
  });
});

describe("parseVolcengineCodingPlanTiers", () => {
  it("真实响应：字段为 Level，仅百分比，-1 重置时间无重置", () => {
    const rows = parseVolcengineCodingPlanTiers({
      Status: "Running",
      QuotaUsage: [
        { Level: "session", Percent: 0.0, ResetTimestamp: -1 },
        { Level: "weekly", Percent: 1.672568, ResetTimestamp: 1_782_057_600 },
        { Level: "monthly", Percent: 0.836284, ResetTimestamp: 1_784_303_999 },
      ],
    });
    expect(rows).toHaveLength(3);
    expect(rows[0].planName).toBe("5 小时窗口");
    expect(rows[0].used).toBe(0);
    expect(rows[0].resetsAt).toBeNull();
    expect(rows[1].resetsAt).toBe(new Date(1_782_057_600_000).toISOString());
  });

  it("未知窗口跳过；缺数组返回空", () => {
    const rows = parseVolcengineCodingPlanTiers({
      QuotaUsage: [
        { Level: "daily", Percent: 9.0 },
        { Level: "weekly", Percent: 20.0 },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].planName).toBe("周窗口");
    expect(parseVolcengineCodingPlanTiers({})).toHaveLength(0);
  });
});

// ── fetchBalance 编排（注入 fetch 桩走真实分支）────────────────

describe("fetchBalance · coding plan 编排", () => {
  it("kimi：请求 {coding 根}/usages 且带 Bearer", async () => {
    const { impl, calls } = fetchQueue([
      {
        match: /\/usages$/,
        respond: () =>
          jsonResponse({
            limits: [{ detail: { limit: 120, remaining: 90, resetTime: 1_000_000_000_000 } }],
            usage: { limit: 1000, remaining: 850 },
          }),
      },
    ]);
    const result = await fetchBalance(
      makeConfig({ kind: "kimi", baseUrl: "https://api.kimi.com/coding/v1" }),
      impl,
    );
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(calls[0].url).toBe("https://api.kimi.com/coding/v1/usages");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer sk-test-key");
  });

  it("zhipu_coding：有套餐时单次请求额度接口（Authorization 不带 Bearer）", async () => {
    const { impl, calls } = fetchQueue([
      {
        match: /quota\/limit$/,
        respond: () =>
          jsonResponse({
            success: true,
            data: {
              level: "Max",
              limits: [
                { type: "TOKENS_LIMIT", unit: 3, percentage: 20.0, nextResetTime: 1_000_000_000_000 },
                { type: "TOKENS_LIMIT", unit: 6, percentage: 45.0, nextResetTime: 2_000_000_000_000 },
              ],
            },
          }),
      },
    ]);
    const result = await fetchBalance(
      makeConfig({ kind: "zhipu_coding", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" }),
      impl,
    );
    expect(result.success).toBe(true);
    expect(result.data![0].planName).toBe("5 小时窗口 · Max");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe("sk-test-key");
  });

  it("zhipu_coding：按量账户无套餐时回落查账户余额（对齐 cc-switch）", async () => {
    const { impl, calls } = fetchQueue([
      {
        match: /quota\/limit$/,
        respond: () => jsonResponse({ code: 500, msg: "当前用户不存在coding plan", success: false }),
      },
      {
        match: /query-customer-account-report$/,
        respond: () =>
          jsonResponse({
            code: 200,
            msg: "操作成功",
            success: true,
            data: { availableBalance: 14.68, balance: 14.68 },
          }),
      },
    ]);
    const result = await fetchBalance(
      makeConfig({ kind: "zhipu_coding", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" }),
      impl,
    );
    expect(result.success).toBe(true);
    expect(result.data![0].planName).toBe("智谱 GLM");
    expect(result.data![0].remaining).toBe(14.68);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe("https://open.bigmodel.cn/api/biz/account/query-customer-account-report");
  });

  it("zhipu_team：请求带 ?type=2 与组织 / 项目头；凭据缺失确定性报错", async () => {
    const { impl, calls } = fetchQueue([
      {
        match: /quota\/limit\?type=2$/,
        respond: () =>
          jsonResponse({
            success: true,
            data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: 33.0 }] },
          }),
      },
    ]);
    const result = await fetchBalance(
      makeConfig({
        kind: "zhipu_team",
        baseUrl: "https://open.bigmodel.cn",
        organizationId: "org-1",
        projectId: "proj-1",
      }),
      impl,
    );
    expect(result.success).toBe(true);
    expect(calls[0].url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["bigmodel-organization"]).toBe("org-1");
    expect(headers["bigmodel-project"]).toBe("proj-1");

    const missing = await fetchBalance(
      makeConfig({ kind: "zhipu_team", baseUrl: "https://open.bigmodel.cn", organizationId: "", projectId: "" }),
      impl,
    );
    expect(missing.success).toBe(false);
    expect(missing.errorKind).toBe("deterministic");
  });

  it("minimax：国内站走 api.minimaxi.com 域名", async () => {
    const { impl, calls } = fetchQueue([
      {
        match: /coding_plan\/remains$/,
        respond: () =>
          jsonResponse({
            model_remains: [
              { model_name: "general", current_interval_remaining_percent: 60, current_weekly_status: 3 },
            ],
            base_resp: { status_code: 0 },
          }),
      },
    ]);
    const result = await fetchBalance(makeConfig({ kind: "minimax", baseUrl: "https://api.minimax.cn" }), impl);
    expect(result.success).toBe(true);
    expect(calls[0].url).toBe("https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains");

    const global = await fetchBalance(makeConfig({ kind: "minimax", baseUrl: "https://api.minimax.io" }), impl);
    expect(global.success).toBe(true);
    expect(calls[1].url).toContain("https://api.minimax.io/");
  });

  it("opencode_go：403 表示 Key 有效但无订阅，不判 Key 失效", async () => {
    const { impl } = fetchQueue([
      { match: /zen\/go\/v1\/usage$/, respond: () => new Response("forbidden", { status: 403 }) },
    ]);
    const result = await fetchBalance(
      makeConfig({ kind: "opencode_go", baseUrl: "https://opencode.ai/inference/go/anthropic" }),
      impl,
    );
    expect(result.success).toBe(false);
    expect(result.data?.[0]?.isValid).not.toBe(false);
    expect(result.error).toContain("没有 OpenCode Go 订阅");
  });

  it("volcengine：缺 AK/SK 确定性报错；GetAFPUsage 成功直接返回并携带签名头", async () => {
    const missing = await fetchBalance(
      makeConfig({ kind: "volcengine", baseUrl: "https://ark.cn-beijing.volces.com/api/plan", accessKeyId: "", secretAccessKey: "" }),
      async () => {
        throw new Error("should not fetch");
      },
    );
    expect(missing.success).toBe(false);
    expect(missing.error).toContain("AccessKey");

    const { impl, calls } = fetchQueue([
      {
        match: /Action=GetAFPUsage/,
        respond: (_url, init) => {
          expect(init?.method).toBe("POST");
          expect((init?.headers as Record<string, string>).Authorization).toMatch(/^HMAC-SHA256 Credential=/);
          return jsonResponse({
            Result: {
              PlanType: "Large",
              AFPFiveHour: { Quota: 50, Used: 12.5, ResetTime: 1_778_806_800_000 },
              AFPWeekly: { Quota: 500, Used: 150, ResetTime: 1_779_062_400_000 },
              AFPMonthly: { Quota: 2000, Used: 850.5, ResetTime: 1_780_531_200_000 },
            },
          });
        },
      },
    ]);
    const result = await fetchBalance(
      makeConfig({
        kind: "volcengine",
        baseUrl: "https://ark.cn-beijing.volces.com/api/plan",
        accessKeyId: "AKLTtest",
        secretAccessKey: "secretkey",
      }),
      impl,
    );
    expect(result.success).toBe(true);
    expect(result.data![0].planName).toBe("5 小时窗口 · Agent Plan Large");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("https://open.volcengineapi.com/?Action=GetAFPUsage&Region=cn-beijing&Version=2024-01-01");
  });

  it("volcengine：Agent Plan 无额度时回落 GetCodingPlanUsage（双 plan 探测）", async () => {
    const { impl, calls } = fetchQueue([
      {
        match: /Action=GetAFPUsage/,
        respond: () =>
          jsonResponse({
            Result: {
              PlanType: "",
              AFPFiveHour: { Quota: 0, Used: 0 },
              AFPWeekly: { Quota: 0, Used: 0 },
              AFPMonthly: { Quota: 0, Used: 0 },
            },
          }),
      },
      {
        match: /Action=GetCodingPlanUsage/,
        respond: () =>
          jsonResponse({
            Result: {
              QuotaUsage: [
                { Level: "session", Percent: 0, ResetTimestamp: -1 },
                { Level: "weekly", Percent: 1.67, ResetTimestamp: 1_782_057_600 },
              ],
            },
          }),
      },
    ]);
    const result = await fetchBalance(
      makeConfig({
        kind: "volcengine",
        baseUrl: "https://ark.cn-beijing.volces.com/api/coding",
        accessKeyId: "AKLTtest",
        secretAccessKey: "secretkey",
      }),
      impl,
    );
    expect(result.success).toBe(true);
    expect(result.data![0].planName).toBe("5 小时窗口 · Coding Plan");
    expect(calls).toHaveLength(2);
  });

  it("volcengine：网关 400 + AccessDenied 信封判凭据失效并给出 AK/SK 引导", async () => {
    const { impl } = fetchQueue([
      {
        match: /Action=GetAFPUsage/,
        respond: () =>
          jsonResponse(
            { ResponseMetadata: { Error: { Code: "InvalidAuthorization", Message: "InvalidAuthorization" } } },
            400,
          ),
      },
    ]);
    const result = await fetchBalance(
      makeConfig({
        kind: "volcengine",
        baseUrl: "https://ark.cn-beijing.volces.com/api/plan",
        accessKeyId: "AKLTbad",
        secretAccessKey: "badsecret",
      }),
      impl,
    );
    expect(result.success).toBe(false);
    expect(result.data?.[0]?.isValid).toBe(false);
    expect(result.error).toContain("AccessKey ID / Secret");
  });

  it("command_code：串行四个 /alpha 接口，summary 带 since 与 orgId", async () => {
    const { impl, calls } = fetchQueue([
      {
        match: /\/alpha\/whoami/,
        respond: () => jsonResponse({ org: { id: "org-123" } }),
      },
      {
        match: /\/alpha\/billing\/credits/,
        respond: () =>
          jsonResponse({
            credits: { planId: "provider", monthlyCredits: 12.5, purchasedCredits: 3, freeCredits: 0.5 },
            windowLimits: {
              limited: true,
              fiveHour: { used: 4, cap: 14, resetAt: "2026-09-12T18:00:00.000Z" },
              weekly: { used: 12, cap: 40, resetAt: "2026-09-16T00:00:00.000Z" },
            },
          }),
      },
      {
        match: /\/alpha\/billing\/subscriptions/,
        respond: () =>
          jsonResponse({
            data: {
              planId: "goat",
              currentPeriodStart: "2026-09-01T00:00:00Z",
              currentPeriodEnd: "2026-10-01T00:00:00Z",
            },
          }),
      },
      {
        match: /\/alpha\/usage\/summary/,
        respond: (url) => {
          expect(url).toContain("orgId=org-123");
          expect(url).toContain("since=2026-09-01T00");
          return jsonResponse({ totalCost: 7 });
        },
      },
    ]);
    const result = await fetchBalance(
      makeConfig({ kind: "command_code", baseUrl: "https://api.commandcode.ai/provider" }),
      impl,
    );
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(3);
    expect(calls).toHaveLength(4);
    expect(calls[0].url).toContain("/alpha/whoami?limits=1");
    expect(calls[1].url).toContain("/alpha/billing/credits?orgId=org-123");
  });

  it("zenmux：直接 GET 用户配置的端点地址", async () => {
    const { impl, calls } = fetchQueue([
      {
        match: /zenmux\.io/,
        respond: () =>
          jsonResponse({
            success: true,
            data: { quota_5_hour: { usage_percentage: 0.2 }, quota_7_day: { usage_percentage: 0.4 } },
          }),
      },
    ]);
    const result = await fetchBalance(
      makeConfig({ kind: "zenmux", baseUrl: "https://api.zenmux.io/usage" }),
      impl,
    );
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(calls[0].url).toBe("https://api.zenmux.io/usage");
  });
});
