import { deriveProvider, type UsageRecord } from "@/lib/usage";

/**
 * PI-Desktop（vastsa/PI-Desktop，Electron 桌面编码助手）会话转录
 * （~/.pi-desktop/sessions/<uuid>.jsonl，每行一个 JSON 记录）的字段语义
 * 依据本机 PI-Desktop 0.22.0 的自身代码反查确认，不靠字段名望文生义：
 *
 * - 转录由 host-core（Rust，crates/host-core/src/transcripts.rs）写入：首行是
 *   `{"type":"session","createdAt":...,"schema":2,"sessionId":...}`，之后每行
 *   一条记录；`type` 还可能是 `message` / `compaction` / `tool_review_state`
 *   （后两者不含量），阅读器对未知 type 与坏行是跳过（"skipping unparseable
 *   transcript line"），崩溃可能留下残缺尾行。
 * - 用量只出现在 `type:"message"` 且 `role:"assistant"` 的记录上：
 *   `meta.usage` 是 app 主进程 usageFromPi 归一化后落盘的形态——
 *   `inputTokens` 不含缓存读（fresh 口径）、`cacheReadTokens`/`cacheWriteTokens`
 *   仅 >0 时写入、`reasoningTokens` 是 output 的子集（不另行累计）、
 *   `totalTokens` 为上游报告值（已含缓存，权威），缺失时回退四项求和；
 *   `operationId` 是单次模型请求的稳定标识（消息编辑重写后不变），是去重键；
 *   `aggregation:"aggregate"` 表示多条请求合计，此时若有 `usage.operations[]`
 *   则只对 operations 求和、忽略顶层值，二者取一。
 * - `cost`：绝对美元；`costStatus:"reported"` 表示供应商计费
 *   （cost.totalFromProvider），`"estimated"` 为按 models.dev 本地估算，
 *   `"unknown"` 时整个 cost 对象不落盘。
 * - `meta.status`：`complete` / `in_progress` / `error` / `aborted`。失败
 *   （error/aborted）请求通常没有 usage 对象，但请求确实发生（有
 *   responseDurationMs），仍按零 token 的失败请求计数，口径对齐 cc-switch
 *   对 pi 会话 stopReason:"error" 零用量仍导入的处理。
 * - `meta.responseDurationMs`：精确计时的响应耗时（毫秒）。
 * - `meta.modelId` 是模型目录 id（模型维度主键），`responseModelId` 是供应
 *   商实际服务的模型，缺失时回退；`meta.providerId` 是 app 内部 provider 行
 *   UUID，不适合展示，供应商按模型名推断。
 * - 记录级 `createdAt` 为 ISO-8601 UTC 毫秒时间戳；转录内没有 cwd / 项目
 *   信息（项目归组只存于 pi.sqlite），项目维度记「未知项目」。
 * - 伴随文件 `<uuid>.revisions.jsonl`（消息编辑历史）、`<uuid>.inflight.json`
 *   （流式中转瞬态）不是转录，由 reader/discovery 排除；消息编辑 / 删除 /
 *   截断会原子重写主文件（tmp+rename），所以增量走整文件重读引擎。
 */

interface PiUsageEntry {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}

interface PiUsage extends PiUsageEntry {
  /** 单次模型请求的稳定标识；legacy 事件为 "message:<sessionId>:<messageId>"。 */
  operationId?: string;
  aggregation?: string;
  usageOrigin?: string;
  costStatus?: string;
  /** aggregation:"aggregate" 时的逐请求明细；存在则只对其求和。 */
  operations?: PiUsageEntry[];
}

interface PiMessageMeta {
  modelId?: string;
  responseModelId?: string;
  providerId?: string;
  status?: string;
  responseDurationMs?: number;
  usage?: PiUsage;
}

export interface PiDesktopRecord {
  type?: string;
  id?: string;
  role?: string;
  createdAt?: string | number;
  sessionId?: string;
  /** session 头的 schema 版本（当前为 2）；message 记录的内容块数组。 */
  schema?: number;
  blocks?: unknown[];
  meta?: PiMessageMeta;
}

export function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }
  return undefined;
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** 单条 usage（或 operations 汇总）的 token 四项 + 上游报告 total。 */
interface TokenSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reportedTotalTokens: number;
}

function tokenValue(value: unknown): number {
  const parsed = finiteNumber(value);
  return parsed === undefined ? 0 : Math.round(parsed);
}

function summarizeEntry(entry: PiUsageEntry | undefined): TokenSummary {
  return {
    inputTokens: tokenValue(entry?.inputTokens),
    outputTokens: tokenValue(entry?.outputTokens),
    cacheReadTokens: tokenValue(entry?.cacheReadTokens),
    cacheCreationTokens: tokenValue(entry?.cacheWriteTokens),
    reportedTotalTokens: tokenValue(entry?.totalTokens),
  };
}

function sumTokenSummaries(summaries: TokenSummary[]): TokenSummary {
  return summaries.reduce(
    (sum, item) => ({
      inputTokens: sum.inputTokens + item.inputTokens,
      outputTokens: sum.outputTokens + item.outputTokens,
      cacheReadTokens: sum.cacheReadTokens + item.cacheReadTokens,
      cacheCreationTokens: sum.cacheCreationTokens + item.cacheCreationTokens,
      reportedTotalTokens: sum.reportedTotalTokens + item.reportedTotalTokens,
    }),
    summarizeEntry(undefined),
  );
}

/** cost 报告总额（美元）：total>0 用之，否则按组件求和（负值按 0 计）。 */
function costTotal(entry: PiUsageEntry | undefined): number | undefined {
  const cost = entry?.cost;
  if (!cost || typeof cost !== "object") return undefined;
  const total = finiteNumber(cost.total);
  if (total !== undefined && total > 0) return total;
  const components = [cost.input, cost.output, cost.cacheRead, cost.cacheWrite];
  const componentSum = components.reduce<number>((sum, value) => {
    const parsed = finiteNumber(value);
    return sum + (parsed !== undefined && parsed > 0 ? parsed : 0);
  }, 0);
  return componentSum > 0 ? componentSum : undefined;
}

/** aggregation:"aggregate" 且带 operations[] 时只对明细求和，忽略顶层值。 */
function resolveTokenSummary(usage: PiUsage): TokenSummary {
  if (Array.isArray(usage.operations) && usage.operations.length > 0) {
    return sumTokenSummaries(usage.operations.map((operation) => summarizeEntry(operation)));
  }
  return summarizeEntry(usage);
}

function resolveCostTotal(usage: PiUsage): number | undefined {
  if (Array.isArray(usage.operations) && usage.operations.length > 0) {
    const totals = usage.operations
      .map((operation) => costTotal(operation))
      .filter((value): value is number => value !== undefined);
    if (totals.length > 0) return totals.reduce((sum, value) => sum + value, 0);
    return undefined;
  }
  return costTotal(usage);
}

function parseAssistantRecord(
  entry: PiDesktopRecord,
  sessionId: string,
  file: string,
  lineIndex: number,
): UsageRecord | null {
  const meta = entry.meta;
  const usage = meta?.usage;
  const hasUsage = typeof usage === "object" && usage !== null;
  const failed = meta?.status === "error" || meta?.status === "aborted";
  // 无 usage 且未失败的 assistant 记录（纯工具调用回合等）不是模型请求。
  if (!hasUsage && !failed) return null;

  const timestamp = parseTimestamp(entry.createdAt);
  if (timestamp === undefined) return null;

  const tokens = hasUsage ? resolveTokenSummary(usage) : summarizeEntry(undefined);
  const totalTokens =
    tokens.reportedTotalTokens > 0
      ? tokens.reportedTotalTokens
      : tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheCreationTokens;

  const operationId = hasUsage ? nonemptyString(usage.operationId) : undefined;
  const messageId = nonemptyString(entry.id);
  const fallbackId = messageId ?? `${file}:${lineIndex}`;
  const recordKey = operationId ?? fallbackId;

  // costStatus:"reported"（供应商计费）才计入 Credits（绝对美元）；
  // "estimated" 为本地估算，不计费、仅保留报告值；"unknown" 无 cost 对象。
  const costStatus = hasUsage ? usage.costStatus : undefined;
  const reportedCost = hasUsage ? resolveCostTotal(usage) : undefined;
  const isReportedCost = costStatus === "reported" && reportedCost !== undefined;

  const model =
    nonemptyString(meta?.modelId) ??
    nonemptyString(meta?.responseModelId) ??
    "未知模型";
  const duration = finiteNumber(meta?.responseDurationMs);

  return {
    id: `pidesktop:${sessionId}:${recordKey}`,
    requestId: recordKey,
    sessionId,
    harness: "pidesktop",
    project: "未知项目",
    model,
    provider: deriveProvider(model, "Pi Desktop"),
    timestamp,
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cacheReadTokens: tokens.cacheReadTokens,
    cacheCreationTokens: tokens.cacheCreationTokens,
    totalTokens,
    inputTokenSemantics: "fresh",
    hasTokenUsage:
      totalTokens > 0 ||
      tokens.inputTokens > 0 ||
      tokens.outputTokens > 0 ||
      tokens.cacheReadTokens > 0 ||
      tokens.cacheCreationTokens > 0,
    credits: isReportedCost ? reportedCost : 0,
    hasCredit: isReportedCost,
    reportedCredits: reportedCost,
    estimatedDurationMs: duration !== undefined && duration > 0 ? duration : undefined,
    status: failed ? "error" : "success",
  };
}

/**
 * 解析整个 PI-Desktop 会话转录文件。首个有效 JSON 行必须是 session 头，
 * 否则视为非 PI-Desktop 转录返回空（与 host-core 阅读器同口径）；
 * 坏行、未知 type 与非 assistant 记录一律跳过。
 */
export function parsePiDesktopSession(content: string, file: string): UsageRecord[] {
  const lines = content.split(/\r?\n/);
  const records: UsageRecord[] = [];
  let sessionId = file.replace(/\.jsonl$/, "");
  let sawSessionHeader = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    let entry: PiDesktopRecord;
    try {
      entry = JSON.parse(line) as PiDesktopRecord;
    } catch {
      continue;
    }
    if (!sawSessionHeader) {
      if (entry.type !== "session") return [];
      sawSessionHeader = true;
      const headerSessionId = nonemptyString(entry.sessionId);
      if (headerSessionId) sessionId = headerSessionId;
      continue;
    }
    if (entry.type !== "message" || entry.role !== "assistant") continue;
    const record = parseAssistantRecord(entry, sessionId, file, index);
    if (record) records.push(record);
  }

  return records;
}
