import { describe, expect, it } from "vitest";
import {
  BALANCE_PROVIDER_PRESETS,
  detectBalanceKind,
  formatRelativeTime,
  isPresetLockedBaseUrl,
  matchBalancePreset,
  maskApiKey,
  resolvePresetBaseUrl,
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

  it("识别 coding plan 供应商（对齐 cc-switch detect_provider）", () => {
    expect(detectBalanceKind("https://api.kimi.com/coding/v1")).toBe("kimi");
    expect(detectBalanceKind("https://api.kimi.ai/coding/v1/chat/completions")).toBe("kimi");
    // 不带 /coding 的 Kimi 地址不是编程套餐入口
    expect(detectBalanceKind("https://api.kimi.com/v1")).toBeNull();

    expect(detectBalanceKind("https://api.minimaxi.com/v1")).toBe("minimax");
    expect(detectBalanceKind("https://api.minimax.cn/anthropic")).toBe("minimax");
    expect(detectBalanceKind("https://api.minimax.io/v1")).toBe("minimax");
    // hostname 精确匹配：后缀域名不算命中（对齐 cc-switch codex_url_host_matches_any）
    expect(detectBalanceKind("https://api.minimax.cn.example.com/v1")).toBeNull();
    expect(detectBalanceKind("https://api.minimax.io.example.com/v1")).toBeNull();

    expect(detectBalanceKind("https://opencode.ai/inference/go/anthropic")).toBe("opencode_go");
    expect(detectBalanceKind("https://opencode.ai/inference/go/v1")).toBe("opencode_go");
    expect(detectBalanceKind("https://opencode.ai/zen/go")).toBe("opencode_go");
    expect(detectBalanceKind("https://opencode.ai/zen/go/v1")).toBe("opencode_go");
    // Zen 按量版没有用量 API，不得命中
    expect(detectBalanceKind("https://opencode.ai/zen/v1")).toBeNull();
    expect(detectBalanceKind("https://opencode.ai/inference/v1")).toBeNull();

    expect(detectBalanceKind("https://api.commandcode.ai/provider")).toBe("command_code");
    expect(detectBalanceKind("https://api.commandcode.ai/provider/v1")).toBe("command_code");
    expect(detectBalanceKind("https://commandcode.ai/provider")).toBeNull();

    expect(detectBalanceKind("https://ark.cn-beijing.volces.com/api/plan/v3")).toBe("volcengine");
    expect(detectBalanceKind("https://ark.cn-beijing.volces.com/api/coding")).toBe("volcengine");
    // 按量付费入口没有套餐额度
    expect(detectBalanceKind("https://ark.cn-beijing.volces.com/api/v3")).toBeNull();

    expect(detectBalanceKind("https://api.zenmux.io/usage")).toBe("zenmux");
  });

  it("智谱 Coding Plan 与账户余额共用域名，检测仍归 zhipu（需预设显式区分）", () => {
    expect(detectBalanceKind("https://open.bigmodel.cn/api/coding/paas/v4")).toBe("zhipu");
    expect(detectBalanceKind("https://api.z.ai/api/coding/paas/v4")).toBe("zhipu");
  });
});

describe("BALANCE_PROVIDER_PRESETS", () => {
  it("id 唯一，锁定地址互不重复且以 https 开头", () => {
    const ids = new Set(BALANCE_PROVIDER_PRESETS.map((preset) => preset.id));
    expect(ids.size).toBe(BALANCE_PROVIDER_PRESETS.length);
    const urlKinds = new Map<string, Set<string>>();
    for (const preset of BALANCE_PROVIDER_PRESETS) {
      const urls =
        preset.variants?.map((variant) => variant.baseUrl) ?? (preset.baseUrl ? [preset.baseUrl] : []);
      for (const url of urls) {
        const kinds = urlKinds.get(url) ?? new Set<string>();
        kinds.add(preset.kind);
        urlKinds.set(url, kinds);
      }
    }
    // 智谱家族（余额 / Coding Plan / 团队版）是同一站点的不同套餐，允许共用地址；
    // 其余供应商的锁定地址必须互不重复。
    const zhipuFamily = new Set(["zhipu", "zhipu_coding", "zhipu_team"]);
    for (const [url, kinds] of urlKinds) {
      expect(url.startsWith("https://")).toBe(true);
      if (kinds.size > 1) {
        for (const kind of kinds) expect(zhipuFamily.has(kind)).toBe(true);
      }
    }
  });

  it("每个 kind 恰好有一个预设，查询端点能按预设地址复现", () => {
    for (const preset of BALANCE_PROVIDER_PRESETS) {
      const sameKind = BALANCE_PROVIDER_PRESETS.filter((item) => item.kind === preset.kind);
      expect(sameKind).toHaveLength(1);
      const baseUrl = resolvePresetBaseUrl(preset, preset.variants?.[0].id ?? preset.id);
      // autoDetect: false 的预设（智谱 Coding Plan 系）与余额模板共用域名，跳过检测断言
      if (baseUrl !== null && preset.autoDetect !== false) {
        expect(detectBalanceKind(baseUrl)).toBe(preset.kind);
      }
    }
  });
});

describe("matchBalancePreset", () => {
  it("固定厂商按 kind 反查预设", () => {
    expect(matchBalancePreset("deepseek", "https://api.deepseek.com")).toEqual({
      presetId: "deepseek",
      variantId: "deepseek",
    });
    expect(matchBalancePreset("newapi", "https://relay.example.com")).toEqual({
      presetId: "newapi",
      variantId: "newapi",
    });
  });

  it("有站点变体的按地址域名选变体，匹配不到取第一个", () => {
    expect(matchBalancePreset("siliconflow", "https://api.siliconflow.cn/v1")).toEqual({
      presetId: "siliconflow",
      variantId: "siliconflow-cn",
    });
    expect(matchBalancePreset("zhipu", "https://api.z.ai/api/paas/v4")).toEqual({
      presetId: "zhipu",
      variantId: "zhipu-com",
    });
    expect(matchBalancePreset("siliconflow", "https://unknown.example.com")).toEqual({
      presetId: "siliconflow",
      variantId: "siliconflow-cn",
    });
  });

  it("通用模板返回 null（表单落在自定义）", () => {
    expect(matchBalancePreset("general", "https://api.example.com")).toBeNull();
  });
});

describe("isPresetLockedBaseUrl", () => {
  it("命中预设或变体的锁定地址", () => {
    expect(isPresetLockedBaseUrl("https://api.deepseek.com")).toBe(true);
    expect(isPresetLockedBaseUrl("https://api.siliconflow.com")).toBe(true);
    expect(isPresetLockedBaseUrl("https://open.bigmodel.cn")).toBe(true);
    expect(isPresetLockedBaseUrl("https://relay.example.com")).toBe(false);
    expect(isPresetLockedBaseUrl("")).toBe(false);
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
