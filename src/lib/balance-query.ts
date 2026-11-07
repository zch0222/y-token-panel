import "server-only";
import type {
  BalanceData,
  BalanceKind,
  BalanceProviderConfig,
  BalanceResult,
} from "@/lib/balance";
import { QUERY_TIMEOUT_MS } from "@/lib/balance-throttle";

/**
 * 各供应商余额查询实现，端点与解析口径移植自 cc-switch：
 * - 原生余额（balance.rs）：DeepSeek / StepFun / SiliconFlow / OpenRouter / Novita / 智谱
 * - 通用模板（UsageScriptModal.tsx）：newapi / sub2api / general
 *
 * 错误语义对齐 cc-switch 的「瞬时 vs 确定性」二分：
 * - fetch 抛错（网络 / 超时）与 HTTP 429、5xx → errorKind "transient"
 *   （上层保留上次成功值并进入冷却，不透传旧额度）；
 * - 401/403 → data[0].isValid=false「Key 已失效」，errorKind "deterministic"；
 * - 其他非 2xx 与响应解析失败 → errorKind "deterministic"，立即透出。
 * 零余额 / 负余额不判 Key 失效（cc-switch #8812 / #8175），交给 UI 红字显示。
 */

type FetchLike = typeof fetch;

const USER_AGENT = "y-token-panel/1.0";

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/** 对齐 cc-switch parse_f64_field：兼容数字与字符串两种格式。 */
function parseNumberField(
  obj: Record<string, unknown> | null | undefined,
  field: string,
): number | null {
  const value = obj?.[field];
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function ok(data: BalanceData[] | null): BalanceResult {
  return { success: true, data, error: null, errorKind: null };
}

function transientError(message: string): BalanceResult {
  return { success: false, data: null, error: message, errorKind: "transient" };
}

function deterministicError(message: string): BalanceResult {
  return { success: false, data: null, error: message, errorKind: "deterministic" };
}

/** 对齐 cc-switch make_auth_error：401/403 不算查询失败，而是 Key 失效信号。 */
function authError(status: number): BalanceResult {
  return {
    success: false,
    data: [
      {
        isValid: false,
        invalidMessage: `Key 已失效（HTTP ${status}），请检查后重新保存`,
      },
    ],
    error: `Authentication failed (HTTP ${status})`,
    errorKind: "deterministic",
  };
}

/** 对齐 cc-switch 智谱口径：success:false 时把 msg 透出为确定性错误。 */
function apiErrorMessage(message: string): BalanceResult {
  return deterministicError(`API error: ${message}`);
}

// ── 各供应商响应解析（纯函数，可单测） ────────────────────────

/** DeepSeek：多币种钱包各一行；任一钱包有余额时过滤空钱包（cc-switch #8170）。 */
export function parseDeepSeekBalance(body: unknown): BalanceData[] | null {
  const infos = (body as Record<string, unknown> | null)?.balance_infos;
  if (!Array.isArray(infos)) return null;
  let rows: BalanceData[] = infos.map((info) => {
    const currency =
      typeof (info as Record<string, unknown>)?.currency === "string"
        ? String((info as Record<string, unknown>).currency)
        : "CNY";
    return {
      planName: currency,
      remaining: parseNumberField(info as Record<string, unknown>, "total_balance"),
      total: null,
      used: null,
      unit: currency,
      isValid: true,
      invalidMessage: null,
    };
  });
  if (rows.some((row) => (row.remaining ?? 0) > 0)) {
    rows = rows.filter((row) => (row.remaining ?? 0) > 0);
  }
  return rows.length > 0 ? rows : null;
}

export function parseStepfunBalance(body: unknown): BalanceData[] | null {
  const obj = body as Record<string, unknown> | null;
  const balance = parseNumberField(obj, "balance");
  if (balance === null) return null;
  return [
    { planName: null, remaining: balance, total: null, used: null, unit: "CNY", isValid: true, invalidMessage: null },
  ];
}

/** SiliconFlow：.cn 站 CNY、.com 站 USD，读 data.totalBalance。 */
export function parseSiliconflowBalance(body: unknown, isCN: boolean): BalanceData[] | null {
  const data = (body as Record<string, unknown> | null)?.data as Record<string, unknown> | null;
  const balance = parseNumberField(data, "totalBalance");
  if (balance === null) return null;
  return [
    {
      planName: null,
      remaining: balance,
      total: null,
      used: null,
      unit: isCN ? "CNY" : "USD",
      isValid: true,
      invalidMessage: null,
    },
  ];
}

/** OpenRouter：remaining = total_credits - total_usage。 */
export function parseOpenRouterBalance(body: unknown): BalanceData[] | null {
  const data = (body as Record<string, unknown> | null)?.data as Record<string, unknown> | null;
  const total = parseNumberField(data, "total_credits");
  const used = parseNumberField(data, "total_usage");
  if (total === null && used === null) return null;
  return [
    {
      planName: null,
      remaining: total !== null && used !== null ? total - used : null,
      total,
      used,
      unit: "USD",
      isValid: true,
      invalidMessage: null,
    },
  ];
}

/** Novita：原始单位 0.0001 USD（除以 10000）。 */
export function parseNovitaBalance(body: unknown): BalanceData[] | null {
  const available = parseNumberField(body as Record<string, unknown> | null, "availableBalance");
  if (available === null) return null;
  return [
    {
      planName: null,
      remaining: available / 10_000,
      total: null,
      used: null,
      unit: "USD",
      isValid: true,
      invalidMessage: null,
    },
  ];
}

/** 智谱：success:false 透出 msg；availableBalance 缺失时退回 balance；0 余额不判失效。 */
export function parseZhipuBalance(body: unknown, isCN: boolean): BalanceResult {
  const obj = body as Record<string, unknown> | null;
  if (obj?.success === false) {
    const message = typeof obj.msg === "string" ? obj.msg : "Unknown error";
    return apiErrorMessage(message);
  }
  const data =
    obj && typeof obj.data === "object" && obj.data !== null
      ? (obj.data as Record<string, unknown>)
      : obj;
  const available =
    parseNumberField(data, "availableBalance") ?? parseNumberField(data, "balance");
  if (available === null) {
    return deterministicError("Missing or invalid Zhipu balance");
  }
  return ok([
    {
      planName: isCN ? "智谱 GLM" : "Z.ai",
      remaining: available,
      total: null,
      used: null,
      unit: isCN ? "CNY" : "USD",
      isValid: true,
      invalidMessage: null,
    },
  ]);
}

/** new-api 中转站：配额换算 500000 = $1。 */
export function parseNewapiBalance(body: unknown): BalanceResult {
  const obj = body as Record<string, unknown> | null;
  const data = obj?.data as Record<string, unknown> | null;
  if (obj?.success && data) {
    const quota = parseNumberField(data, "quota") ?? 0;
    const usedQuota = parseNumberField(data, "used_quota") ?? 0;
    return ok([
      {
        planName: typeof data.group === "string" && data.group ? data.group : null,
        remaining: quota / 500_000,
        used: usedQuota / 500_000,
        total: (quota + usedQuota) / 500_000,
        unit: "USD",
        isValid: true,
        invalidMessage: null,
      },
    ]);
  }
  return {
    success: false,
    data: [
      {
        isValid: false,
        invalidMessage:
          typeof obj?.message === "string" && obj.message ? obj.message : "查询失败",
      },
    ],
    error: typeof obj?.message === "string" && obj.message ? obj.message : "查询失败",
    errorKind: "deterministic",
  };
}

/** Sub2API：remaining 为 -1（不限量）时不显示；quota.limit>0 时给 used/total。 */
export function parseSub2apiBalance(body: unknown): BalanceData[] | null {
  const obj = body as Record<string, unknown> | null;
  const quota = obj?.quota as Record<string, unknown> | null;
  const row: BalanceData = {
    planName: typeof obj?.planName === "string" ? obj.planName : null,
    remaining: null,
    total: null,
    used: null,
    unit: (typeof obj?.unit === "string" && obj.unit) || (typeof quota?.unit === "string" && quota.unit) || "USD",
    isValid: obj?.isValid !== false,
    invalidMessage:
      obj?.isValid === false
        ? typeof obj?.status === "string"
          ? obj.status
          : "查询失败"
        : null,
  };
  if (typeof obj?.remaining === "number" && obj.remaining >= 0) {
    row.remaining = obj.remaining;
  }
  const limit = parseNumberField(quota, "limit");
  if (limit !== null && limit > 0) {
    row.used = parseNumberField(quota, "used");
    row.total = limit;
  }
  return [row];
}

/** 通用模板：读响应里的 balance 字段，is_active 缺省视为有效。 */
export function parseGeneralBalance(body: unknown): BalanceData[] | null {
  const obj = body as Record<string, unknown> | null;
  if (obj === null) return null;
  if (typeof obj.balance !== "number" && typeof obj.balance !== "string") return null;
  const balance = parseNumberField(obj, "balance");
  return [
    {
      planName: null,
      remaining: balance,
      total: parseNumberField(obj, "total"),
      used: parseNumberField(obj, "used"),
      unit: typeof obj.unit === "string" ? obj.unit : "USD",
      isValid: obj.is_active === undefined ? true : Boolean(obj.is_active),
      invalidMessage: null,
    },
  ];
}

// ── 请求构造 ────────────────────────────────────────────────

interface QueryPlan {
  url: string;
  headers: Record<string, string>;
  /** 拿到 2xx 响应体后的解析器；返回 null 表示字段缺失。 */
  parse(body: unknown): BalanceResult;
}

function buildQueryPlan(config: BalanceProviderConfig): QueryPlan {
  const base = normalizeBaseUrl(config.baseUrl);
  const apiKey = config.apiKey.trim();
  const bearerHeaders: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
    Authorization: `Bearer ${apiKey}`,
  };

  switch (config.kind) {
    case "deepseek":
      return {
        url: "https://api.deepseek.com/user/balance",
        headers: bearerHeaders,
        parse: (body) => ok(parseDeepSeekBalance(body)),
      };
    case "stepfun":
      return {
        url: "https://api.stepfun.com/v1/accounts",
        headers: bearerHeaders,
        parse: (body) => ok(parseStepfunBalance(body)),
      };
    case "siliconflow": {
      const isCN = base.toLowerCase().includes("siliconflow.cn");
      return {
        url: `${base}/v1/user/info`,
        headers: bearerHeaders,
        parse: (body) => ok(parseSiliconflowBalance(body, isCN)),
      };
    }
    case "openrouter":
      return {
        url: `${base}/api/v1/credits`,
        headers: bearerHeaders,
        parse: (body) => ok(parseOpenRouterBalance(body)),
      };
    case "novita":
      return {
        url: `${base}/v3/user/balance`,
        headers: bearerHeaders,
        parse: (body) => ok(parseNovitaBalance(body)),
      };
    case "zhipu": {
      // 对齐 cc-switch：cn/international 两个固定 host，Key 不带 Bearer。
      const isCN = base.toLowerCase().includes("bigmodel.cn");
      const host = isCN ? "https://open.bigmodel.cn" : "https://api.z.ai";
      return {
        url: `${host}/api/biz/account/query-customer-account-report`,
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          Authorization: apiKey,
          "Accept-Language": "en-US,en",
        },
        parse: (body) => parseZhipuBalance(body, isCN),
      };
    }
    case "newapi": {
      const accessToken = (config.accessToken ?? "").trim();
      const userId = (config.userId ?? "").trim();
      return {
        url: `${base}/api/user/self`,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          Authorization: `Bearer ${accessToken}`,
          "New-Api-User": userId,
        },
        parse: (body) => parseNewapiBalance(body),
      };
    }
    case "sub2api": {
      // 供应商地址带不带 /v1 都拼出同一个地址（对齐 cc-switch SUB2API 模板）。
      const host = base.replace(/\/v1$/, "");
      return {
        url: `${host}/v1/usage`,
        headers: bearerHeaders,
        parse: (body) => ok(parseSub2apiBalance(body)),
      };
    }
    case "general":
    default:
      return {
        url: `${base}/user/balance`,
        headers: bearerHeaders,
        parse: (body) => ok(parseGeneralBalance(body)),
      };
  }
}

/**
 * 查询单个供应商余额。fetchImpl 可注入便于测试；网络 / 超时 / 5xx / 429 一律
 * 返回 transient 结果（不抛异常），由上层限流器决定重试与冷却。
 */
export async function fetchBalance(
  config: BalanceProviderConfig,
  fetchImpl: FetchLike = fetch,
): Promise<BalanceResult> {
  if (!config.apiKey.trim() && config.kind !== "newapi") {
    return deterministicError("缺少 API Key");
  }
  if (config.kind === "newapi" && !(config.accessToken ?? "").trim()) {
    return deterministicError("new-api 中转站需要在设置里填写 Access Token（与用户 ID）");
  }

  const plan = buildQueryPlan(config);

  let response: Response;
  try {
    response = await fetchImpl(plan.url, {
      method: "GET",
      headers: plan.headers,
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isAbort = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return transientError(isAbort ? `Network error: 请求超时（${QUERY_TIMEOUT_MS / 1000}s）` : `Network error: ${message}`);
  }

  const status = response.status;
  if (status === 401 || status === 403) {
    return authError(status);
  }
  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    const snippet = bodyText.slice(0, 200).trim();
    const message = `API error (HTTP ${status})${snippet ? `: ${snippet}` : ""}`;
    // 429 与 5xx 是瞬时失败（供应商限流 / 抖动），其余 4xx 视为确定性失败。
    return status === 429 || status >= 500 ? transientError(message) : deterministicError(message);
  }

  // 对齐 cc-switch「先读体再解析」：读体失败（连接中断）算瞬时，解析失败才算确定性。
  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return transientError(`Failed to read response: ${message}`);
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return deterministicError(`Failed to parse response: ${bodyText.slice(0, 120) || "空响应"}`);
  }

  return plan.parse(body);
}

/** 供测试与类型收口：kind → 是否需要 newapi 专属凭据。 */
export function requiresNewapiCredentials(kind: BalanceKind): boolean {
  return kind === "newapi";
}
