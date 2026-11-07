import { describe, expect, it } from "vitest";
import {
  detectBalanceKind,
  formatRelativeTime,
  maskApiKey,
} from "@/lib/balance";
import {
  parseDeepSeekBalance,
  parseGeneralBalance,
  parseNewapiBalance,
  parseNovitaBalance,
  parseOpenRouterBalance,
  parseSiliconflowBalance,
  parseStepfunBalance,
  parseSub2apiBalance,
  parseZhipuBalance,
} from "@/lib/balance-query";

describe("detectBalanceKind", () => {
  it("按 Base URL 识别已知供应商", () => {
    expect(detectBalanceKind("https://api.deepseek.com")).toBe("deepseek");
    expect(detectBalanceKind("https://api.deepseek.com/v1")).toBe("deepseek");
    expect(detectBalanceKind("https://api.stepfun.ai/v1")).toBe("stepfun");
    expect(detectBalanceKind("https://api.stepfun.com")).toBe("stepfun");
    expect(detectBalanceKind("https://api.siliconflow.cn/v1")).toBe("siliconflow");
    expect(detectBalanceKind("https://api.siliconflow.com/v1")).toBe("siliconflow");
    expect(detectBalanceKind("https://openrouter.ai/api/v1")).toBe("openrouter");
    expect(detectBalanceKind("https://api.novita.ai/v3")).toBe("novita");
    expect(detectBalanceKind("https://open.bigmodel.cn/api/paas/v4")).toBe("zhipu");
    expect(detectBalanceKind("https://api.z.ai/api/paas/v4")).toBe("zhipu");
  });

  it("未知地址返回 null，交由用户显式选择模板", () => {
    expect(detectBalanceKind("https://relay.example.com")).toBeNull();
    expect(detectBalanceKind("")).toBeNull();
  });
});

describe("maskApiKey", () => {
  it("长 Key 保留前 6 后 4", () => {
    expect(maskApiKey("sk-1234567890abcdef")).toBe("sk-123···cdef");
  });

  it("短 Key 只保留首尾各 2 位", () => {
    expect(maskApiKey("sk-abc")).toBe("sk···bc");
  });

  it("空 Key 返回空字符串", () => {
    expect(maskApiKey("   ")).toBe("");
  });
});

describe("formatRelativeTime", () => {
  it("按粒度输出相对时间", () => {
    const now = 1_000_000_000;
    expect(formatRelativeTime(now - 10_000, now)).toBe("刚刚");
    expect(formatRelativeTime(now - 45_000, now)).toBe("45 秒前");
    expect(formatRelativeTime(now - 120_000, now)).toBe("2 分钟前");
    expect(formatRelativeTime(now - 3 * 60 * 60_000, now)).toBe("3 小时前");
    expect(formatRelativeTime(now - 2 * 24 * 60 * 60_000, now)).toBe("2 天前");
  });
});

describe("parseDeepSeekBalance", () => {
  it("每个币种钱包一行，任一有余额时过滤空钱包", () => {
    const rows = parseDeepSeekBalance({
      is_available: true,
      balance_infos: [
        { currency: "CNY", total_balance: "110.00" },
        { currency: "USD", total_balance: "0.00" },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toMatchObject({ planName: "CNY", remaining: 110, unit: "CNY" });
  });

  it("全部钱包为空时保留行（0 余额不是 Key 失效）", () => {
    const rows = parseDeepSeekBalance({
      balance_infos: [{ currency: "CNY", total_balance: "0.00" }],
    });
    expect(rows).toHaveLength(1);
    expect(rows?.[0].remaining).toBe(0);
  });

  it("缺少 balance_infos 时返回 null", () => {
    expect(parseDeepSeekBalance({})).toBeNull();
  });
});

describe("parseStepfunBalance", () => {
  it("读取 balance 字段（CNY）", () => {
    expect(parseStepfunBalance({ balance: 25.5 })?.[0]).toMatchObject({
      remaining: 25.5,
      unit: "CNY",
    });
  });
});

describe("parseSiliconflowBalance", () => {
  it("读取 data.totalBalance，按站点决定单位", () => {
    expect(parseSiliconflowBalance({ data: { totalBalance: "12.34" } }, true)?.[0]).toMatchObject({
      remaining: 12.34,
      unit: "CNY",
    });
    expect(parseSiliconflowBalance({ data: { totalBalance: 1.5 } }, false)?.[0].unit).toBe("USD");
  });
});

describe("parseOpenRouterBalance", () => {
  it("剩余 = 总额度 - 已用", () => {
    const row = parseOpenRouterBalance({
      data: { total_credits: 100, total_usage: 37.5 },
    })?.[0];
    expect(row).toMatchObject({ remaining: 62.5, total: 100, used: 37.5, unit: "USD" });
  });
});

describe("parseNovitaBalance", () => {
  it("原始单位 0.0001 USD，除以 10000", () => {
    expect(parseNovitaBalance({ availableBalance: 250_000 })?.[0]).toMatchObject({
      remaining: 25,
      unit: "USD",
    });
  });
});

describe("parseZhipuBalance", () => {
  it("success:false 时透出 msg 作为确定性错误", () => {
    const result = parseZhipuBalance({ success: false, msg: "invalid api key" }, true);
    expect(result.success).toBe(false);
    expect(result.error).toContain("invalid api key");
    expect(result.errorKind).toBe("deterministic");
  });

  it("availableBalance 缺失时退回 balance，0 余额不判失效", () => {
    const result = parseZhipuBalance({ data: { balance: 0 } }, true);
    expect(result.success).toBe(true);
    expect(result.data?.[0]).toMatchObject({ remaining: 0, unit: "CNY", isValid: true });
  });

  it("国际站单位为 USD", () => {
    const result = parseZhipuBalance({ data: { availableBalance: "3.2" } }, false);
    expect(result.data?.[0].unit).toBe("USD");
  });
});

describe("parseNewapiBalance", () => {
  it("配额换算 500000 = $1", () => {
    const result = parseNewapiBalance({
      success: true,
      data: { quota: 1_000_000, used_quota: 500_000, group: "vip" },
    });
    expect(result.data?.[0]).toMatchObject({
      planName: "vip",
      remaining: 2,
      used: 1,
      total: 3,
      unit: "USD",
    });
  });

  it("success:false 时给出 isValid:false 与消息", () => {
    const result = parseNewapiBalance({ success: false, message: "无权访问" });
    expect(result.success).toBe(false);
    expect(result.data?.[0].isValid).toBe(false);
    expect(result.data?.[0].invalidMessage).toBe("无权访问");
  });
});

describe("parseSub2apiBalance", () => {
  it("remaining 为 -1（不限量）时不显示，quota.limit>0 时给 used/total", () => {
    const row = parseSub2apiBalance({
      isValid: true,
      remaining: -1,
      quota: { limit: 100, used: 40, unit: "USD" },
    })?.[0];
    expect(row?.remaining).toBeNull();
    expect(row).toMatchObject({ used: 40, total: 100, unit: "USD" });
  });

  it("isValid:false 透出 status", () => {
    const row = parseSub2apiBalance({ isValid: false, status: "banned" })?.[0];
    expect(row?.isValid).toBe(false);
    expect(row?.invalidMessage).toBe("banned");
  });
});

describe("parseGeneralBalance", () => {
  it("读取 balance 字段，兼容字符串数字与 is_active", () => {
    const row = parseGeneralBalance({ balance: "9.9", is_active: true })?.[0];
    expect(row).toMatchObject({ remaining: 9.9, isValid: true, unit: "USD" });
  });

  it("缺少 balance 字段返回 null", () => {
    expect(parseGeneralBalance({ foo: 1 })).toBeNull();
  });
});
