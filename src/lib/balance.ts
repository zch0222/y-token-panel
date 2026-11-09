/**
 * 余额查询的共享类型与纯工具（客户端可 import，不依赖服务端 API）。
 *
 * 查询端点与解析口径移植自 cc-switch（src-tauri/src/services/balance.rs、
 * coding_plan.rs 与 UsageScriptModal.tsx 的 general / newapi / sub2api 模板）：
 * - UsageData 风格的 BalanceData（planName/remaining/total/used/unit/isValid）
 * - coding plan 套餐额度（Kimi / GLM / MiniMax / 火山方舟 / OpenCode Go /
 *   ZenMux / Command Code），5 小时 / 周 / 月窗口以已用百分比呈现
 * - 零余额 / 负余额不判 Key 失效（cc-switch #8812 / #8175），交给 UI 红字显示
 */

export type BalanceKind =
  | "deepseek"
  | "stepfun"
  | "siliconflow"
  | "openrouter"
  | "novita"
  | "zhipu"
  | "kimi"
  | "zhipu_coding"
  | "zhipu_team"
  | "minimax"
  | "volcengine"
  | "opencode_go"
  | "zenmux"
  | "command_code"
  | "newapi"
  | "sub2api"
  | "general";

/** 单条余额数据（对齐 cc-switch UsageData；全部字段可选，仅做展示）。 */
export interface BalanceData {
  /** 套餐/钱包名，如 DeepSeek 的币种（CNY/USD）、newapi 的分组。 */
  planName?: string | null;
  /** 剩余额度。 */
  remaining?: number | null;
  /** 总额度（可选，部分供应商不提供）。 */
  total?: number | null;
  /** 已用额度（可选）。 */
  used?: number | null;
  /** 计价单位：CNY / USD / % 等。 */
  unit?: string | null;
  /** 窗口重置时间（ISO 8601）；coding plan 的 5 小时 / 周窗口使用。 */
  resetsAt?: string | null;
  /** false = Key 已失效（401/403）；null/true = 未知或有效。 */
  isValid?: boolean | null;
  invalidMessage?: string | null;
}

/** 一次查询的结果；errorKind 区分瞬时失败（网络/5xx/429）与确定性失败（4xx/解析失败）。 */
export interface BalanceResult {
  success: boolean;
  data?: BalanceData[] | null;
  error?: string | null;
  errorKind?: "transient" | "deterministic" | null;
}

/** 供应商配置（明文 Key 只存本机 balance.json，绝不下发前端）。 */
export interface BalanceProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  kind: BalanceKind;
  /** newapi 类中转站走用户系统 access token 而非 API Key。 */
  accessToken?: string;
  /** newapi 类中转站的用户 ID（请求头 New-Api-User）。 */
  userId?: string;
  /** 火山方舟控制面 OpenAPI 的 AccessKey ID（与推理 API Key 是两套凭据）。 */
  accessKeyId?: string;
  /** 火山方舟控制面 OpenAPI 的 AccessKey Secret。 */
  secretAccessKey?: string;
  /** 智谱团队版请求头 bigmodel-organization。 */
  organizationId?: string;
  /** 智谱团队版请求头 bigmodel-project。 */
  projectId?: string;
  createdAt: number;
  updatedAt: number;
}

/** 供应商的脱敏视图（GET /api/balance/providers 的返回项）。 */
export interface BalanceProviderView {
  id: string;
  name: string;
  baseUrl: string;
  kind: BalanceKind;
  kindLabel: string;
  apiKeyMasked: string;
  accessTokenMasked?: string;
  userId?: string;
  accessKeyId?: string;
  secretAccessKeyMasked?: string;
  organizationId?: string;
  projectId?: string;
  createdAt: number;
  updatedAt: number;
}

/** 上次成功快照（keep-last-good：瞬时失败期间继续展示）。 */
export interface BalanceSuccessSnapshot {
  data: BalanceData[];
  fetchedAt: number;
}

/** 每个供应商的缓存与限流状态（持久化，重启后仍生效）。 */
export interface BalanceCacheEntry {
  lastResult: BalanceResult | null;
  lastFetchedAt: number;
  lastSuccess: BalanceSuccessSnapshot | null;
  /** 距离下一次允许真实外呼的时间（防风控最小间隔）。 */
  nextEligibleAt: number;
  /** 失败冷却截止时间（瞬时 60s / 429 专属 5min）。 */
  cooldownUntil: number;
  cooldownReason: string | null;
}

export const BALANCE_KIND_OPTIONS: {
  value: BalanceKind | "auto";
  label: string;
  hint: string;
}[] = [
  { value: "auto", label: "自动检测", hint: "按 Base URL 自动匹配已知供应商，匹配不到时按通用模板查询" },
  { value: "deepseek", label: "DeepSeek", hint: "GET /user/balance，多币种钱包" },
  { value: "stepfun", label: "StepFun", hint: "GET /v1/accounts" },
  { value: "siliconflow", label: "SiliconFlow", hint: "GET /v1/user/info（.cn 为 CNY，.com 为 USD）" },
  { value: "openrouter", label: "OpenRouter", hint: "GET /api/v1/credits，剩余 = 总额度 - 已用" },
  { value: "novita", label: "Novita AI", hint: "GET /v3/user/balance" },
  { value: "zhipu", label: "智谱 / Z.ai", hint: "账户余额报表接口，Key 不带 Bearer" },
  { value: "kimi", label: "Kimi For Coding", hint: "GET {coding 根地址}/usages，5 小时与周窗口额度" },
  { value: "zhipu_coding", label: "GLM Coding Plan", hint: "GET /api/monitor/usage/quota/limit，5 小时与周窗口；有 TIME_LIMIT 时另展示 MCP 每月调用额度" },
  { value: "zhipu_team", label: "GLM Coding Plan 团队版", hint: "额度接口加 ?type=2，需组织 ID 与项目 ID" },
  { value: "minimax", label: "MiniMax Coding Plan", hint: "GET /v1/api/openplatform/coding_plan/remains，剩余百分比反转" },
  { value: "volcengine", label: "火山方舟套餐", hint: "控制面 OpenAPI（GetAFPUsage / GetCodingPlanUsage），需 AccessKey 签名" },
  { value: "opencode_go", label: "OpenCode Go", hint: "GET /zen/go/v1/usage，5 小时 / 周 / 月三窗口" },
  { value: "zenmux", label: "ZenMux", hint: "GET 用量端点，5 小时与 7 天窗口（可含美元金额）" },
  { value: "command_code", label: "Command Code", hint: "/alpha 控制面接口，月度额度与 5 小时 / 周窗口" },
  { value: "newapi", label: "new-api 中转站", hint: "GET /api/user/self，需要 Access Token 与用户 ID" },
  { value: "sub2api", label: "Sub2API", hint: "GET /v1/usage，API Key 认证" },
  { value: "general", label: "通用模板", hint: "GET /user/balance，读取响应里的 balance 字段" },
];

/** 对齐 cc-switch codex_url_host_matches_any：hostname 与候选完全相等才算命中。 */
function urlHostMatchesAny(baseUrl: string, hosts: string[]): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    host = baseUrl.toLowerCase();
  }
  return hosts.some((candidate) => host === candidate);
}

/**
 * 对齐 cc-switch detect_provider：按 Base URL 识别已知供应商，识别不到返回 null。
 * 智谱 Coding Plan（zhipu_coding / zhipu_team）与账户余额（zhipu）共用域名，
 * 无法靠地址区分，不参与自动检测，需在预设里显式选择。
 */
export function detectBalanceKind(baseUrl: string): BalanceKind | null {
  const url = baseUrl.toLowerCase();
  if (url.includes("api.deepseek.com")) return "deepseek";
  if (url.includes("api.stepfun.ai") || url.includes("api.stepfun.com")) return "stepfun";
  if (url.includes("api.siliconflow.cn") || url.includes("api.siliconflow.com")) return "siliconflow";
  if (url.includes("openrouter.ai")) return "openrouter";
  if (url.includes("api.novita.ai")) return "novita";
  if (url.includes("bigmodel.cn") || url.includes("api.z.ai")) return "zhipu";
  if (url.includes("api.kimi.com/coding") || url.includes("api.kimi.ai/coding")) return "kimi";
  if (urlHostMatchesAny(url, ["api.minimaxi.com", "api.minimax.cn", "api.minimax.io"])) {
    return "minimax";
  }
  if (url.includes("opencode.ai/zen/go") || url.includes("opencode.ai/inference/go")) {
    // Zen 按量版（/zen/v1、/inference/v1）没有用量 API，刻意不命中。
    return "opencode_go";
  }
  if (url.includes("zenmux")) return "zenmux";
  if (url.includes("api.commandcode.ai/provider")) return "command_code";
  if (url.includes("volces.com/api/plan") || url.includes("volces.com/api/coding")) {
    // 仅命中 Agent Plan（/api/plan）与 Coding Plan（/api/coding）入口；
    // 按量付费走 /api/v3 与 /api/compatible，没有套餐额度。
    return "volcengine";
  }
  return null;
}

export function getBalanceKindLabel(kind: BalanceKind): string {
  return BALANCE_KIND_OPTIONS.find((option) => option.value === kind)?.label ?? kind;
}

// ── 供应商预设（添加面板用，对齐 cc-switch 的 ProviderPreset 思路）─────────────

/** 同一供应商的站点变体（如国内 / 国际站），切换变体时同步锁定的 Base URL。 */
export interface BalancePresetVariant {
  id: string;
  label: string;
  baseUrl: string;
}

/**
 * 供应商预设：固定厂商（DeepSeek 等）的地址自动填充且不可编辑；
 * new-api / Sub2API / ZenMux 这类自建站点地址由用户填写。
 */
export interface BalanceProviderPreset {
  id: string;
  kind: BalanceKind;
  label: string;
  /** 选择列表与预设条里的副标题（域名或说明）。 */
  domain: string;
  /** 固定厂商的锁定地址；null = 地址由用户填写。 */
  baseUrl: string | null;
  /** 站点变体；有变体时锁定地址以所选变体为准。 */
  variants?: BalancePresetVariant[];
  /**
   * false = 锁定地址与其它 kind 共用域名（如智谱 Coding Plan 与账户余额），
   * detectBalanceKind 无法区分，不参与自动检测，只能显式选择。
   */
  autoDetect?: boolean;
  /** 该供应商的凭据表单需求。 */
  fields: {
    /** 推理 API Key；optional = 仅作记录，none = 不需要。 */
    apiKey: "required" | "optional" | "none";
    /** new-api 需要用户系统 Access Token 而非 API Key。 */
    accessToken: boolean;
    /** new-api 请求头 New-Api-User。 */
    userId: boolean;
    /** 火山方舟控制面 AccessKey ID。 */
    accessKeyId: boolean;
    /** 火山方舟控制面 AccessKey Secret。 */
    secretAccessKey: boolean;
    /** 智谱团队版请求头 bigmodel-organization。 */
    organizationId: boolean;
    /** 智谱团队版请求头 bigmodel-project。 */
    projectId: boolean;
  };
  hint: string;
}

/** 无额外凭据需求的默认表单（绝大多数供应商只要一把 API Key）。 */
const API_KEY_FIELDS = {
  apiKey: "required",
  accessToken: false,
  userId: false,
  accessKeyId: false,
  secretAccessKey: false,
  organizationId: false,
  projectId: false,
} as const;

/** 添加面板的预设列表：固定厂商在前，自建站点在后。 */
export const BALANCE_PROVIDER_PRESETS: BalanceProviderPreset[] = [
  {
    id: "deepseek",
    kind: "deepseek",
    label: "DeepSeek",
    domain: "api.deepseek.com",
    baseUrl: "https://api.deepseek.com",
    fields: API_KEY_FIELDS,
    hint: "GET /user/balance，多币种钱包",
  },
  {
    id: "siliconflow",
    kind: "siliconflow",
    label: "SiliconFlow",
    domain: "siliconflow.cn / .com",
    baseUrl: null,
    variants: [
      { id: "siliconflow-cn", label: "国内站（CNY）", baseUrl: "https://api.siliconflow.cn" },
      { id: "siliconflow-com", label: "国际站（USD）", baseUrl: "https://api.siliconflow.com" },
    ],
    fields: API_KEY_FIELDS,
    hint: "GET /v1/user/info，按站点显示 CNY / USD",
  },
  {
    id: "zhipu",
    kind: "zhipu",
    label: "智谱 / Z.ai",
    domain: "bigmodel.cn / z.ai",
    baseUrl: null,
    variants: [
      { id: "zhipu-cn", label: "国内站（CNY）", baseUrl: "https://open.bigmodel.cn" },
      { id: "zhipu-com", label: "国际站（USD）", baseUrl: "https://api.z.ai" },
    ],
    fields: API_KEY_FIELDS,
    hint: "账户余额报表接口，Key 不带 Bearer",
  },
  {
    id: "kimi",
    kind: "kimi",
    label: "Kimi For Coding",
    domain: "api.kimi.com / api.kimi.ai",
    baseUrl: null,
    variants: [
      { id: "kimi-cn", label: "国内站", baseUrl: "https://api.kimi.com/coding/v1" },
      { id: "kimi-global", label: "国际站", baseUrl: "https://api.kimi.ai/coding/v1" },
    ],
    fields: API_KEY_FIELDS,
    hint: "GET /usages，展示 5 小时与周窗口额度",
  },
  {
    id: "zhipu_coding",
    kind: "zhipu_coding",
    label: "GLM Coding Plan",
    domain: "bigmodel.cn / z.ai",
    baseUrl: null,
    autoDetect: false,
    variants: [
      { id: "zhipu-cn-coding", label: "国内站", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" },
      { id: "zhipu-com-coding", label: "国际站", baseUrl: "https://api.z.ai/api/coding/paas/v4" },
    ],
    fields: API_KEY_FIELDS,
    hint: "套餐额度接口（quota/limit），按量账户无套餐时自动回落查余额",
  },
  {
    id: "zhipu_team",
    kind: "zhipu_team",
    label: "GLM Coding Plan 团队版",
    domain: "open.bigmodel.cn（仅国内站）",
    baseUrl: "https://open.bigmodel.cn",
    autoDetect: false,
    fields: {
      apiKey: "required",
      accessToken: false,
      userId: false,
      accessKeyId: false,
      secretAccessKey: false,
      organizationId: true,
      projectId: true,
    },
    hint: "额度接口加 ?type=2，需要 API Key + 组织 ID + 项目 ID",
  },
  {
    id: "minimax",
    kind: "minimax",
    label: "MiniMax Coding Plan",
    domain: "api.minimaxi.com / api.minimax.io",
    baseUrl: null,
    variants: [
      { id: "minimax-cn", label: "国内站", baseUrl: "https://api.minimaxi.com" },
      { id: "minimax-global", label: "国际站", baseUrl: "https://api.minimax.io" },
    ],
    fields: API_KEY_FIELDS,
    hint: "GET /v1/api/openplatform/coding_plan/remains，剩余百分比反转为已用",
  },
  {
    id: "volcengine",
    kind: "volcengine",
    label: "火山方舟套餐",
    domain: "ark.cn-beijing.volces.com",
    baseUrl: null,
    variants: [
      { id: "volc-agent", label: "Agent Plan 入口", baseUrl: "https://ark.cn-beijing.volces.com/api/plan" },
      { id: "volc-coding", label: "Coding Plan 入口", baseUrl: "https://ark.cn-beijing.volces.com/api/coding" },
    ],
    fields: {
      apiKey: "none",
      accessToken: false,
      userId: false,
      accessKeyId: true,
      secretAccessKey: true,
      organizationId: false,
      projectId: false,
    },
    hint: "控制面 OpenAPI 自动探测 Agent Plan / Coding Plan，需账号 AccessKey（非推理 Key）",
  },
  {
    id: "opencode_go",
    kind: "opencode_go",
    label: "OpenCode Go",
    domain: "opencode.ai",
    baseUrl: "https://opencode.ai/inference/go/anthropic",
    fields: API_KEY_FIELDS,
    hint: "GET /zen/go/v1/usage，5 小时 / 周 / 月三窗口已用百分比",
  },
  {
    id: "command_code",
    kind: "command_code",
    label: "Command Code",
    domain: "api.commandcode.ai",
    baseUrl: "https://api.commandcode.ai/provider",
    fields: API_KEY_FIELDS,
    hint: "/alpha 控制面接口，月度额度与 5 小时 / 周窗口",
  },
  {
    id: "openrouter",
    kind: "openrouter",
    label: "OpenRouter",
    domain: "openrouter.ai",
    baseUrl: "https://openrouter.ai",
    fields: API_KEY_FIELDS,
    hint: "GET /api/v1/credits，剩余 = 总额度 - 已用",
  },
  {
    id: "novita",
    kind: "novita",
    label: "Novita AI",
    domain: "api.novita.ai",
    baseUrl: "https://api.novita.ai",
    fields: API_KEY_FIELDS,
    hint: "GET /v3/user/balance",
  },
  {
    id: "stepfun",
    kind: "stepfun",
    label: "StepFun",
    domain: "api.stepfun.com",
    baseUrl: "https://api.stepfun.com",
    fields: API_KEY_FIELDS,
    hint: "GET /v1/accounts",
  },
  {
    id: "newapi",
    kind: "newapi",
    label: "new-api 中转站",
    domain: "自建站点，地址自定义",
    baseUrl: null,
    fields: {
      apiKey: "optional",
      accessToken: true,
      userId: true,
      accessKeyId: false,
      secretAccessKey: false,
      organizationId: false,
      projectId: false,
    },
    hint: "GET /api/user/self，需要 Access Token 与用户 ID",
  },
  {
    id: "sub2api",
    kind: "sub2api",
    label: "Sub2API",
    domain: "自建站点，地址自定义",
    baseUrl: null,
    fields: API_KEY_FIELDS,
    hint: "GET /v1/usage，API Key 认证",
  },
  {
    id: "zenmux",
    kind: "zenmux",
    label: "ZenMux",
    domain: "自建站点，地址自定义",
    baseUrl: null,
    fields: API_KEY_FIELDS,
    hint: "GET 用量端点（地址即查询端点），5 小时与 7 天窗口",
  },
];

export function getBalancePreset(presetId: string): BalanceProviderPreset | undefined {
  return BALANCE_PROVIDER_PRESETS.find((preset) => preset.id === presetId);
}

/** 预设当前生效的锁定地址（无变体即自身；可编辑预设返回 null）。 */
export function resolvePresetBaseUrl(
  preset: BalanceProviderPreset,
  variantId: string,
): string | null {
  if (preset.variants) {
    return preset.variants.find((variant) => variant.id === variantId)?.baseUrl
      ?? preset.variants[0]?.baseUrl
      ?? null;
  }
  return preset.baseUrl;
}

/** 是否为固定厂商预设（地址自动填充并锁定）。 */
export function isFixedBalancePreset(preset: BalanceProviderPreset): boolean {
  return resolvePresetBaseUrl(preset, "") !== null;
}

function urlHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/**
 * 编辑回填：按已存 kind + Base URL 反查预设与站点变体。
 * 通用模板或未知 kind 返回 null（表单落在「自定义」）。
 */
export function matchBalancePreset(
  kind: BalanceKind,
  baseUrl: string,
): { presetId: string; variantId: string } | null {
  const preset = BALANCE_PROVIDER_PRESETS.find((item) => item.kind === kind);
  if (!preset) return null;
  if (!preset.variants) {
    return { presetId: preset.id, variantId: preset.id };
  }
  // 有站点变体的（SiliconFlow / 智谱）：按地址里的域名匹配，匹配不到取第一个。
  const variant =
    preset.variants.find((item) => baseUrl.toLowerCase().includes(urlHost(item.baseUrl)))
    ?? preset.variants[0];
  return { presetId: preset.id, variantId: variant.id };
}

/** 地址是否为某个预设（或其站点变体）自动填充的锁定值。 */
export function isPresetLockedBaseUrl(baseUrl: string): boolean {
  return BALANCE_PROVIDER_PRESETS.some(
    (preset) =>
      (preset.baseUrl !== null && preset.baseUrl === baseUrl)
      || preset.variants?.some((variant) => variant.baseUrl === baseUrl) === true,
  );
}

/** 脱敏：保留前 6 后 4，中间以 ··· 代替；过短的 Key 只保留首尾各 2 位。 */
export function maskApiKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 10) {
    return `${trimmed.slice(0, 2)}···${trimmed.slice(-2)}`;
  }
  return `${trimmed.slice(0, 6)}···${trimmed.slice(-4)}`;
}

/** 相对时间：刚刚 / N 秒前 / N 分钟前 / N 小时前 / N 天前（展示粒度 30s）。 */
export function formatRelativeTime(ms: number, now = Date.now()): string {
  const delta = Math.max(0, now - ms);
  if (delta < 30_000) return "刚刚";
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

/** 窗口重置倒计时（coding plan 的 resetsAt）：已过期或无法解析返回 null。 */
export function formatResetCountdown(resetsAt: string, now = Date.now()): string | null {
  const target = Date.parse(resetsAt);
  if (!Number.isFinite(target)) return null;
  const delta = target - now;
  if (delta <= 0) return null;
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds} 秒后重置`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟后重置`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分后重置`;
  const days = Math.floor(hours / 24);
  return `${days} 天 ${hours % 24} 小时后重置`;
}

/** 格式化余额数字：保留至多 4 位小数并去掉尾随零（很多接口返回 0.0001 精度）。 */
export function formatBalanceNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 10_000) / 10_000;
  return rounded.toLocaleString("zh-CN", { maximumFractionDigits: 4 });
}
