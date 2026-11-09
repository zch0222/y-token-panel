import "server-only";
import { createHash, createHmac } from "node:crypto";
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
 * - 编程套餐额度（coding_plan.rs）：Kimi / GLM Coding Plan（个人 + 团队）/ MiniMax /
 *   火山方舟 Agent·Coding Plan / OpenCode Go / ZenMux / Command Code
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

/** 对齐 cc-switch extract_reset_time：字符串直通（ISO 8601）；数字自动区分秒 / 毫秒，0 / 负值视为无重置。 */
function extractResetTime(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0) return null;
    const ms = value < 1_000_000_000_000 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  return null;
}

/** 限定额窗口的展示名（对齐 cc-switch TIER_FIVE_HOUR / TIER_WEEKLY_LIMIT / TIER_MONTHLY）。 */
const WINDOW_LABELS = {
  fiveHour: "5 小时窗口",
  weekly: "周窗口",
  monthly: "月窗口",
  monthlyTools: "MCP 每月额度",
} as const;

/** 只有已用百分比的窗口（智谱 / MiniMax / OpenCode Go / 火山 Coding Plan）：以 0-100 呈现。 */
function percentRow(planName: string, utilization: number, resetsAt: string | null): BalanceData {
  return {
    planName,
    remaining: 100 - utilization,
    total: 100,
    used: utilization,
    unit: "%",
    resetsAt,
    isValid: true,
    invalidMessage: null,
  };
}

function safeJsonParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
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

// ── 编程套餐（coding plan）响应解析（纯函数，对齐 cc-switch coding_plan.rs）────

/** Kimi For Coding：GET {coding 根地址}/usages，limits[].detail 为 5 小时窗口、usage 为周窗口。 */
export function parseKimiCodingBalance(body: unknown): BalanceResult {
  const obj = body as Record<string, unknown> | null;
  const rows: BalanceData[] = [];
  // 5 小时窗口限额（可能多条，逐条展示）
  if (Array.isArray(obj?.limits)) {
    for (const raw of obj.limits) {
      const detail = (raw as Record<string, unknown> | null)?.detail as Record<string, unknown> | null;
      if (!detail) continue;
      const limit = parseNumberField(detail, "limit") ?? 1.0;
      const remaining = parseNumberField(detail, "remaining") ?? 0.0;
      rows.push({
        planName: WINDOW_LABELS.fiveHour,
        remaining,
        total: limit,
        used: Math.max(0, limit - remaining),
        unit: null,
        resetsAt: extractResetTime(detail.resetTime),
        isValid: true,
        invalidMessage: null,
      });
    }
  }
  // 周窗口（usage）
  const usage = obj?.usage as Record<string, unknown> | null;
  if (usage) {
    const limit = parseNumberField(usage, "limit") ?? 1.0;
    const remaining = parseNumberField(usage, "remaining") ?? 0.0;
    rows.push({
      planName: WINDOW_LABELS.weekly,
      remaining,
      total: limit,
      used: Math.max(0, limit - remaining),
      unit: null,
      resetsAt: extractResetTime(usage.resetTime),
      isValid: true,
      invalidMessage: null,
    });
  }
  if (rows.length === 0) {
    return deterministicError("Kimi usage response missing limits/usage fields");
  }
  return ok(rows);
}

/** 智谱个人版按量账户查套餐接口回 200 + 业务错误「不存在 coding plan」，单独识别后回落查余额。 */
export function zhipuCodingHasNoPlan(body: unknown): boolean {
  const obj = body as Record<string, unknown> | null;
  if (obj?.success !== false) return false;
  const msg = typeof obj.msg === "string" ? obj.msg : "";
  const compact = msg.toLowerCase().replaceAll(/[\s_-]/g, "");
  if (!compact.includes("codingplan")) return false;
  const lower = msg.toLowerCase();
  return [
    "不存在",
    "没有",
    "未开通",
    "not exist",
    "not found",
    "not have",
    "doesn't have",
    "no coding plan",
    "not subscribed",
  ].some((keyword) => lower.includes(keyword));
}

interface ZhipuTierEntry {
  resetMs: number | null;
  percentage: number;
  resetsAt: string | null;
}

/**
 * 智谱 data.limits[] 的 TOKENS_LIMIT 条目 → 窗口行。
 * 分类优先级（对齐 cc-switch parse_zhipu_token_tiers）：
 * 1. unit 字段显式分类（3 = 5 小时窗，6 = 周窗）——周期末尾周窗比 5 小时窗更早重置，
 *    按重置时间排序必然标反（cc-switch issue #3036），必须锚定 unit；
 * 2. unit 缺失 / 不认识时兜底：无 nextResetTime 的优先归 5 小时窗，其余按重置升序填空位。
 *
 * TIME_LIMIT（unit:5）是月度 MCP / 搜索 / 阅读调用额度，独立展示；
 * 没有该条目不伪造 0% 工具窗口，也不把它误当成 Token 月限额。
 */
function parseZhipuQuotaRows(data: Record<string, unknown>): BalanceData[] {
  let fiveHour: ZhipuTierEntry | null = null;
  let weekly: ZhipuTierEntry | null = null;
  let monthly: BalanceData | null = null;
  const unclassified: ZhipuTierEntry[] = [];

  if (Array.isArray(data.limits)) {
    for (const raw of data.limits) {
      const item = raw as Record<string, unknown>;
      const type = typeof item.type === "string" ? item.type : "";
      const resetMs =
        typeof item.nextResetTime === "number" && Number.isFinite(item.nextResetTime)
          ? item.nextResetTime
          : null;
      const resetsAt = resetMs !== null ? new Date(resetMs).toISOString() : null;

      // 上游返回月度 MCP / 搜索 / 阅读调用额度时才展示，不能冒充 Token 月限额。
      if (/^time_limit$/i.test(type)) {
        if (monthly !== null || item.unit !== 5) continue;
        const total = parseNumberField(item, "usage");
        const used = parseNumberField(item, "currentValue");
        const remaining = parseNumberField(item, "remaining");
        if (total !== null && total > 0 && (used !== null || remaining !== null)) {
          monthly = {
            planName: WINDOW_LABELS.monthlyTools,
            remaining: remaining ?? Math.max(0, total - (used ?? 0)),
            total,
            used: used ?? Math.max(0, total - (remaining ?? 0)),
            unit: "次",
            resetsAt,
            isValid: true,
            invalidMessage: null,
          };
        } else {
          const percentage =
            typeof item.percentage === "number" && Number.isFinite(item.percentage)
              ? item.percentage
              : 0;
          monthly = percentRow(WINDOW_LABELS.monthlyTools, percentage, resetsAt);
        }
        continue;
      }

      // 大小写不敏感：上游改成小写 / 驼峰仍能识别
      if (!/^tokens_limit$/i.test(type) && !/^credit_limit$/i.test(type)) continue;
      const percentage =
        typeof item.percentage === "number" && Number.isFinite(item.percentage)
          ? item.percentage
          : 0;
      const entry: ZhipuTierEntry = { resetMs, percentage, resetsAt };
      const unit = item.unit;
      if (unit === 3 && fiveHour === null) fiveHour = entry;
      else if (unit === 6 && weekly === null) weekly = entry;
      else unclassified.push(entry);
    }
  }

  unclassified.sort((a, b) => {
    const aHas = a.resetMs !== null ? 1 : 0;
    const bHas = b.resetMs !== null ? 1 : 0;
    if (aHas !== bHas) return aHas - bHas;
    return (a.resetMs ?? Number.MIN_SAFE_INTEGER) - (b.resetMs ?? Number.MIN_SAFE_INTEGER);
  });
  for (const entry of unclassified) {
    if (fiveHour === null) fiveHour = entry;
    else if (weekly === null) weekly = entry;
    // 智谱当前最多两条 TOKENS_LIMIT，多余的忽略
  }

  const rows: BalanceData[] = [];
  if (fiveHour) rows.push(percentRow(WINDOW_LABELS.fiveHour, fiveHour.percentage, fiveHour.resetsAt));
  if (weekly) rows.push(percentRow(WINDOW_LABELS.weekly, weekly.percentage, weekly.resetsAt));
  if (monthly) rows.push(monthly);
  return rows;
}

/** 智谱 Coding Plan（个人版与团队版同 shape）：success:false 透出 msg；窗口由 unit/重置时间分类。 */
export function parseZhipuCodingBalance(body: unknown): BalanceResult {
  const obj = body as Record<string, unknown> | null;
  if (obj?.success === false) {
    const message = typeof obj.msg === "string" ? obj.msg : "Unknown error";
    return apiErrorMessage(message);
  }
  const data =
    obj && typeof obj.data === "object" && obj.data !== null
      ? (obj.data as Record<string, unknown>)
      : null;
  if (!data) return deterministicError("Missing 'data' field in response");
  const rows = parseZhipuQuotaRows(data);
  if (rows.length === 0) {
    return deterministicError("Zhipu coding plan response has no TOKENS_LIMIT entries");
  }
  // 套餐等级（Lite/Pro/Max…）挂在第一行窗口名后展示
  const level = typeof data.level === "string" && data.level.trim() ? data.level.trim() : null;
  if (level && rows[0].planName) {
    rows[0] = { ...rows[0], planName: `${rows[0].planName} · ${level}` };
  }
  return ok(rows);
}

/** MiniMax Coding Plan：GET coding_plan/remains，取 general 桶剩余百分比反转为已用。 */
export function parseMinimaxCodingBalance(body: unknown): BalanceResult {
  const obj = body as Record<string, unknown> | null;
  const baseResp = obj?.base_resp as Record<string, unknown> | null;
  if (baseResp) {
    const statusCode = typeof baseResp.status_code === "number" ? baseResp.status_code : -1;
    if (statusCode !== 0) {
      const message =
        typeof baseResp.status_msg === "string" ? baseResp.status_msg : "Unknown error";
      return deterministicError(`API error (code ${statusCode}): ${message}`);
    }
  }
  const modelRemains = Array.isArray(obj?.model_remains) ? obj.model_remains : [];
  // 只取 model_name == "general" 的条目，跳过 video 等非编程模型
  const item = modelRemains.find(
    (raw) => (raw as Record<string, unknown>)?.model_name === "general",
  ) as Record<string, unknown> | undefined;

  const rows: BalanceData[] = [];
  if (item) {
    // 5h 桶：剩余百分比 → 已用百分比
    if (typeof item.current_interval_remaining_percent === "number") {
      rows.push(
        percentRow(
          WINDOW_LABELS.fiveHour,
          100 - item.current_interval_remaining_percent,
          typeof item.end_time === "number" ? extractResetTime(item.end_time) : null,
        ),
      );
    }
    // 周桶：1 = 正常计时、2 = 周额度已耗尽（照常展示）、3 = 无周限额（跳过，恒回 100）
    const weeklyStatus = item.current_weekly_status;
    if ((weeklyStatus === 1 || weeklyStatus === 2) && typeof item.current_weekly_remaining_percent === "number") {
      rows.push(
        percentRow(
          WINDOW_LABELS.weekly,
          100 - item.current_weekly_remaining_percent,
          typeof item.weekly_end_time === "number" ? extractResetTime(item.weekly_end_time) : null,
        ),
      );
    }
  }
  if (rows.length === 0) {
    return deterministicError("MiniMax response has no 'general' coding plan tiers");
  }
  return ok(rows);
}

/** OpenCode Go：三窗口已用百分比；percent=0 时 resetsAt 是上游占位值，丢弃倒计时。 */
export function parseOpencodeGoBalance(body: unknown): BalanceResult {
  const usage = (body as Record<string, unknown> | null)?.usage as Record<string, unknown> | null;
  const rows: BalanceData[] = [];
  if (usage) {
    const windows: [string, string][] = [
      ["rolling", WINDOW_LABELS.fiveHour],
      ["weekly", WINDOW_LABELS.weekly],
      ["monthly", WINDOW_LABELS.monthly],
    ];
    for (const [key, label] of windows) {
      const win = usage[key] as Record<string, unknown> | null;
      if (!win || typeof win !== "object") continue;
      const percent = parseNumberField(win, "percent");
      if (percent === null) continue;
      rows.push(percentRow(label, percent, percent > 0 ? extractResetTime(win.resetsAt) : null));
    }
  }
  // 一个窗口都没解析出来 = 响应形态不认识（未文档化端点可能再次变形），明确报错
  if (rows.length === 0) {
    return deterministicError("Unexpected usage response shape");
  }
  return ok(rows);
}

function zenmuxWindowRow(label: string, win: Record<string, unknown>): BalanceData {
  const resetsAt = typeof win.resets_at === "string" ? win.resets_at : null;
  // 有美元金额时直接展示绝对额度（usage_percentage 是 0-1 小数）
  const usedUsd = parseNumberField(win, "used_value_usd");
  const maxUsd = parseNumberField(win, "max_value_usd");
  if (usedUsd !== null && maxUsd !== null && maxUsd > 0) {
    return {
      planName: label,
      remaining: maxUsd - usedUsd,
      total: maxUsd,
      used: usedUsd,
      unit: "USD",
      resetsAt,
      isValid: true,
      invalidMessage: null,
    };
  }
  return percentRow(label, (parseNumberField(win, "usage_percentage") ?? 0) * 100, resetsAt);
}

/** ZenMux：quota_5_hour / quota_7_day 两窗口，可含美元金额与套餐等级。 */
export function parseZenmuxBalance(body: unknown): BalanceResult {
  const obj = body as Record<string, unknown> | null;
  if (obj?.success !== true) {
    const message = typeof obj?.message === "string" ? obj.message : "Unknown error";
    return deterministicError(`API error: ${message}`);
  }
  const data = obj.data as Record<string, unknown> | null;
  if (!data || typeof data !== "object") {
    return deterministicError("Missing 'data' field in response");
  }
  const rows: BalanceData[] = [];
  const q5 = data.quota_5_hour as Record<string, unknown> | null;
  if (q5 && typeof q5 === "object") rows.push(zenmuxWindowRow(WINDOW_LABELS.fiveHour, q5));
  const q7 = data.quota_7_day as Record<string, unknown> | null;
  if (q7 && typeof q7 === "object") rows.push(zenmuxWindowRow(WINDOW_LABELS.weekly, q7));
  if (rows.length === 0) {
    return deterministicError("ZenMux response has no quota windows");
  }
  const plan = data.plan as Record<string, unknown> | null;
  const planTier = typeof plan?.tier === "string" ? plan.tier : "";
  const accountStatus = typeof data.account_status === "string" ? data.account_status : "";
  const planInfo = planTier
    ? accountStatus
      ? `${planTier}（${accountStatus}）`
      : planTier
    : null;
  if (planInfo && rows[0].planName) {
    rows[0] = { ...rows[0], planName: `${rows[0].planName} · ${planInfo}` };
  }
  return ok(rows);
}

function commandCodeWindowRow(label: string, win: Record<string, unknown>): BalanceData | null {
  const used = parseNumberField(win, "used");
  const cap = parseNumberField(win, "cap");
  if (used === null || cap === null || cap <= 0) return null;
  return {
    planName: label,
    remaining: cap - used,
    total: cap,
    used,
    unit: null,
    resetsAt: extractResetTime(win.resetAt),
    isValid: true,
    invalidMessage: null,
  };
}

/** Command Code：credits + subscriptions + usage/summary 三个响应合成月度与窗口额度。 */
export function parseCommandCodeQuota(
  creditsResponse: unknown,
  subscriptionResponse: unknown,
  summaryResponse: unknown,
): BalanceResult {
  const credits = creditsResponse as Record<string, unknown> | null;
  const creditRoot = credits?.credits as Record<string, unknown> | null;
  if (!creditRoot) return deterministicError("Missing 'credits' field in response");

  const monthlyRemaining = Math.max(0, parseNumberField(creditRoot, "monthlyCredits") ?? 0);
  const purchasedRemaining = Math.max(0, parseNumberField(creditRoot, "purchasedCredits") ?? 0);
  const freeRemaining = Math.max(0, parseNumberField(creditRoot, "freeCredits") ?? 0);
  const totalRemaining = monthlyRemaining + purchasedRemaining + freeRemaining;
  const totalSpentRaw = parseNumberField(summaryResponse as Record<string, unknown> | null, "totalCost");
  if (totalSpentRaw === null) return deterministicError("Missing 'totalCost' field in response");
  const totalSpent = Math.max(0, totalSpentRaw);
  const totalPool = totalSpent + totalRemaining;

  const subscription = subscriptionResponse as Record<string, unknown> | null;
  const subData = subscription?.data as Record<string, unknown> | null;
  const periodEnd = subData ? extractResetTime(subData.currentPeriodEnd) : null;
  const planId =
    typeof subData?.planId === "string" && subData.planId
      ? subData.planId
      : typeof creditRoot.planId === "string"
        ? creditRoot.planId
        : null;

  const rows: BalanceData[] = [];
  // windowLimits 实际响应放在 credits 同级；保留嵌套位置兼容历史变体
  const windowLimits = (credits?.windowLimits ?? creditRoot.windowLimits) as Record<string, unknown> | null;
  if (windowLimits && typeof windowLimits === "object" && windowLimits.limited === true) {
    const fiveHour = windowLimits.fiveHour as Record<string, unknown> | null;
    if (fiveHour) {
      const row = commandCodeWindowRow(WINDOW_LABELS.fiveHour, fiveHour);
      if (row) rows.push(row);
    }
    const weekly = windowLimits.weekly as Record<string, unknown> | null;
    if (weekly) {
      const row = commandCodeWindowRow(WINDOW_LABELS.weekly, weekly);
      if (row) rows.push(row);
    }
  }
  rows.push({
    planName: planId ? `${WINDOW_LABELS.monthly} · ${planId}` : WINDOW_LABELS.monthly,
    remaining: totalRemaining,
    total: totalPool,
    used: totalSpent,
    unit: null,
    resetsAt: periodEnd,
    isValid: true,
    invalidMessage: null,
  });
  return ok(rows);
}

// ── 火山方舟 Agent Plan / Coding Plan（控制面 OpenAPI + 火山签名 V4）─────────

const VOLCENGINE_OPENAPI_HOST = "open.volcengineapi.com";
const VOLCENGINE_API_VERSION = "2024-01-01";
const VOLCENGINE_DEFAULT_REGION = "cn-beijing";
const VOLCENGINE_SERVICE = "ark";
const VOLCENGINE_CONTENT_TYPE = "application/json; charset=utf-8";
// 固定顺序 canonical headers（火山特有，不按字母序），照搬标准 SigV4 会签名失败。
const VOLCENGINE_SIGNED_HEADERS = "host;x-date;x-content-sha256;content-type";
const VOLCENGINE_AKSK_HINT =
  "Check the AccessKey ID / Secret are correct and the account has Ark usage-query (OpenAPI) permission.";

/** 从数据面 base_url 提取 Region（ark.cn-beijing.volces.com → cn-beijing）；识别不到回落 cn-beijing。 */
export function volcengineRegion(baseUrl: string): string {
  const withoutScheme = baseUrl.includes("://") ? baseUrl.slice(baseUrl.indexOf("://") + 3) : baseUrl;
  const host = withoutScheme.split("/")[0] ?? "";
  const region = host.split(".").find((part) => part.startsWith("cn-") || part.startsWith("ap-"));
  return region ?? VOLCENGINE_DEFAULT_REGION;
}

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: string | Uint8Array, data: string): Uint8Array {
  return new Uint8Array(createHmac("sha256", key).update(data, "utf8").digest());
}

/** RFC3986 unreserved 之外全部 %XX 大写编码（canonical query 用）。 */
function volcUriEncode(input: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(input)) {
    const unreserved =
      (byte >= 0x41 && byte <= 0x5a)
      || (byte >= 0x61 && byte <= 0x7a)
      || (byte >= 0x30 && byte <= 0x39)
      || byte === 0x2d
      || byte === 0x5f
      || byte === 0x2e
      || byte === 0x7e;
    out += unreserved ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** 按 key 字母序、逐段 URL 编码的 canonical query；同一份字符串既用于签名也用于实际 URL。 */
export function volcengineCanonicalQuery(action: string, region: string): string {
  const pairs: [string, string][] = [
    ["Action", action],
    ["Region", region],
    ["Version", VOLCENGINE_API_VERSION],
  ];
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return pairs.map(([key, value]) => `${volcUriEncode(key)}=${volcUriEncode(value)}`).join("&");
}

/**
 * 火山引擎签名 V4（AWS SigV4 的火山变体）：algorithm 无 AWS4 前缀、scope 结尾
 * `request`、签名密钥 kDate=HMAC(SK, date)（SK 不加前缀）、headers 固定顺序。
 */
export function volcengineSign(
  accessKeyId: string,
  secretAccessKey: string,
  region: string,
  canonicalQuery: string,
  body: Uint8Array,
  now: Date,
): { authorization: string; xDate: string; xContentSha256: string } {
  const pad = (value: number) => String(value).padStart(2, "0");
  const xDate = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const shortDate = xDate.slice(0, 8);
  const xContentSha256 = sha256Hex(body);

  const canonicalHeaders =
    `host:${VOLCENGINE_OPENAPI_HOST}\n` +
    `x-date:${xDate}\n` +
    `x-content-sha256:${xContentSha256}\n` +
    `content-type:${VOLCENGINE_CONTENT_TYPE}\n`;
  const canonicalRequest =
    `POST\n/\n${canonicalQuery}\n${canonicalHeaders}\n${VOLCENGINE_SIGNED_HEADERS}\n${xContentSha256}`;
  const credentialScope = `${shortDate}/${region}/${VOLCENGINE_SERVICE}/request`;
  const stringToSign =
    `HMAC-SHA256\n${xDate}\n${credentialScope}\n${sha256Hex(new TextEncoder().encode(canonicalRequest))}`;

  const kDate = hmacSha256(secretAccessKey, shortDate);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, VOLCENGINE_SERVICE);
  const kSigning = hmacSha256(kService, "request");
  const signature = Buffer.from(hmacSha256(kSigning, stringToSign)).toString("hex");

  const authorization =
    `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${VOLCENGINE_SIGNED_HEADERS}, Signature=${signature}`;
  return { authorization, xDate, xContentSha256 };
}

/** 提取火山 OpenAPI 响应里的 ResponseMetadata.Error（或顶层 Error）。 */
export function volcengineResponseError(body: unknown): { code: string; message: string } | null {
  const obj = body as Record<string, unknown> | null;
  const raw =
    (obj?.ResponseMetadata as Record<string, unknown> | null)?.Error ?? obj?.Error;
  if (!raw || typeof raw !== "object") return null;
  const err = raw as Record<string, unknown>;
  const code = typeof err.Code === "string" ? err.Code : "";
  const message = typeof err.Message === "string" ? err.Message : "";
  if (!code && !message) return null;
  return { code, message };
}

/** OpenAPI 错误码是否属于鉴权类（提示换 AK/SK 而非当普通错误）。 */
export function volcengineIsAuthErrorCode(code: string): boolean {
  const lower = code.toLowerCase();
  return [
    "auth",
    "signature",
    "accessdenied",
    "denied",
    "unauthorized",
    "forbidden",
    "credential",
    "token",
  ].some((keyword) => lower.includes(keyword));
}

/** GetAFPUsage：5h / 周 / 月三窗口（AFPDaily 被官方控制台隐藏，跳过）；Quota<=0 视为未订阅。 */
export function parseVolcengineAfpTiers(result: unknown): BalanceData[] {
  const obj = result as Record<string, unknown> | null;
  const windows: [string, string][] = [
    ["AFPFiveHour", WINDOW_LABELS.fiveHour],
    ["AFPWeekly", WINDOW_LABELS.weekly],
    ["AFPMonthly", WINDOW_LABELS.monthly],
  ];
  const rows: BalanceData[] = [];
  for (const [key, label] of windows) {
    const win = obj?.[key] as Record<string, unknown> | null;
    if (!win || typeof win !== "object") continue;
    const quota = parseNumberField(win, "Quota") ?? 0;
    if (quota <= 0) continue;
    const used = parseNumberField(win, "Used") ?? 0;
    rows.push({
      planName: label,
      remaining: quota - used,
      total: quota,
      used,
      unit: null,
      resetsAt: extractResetTime(win.ResetTime),
      isValid: true,
      invalidMessage: null,
    });
  }
  return rows;
}

function volcCodingWindowLabel(label: string): string | null {
  const normalized = label.toLowerCase();
  if (["session", "5h", "fivehour", "five_hour", "rolling_5h"].includes(normalized)) {
    return WINDOW_LABELS.fiveHour;
  }
  if (["weekly", "week", "7d"].includes(normalized)) return WINDOW_LABELS.weekly;
  if (["monthly", "month"].includes(normalized)) return WINDOW_LABELS.monthly;
  return null;
}

/** GetCodingPlanUsage：只回百分比；真实字段是 Level（session/weekly/monthly），其余作防御式 fallback。 */
export function parseVolcengineCodingPlanTiers(result: unknown): BalanceData[] {
  const obj = result as Record<string, unknown> | null;
  const arr =
    (Array.isArray(obj?.QuotaUsage) ? obj.QuotaUsage : undefined)
    ?? (Array.isArray(obj?.Usages) ? obj.Usages : undefined)
    ?? (Array.isArray(obj?.Details) ? obj.Details : undefined);
  if (!arr) return [];
  const rows: BalanceData[] = [];
  for (const raw of arr) {
    const item = raw as Record<string, unknown>;
    const labelSource =
      [item.Level, item.Type, item.Period, item.Label, item.Window].find(
        (value): value is string => typeof value === "string",
      ) ?? "";
    const label = volcCodingWindowLabel(labelSource);
    if (!label) continue;
    const utilization =
      parseNumberField(item, "Percent")
      ?? parseNumberField(item, "UsedPercent")
      ?? parseNumberField(item, "UsagePercent")
      ?? 0;
    const resetRaw = item.ResetTime !== undefined ? item.ResetTime : item.ResetTimestamp;
    rows.push(percentRow(label, utilization, extractResetTime(resetRaw)));
  }
  return rows;
}

/** 凭据失效但文案自定义（火山是 AK/SK，不是 API Key）。 */
function authInvalid(message: string, detail: string): BalanceResult {
  return {
    success: false,
    data: [{ isValid: false, invalidMessage: message }],
    error: detail,
    errorKind: "deterministic",
  };
}

type VolcCall =
  | { kind: "body"; body: unknown }
  | { kind: "auth"; detail: string }
  | { kind: "soft"; detail: string }
  | { kind: "transient"; detail: string };

async function volcengineOpenApiCall(
  region: string,
  accessKeyId: string,
  secretAccessKey: string,
  action: string,
  fetchImpl: FetchLike,
): Promise<VolcCall> {
  const canonicalQuery = volcengineCanonicalQuery(action, region);
  const url = `https://${VOLCENGINE_OPENAPI_HOST}/?${canonicalQuery}`;
  const body = new Uint8Array(0);
  const { authorization, xDate, xContentSha256 } = volcengineSign(
    accessKeyId,
    secretAccessKey,
    region,
    canonicalQuery,
    body,
    new Date(),
  );

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "X-Date": xDate,
        "X-Content-Sha256": xContentSha256,
        "Content-Type": VOLCENGINE_CONTENT_TYPE,
        Authorization: authorization,
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isAbort = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      kind: "transient",
      detail: isAbort
        ? `Network error: 请求超时（${QUERY_TIMEOUT_MS / 1000}s）`
        : `Network error: ${message}`,
    };
  }

  const status = response.status;
  if (status === 401 || status === 403) {
    return {
      kind: "auth",
      detail: `Authentication failed (HTTP ${status}). ${VOLCENGINE_AKSK_HINT}`,
    };
  }
  if (!response.ok) {
    // 网关对签名/凭据类错误常返 4xx（多为 400）并带与 200 相同的 Error 信封
    const raw = await response.text().catch(() => "");
    const parsed = safeJsonParse(raw);
    const err = parsed !== undefined ? volcengineResponseError(parsed) : null;
    if (err) {
      if (volcengineIsAuthErrorCode(err.code)) {
        return {
          kind: "auth",
          detail: `Authentication failed (HTTP ${status}, ${err.code}): ${err.message}. ${VOLCENGINE_AKSK_HINT}`,
        };
      }
      return { kind: "soft", detail: `API error (HTTP ${status}, ${err.code}): ${err.message}` };
    }
    return { kind: "soft", detail: `API error (HTTP ${status}): ${raw.slice(0, 200)}` };
  }

  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "transient", detail: `Failed to read response: ${message}` };
  }
  const parsed = safeJsonParse(raw);
  if (parsed === undefined) {
    return { kind: "soft", detail: `Failed to parse response: ${raw.slice(0, 120) || "空响应"}` };
  }
  // 火山 OpenAPI 业务错误常以 200 + ResponseMetadata.Error 返回
  const err = volcengineResponseError(parsed);
  if (err) {
    if (volcengineIsAuthErrorCode(err.code)) {
      return {
        kind: "auth",
        detail: `Authentication failed (${err.code}): ${err.message}. ${VOLCENGINE_AKSK_HINT}`,
      };
    }
    return { kind: "soft", detail: `API error (${err.code}): ${err.message}` };
  }
  return { kind: "body", body: parsed };
}

/** 火山方舟：GetAFPUsage（绝对额度）→ 未订阅再 GetCodingPlanUsage（百分比），双 plan 自动探测。 */
export async function fetchVolcengineBalance(
  config: BalanceProviderConfig,
  fetchImpl: FetchLike,
): Promise<BalanceResult> {
  const region = volcengineRegion(config.baseUrl);
  const accessKeyId = (config.accessKeyId ?? "").trim();
  const secretAccessKey = (config.secretAccessKey ?? "").trim();
  const softErrors: string[] = [];
  const emptyResponses: string[] = [];
  const summarize = (action: string, body: unknown): string =>
    `${action}=${JSON.stringify(body).slice(0, 700)}`;

  // 1) Agent Plan：GetAFPUsage
  const afp = await volcengineOpenApiCall(region, accessKeyId, secretAccessKey, "GetAFPUsage", fetchImpl);
  if (afp.kind === "auth") {
    return authInvalid(
      `AccessKey 已失效，请检查 AK/SK（非推理 API Key）`,
      afp.detail,
    );
  }
  if (afp.kind === "transient") return transientError(`GetAFPUsage: ${afp.detail}`);
  if (afp.kind === "soft") {
    softErrors.push(`GetAFPUsage: ${afp.detail}`);
  } else {
    const bodyObj = afp.body as Record<string, unknown> | null;
    const result = bodyObj?.Result !== undefined ? bodyObj.Result : afp.body;
    const rows = parseVolcengineAfpTiers(result);
    if (rows.length > 0) {
      const planType =
        typeof (result as Record<string, unknown> | null)?.PlanType === "string"
          ? ((result as Record<string, unknown>).PlanType as string).trim()
          : "";
      if (planType && rows[0].planName) {
        rows[0] = { ...rows[0], planName: `${rows[0].planName} · Agent Plan ${planType}` };
      }
      return ok(rows);
    }
    emptyResponses.push(summarize("GetAFPUsage", afp.body));
  }

  // 2) Coding Plan：GetCodingPlanUsage
  const coding = await volcengineOpenApiCall(
    region,
    accessKeyId,
    secretAccessKey,
    "GetCodingPlanUsage",
    fetchImpl,
  );
  if (coding.kind === "auth") {
    return authInvalid(`AccessKey 已失效，请检查 AK/SK（非推理 API Key）`, coding.detail);
  }
  if (coding.kind === "transient") return transientError(`GetCodingPlanUsage: ${coding.detail}`);
  if (coding.kind === "soft") {
    softErrors.push(`GetCodingPlanUsage: ${coding.detail}`);
  } else {
    const bodyObj = coding.body as Record<string, unknown> | null;
    const result = bodyObj?.Result !== undefined ? bodyObj.Result : coding.body;
    const rows = parseVolcengineCodingPlanTiers(result);
    if (rows.length > 0) {
      if (rows[0].planName) {
        rows[0] = { ...rows[0], planName: `${rows[0].planName} · Coding Plan` };
      }
      return ok(rows);
    }
    emptyResponses.push(summarize("GetCodingPlanUsage", coding.body));
  }

  if (softErrors.length > 0) {
    return deterministicError(softErrors.join("; "));
  }
  if (emptyResponses.length > 0) {
    // 签名已通过但响应里没有可解析的额度，带原始响应用于核对字段 / 确认未订阅
    return deterministicError(
      `No active subscription found (signature OK). Raw: ${emptyResponses.join(" || ")}`.slice(0, 600),
    );
  }
  return deterministicError("No active Agent Plan or Coding Plan subscription found for this credential");
}

// ── Command Code（/alpha 控制面，whoami → credits → subscriptions → summary）──

const COMMAND_CODE_API_BASE = "https://api.commandcode.ai";

type CommandCodeFetch =
  | { kind: "body"; body: unknown }
  | { kind: "auth" }
  | { kind: "error"; message: string }
  | { kind: "transient"; message: string };

function commandCodeUrl(baseUrl: string, path: string, params: [string, string][]): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}${path}`);
  for (const [key, value] of params) url.searchParams.append(key, value);
  return url.toString();
}

/** /alpha 是官方 CLI 的私有路由，未公开文档化；保持宽松解析。 */
async function fetchCommandCodeJson(
  baseUrl: string,
  path: string,
  params: [string, string][],
  apiKey: string,
  fetchImpl: FetchLike,
): Promise<CommandCodeFetch> {
  const url = commandCodeUrl(baseUrl, path, params);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isAbort = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      kind: "transient",
      message: isAbort
        ? `Network error: 请求超时（${QUERY_TIMEOUT_MS / 1000}s）`
        : `Network error: ${message}`,
    };
  }

  const status = response.status;
  if (status === 401) return { kind: "auth" };
  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "transient", message: `Failed to read response: ${message}` };
  }
  if (!response.ok) {
    return { kind: "error", message: `API error (HTTP ${status}): ${raw.slice(0, 200)}` };
  }
  const parsed = safeJsonParse(raw);
  if (parsed === undefined) {
    return { kind: "error", message: `Failed to parse response: ${raw.slice(0, 120) || "空响应"}` };
  }
  return { kind: "body", body: parsed };
}

/** Command Code：四个 /alpha 接口串行取数后合成额度（对齐 cc-switch query_command_code_at）。 */
export async function fetchCommandCodeBalance(
  config: BalanceProviderConfig,
  fetchImpl: FetchLike,
): Promise<BalanceResult> {
  const apiKey = config.apiKey.trim();

  const whoami = await fetchCommandCodeJson(
    COMMAND_CODE_API_BASE,
    "/alpha/whoami",
    [["limits", "1"]],
    apiKey,
    fetchImpl,
  );
  if (whoami.kind === "auth") return authError(401);
  if (whoami.kind === "transient") return transientError(whoami.message);
  if (whoami.kind === "error") return deterministicError(whoami.message);
  const orgId = (
    (whoami.body as Record<string, unknown> | null)?.org as Record<string, unknown> | null
  )?.id;
  const orgParams: [string, string][] = typeof orgId === "string" ? [["orgId", orgId]] : [];

  const credits = await fetchCommandCodeJson(
    COMMAND_CODE_API_BASE,
    "/alpha/billing/credits",
    orgParams,
    apiKey,
    fetchImpl,
  );
  if (credits.kind === "auth") return authError(401);
  if (credits.kind === "transient") return transientError(credits.message);
  if (credits.kind === "error") return deterministicError(credits.message);

  const subscription = await fetchCommandCodeJson(
    COMMAND_CODE_API_BASE,
    "/alpha/billing/subscriptions",
    orgParams,
    apiKey,
    fetchImpl,
  );
  if (subscription.kind === "auth") return authError(401);
  if (subscription.kind === "transient") return transientError(subscription.message);
  if (subscription.kind === "error") return deterministicError(subscription.message);

  const periodStart = (
    (subscription.body as Record<string, unknown> | null)?.data as Record<string, unknown> | null
  )?.currentPeriodStart;
  const summaryParams: [string, string][] = [];
  if (typeof periodStart === "string") summaryParams.push(["since", periodStart]);
  summaryParams.push(...orgParams);

  const summary = await fetchCommandCodeJson(
    COMMAND_CODE_API_BASE,
    "/alpha/usage/summary",
    summaryParams,
    apiKey,
    fetchImpl,
  );
  if (summary.kind === "auth") return authError(401);
  if (summary.kind === "transient") return transientError(summary.message);
  if (summary.kind === "error") return deterministicError(summary.message);

  return parseCommandCodeQuota(credits.body, subscription.body, summary.body);
}



interface QueryPlan {
  url: string;
  headers: Record<string, string>;
  /** 拿到 2xx 响应体后的解析器；返回 null 表示字段缺失。 */
  parse(body: unknown): BalanceResult;
  /** 403 的定制语义（如 OpenCode Go：Key 有效但没有订阅，不算失效）。缺省按 Key 失效处理。 */
  onForbidden?: () => BalanceResult;
  /** parse 返回 NO_CODING_PLAN_FALLBACK 哨兵时改走该回落计划（智谱按量账户查余额）。 */
  fallbackPlan?: QueryPlan;
}

/** 智谱按量账户查套餐的哨兵结果：个人版编码套餐探测到「无套餐」时回落查账户余额。 */
const NO_CODING_PLAN_FALLBACK: BalanceResult = {
  success: false,
  data: null,
  error: "no coding plan",
  errorKind: "deterministic",
};

/** 智谱账户余额报表请求（zhipu kind 与 zhipu_coding 的回落共用）。 */
function zhipuBalancePlan(host: string, apiKey: string, isCN: boolean): QueryPlan {
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
      return zhipuBalancePlan(host, apiKey, isCN);
    }
    case "kimi":
      // base 即 Kimi Code API 根地址（https://api.kimi.com|ai/coding/v1）
      return {
        url: `${base}/usages`,
        headers: bearerHeaders,
        parse: (body) => parseKimiCodingBalance(body),
      };
    case "zhipu_coding": {
      const isCN = base.toLowerCase().includes("bigmodel.cn");
      const host = isCN ? "https://open.bigmodel.cn" : "https://api.z.ai";
      return {
        url: `${host}/api/monitor/usage/quota/limit`,
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          Authorization: apiKey, // 智谱不加 Bearer 前缀
          "Content-Type": "application/json",
          "Accept-Language": "en-US,en",
        },
        parse: (body) =>
          zhipuCodingHasNoPlan(body)
            ? NO_CODING_PLAN_FALLBACK
            : parseZhipuCodingBalance(body),
        // 按量付费账户没有套餐：改查账户余额（对齐 cc-switch 的回落行为）
        fallbackPlan: zhipuBalancePlan(host, apiKey, isCN),
      };
    }
    case "zhipu_team": {
      const organizationId = (config.organizationId ?? "").trim();
      const projectId = (config.projectId ?? "").trim();
      return {
        // 团队版仅国内站，同一 quota 路径靠 ?type=2 区分；响应 shape 与个人版一致
        url: "https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2",
        headers: {
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          Authorization: apiKey,
          "bigmodel-organization": organizationId,
          "bigmodel-project": projectId,
          "Content-Type": "application/json",
          "Accept-Language": "en-US,en",
        },
        // 团队版没有套餐不回落余额：余额接口不认组织/项目头，查到的未必是这个团队的钱
        parse: (body) => parseZhipuCodingBalance(body),
      };
    }
    case "minimax": {
      // 额度接口只在 api.minimaxi.com / api.minimax.io 有公开出处；国内新推理域名
      // api.minimax.cn 沿用旧域名（同一账号体系与 Key）
      const domain = base.toLowerCase().includes("minimax.io") ? "api.minimax.io" : "api.minimaxi.com";
      return {
        url: `https://${domain}/v1/api/openplatform/coding_plan/remains`,
        headers: bearerHeaders,
        parse: (body) => parseMinimaxCodingBalance(body),
      };
    }
    case "opencode_go":
      return {
        // 用量端点只认 Bearer——与推理侧 /messages 只认 x-api-key 正好相反
        url: "https://opencode.ai/zen/go/v1/usage",
        headers: bearerHeaders,
        parse: (body) => parseOpencodeGoBalance(body),
        onForbidden: () =>
          deterministicError("API Key 有效但该 workspace 没有 OpenCode Go 订阅（HTTP 403）"),
      };
    case "zenmux":
      // base 即用户配置的用量端点（对齐 cc-switch：直接 GET base_url）
      return {
        url: base,
        headers: bearerHeaders,
        parse: (body) => parseZenmuxBalance(body),
      };
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

/** 各 kind 的凭据完整性校验；返回 null 表示通过。 */
function validateCredentials(config: BalanceProviderConfig): BalanceResult | null {
  const apiKey = config.apiKey.trim();
  switch (config.kind) {
    case "newapi":
      if (!(config.accessToken ?? "").trim()) {
        return deterministicError("new-api 中转站需要在设置里填写 Access Token（与用户 ID）");
      }
      return null;
    case "volcengine":
      if (!(config.accessKeyId ?? "").trim() || !(config.secretAccessKey ?? "").trim()) {
        return deterministicError(
          "火山方舟需要在设置里填写账号 AccessKey ID 与 Secret（控制面 OpenAPI 凭据，非推理 API Key）",
        );
      }
      return null;
    case "zhipu_team":
      if (
        !apiKey
        || !(config.organizationId ?? "").trim()
        || !(config.projectId ?? "").trim()
      ) {
        return deterministicError("GLM 团队版需要填写 API Key、组织 ID 与项目 ID 三者");
      }
      return null;
    default:
      if (!apiKey) return deterministicError("缺少 API Key");
      return null;
  }
}

/** 执行单个请求计划（fetch + 状态码归类 + 解析；含智谱无套餐回落）。 */
async function executePlan(plan: QueryPlan, fetchImpl: FetchLike): Promise<BalanceResult> {
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
  if (status === 401) {
    return authError(status);
  }
  if (status === 403) {
    // 默认按 Key 失效；OpenCode Go 等供应商的 403 另有语义（Key 有效但无订阅）
    return plan.onForbidden ? plan.onForbidden() : authError(status);
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

  const result = plan.parse(body);
  if (result === NO_CODING_PLAN_FALLBACK && plan.fallbackPlan) {
    return executePlan(plan.fallbackPlan, fetchImpl);
  }
  return result;
}

/**
 * 查询单个供应商余额。fetchImpl 可注入便于测试；网络 / 超时 / 5xx / 429 一律
 * 返回 transient 结果（不抛异常），由上层限流器决定重试与冷却。
 * 火山方舟（AK/SK 签名 + 双 plan 探测）与 Command Code（多接口串行）走专属编排。
 */
export async function fetchBalance(
  config: BalanceProviderConfig,
  fetchImpl: FetchLike = fetch,
): Promise<BalanceResult> {
  const credentialError = validateCredentials(config);
  if (credentialError) return credentialError;

  if (config.kind === "volcengine") {
    return fetchVolcengineBalance(config, fetchImpl);
  }
  if (config.kind === "command_code") {
    return fetchCommandCodeBalance(config, fetchImpl);
  }
  return executePlan(buildQueryPlan(config), fetchImpl);
}

/** 供测试与类型收口：kind → 是否需要 newapi 专属凭据。 */
export function requiresNewapiCredentials(kind: BalanceKind): boolean {
  return kind === "newapi";
}
