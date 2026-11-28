import { collectFirstTokenMedians } from "@/lib/first-token";
import { sumSpeedTotals } from "@/lib/speed";

export const HARNESS_OPTIONS = [
  { id: "codebuddy", label: "CodeBuddy", description: "CodeBuddy CLI 本地会话" },
  { id: "workbuddy", label: "WorkBuddy", description: "WorkBuddy Desktop / CLI 本地会话" },
  { id: "qoder", label: "Qoder", description: "Qoder Desktop / CLI 本地会话" },
  { id: "zcode", label: "ZCode", description: "ZCode Desktop / CLI 本地会话" },
  { id: "opencode", label: "OpenCode", description: "OpenCode 编程助手" },
  { id: "kcode", label: "KCode", description: "Kimi Code Desktop / CLI 本地会话" },
  { id: "claude", label: "Claude Code", description: "Claude Code CLI / Desktop 本地会话" },
  { id: "codex", label: "Codex / ChatGPT", description: "Codex CLI / Desktop 本地会话" },
  { id: "dsh", label: "DeepSeek Harness", description: "DeepSeek Harness CLI / Desktop 本地会话" },
  { id: "antigravity", label: "Antigravity", description: "Google Antigravity IDE / CLI 本地会话" },
  { id: "pidesktop", label: "Pi Desktop", description: "PI-Desktop 桌面端本地会话" },
  { id: "devin", label: "Devin", description: "Devin Desktop / CLI 本地会话" },
] as const;

export type HarnessId = (typeof HARNESS_OPTIONS)[number]["id"];
export type HarnessFilter = "all" | HarnessId;
export type RangeKey = "today" | "yesterday" | "7d" | "30d" | "all" | "custom";

/** 趋势图聚合粒度；custom 按跨度自适应分档。 */
export type TrendGranularity = "minute" | "hour" | "day";
export type MetricKey = "cost" | "credits" | "requests" | "tokens" | "cacheRate";
export type GroupDimension = "model" | "provider" | "project" | "harness";
export type InputTokenSemantics = "fresh" | "total";
export type BillingFilter = "all" | "billable" | "unbilled";

export interface UsageRecord {
  id: string;
  requestId: string;
  sessionId: string;
  harness: HarnessId;
  project: string;
  model: string;
  provider: string;
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** cacheCreationTokens 中按 1 小时 TTL 写入的子集（Claude 单独计价）。 */
  cacheCreation1hTokens?: number;
  totalTokens: number;
  inputTokenSemantics: InputTokenSemantics;
  hasTokenUsage: boolean;
  /** 实际计费的 Credits；服务端标记为不计费的请求记为 0。 */
  credits: number;
  /** 计量信息完整（能确定计费金额，包括确定不计费）。 */
  hasCredit: boolean;
  /** 服务端报告的原始 Credits；不计费请求也会报告非零值。 */
  reportedCredits?: number;
  billable?: boolean;
  contextUsageRatio?: number;
  /**
   * 估算的请求耗时（毫秒）。CodeBuddy 会话日志按时间戳推算（完成时刻 −
   * 请求起点，含首字等待）；推不出时为 undefined。Qoder 记录没有该字段。
   */
  estimatedDurationMs?: number;
  /**
   * 首 token 耗时（毫秒）。ZCode / KCode / Antigravity / DSH 为原生精确计时；
   * Claude / Codex 按时间戳推算（见 first-token.ts）；其余 Harness 没有。
   */
  firstTokenMs?: number;
  /** 实际查价使用的归一化/命中模型；找不到价格时缺失。 */
  pricingModel?: string;
  inputCostUsd?: number;
  outputCostUsd?: number;
  cacheReadCostUsd?: number;
  cacheCreationCostUsd?: number;
  /** 本地价格表估算总成本（美元）；hasCost 为 false 时不是 0 美元而是未定价。 */
  totalCostUsd?: number;
  hasCost?: boolean;
  status: "success" | "error";
}

export interface CreditBreakdownItem {
  harness: HarnessId;
  label: string;
  credits: number;
}

export interface HarnessUsage {
  harness: HarnessId;
  records: UsageRecord[];
  scannedFiles: number;
  skippedFiles: number;
  source: string;
  sourceAvailable: boolean;
}

export interface UsageSource extends Omit<HarnessUsage, "records"> {
  recordCount: number;
}

export type UsageSyncPhase = "empty" | "importing" | "ready" | "error";

export interface UsageSyncStatus {
  phase: UsageSyncPhase;
  revision: number;
  hasSnapshot: boolean;
  startedAt: number | null;
  syncedAt: number | null;
  durationMs: number | null;
  error: string | null;
  recordCount: number;
}

export interface UsageResponse {
  records: UsageRecord[];
  sources: UsageSource[];
  scannedFiles: number;
  skippedFiles: number;
  syncedAt: number;
  /** 以下字段由持久化查询层附加；reader 的原始扫描结果不包含它们。 */
  revision?: number;
  snapshotAvailable?: boolean;
  sync?: UsageSyncStatus;
}

export interface UsageSnapshotResponse extends UsageResponse {
  revision: number;
  snapshotAvailable: boolean;
  sync: UsageSyncStatus;
}

/** 聚合查询的筛选条件；与前端筛选栏一一对应。 */
export interface UsageQueryFilters {
  range: RangeKey;
  /** 自定义时间段的起点（epoch 毫秒，闭区间）；仅 range === "custom" 时有效。 */
  start?: number;
  /** 自定义时间段的终点（epoch 毫秒，闭区间）；仅 range === "custom" 时有效。 */
  end?: number;
  harness: HarnessFilter;
  project: string;
  provider: string;
  model: string;
  billing: BillingFilter;
}

export const DEFAULT_USAGE_FILTERS: UsageQueryFilters = {
  range: "today",
  harness: "all",
  project: "all",
  provider: "all",
  model: "all",
  billing: "all",
};

/** POST /api/usage/sync 的小结果；不再随同步返回全部历史记录（M6）。 */
export interface UsageSyncResult {
  revision: number;
  changed: boolean;
  recordCount: number;
  syncedAt: number;
  sync: UsageSyncStatus;
}

export interface UsageGroups {
  harness: GroupStat[];
  provider: GroupStat[];
  model: GroupStat[];
  project: GroupStat[];
}

/** 下拉选项的轻量 facet；与汇总共用 Harness/供应商口径。 */
export interface UsageFacets {
  projects: string[];
  providers: string[];
  models: string[];
}

/** 服务端聚合视图；页面默认只下载该响应，不再下载全部历史 records。 */
export interface UsageView {
  revision: number;
  snapshotAvailable: boolean;
  syncedAt: number;
  sync: UsageSyncStatus;
  sources: UsageSource[];
  scannedFiles: number;
  skippedFiles: number;
  summary: UsageSummary;
  /** 侧栏“今日消耗”；只按 Harness 过滤，不随所选范围变化。 */
  todaySummary: UsageSummary;
  trend: TrendPoint[];
  groups: UsageGroups;
  facets: UsageFacets;
  /** 当前筛选命中的记录总数；用于日志 tab 计数与导出入口。 */
  filteredCount: number;
}

/** 请求日志分页页；页大小受服务端钳制。 */
export interface UsageRecordsPage {
  revision: number;
  total: number;
  page: number;
  pageSize: number;
  records: UsageRecord[];
}

/** 统计页按时间桶（日/月）的聚合行；不含首字与速度（分桶中位数成本高）。 */
export interface UsageBucketStat {
  /** 桶键：daily 为 "YYYY-MM-DD"，monthly 为 "YYYY-MM"（本地时区）。 */
  key: string;
  requests: number;
  credits: number;
  hasCredit: boolean;
  /** 按 Harness 分列的计费 Credits，不同 Harness 的 Credits 单位不同。 */
  creditsByHarness: CreditBreakdownItem[];
  mixedCreditUnits: boolean;
  /** 服务端报告了 Credits 但标记为不计费的部分。 */
  unbilledCredits: number;
  tokens: number;
  hasTokens: boolean;
  /** 本地价格表估算成本（美元）；unpricedRequests > 0 时为已定价部分的下限。 */
  costUsd: number;
  hasCost: boolean;
  /** 有 Token 用量但价格表未命中的请求数。 */
  unpricedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheableInputTokens: number;
  cacheRate: number;
  successRate: number;
}

/** 统计页 日×模型 明细行；按 model 透视展示。 */
export interface UsageDayModelStat {
  day: string;
  model: string;
  provider: string;
  requests: number;
  tokens: number;
  hasTokens: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  credits: number;
  hasCredit: boolean;
  /** 本地价格表估算成本（美元）。 */
  costUsd: number;
  hasCost: boolean;
  unpricedRequests: number;
}

/** 统计页 月×模型 明细行；不截断，覆盖全部有记录的月份。 */
export interface UsageMonthModelStat extends Omit<UsageDayModelStat, "day"> {
  /** 桶键 "YYYY-MM"（本地时区）。 */
  month: string;
}

/** 统计面板聚合视图（/api/usage/stats）；与 /api/usage/query 共用筛选口径。 */
export interface UsageStatsView {
  revision: number;
  snapshotAvailable: boolean;
  /** 按日聚合（本地时区），日期降序，只含有记录的日期。 */
  daily: UsageBucketStat[];
  /** 按月聚合，月份降序，只含有记录的月份。 */
  monthly: UsageBucketStat[];
  /** 按 日×模型 聚合（日降序、Tokens 降序）；天数受 STATS_DAILY_MODEL_MAX_DAYS 限制。 */
  dailyModels: UsageDayModelStat[];
  /** dailyModels 因天数上限被截断（保留最近日期，单日不会被切断）。 */
  dailyModelsTruncated: boolean;
  /** 按 月×模型 聚合（月降序、Tokens 降序），不截断。 */
  monthlyModels: UsageMonthModelStat[];
}

export interface UsageSummary {
  requests: number;
  /** 计费 Credits 合计；mixedCreditUnits 为 true 时跨 Harness 相加，没有意义，不应展示。 */
  credits: number;
  hasCredit: boolean;
  /** 按 Harness 分列的计费 Credits，不同 Harness 的 Credits 单位不同。 */
  creditsByHarness: CreditBreakdownItem[];
  mixedCreditUnits: boolean;
  /** 服务端报告了 Credits 但标记为不计费的部分。 */
  unbilledCredits: number;
  tokens: number;
  hasTokens: boolean;
  /** 本地价格表估算成本（美元）；unpricedRequests > 0 时为已定价部分的下限。 */
  costUsd: number;
  hasCost: boolean;
  /** 有 Token 用量但价格表未命中的请求数。 */
  unpricedRequests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheableInputTokens: number;
  cacheRate: number;
  successRate: number;
  /** 速度分子：可估算速度的请求（输出 ≥ 200 token 且估算耗时 ≥ 1s）的输出 token 之和。 */
  speedOutputTokens: number;
  /** 速度分母：同批请求的估算耗时之和（毫秒）。汇总速度 = 分子 ÷ (分母 / 1000)。 */
  speedDurationMs: number;
  /** 首 token 中位数（毫秒）：原生计时来源的成功请求；没有时为 null。 */
  firstTokenMedianMs: number | null;
  /** 估算首 token 中位数（毫秒）：Claude / Codex 按时间戳推出的请求；展示带 ≈。 */
  estFirstTokenMedianMs: number | null;
}

export interface GroupStat extends UsageSummary {
  key: string;
  lastUsed: number;
}

export interface TrendPoint {
  key: string;
  label: string;
  fullLabel: string;
  tokens: number;
  requests: number;
  credits: number;
  /** 本地价格表估算成本（美元）。 */
  cost: number;
  /** 服务端报告但标记为不计费的 Credits，用于在趋势图上叠加显示。 */
  unbilledCredits: number;
  cacheRate: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheableInputTokens: number;
}

export const RANGE_OPTIONS: Array<{ value: RangeKey; label: string }> = [
  { value: "today", label: "当天" },
  { value: "yesterday", label: "昨天" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
  { value: "custom", label: "自定义时间段" },
  { value: "all", label: "全部时间" },
];

export const BILLING_OPTIONS: Array<{ value: BillingFilter; label: string }> = [
  { value: "all", label: "全部计费状态" },
  { value: "billable", label: "计费" },
  { value: "unbilled", label: "未计费" },
];

/** 没有计费标记的记录（如 CodeBuddy）按计费处理。 */
function matchesBilling(record: UsageRecord, billing: BillingFilter): boolean {
  if (billing === "billable") return record.billable !== false;
  if (billing === "unbilled") return record.billable === false;
  return true;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** custom 跨度 ≤ 6 小时按分钟聚合，≤ 7 天按小时，更长按日期。 */
const MINUTE_GRANULARITY_MAX_SPAN_MS = 6 * HOUR_MS;
const HOUR_GRANULARITY_MAX_SPAN_MS = 7 * DAY_MS;
/** custom 按日期聚合时最多铺满 366 天空桶；更长跨度只为出现过的日期建桶（同 all）。 */
const DAY_SCAFFOLD_MAX_SPAN_MS = 366 * DAY_MS;
const pad = (value: number) => String(value).padStart(2, "0");

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function getRangeBounds(range: RangeKey, now = new Date()) {
  const today = startOfDay(now).getTime();
  if (range === "today") return { start: today, end: now.getTime() };
  if (range === "yesterday") {
    return { start: today - DAY_MS, end: today - 1 };
  }
  if (range === "7d") return { start: today - 6 * DAY_MS, end: now.getTime() };
  if (range === "30d") return { start: today - 29 * DAY_MS, end: now.getTime() };
  return { start: 0, end: Number.POSITIVE_INFINITY };
}

/**
 * 解析筛选条件的时间边界；custom 必须显式给出 start/end，缺失时直接抛错，
 * 避免静默退化为全部时间（解析层已在 400 拦截，这里是纵深防御）。
 */
export function resolveRangeBounds(
  filters: Pick<UsageQueryFilters, "range" | "start" | "end">,
  now = new Date(),
): { start: number; end: number } {
  if (filters.range === "custom") {
    const { start, end } = filters;
    if (start === undefined || end === undefined) {
      throw new Error("自定义时间段缺少 start/end");
    }
    return { start, end };
  }
  return getRangeBounds(filters.range, now);
}

/** 趋势聚合粒度：预设沿用原有口径（当天/昨天按小时，其余按日期），custom 按跨度分档。 */
export function getTrendGranularity(
  range: RangeKey,
  start?: number,
  end?: number,
): TrendGranularity {
  if (range === "today" || range === "yesterday") return "hour";
  if (range !== "custom" || start === undefined || end === undefined) return "day";
  const span = end - start;
  if (span <= MINUTE_GRANULARITY_MAX_SPAN_MS) return "minute";
  if (span <= HOUR_GRANULARITY_MAX_SPAN_MS) return "hour";
  return "day";
}

/** 进入自定义时间段的默认窗口：今天 00:00 ～ 今天 23:00。 */
export function defaultCustomRange(now = new Date()): { start: number; end: number } {
  const day = startOfDay(now).getTime();
  return { start: day, end: day + 23 * HOUR_MS };
}

/** 筛选触发器显示的自定义时间段文案：同天 “11-15 10:00–11:30”，跨天带各自日期。 */
export function formatCustomRangeLabel(start: number, end: number): string {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const day = (date: Date) => `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const clock = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const startText = `${day(startDate)} ${clock(startDate)}`;
  const endText = dateKey(end) === dateKey(start) ? clock(endDate) : `${day(endDate)} ${clock(endDate)}`;
  return `${startText}–${endText}`;
}

export function filterUsageRecords(
  records: UsageRecord[],
  range: RangeKey,
  project = "all",
  provider = "all",
  model = "all",
  now = new Date(),
  harness: HarnessFilter = "all",
  billing: BillingFilter = "all",
  custom?: { start?: number; end?: number },
): UsageRecord[] {
  const { start, end } = resolveRangeBounds(
    { range, start: custom?.start, end: custom?.end },
    now,
  );
  return records
    .filter(
      (record) =>
        record.timestamp >= start &&
        record.timestamp <= end &&
        (harness === "all" || record.harness === harness) &&
        (project === "all" || record.project === project) &&
        (provider === "all" || record.provider === provider) &&
        (model === "all" || record.model === model) &&
        matchesBilling(record, billing),
    )
    .sort((a, b) => b.timestamp - a.timestamp);
}

function getCacheableInputTokens(record: UsageRecord): number {
  if (record.inputTokenSemantics === "total") return record.inputTokens;
  return record.inputTokens + record.cacheReadTokens + record.cacheCreationTokens;
}

export function summarizeRecords(records: UsageRecord[]): UsageSummary {
  const inputTokens = records.reduce((sum, record) => sum + record.inputTokens, 0);
  const cacheReadTokens = records.reduce(
    (sum, record) => sum + record.cacheReadTokens,
    0,
  );
  const cacheableInputTokens = records.reduce(
    (sum, record) => sum + getCacheableInputTokens(record),
    0,
  );
  const successful = records.filter((record) => record.status === "success").length;
  const creditTotals = new Map<HarnessId, number>();
  let unbilledCredits = 0;
  for (const record of records) {
    if (record.hasCredit) {
      creditTotals.set(record.harness, (creditTotals.get(record.harness) ?? 0) + record.credits);
    }
    if (record.billable === false) unbilledCredits += record.reportedCredits ?? 0;
  }
  const creditsByHarness = HARNESS_OPTIONS.flatMap((option) => {
    const credits = creditTotals.get(option.id);
    return credits === undefined ? [] : [{ harness: option.id, label: option.label, credits }];
  });
  const speedTotals = sumSpeedTotals(records);
  const firstToken = collectFirstTokenMedians(records);
  return {
    requests: records.length,
    credits: records.reduce((sum, record) => sum + record.credits, 0),
    hasCredit: creditsByHarness.length > 0,
    creditsByHarness,
    mixedCreditUnits: creditsByHarness.length > 1,
    unbilledCredits,
    tokens: records.reduce((sum, record) => sum + record.totalTokens, 0),
    hasTokens: records.some((record) => record.hasTokenUsage),
    costUsd: records.reduce((sum, record) => sum + (record.totalCostUsd ?? 0), 0),
    hasCost: records.some((record) => record.hasCost === true),
    unpricedRequests: records.filter((record) => record.hasTokenUsage && record.hasCost !== true).length,
    inputTokens,
    outputTokens: records.reduce((sum, record) => sum + record.outputTokens, 0),
    cacheReadTokens,
    cacheableInputTokens,
    cacheRate: cacheableInputTokens > 0 ? cacheReadTokens / cacheableInputTokens : 0,
    successRate: records.length > 0 ? successful / records.length : 0,
    speedOutputTokens: speedTotals.speedOutputTokens,
    speedDurationMs: speedTotals.speedDurationMs,
    firstTokenMedianMs: firstToken.firstTokenMedianMs,
    estFirstTokenMedianMs: firstToken.estFirstTokenMedianMs,
  };
}

export function groupRecords(
  records: UsageRecord[],
  dimension: GroupDimension,
): GroupStat[] {
  const groups = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const key = record[dimension];
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return Array.from(groups, ([key, rows]) => ({
    key,
    ...summarizeRecords(rows),
    lastUsed: Math.max(...rows.map((record) => record.timestamp)),
  })).sort((a, b) => b.requests - a.requests || b.tokens - a.tokens);
}

function dateKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 与 SQL strftime('%Y-%m-%d %H', …, 'localtime') 一致的小时桶 key。 */
function hourKey(timestamp: number): string {
  return `${dateKey(timestamp)} ${pad(new Date(timestamp).getHours())}`;
}

/** 与 SQL strftime('%Y-%m-%d %H:%M', …, 'localtime') 一致的分钟桶 key。 */
function minuteKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${dateKey(timestamp)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function floorHour(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()).getTime();
}

function floorMinute(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
  ).getTime();
}

function emptyPoint(key: string, label: string, fullLabel: string): TrendPoint {
  return {
    key,
    label,
    fullLabel,
    tokens: 0,
    requests: 0,
    credits: 0,
    cost: 0,
    unbilledCredits: 0,
    cacheRate: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheableInputTokens: 0,
  };
}

/**
 * 趋势桶脚手架：按范围生成从早到晚的空桶。`all` 范围只为出现过的日期
 * （presentDayKeys，升序）建桶；服务端聚合时传入 SQL 分组得到的日期键。
 * `custom` 按 getTrendGranularity 的粒度铺桶（边界缺省时返回空脚手架，
 * 正常链路由 resolveRangeBounds 先行拦截）。
 */
export function createTrendPoints(
  range: RangeKey,
  now = new Date(),
  presentDayKeys: string[] = [],
  custom?: { start?: number; end?: number },
): Map<string, TrendPoint> {
  const points = new Map<string, TrendPoint>();
  const granularity = getTrendGranularity(range, custom?.start, custom?.end);
  const hourly = range === "today" || range === "yesterday";

  if (range === "custom") {
    const { start, end } = custom ?? {};
    if (start === undefined || end === undefined) return points;
    if (granularity === "minute") {
      for (let timestamp = floorMinute(start); timestamp <= end; timestamp += 60_000) {
        const key = minuteKey(timestamp);
        const next = minuteKey(timestamp + 60_000);
        // 桶区间文案与小时桶一致：同天右侧只带时间，跨天带完整日期。
        const fullLabel =
          key.slice(0, 10) === next.slice(0, 10) ? `${key}–${next.slice(11)}` : `${key}–${next}`;
        points.set(key, emptyPoint(key, key.slice(11), fullLabel));
      }
    } else if (granularity === "hour") {
      // 跨天的 custom 小时桶在 label 上带日期前缀，避免连续多天出现重复的 “10:00”。
      const sameDay = dateKey(start) === dateKey(end);
      for (let timestamp = floorHour(start); timestamp <= end; timestamp += HOUR_MS) {
        const key = hourKey(timestamp);
        const date = new Date(timestamp);
        const clock = `${pad(date.getHours())}:00`;
        points.set(
          key,
          emptyPoint(
            key,
            sameDay ? clock : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`,
            `${key}:00–${pad((date.getHours() + 1) % 24)}:00`,
          ),
        );
      }
    } else if (end - start <= DAY_SCAFFOLD_MAX_SPAN_MS) {
      for (let timestamp = startOfDay(new Date(start)).getTime(); timestamp <= end; timestamp += DAY_MS) {
        const key = dateKey(timestamp);
        const date = new Date(timestamp);
        points.set(
          key,
          emptyPoint(key, `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`, key),
        );
      }
    } else {
      // 超长跨度只为出现过的日期建桶，与 all 分支一致。
      for (const day of Array.from(new Set(presentDayKeys)).sort()) {
        const date = new Date(`${day}T00:00:00`);
        points.set(
          day,
          emptyPoint(day, `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`, day),
        );
      }
    }
    return points;
  }

  if (hourly) {
    const today = startOfDay(now).getTime();
    const day = range === "today" ? today : today - DAY_MS;
    const hours = range === "today" ? now.getHours() + 1 : 24;
    for (let hour = 0; hour < hours; hour += 1) {
      const key = `${dateKey(day)} ${pad(hour)}`;
      points.set(
        key,
        emptyPoint(
          key,
          `${pad(hour)}:00`,
          `${dateKey(day)} ${pad(hour)}:00–${pad((hour + 1) % 24)}:00`,
        ),
      );
    }
  } else if (range === "all") {
    const days = Array.from(new Set(presentDayKeys)).sort();
    for (const day of days) {
      const date = new Date(`${day}T00:00:00`);
      points.set(
        day,
        emptyPoint(day, `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`, day),
      );
    }
  } else {
    const { start, end } = getRangeBounds(range, now);
    for (let timestamp = start; timestamp <= end; timestamp += DAY_MS) {
      const key = dateKey(timestamp);
      const date = new Date(timestamp);
      points.set(
        key,
        emptyPoint(key, `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`, key),
      );
    }
  }

  return points;
}

export function buildTrend(
  records: UsageRecord[],
  range: RangeKey,
  now = new Date(),
  custom?: { start?: number; end?: number },
): TrendPoint[] {
  const points = createTrendPoints(
    range,
    now,
    records.map((record) => dateKey(record.timestamp)),
    custom,
  );
  const granularity = getTrendGranularity(range, custom?.start, custom?.end);

  for (const record of records) {
    const key =
      granularity === "minute"
        ? minuteKey(record.timestamp)
        : granularity === "hour"
          ? hourKey(record.timestamp)
          : dateKey(record.timestamp);
    const point = points.get(key);
    if (!point) continue;
    point.tokens += record.totalTokens;
    point.requests += 1;
    point.credits += record.credits;
    point.cost += record.totalCostUsd ?? 0;
    if (record.billable === false) point.unbilledCredits += record.reportedCredits ?? 0;
    point.inputTokens += record.inputTokens;
    point.cacheReadTokens += record.cacheReadTokens;
    point.cacheableInputTokens += getCacheableInputTokens(record);
  }

  return Array.from(points.values()).map((point) => ({
    ...point,
    cacheRate:
      point.cacheableInputTokens > 0
        ? point.cacheReadTokens / point.cacheableInputTokens
        : 0,
  }));
}

/** 从模型名推断供应商；兜底值由调用方给定（如 CodeBuddy / KCode）。 */
export function deriveProvider(model: string, fallback = "CodeBuddy"): string {
  const normalized = model.toLowerCase();
  if (normalized.includes("deepseek")) return "DeepSeek";
  if (normalized.includes("kimi") || /^k\d/.test(normalized)) return "Moonshot AI";
  if (normalized.includes("claude")) return "Anthropic";
  if (/(gpt|openai|^o[134])/.test(normalized)) return "OpenAI";
  if (normalized.includes("gemini")) return "Google";
  if (normalized.includes("qwen")) return "Alibaba Cloud";
  if (normalized.includes("doubao")) return "Volcengine";
  if (normalized.includes("minimax")) return "MiniMax";
  return fallback;
}

export function formatCompact(value: number): string {
  const absolute = Math.abs(value);
  // 999.5K 四舍五入后是 1000K，所以从这里开始就进位到下一个单位。
  if (absolute >= 999.5e6) return `${trimNumber(value / 1e9)}B`;
  if (absolute >= 999.5e3) return `${trimNumber(value / 1e6)}M`;
  if (absolute >= 1e3) return `${trimNumber(value / 1e3)}K`;
  return Math.round(value).toLocaleString("zh-CN");
}

function trimNumber(value: number): string {
  const absolute = Math.abs(value);
  const digits = absolute >= 100 ? 0 : absolute >= 10 ? 1 : 2;
  return String(Number(value.toFixed(digits)));
}

export function formatPercent(value: number): string {
  const percent = Math.max(0, Math.min(100, value * 100));
  return `${percent.toFixed(percent >= 99.95 || percent === 0 ? 0 : 1)}%`;
}

export function formatCredits(value: number, hasCredit = true): string {
  if (!hasCredit) return "—";
  return value.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

export function getHarnessLabel(harness: HarnessId): string {
  return HARNESS_OPTIONS.find((option) => option.id === harness)?.label ?? harness;
}

export function getProjectLabel(directory: string): string {
  return directory.replace(/^[a-z]--?code-/i, "") || directory;
}
