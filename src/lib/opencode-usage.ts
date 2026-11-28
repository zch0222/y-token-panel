// OpenCode 用量解析器。
//
// 字段语义以本机安装的 @opencode/cli@2.4.2 内嵌源码为准（Bun 打包后的
// module-0076/0078/0395/0399/0401/0408，不是根据字段名猜测）：
// - opencode 2.4.2 使用事件溯源投影写入 SQLite。`session.step.ended` /
//   `session.step.failed` 会落成 `session_message.type = "assistant"` 的消息，
//   并在消息 `data.tokens`、`data.cost`、`data.time` 中持久化 token、费用和时间。
// - 自动/手动压缩摘要会落成 `session_message.type = "compaction"`，其
//   `data.status` 是 "completed" | "failed"，`data.tokens` 同样保存压缩请求的 token。
// - `TokenUsage.Info` 的精确形状是
//   `{ input, output, reasoning, cache: { read, write } }`，五项都是整数。module-0401 的
//   归一化函数明确取 `nonCachedInputTokens` 作为 input、`visibleOutputTokens` 作为 output，
//   reasoning 单独记录；OpenCode 自己的 total 是五项求和，因此 input 是 fresh 口径，
//   output 需要加回 reasoning 才能与面板 total 字段对齐。
// - assistant `time.created` 是模型 step 开始时间，`time.completed` 是 step 完成/失败时间。
//   2.4.2 还有 `time.streamed`（流结束）和 `time.firstToken`（首个模型 token 到达），
//   这两个字段随消息 JSON 持久化；cc-switch 所谓“没有 first token”只适用于其参考的旧版本。
// - `model` 在 v2 assistant 消息中是 `{ providerID, id, variant }` 对象；旧 v1 消息迁移前是
//   `providerID` / `modelID` 平铺字段。opencode 启动时会自动把 v1 表迁移成 v2，但为了兼容
//   尚未由 opencode 2.x 打开过的数据库，本解析器同时直接读取 v1 表。
// - `cost` 是美元成本：优先使用模型/供应商报告的 usage.cost，缺失时 OpenCode 会按模型价目估算。
//   落库后的消息不保留“报告值还是估算值”的标记，所以这里不把它冒充供应商额度；y-token-panel
//   仍按统一模型价格表计算美元成本，OpenCode 记录的 credits 恒为不可用。
// - v2 会话位于 `session_v2.directory`；标题生成等后台调用只汇总到 session 行，没有独立的
//   request/message 行，事件表投影后也不会保留可重放事件，因此和 cc-switch 一样只统计
//   assistant/compaction 消息中可归属到具体请求的用量。

import { basename } from "node:path";
import { deriveProvider, type UsageRecord } from "@/lib/usage";

export const OPENCODE_V2_USAGE_SQL = `
  SELECT
    m.id AS message_id,
    m.type AS message_type,
    m.time_created AS row_time_created,
    m.time_updated AS row_time_updated,
    m.data AS data,
    s.id AS session_id,
    s.directory AS session_directory
  FROM session_message m
  JOIN session_v2 s ON s.id = m.session_id
  WHERE m.type IN ('assistant', 'compaction')
  ORDER BY m.time_created ASC, m.id ASC
`;

export const OPENCODE_V1_USAGE_SQL = `
  SELECT
    m.id AS message_id,
    NULL AS message_type,
    m.time_created AS row_time_created,
    m.time_updated AS row_time_updated,
    m.data AS data,
    s.id AS session_id,
    s.directory AS session_directory
  FROM message m
  JOIN session s ON s.id = m.session_id
  ORDER BY m.time_created ASC, m.id ASC
`;

export type OpenCodeSchemaVersion = "v1" | "v2";

export interface OpenCodeUsageRow {
  message_id: unknown;
  message_type: unknown;
  row_time_created: unknown;
  row_time_updated: unknown;
  data: unknown;
  session_id: unknown;
  session_directory: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  return undefined;
}

function asNonNegativeNumber(value: unknown): number | undefined {
  const parsed = asFiniteNumber(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function parseMessageData(raw: unknown): Record<string, unknown> | undefined {
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readTokenUsage(data: Record<string, unknown>): {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
} | undefined {
  if (!isRecord(data.tokens)) return undefined;
  const input = asNonNegativeNumber(data.tokens.input);
  const output = asNonNegativeNumber(data.tokens.output);
  const reasoning = asNonNegativeNumber(data.tokens.reasoning);
  const cache = isRecord(data.tokens.cache) ? data.tokens.cache : undefined;
  const cacheRead = asNonNegativeNumber(cache?.read);
  const cacheWrite = asNonNegativeNumber(cache?.write);
  if (
    input === undefined ||
    output === undefined ||
    reasoning === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined
  ) {
    return undefined;
  }
  return {
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    total: input + output + reasoning + cacheRead + cacheWrite,
  };
}

function readModel(data: Record<string, unknown>, schema: OpenCodeSchemaVersion): {
  model: string;
  providerID?: string;
} {
  const modelField = data.model;
  const modelFromObject = isRecord(modelField) ? asNonEmptyString(modelField.id) : undefined;
  const providerFromObject = isRecord(modelField) ? asNonEmptyString(modelField.providerID) : undefined;
  const model =
    schema === "v2"
      ? modelFromObject ?? asNonEmptyString(data.modelID) ?? asNonEmptyString(modelField)
      : asNonEmptyString(data.modelID) ?? modelFromObject ?? asNonEmptyString(modelField);
  const providerID =
    schema === "v2"
      ? providerFromObject ?? asNonEmptyString(data.providerID)
      : asNonEmptyString(data.providerID) ?? providerFromObject;
  return { model: model ?? "unknown", providerID };
}

function readMessageType(
  data: Record<string, unknown>,
  row: OpenCodeUsageRow,
  schema: OpenCodeSchemaVersion,
): "assistant" | "compaction" | undefined {
  if (schema === "v2") {
    return row.message_type === "assistant" || row.message_type === "compaction"
      ? row.message_type
      : undefined;
  }
  return data.role === "assistant" ? "assistant" : undefined;
}

function isMessageComplete(
  type: "assistant" | "compaction",
  data: Record<string, unknown>,
): boolean {
  if (type === "compaction") return data.status === "completed" || data.status === "failed";
  const time = isRecord(data.time) ? data.time : undefined;
  return asFiniteNumber(time?.completed) !== undefined;
}

function readTimestamp(data: Record<string, unknown>, row: OpenCodeUsageRow): number | undefined {
  const time = isRecord(data.time) ? data.time : undefined;
  return asFiniteNumber(time?.created) ?? asFiniteNumber(row.row_time_created);
}

function readDuration(data: Record<string, unknown>, created: number): number | undefined {
  const time = isRecord(data.time) ? data.time : undefined;
  const completed = asFiniteNumber(time?.completed);
  if (completed === undefined) return undefined;
  // OpenCode 同时记录流结束时间和 step 完成时间。cc-switch 优先使用 streamed，
  // 因为 completed 可能包含 step 收尾；只有 streamed 缺失/乱序时才退回 completed。
  const streamed = asFiniteNumber(time?.streamed);
  const end = streamed !== undefined && streamed > created ? streamed : completed;
  return end > created ? end - created : undefined;
}

function readFirstTokenMs(
  data: Record<string, unknown>,
  created: number,
  durationMs?: number,
): number | undefined {
  const time = isRecord(data.time) ? data.time : undefined;
  const firstToken = asFiniteNumber(time?.firstToken);
  if (firstToken === undefined || firstToken <= created) return undefined;
  const latency = firstToken - created;
  if (durationMs !== undefined && latency > durationMs) return undefined;
  return latency;
}

function readStatus(
  type: "assistant" | "compaction",
  data: Record<string, unknown>,
): "success" | "error" {
  if (type === "compaction") return data.status === "failed" ? "error" : "success";
  return isRecord(data.error) || data.finish === "error" ? "error" : "success";
}

export function opencodeProjectLabel(directory: string | undefined): string {
  let normalized = (directory ?? "").split(String.fromCharCode(92)).join("/");
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  const leaf = normalized ? basename(normalized) : "";
  return leaf || normalized || "unknown";
}

export function parseOpenCodeUsageRow(
  row: OpenCodeUsageRow,
  schema: OpenCodeSchemaVersion,
): UsageRecord | null {
  const data = parseMessageData(row.data);
  if (!data) return null;
  const type = readMessageType(data, row, schema);
  if (!type || !isMessageComplete(type, data)) return null;

  const usage = readTokenUsage(data);
  // cc-switch 也跳过全零 token 行；失败的 assistant step 经常只有 error/time，没有真实用量。
  if (!usage || usage.total <= 0) return null;

  const timestamp = readTimestamp(data, row);
  const sessionId = asNonEmptyString(row.session_id);
  const messageId = asNonEmptyString(row.message_id);
  if (timestamp === undefined || !sessionId || !messageId) return null;

  const durationMs = readDuration(data, timestamp);
  const firstTokenMs = readFirstTokenMs(data, timestamp, durationMs);
  const { model, providerID } = readModel(data, schema);
  const directory = asNonEmptyString(row.session_directory);

  return {
    id: `opencode:${sessionId}:${messageId}`,
    requestId: messageId,
    sessionId,
    harness: "opencode",
    project: opencodeProjectLabel(directory),
    model,
    provider: providerID ?? deriveProvider(model, "OpenCode"),
    timestamp,
    inputTokens: usage.input,
    outputTokens: usage.output + usage.reasoning,
    cacheReadTokens: usage.cacheRead,
    cacheCreationTokens: usage.cacheWrite,
    totalTokens: usage.total,
    inputTokenSemantics: "fresh",
    hasTokenUsage: true,
    credits: 0,
    hasCredit: false,
    status: readStatus(type, data),
    ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
    ...(durationMs !== undefined ? { estimatedDurationMs: durationMs } : {}),
  };
}

export function collectOpenCodeUsage(
  rows: Iterable<OpenCodeUsageRow>,
  schema: OpenCodeSchemaVersion,
): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const row of rows) {
    const record = parseOpenCodeUsageRow(row, schema);
    if (record) records.push(record);
  }
  return records;
}
