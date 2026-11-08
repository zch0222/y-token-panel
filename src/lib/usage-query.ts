import type { DatabaseSync } from "node:sqlite";
import {
  SPEED_ESTIMATE_MIN_DURATION_MS,
  SPEED_ESTIMATE_MIN_OUTPUT_TOKENS,
} from "@/lib/speed";
import {
  BILLING_OPTIONS,
  createTrendPoints,
  getRangeBounds,
  HARNESS_OPTIONS,
  RANGE_OPTIONS,
  summarizeRecords,
  type BillingFilter,
  type GroupDimension,
  type GroupStat,
  type HarnessFilter,
  type HarnessId,
  type TrendPoint,
  type UsageFacets,
  type UsageQueryFilters,
  type UsageRecord,
  type UsageRecordsPage,
  type UsageSource,
  type UsageSummary,
  type UsageSyncStatus,
  type UsageView,
} from "@/lib/usage";

/** 分页页大小上限；防止一次拉走全部历史记录。 */
export const MAX_RECORDS_PAGE_SIZE = 100;
export const DEFAULT_RECORDS_PAGE_SIZE = 10;
const MAX_FILTER_TEXT_LENGTH = 300;
/** getRangeBounds 对 all 返回 Infinity；SQL 绑定安全整数上界即可等价。 */
const MAX_TIMESTAMP_MS = Number.MAX_SAFE_INTEGER;

interface SummaryRow {
  requests: number;
  credits: number;
  has_credit: number;
  unbilled_credits: number;
  tokens: number;
  has_token_usage: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cacheable_input_tokens: number;
  successful: number;
  speed_output_tokens: number;
  speed_duration_ms: number;
}

interface TrendRow {
  bucket: string;
  tokens: number;
  requests: number;
  credits: number;
  unbilled_credits: number;
  input_tokens: number;
  cache_read_tokens: number;
  cacheable_input_tokens: number;
}

export interface RecordRow {
  id: number;
  record_id: string;
  request_id: string;
  session_id: string;
  harness: HarnessId;
  project: string;
  model: string;
  provider: string;
  timestamp_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
  input_token_semantics: "fresh" | "total";
  has_token_usage: number;
  credits: number;
  has_credit: number;
  reported_credits: number | null;
  billable: number | null;
  context_usage_ratio: number | null;
  estimated_duration_ms: number | null;
  status: "success" | "error";
}

/** 供分页、详情与 readNormalizedRecords 共用的行映射；可选字段保持 undefined 语义。 */
export function mapRecordRow(row: RecordRow): UsageRecord {
  return {
    id: row.record_id,
    requestId: row.request_id,
    sessionId: row.session_id,
    harness: row.harness,
    project: row.project,
    model: row.model,
    provider: row.provider,
    timestamp: row.timestamp_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    totalTokens: row.total_tokens,
    inputTokenSemantics: row.input_token_semantics,
    hasTokenUsage: row.has_token_usage === 1,
    credits: row.credits,
    hasCredit: row.has_credit === 1,
    ...(row.reported_credits === null ? {} : { reportedCredits: row.reported_credits }),
    ...(row.billable === null ? {} : { billable: row.billable === 1 }),
    ...(row.context_usage_ratio === null
      ? {}
      : { contextUsageRatio: row.context_usage_ratio }),
    ...(row.estimated_duration_ms === null
      ? {}
      : { estimatedDurationMs: row.estimated_duration_ms }),
    status: row.status,
  };
}

/**
 * 与 matchesBilling 相同的 SQL 口径：没有计费标记（NULL）的记录按计费处理。
 */
function billingCondition(billing: BillingFilter): string {
  if (billing === "billable") return "(billable IS NULL OR billable = 1)";
  if (billing === "unbilled") return "(billable = 0)";
  return "1 = 1";
}

interface FilterSql {
  where: string;
  params: Array<string | number>;
}

/** 与 filterUsageRecords 相同筛选条件的 SQL 形态；调用方决定是否省略部分维度。 */
function filterSql(filters: UsageQueryFilters, now: Date, options: {
  skipRange?: boolean;
  skipBilling?: boolean;
  skipFacet?: Array<"project" | "provider" | "model">;
} = {}): FilterSql {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  if (!options.skipRange) {
    const { start, end } = getRangeBounds(filters.range, now);
    conditions.push("timestamp_ms >= ?", "timestamp_ms <= ?");
    params.push(start, Math.min(end, MAX_TIMESTAMP_MS));
  }
  if (filters.harness !== "all") {
    conditions.push("harness = ?");
    params.push(filters.harness);
  }
  const skip = new Set(options.skipFacet ?? []);
  if (filters.project !== "all" && !skip.has("project")) {
    conditions.push("project = ?");
    params.push(filters.project);
  }
  if (filters.provider !== "all" && !skip.has("provider")) {
    conditions.push("provider = ?");
    params.push(filters.provider);
  }
  if (filters.model !== "all" && !skip.has("model")) {
    conditions.push("model = ?");
    params.push(filters.model);
  }
  if (!options.skipBilling) conditions.push(billingCondition(filters.billing));
  return { where: conditions.length > 0 ? conditions.join(" AND ") : "1 = 1", params };
}

// 与 summarizeRecords 逐字段等价的聚合表达式；credits 合计不含 hasCredit 门槛
// （口径与 JS 一致：不计费记录 credits 恒为 0），creditsByHarness 另按来源分组。
const SUMMARY_SQL = `
  COUNT(*) AS requests,
  COALESCE(SUM(credits), 0) AS credits,
  COALESCE(MAX(has_credit), 0) AS has_credit,
  COALESCE(SUM(CASE WHEN billable = 0 THEN COALESCE(reported_credits, 0) ELSE 0 END), 0) AS unbilled_credits,
  COALESCE(SUM(total_tokens), 0) AS tokens,
  COALESCE(MAX(has_token_usage), 0) AS has_token_usage,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens,
  COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(CASE WHEN input_token_semantics = 'total'
    THEN input_tokens ELSE input_tokens + cache_read_tokens + cache_creation_tokens END), 0) AS cacheable_input_tokens,
  COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS successful,
  COALESCE(SUM(CASE WHEN estimated_duration_ms IS NOT NULL
    AND estimated_duration_ms >= ${SPEED_ESTIMATE_MIN_DURATION_MS}
    AND output_tokens >= ${SPEED_ESTIMATE_MIN_OUTPUT_TOKENS}
    THEN output_tokens ELSE 0 END), 0) AS speed_output_tokens,
  COALESCE(SUM(CASE WHEN estimated_duration_ms IS NOT NULL
    AND estimated_duration_ms >= ${SPEED_ESTIMATE_MIN_DURATION_MS}
    AND output_tokens >= ${SPEED_ESTIMATE_MIN_OUTPUT_TOKENS}
    THEN estimated_duration_ms ELSE 0 END), 0) AS speed_duration_ms
`;

const EMPTY_SUMMARY = summarizeRecords([]);

function summaryFromRow(row: SummaryRow, creditsByHarness: UsageSummary["creditsByHarness"]): UsageSummary {
  return {
    requests: row.requests,
    credits: row.credits,
    hasCredit: row.has_credit === 1 || creditsByHarness.length > 0,
    creditsByHarness,
    mixedCreditUnits: creditsByHarness.length > 1,
    unbilledCredits: row.unbilled_credits,
    tokens: row.tokens,
    hasTokens: row.has_token_usage === 1,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheableInputTokens: row.cacheable_input_tokens,
    cacheRate: row.cacheable_input_tokens > 0 ? row.cache_read_tokens / row.cacheable_input_tokens : 0,
    successRate: row.requests > 0 ? row.successful / row.requests : 0,
    speedOutputTokens: row.speed_output_tokens,
    speedDurationMs: row.speed_duration_ms,
  };
}

function creditsByHarnessFromRows(
  creditRows: Array<{ harness: HarnessId; credits: number }>,
): UsageSummary["creditsByHarness"] {
  const creditTotals = new Map(creditRows.map((creditRow) => [creditRow.harness, creditRow.credits]));
  return HARNESS_OPTIONS.flatMap((option) => {
    const credits = creditTotals.get(option.id);
    return credits === undefined ? [] : [{ harness: option.id, label: option.label, credits }];
  });
}

function querySummary(db: DatabaseSync, where: string, params: Array<string | number>): UsageSummary {
  const row = db
    .prepare(`SELECT ${SUMMARY_SQL} FROM usage_records WHERE ${where}`)
    .get(...params) as unknown as SummaryRow;
  // creditsByHarness 与 hasCredit 与 JS 口径一致：只聚合 has_credit = 1 的来源。
  const creditRows = db
    .prepare(
      `SELECT harness, COALESCE(SUM(credits), 0) AS credits
       FROM usage_records WHERE ${where} AND has_credit = 1
       GROUP BY harness`,
    )
    .all(...params) as unknown as Array<{ harness: HarnessId; credits: number }>;
  return summaryFromRow(row, creditsByHarnessFromRows(creditRows));
}

const GROUP_DIMENSIONS: Record<GroupDimension, string> = {
  harness: "harness",
  provider: "provider",
  model: "model",
  project: "project",
};

function queryGroups(
  db: DatabaseSync,
  where: string,
  params: Array<string | number>,
): UsageView["groups"] {
  const result = {} as UsageView["groups"];
  for (const dimension of Object.keys(GROUP_DIMENSIONS) as GroupDimension[]) {
    const column = GROUP_DIMENSIONS[dimension];
    const rows = db
      .prepare(
        `SELECT ${column} AS group_key, ${SUMMARY_SQL}, MAX(timestamp_ms) AS last_used
         FROM usage_records WHERE ${where} GROUP BY ${column}`,
      )
      .all(...params) as unknown as Array<SummaryRow & { group_key: string; last_used: number }>;
    // 组内 Credits 按 Harness 分列（模型/项目组可跨 Harness），与 summarizeRecords 一致。
    const creditRows = db
      .prepare(
        `SELECT ${column} AS group_key, harness, COALESCE(SUM(credits), 0) AS credits
         FROM usage_records WHERE ${where} AND has_credit = 1
         GROUP BY ${column}, harness`,
      )
      .all(...params) as unknown as Array<{ group_key: string; harness: HarnessId; credits: number }>;
    const creditTotals = new Map<string, Map<HarnessId, number>>();
    for (const creditRow of creditRows) {
      const group = creditTotals.get(creditRow.group_key) ?? new Map<HarnessId, number>();
      group.set(creditRow.harness, creditRow.credits);
      creditTotals.set(creditRow.group_key, group);
    }
    const stats: GroupStat[] = rows.map((row) => {
      const totals = creditTotals.get(row.group_key);
      const creditsByHarness = HARNESS_OPTIONS.flatMap((option) => {
        const credits = totals?.get(option.id);
        return credits === undefined ? [] : [{ harness: option.id, label: option.label, credits }];
      });
      return {
        key: row.group_key,
        ...summaryFromRow(row, creditsByHarness),
        lastUsed: row.last_used,
      };
    });
    result[dimension] = stats.sort((a, b) => b.requests - a.requests || b.tokens - a.tokens);
  }
  return result;
}

/** 与 buildTrend 相同的空桶 + 本地时区分桶；聚合值来自 SQL GROUP BY。 */
function queryTrend(
  db: DatabaseSync,
  filters: UsageQueryFilters,
  now: Date,
): TrendPoint[] {
  const hourly = filters.range === "today" || filters.range === "yesterday";
  const bucketFormat = hourly ? "%Y-%m-%d %H" : "%Y-%m-%d";
  const { where, params } = filterSql(filters, now);
  const rows = db
    .prepare(
      `SELECT strftime('${bucketFormat}', timestamp_ms / 1000, 'unixepoch', 'localtime') AS bucket,
        COALESCE(SUM(total_tokens), 0) AS tokens,
        COUNT(*) AS requests,
        COALESCE(SUM(credits), 0) AS credits,
        COALESCE(SUM(CASE WHEN billable = 0 THEN COALESCE(reported_credits, 0) ELSE 0 END), 0) AS unbilled_credits,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
        COALESCE(SUM(CASE WHEN input_token_semantics = 'total'
          THEN input_tokens ELSE input_tokens + cache_read_tokens + cache_creation_tokens END), 0) AS cacheable_input_tokens
      FROM usage_records WHERE ${where}
      GROUP BY bucket`,
    )
    .all(...params) as unknown as TrendRow[];
  const points = createTrendPoints(filters.range, now, rows.map((row) => row.bucket));
  for (const row of rows) {
    const point = points.get(row.bucket);
    if (!point) continue;
    point.tokens += row.tokens;
    point.requests += row.requests;
    point.credits += row.credits;
    point.unbilledCredits += row.unbilled_credits;
    point.inputTokens += row.input_tokens;
    point.cacheReadTokens += row.cache_read_tokens;
    point.cacheableInputTokens += row.cacheable_input_tokens;
  }
  return Array.from(points.values()).map((point) => ({
    ...point,
    cacheRate:
      point.cacheableInputTokens > 0
        ? point.cacheReadTokens / point.cacheableInputTokens
        : 0,
  }));
}

function distinctValues(
  db: DatabaseSync,
  column: "project" | "provider" | "model",
  where: string,
  params: Array<string | number>,
): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT ${column} AS value FROM usage_records WHERE ${where} ORDER BY value`,
      )
      .all(...params) as unknown as Array<{ value: string }>
  ).map((row) => row.value);
}

/**
 * 下拉选项 facet；与前端口径一致：只按 Harness（模型另加所选供应商）过滤，
 * 不随时间范围或计费状态收窄，避免选项随筛选消失。
 */
function queryFacets(db: DatabaseSync, filters: UsageQueryFilters): UsageFacets {
  const base = filterSql(filters, new Date(0), {
    skipRange: true,
    skipBilling: true,
    skipFacet: ["project", "provider", "model"],
  });
  const modelSql = filterSql(filters, new Date(0), {
    skipRange: true,
    skipBilling: true,
    skipFacet: ["project", "model"],
  });
  return {
    projects: distinctValues(db, "project", base.where, base.params),
    providers: distinctValues(db, "provider", base.where, base.params),
    models: distinctValues(db, "model", modelSql.where, modelSql.params),
  };
}

export interface UsageViewContext {
  status: UsageSyncStatus;
  sources: UsageSource[];
}

/** 服务端聚合视图；status/sources 由调用方在只读事务内提供。 */
export function buildUsageView(
  db: DatabaseSync,
  filters: UsageQueryFilters,
  now: Date,
  context: UsageViewContext,
): UsageView {
  const { status, sources } = context;
  const scannedFiles = sources.reduce((sum, source) => sum + source.scannedFiles, 0);
  const skippedFiles = sources.reduce((sum, source) => sum + source.skippedFiles, 0);
  if (!status.hasSnapshot) {
    return {
      revision: status.revision,
      snapshotAvailable: false,
      syncedAt: status.syncedAt ?? 0,
      sync: status,
      sources,
      scannedFiles,
      skippedFiles,
      summary: EMPTY_SUMMARY,
      todaySummary: EMPTY_SUMMARY,
      trend: [],
      groups: { harness: [], provider: [], model: [], project: [] },
      facets: { projects: [], providers: [], models: [] },
      filteredCount: 0,
    };
  }

  const { where, params } = filterSql(filters, now);
  // 侧栏今日消耗只按 Harness 过滤（range=today），与改造前前端口径一致。
  const todayFilters: UsageQueryFilters = { ...filters, range: "today" };
  const todaySql = filterSql(todayFilters, now, {
    skipBilling: true,
    skipFacet: ["project", "provider", "model"],
  });
  const filteredCount = (
    db
      .prepare(`SELECT COUNT(*) AS total FROM usage_records WHERE ${where}`)
      .get(...params) as unknown as { total: number }
  ).total;
  return {
    revision: status.revision,
    snapshotAvailable: true,
    syncedAt: status.syncedAt ?? 0,
    sync: status,
    sources,
    scannedFiles,
    skippedFiles,
    summary: querySummary(db, where, params),
    todaySummary: querySummary(db, todaySql.where, todaySql.params),
    trend: queryTrend(db, filters, now),
    groups: queryGroups(db, where, params),
    facets: queryFacets(db, filters),
    filteredCount,
  };
}

/** 请求日志分页；越界页码钳制到最后一页，排序确定性依赖 (timestamp_ms, rowid)。 */
export function buildRecordsPage(
  db: DatabaseSync,
  filters: UsageQueryFilters,
  page: number,
  pageSize: number,
  now: Date,
  revision: number,
): UsageRecordsPage {
  const { where, params } = filterSql(filters, now);
  const total = (
    db
      .prepare(`SELECT COUNT(*) AS total FROM usage_records WHERE ${where}`)
      .get(...params) as unknown as { total: number }
  ).total;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(Math.max(0, page), pageCount - 1);
  const rows = db
    .prepare(
      `SELECT * FROM usage_records WHERE ${where}
       ORDER BY timestamp_ms DESC, id ASC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, currentPage * pageSize) as unknown as RecordRow[];
  return {
    revision,
    total,
    page: currentPage,
    pageSize,
    records: rows.map(mapRecordRow),
  };
}

/** 单条详情按 (harness, record_id) 查询；不存在返回 null。 */
export function findUsageRecord(
  db: DatabaseSync,
  harness: HarnessId,
  recordId: string,
): UsageRecord | null {
  const row = db
    .prepare("SELECT * FROM usage_records WHERE harness = ? AND record_id = ?")
    .get(harness, recordId) as unknown as RecordRow | undefined;
  return row === undefined ? null : mapRecordRow(row);
}

/** CSV 导出用：同筛选的全部记录，排序与分页一致。 */
export function findAllUsageRecords(
  db: DatabaseSync,
  filters: UsageQueryFilters,
  now: Date,
): UsageRecord[] {
  const { where, params } = filterSql(filters, now);
  const rows = db
    .prepare(
      `SELECT * FROM usage_records WHERE ${where} ORDER BY timestamp_ms DESC, id ASC`,
    )
    .all(...params) as unknown as RecordRow[];
  return rows.map(mapRecordRow);
}

export interface UsageQueryParams {
  filters: UsageQueryFilters;
  page: number;
  pageSize: number;
}

export type ParseUsageQueryResult =
  | { ok: true; value: UsageQueryParams }
  | { ok: false; error: string };

const RANGE_VALUES = new Set(RANGE_OPTIONS.map((option) => option.value));
const BILLING_VALUES = new Set(BILLING_OPTIONS.map((option) => option.value));
const HARNESS_VALUES = new Set<string>(HARNESS_OPTIONS.map((option) => option.id));

function parseEnum<T extends string>(
  searchParams: URLSearchParams,
  key: string,
  allowed: Set<string>,
  fallback: T,
): T | null {
  const raw = searchParams.get(key);
  if (raw === null || raw === "") return fallback;
  return allowed.has(raw) ? (raw as T) : null;
}

function parseFilterText(
  searchParams: URLSearchParams,
  key: string,
): string | null {
  const raw = searchParams.get(key);
  if (raw === null || raw === "") return "all";
  if (raw.length > MAX_FILTER_TEXT_LENGTH) return null;
  return raw;
}

function parsePositiveInteger(
  searchParams: URLSearchParams,
  key: string,
  fallback: number,
): number | null {
  const raw = searchParams.get(key);
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

/** 路由共享的查询参数解析；非法值返回 400 文案而不是静默回退。 */
export function parseUsageQueryParams(searchParams: URLSearchParams): ParseUsageQueryResult {
  const filters: UsageQueryFilters = {
    range: "today",
    harness: "all",
    project: "all",
    provider: "all",
    model: "all",
    billing: "all",
  };
  const range = parseEnum(searchParams, "range", RANGE_VALUES, filters.range);
  if (range === null) return { ok: false, error: "range 参数非法" };
  filters.range = range;
  const harness = parseEnum(
    searchParams,
    "harness",
    new Set(["all", ...HARNESS_VALUES]),
    filters.harness,
  );
  if (harness === null) return { ok: false, error: "harness 参数非法" };
  filters.harness = harness as HarnessFilter;
  const billing = parseEnum(searchParams, "billing", BILLING_VALUES, filters.billing);
  if (billing === null) return { ok: false, error: "billing 参数非法" };
  filters.billing = billing;
  for (const key of ["project", "provider", "model"] as const) {
    const value = parseFilterText(searchParams, key);
    if (value === null) return { ok: false, error: `${key} 参数非法` };
    filters[key] = value;
  }

  const page = parsePositiveInteger(searchParams, "page", 0);
  if (page === null) return { ok: false, error: "page 参数非法" };
  const rawPageSize = parsePositiveInteger(
    searchParams,
    "pageSize",
    DEFAULT_RECORDS_PAGE_SIZE,
  );
  if (rawPageSize === null) return { ok: false, error: "pageSize 参数非法" };
  const pageSize = Math.min(rawPageSize, MAX_RECORDS_PAGE_SIZE);
  return { ok: true, value: { filters, page, pageSize } };
}
