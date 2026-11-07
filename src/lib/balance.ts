/**
 * 余额查询的共享类型与纯工具（客户端可 import，不依赖服务端 API）。
 *
 * 查询端点与解析口径移植自 cc-switch（src-tauri/src/services/balance.rs
 * 与 UsageScriptModal.tsx 的 general / newapi / sub2api 模板）：
 * - UsageData 风格的 BalanceData（planName/remaining/total/used/unit/isValid）
 * - 零余额 / 负余额不判 Key 失效（cc-switch #8812 / #8175），交给 UI 红字显示
 */

export type BalanceKind =
  | "deepseek"
  | "stepfun"
  | "siliconflow"
  | "openrouter"
  | "novita"
  | "zhipu"
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
  { value: "newapi", label: "new-api 中转站", hint: "GET /api/user/self，需要 Access Token 与用户 ID" },
  { value: "sub2api", label: "Sub2API", hint: "GET /v1/usage，API Key 认证" },
  { value: "general", label: "通用模板", hint: "GET /user/balance，读取响应里的 balance 字段" },
];

/** 对齐 cc-switch detect_provider：按 Base URL 识别已知供应商，识别不到返回 null。 */
export function detectBalanceKind(baseUrl: string): BalanceKind | null {
  const url = baseUrl.toLowerCase();
  if (url.includes("api.deepseek.com")) return "deepseek";
  if (url.includes("api.stepfun.ai") || url.includes("api.stepfun.com")) return "stepfun";
  if (url.includes("api.siliconflow.cn") || url.includes("api.siliconflow.com")) return "siliconflow";
  if (url.includes("openrouter.ai")) return "openrouter";
  if (url.includes("api.novita.ai")) return "novita";
  if (url.includes("bigmodel.cn") || url.includes("api.z.ai")) return "zhipu";
  return null;
}

export function getBalanceKindLabel(kind: BalanceKind): string {
  return BALANCE_KIND_OPTIONS.find((option) => option.value === kind)?.label ?? kind;
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

/** 格式化余额数字：保留至多 4 位小数并去掉尾随零（很多接口返回 0.0001 精度）。 */
export function formatBalanceNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 10_000) / 10_000;
  return rounded.toLocaleString("zh-CN", { maximumFractionDigits: 4 });
}
