import path from "node:path";
import {
  deriveProvider,
  type UsageRecord,
} from "@/lib/usage";

/**
 * CodeBuddy CLI 会话记录（~/.codebuddy/projects/<项目>/<会话>.jsonl，每行一个
 * history item）的字段语义依据本机 @tencent-ai/codebuddy-code v2.181.0 的
 * dist/codebuddy.js 反查确认，不靠字段名望文生义：
 *
 * - `timestamp`：SessionManager.ensureHistoryItemTimestamp(item, now =
 *   Date.now()) 在 item 通过 addHistory 进入会话历史时补盖，即「该条目完成
 *   入库的时刻」。assistant 的 message item 由模型响应完成后（response_done
 *   事件带最终 usage 与完整输出）才构造并入库，所以它的 timestamp ≈ 该次
 *   模型请求的结束时刻；user 消息的 timestamp = 提交时刻；function_call_result
 *   的 timestamp = 工具执行完成时刻。
 * - `parentId`：上一条已入库条目的 id（lastMessageId 链）。同一响应内部的
 *   reasoning item 会先入库、成为 message item 的直接父级（实测仅相差几十
 *   毫秒），因此单看直接父级推不出请求耗时，必须继续回溯。
 * - 会话日志中没有首字计时，也没有单请求延迟字段（elapsedMs 只进监控事件，
 *   不落会话文件）；`turn-metrics` 是回合级指标（durationMs = 回合起止墙钟，
 *   含工具执行；tokenDelta 是含输入的累计 totalTokens 差），不能当生成速度用。
 * - CodeBuddy 自己定位「新请求起点」用的也是 user 消息或 function_call_result
 *   （InputItemUtils.findLatestUserOrToolCallResultMessageId）。
 */

interface MessageUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  credit?: number | string;
  prompt_cache_hit_tokens?: number;
  prompt_cache_write_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface ProviderData {
  model?: string;
  requestModelId?: string;
  conversationRequestId?: string;
  messageId?: string;
  rawUsage?: RawUsage;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    inputTokensDetails?: Array<{ cached_tokens?: number }>;
  };
}

export interface SessionRecord {
  id?: string;
  /** 条目完成入库的时刻（毫秒），见文件头说明。 */
  timestamp?: number | string;
  parentId?: string;
  type?: string;
  role?: string;
  status?: string;
  sessionId?: string;
  message?: { usage?: MessageUsage };
  providerData?: ProviderData;
}

/** 父链回溯的最大步数：正常会话几十步内必达请求起点，超界视为脏数据。 */
const MAX_PARENT_WALK = 64;

export function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = finiteNumber(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

export function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }
  return undefined;
}

/** 这一条目是不是「新请求的起点」：用户消息或工具结果（工具结束即下一次模型请求开始）。 */
function isRequestBoundary(item: SessionRecord): boolean {
  if (item.type === "function_call_result") return true;
  return item.type === "message" && item.role === "user";
}

/**
 * 估算单条 assistant 消息的请求耗时（毫秒）：
 * message.timestamp（模型响应完成）− 最近请求起点条目的 timestamp。
 * 沿 parentId 回溯，跳过同一响应内部的 reasoning / message / function_call
 * 条目，直到 user 消息或 function_call_result。窗口含首字等待。推不出有效
 * 窗口（父级缺失、成环、时间戳非法、差值非正）时返回 undefined。
 */
export function deriveEstimatedDurationMs(
  item: SessionRecord,
  byId: Map<string, SessionRecord>,
): number | undefined {
  const messageTimestamp = parseTimestamp(item.timestamp);
  if (messageTimestamp === undefined) return undefined;

  const visited = new Set<string>();
  let current: SessionRecord | undefined = item;
  for (let step = 0; step < MAX_PARENT_WALK; step += 1) {
    const parentId = current?.parentId;
    if (!parentId || typeof parentId !== "string") return undefined;
    if (visited.has(parentId)) return undefined;
    visited.add(parentId);
    const parent: SessionRecord | undefined = byId.get(parentId);
    if (!parent) return undefined;
    if (isRequestBoundary(parent)) {
      const boundaryTimestamp = parseTimestamp(parent.timestamp);
      if (boundaryTimestamp === undefined) return undefined;
      const duration = messageTimestamp - boundaryTimestamp;
      return Number.isFinite(duration) && duration > 0 ? duration : undefined;
    }
    current = parent;
  }
  return undefined;
}

function parseSessionRecord(
  record: SessionRecord,
  project: string,
  file: string,
  lineIndex: number,
): UsageRecord | null {
  const providerData = record.providerData;
  const messageUsage = record.message?.usage;
  const rawUsage = providerData?.rawUsage;
  if (!messageUsage && !providerData?.usage && !rawUsage) return null;

  const timestamp = parseTimestamp(record.timestamp);
  if (timestamp === undefined) return null;

  const inputTokens = firstNumber(
    messageUsage?.input_tokens,
    rawUsage?.prompt_tokens,
    providerData?.usage?.inputTokens,
  ) ?? 0;
  const outputTokens = firstNumber(
    messageUsage?.output_tokens,
    rawUsage?.completion_tokens,
    providerData?.usage?.outputTokens,
  ) ?? 0;
  const cacheReadTokens = firstNumber(
    messageUsage?.cache_read_input_tokens,
    rawUsage?.prompt_cache_hit_tokens,
    rawUsage?.prompt_tokens_details?.cached_tokens,
    rawUsage?.cache_read_input_tokens,
    providerData?.usage?.inputTokensDetails?.[0]?.cached_tokens,
  ) ?? 0;
  const cacheCreationTokens = firstNumber(
    messageUsage?.cache_creation_input_tokens,
    rawUsage?.prompt_cache_write_tokens,
    rawUsage?.cache_creation_input_tokens,
  ) ?? 0;
  const totalTokens = firstNumber(
    messageUsage?.total_tokens,
    rawUsage?.total_tokens,
    providerData?.usage?.totalTokens,
  ) ?? inputTokens + outputTokens;
  const credits = finiteNumber(rawUsage?.credit);
  const sessionId = record.sessionId ?? path.basename(file, ".jsonl");
  const id = record.id ?? providerData?.messageId ?? `${file}:${lineIndex}`;
  const model = providerData?.model ?? providerData?.requestModelId ?? "未知模型";
  const failedStatuses = new Set(["error", "failed", "cancelled", "canceled"]);

  return {
    id: `codebuddy:${sessionId}:${id}`,
    requestId: providerData?.conversationRequestId ?? id,
    sessionId,
    harness: "codebuddy",
    project,
    model,
    provider: deriveProvider(model),
    timestamp,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    inputTokenSemantics: "total",
    hasTokenUsage:
      firstNumber(
        messageUsage?.total_tokens,
        rawUsage?.total_tokens,
        providerData?.usage?.totalTokens,
      ) !== undefined || totalTokens > 0,
    credits: credits ?? 0,
    hasCredit: credits !== undefined,
    status: failedStatuses.has(record.status?.toLowerCase() ?? "") ? "error" : "success",
  };
}

/**
 * 解析整个会话文件：先按行解析出 UsageRecord，再基于全文件的 id → item
 * 映射为每条记录推导估算请求耗时（estimatedDurationMs）。
 */
export function parseSessionFile(
  content: string,
  project: string,
  file: string,
): UsageRecord[] {
  const lines = content.split(/\r?\n/);
  const byId = new Map<string, SessionRecord>();
  const parsed: Array<{ record: UsageRecord; item: SessionRecord }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    let item: SessionRecord;
    try {
      item = JSON.parse(line) as SessionRecord;
    } catch {
      continue;
    }
    if (typeof item.id === "string" && item.id) byId.set(item.id, item);
    const record = parseSessionRecord(item, project, file, index);
    if (record) parsed.push({ record, item });
  }

  return parsed.map(({ record, item }) => ({
    ...record,
    estimatedDurationMs: deriveEstimatedDurationMs(item, byId),
  }));
}
