import { estimatedFirstTokenMs } from "@/lib/first-token";
import {
  deriveProvider,
  type UsageRecord,
} from "@/lib/usage";

/**
 * Codex / ChatGPT rollout 会话记录（~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 * 与压缩形态 .jsonl.zst、~/.codex/archived_sessions/*.jsonl[.zst]，每行一个带
 * ordinal 的事件）的字段语义依据本机 Codex 的代码与真实数据反查确认，并与
 * cc-switch 的会话导入（src-tauri/src/services/session_usage_codex.rs，下称
 * cc-switch）逐条对齐，不靠字段名望文生义：
 *
 * - 行信封 `{timestamp, ordinal, type, payload}`：timestamp 为 RFC3339 写入
 *   时刻；ordinal 从 0 递增，是行在文件内的稳定序号（追加写不变化）。
 * - `session_meta`（只认第一条；本机实测 fork 文件会在 ordinal 1 追加一条
 *   复制来的父线程 meta，不能覆盖）：`payload.id` / `payload.session_id` 为
 *   线程 ID；`forked_from_id` 与 `source.subagent.thread_spawn.parent_thread_id`
 *   指向父线程；`history_mode=paginated` 且带 `history_base`（thread_id +
 *   end_ordinal_exclusive + end_byte_offset）的是翻页/续写页。
 * - `turn_context`：`payload.model` 当前模型、`payload.cwd` 本回合工作目录
 *   （项目归因）；`event_msg/thread_settings_applied` 的
 *   `payload.thread_settings.model` 在 resume 后改模型时更新归因。
 * - `event_msg/token_count`：`payload.info.last_token_usage` 是上一次请求的
 *   精确用量；`total_token_usage` 是线程累计（跨模型与限额桶继续累加，翻页
 *   续写页从父线程累计起算——本机实测续写页首条 total=9025169 恰为父线程
 *   结束累计 8836623 + 自身首请求 188546）。`payload.rate_limits.limit_id`
 *   是快照来源：限额刷新会在别的桶下重发同样的快照（本机实测 100 条
 *   total 只有 99 个不同值），按来源最新全量签名去重。
 * - `token_usage_record`：响应结束写的 `payload.usage`（精确单请求用量），
 *   出现在对应 token_count 之前；远程压缩后 token_count.last 全 0、用量只写
 *   在这里，需按本文件补记（cc-switch 同款）。
 * - `TokenUsage` 语义（本机 codex.exe 二进制 serde 字段序 input/cached_input/
 *   cache_write_input/output/reasoning_output/total 交叉验证）：缓存读与缓存
 *   写是 input_tokens 的不相交组成部分（cc-switch: “Cache reads and writes
 *   are disjoint parts of input_tokens”），total_tokens = input + output（实测
 *   28292+162=28454）；reasoning_output_tokens 含在 output 内（本机
 *   `last_usage_includes_reasoning` 恒为 true）。因此记录按「新鲜输入」口径
 *   统计：inputTokens = input − cached − cache_write。
 * - 子代理 fork（thread_spawn）：本机实测计数器独立从 0 起算（fork 首条
 *   total==last==自身首请求，父线程彼时已累计数百万），不重放父 token 事件；
 *   旧版 Codex 会把父历史复制进子文件，cc-switch 用「子事件签名序列匹配父
 *   线程 fork 时刻前签名序列的前缀数」剔除重放，本解析器同样实现作防御。
 * - 翻页会产生 `rollout-…-<threadId>_<rolloutId>.jsonl` 双段文件名
 *   （openai/codex#38127）：尾部是新的 rollout ID，root meta 的 id 始终是
 *   线程本体 UUID。去重键用文件名尾部 UUID（物理 rollout 身份），会话 ID 用
 *   meta 线程 ID（cc-switch 同款口径）。
 * - Credits：rollout 只在 rate_limits 里带余额/百分比快照，没有单请求费用，
 *   因此 Codex 记录不参与 Credits 统计。日志里没有请求级错误标记（失败的
 *   请求等不到 token_count），与 Claude/KCode 同款全部按 success 计。
 * - 会话日志没有请求计时，耗时按 cc-switch 的 RequestTimer 从各行时间戳推
 *   （含首字等待；口径与边界条件见 CodexRequestTimer 注释）。
 */

/** 单次或累计 token 用量（rollout 的 TokenUsage 结构）。 */
export interface CodexTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

/** 一条 token 事件的增量（缓存读/写已夹进 input 的不相交份额）。 */
export interface CodexTokenDelta {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
}

/** token 事件的匹配签名（cc-switch TokenUsageSignature 的序列化形态）。 */
export type CodexSignatureKey = string;

/** 父时间线里一条带时间戳的 token 事件签名。 */
export interface CodexTimelineEvent {
  timestampMs: number;
  signatureKey: CodexSignatureKey;
}

/** 解析单个 rollout 文件得到的一次计入事件。 */
export interface CodexParsedEvent {
  /** 行 ordinal；去重键与 usage 兜底事件的挂载行都用它。 */
  ordinal: number;
  signatureKey: CodexSignatureKey;
  /** 计入的增量；重复快照为 null（只留签名供重放匹配）。 */
  delta: CodexTokenDelta | null;
  /** 去重后缀：自增序号（token_count 路径）或 `usage:<response_id|行号>`。 */
  requestKey?: string;
  timestampMs?: number;
  model: string;
  cwd?: string;
  estimatedDurationMs?: number;
  firstTokenMs?: number;
}

export interface CodexRolloutMeta {
  /** root session_meta 的线程 ID（会话身份）。 */
  threadId?: string;
  /** 显式父线程（forked_from_id / thread_spawn.parent_thread_id）。 */
  parentThreadId?: string;
  /** root meta 的 timestamp：fork 时刻（父重放签名只取此刻之前）。 */
  rootTimestampMs?: number;
  /** 双段文件名（<threadId>_<rolloutId>）里下划线前的线程本体 UUID。 */
  leadingThreadId?: string;
  /** 翻页/续写页（history_mode=paginated 或 history_base 指向自身）。 */
  isContinuation: boolean;
  /** history_base.thread_id（续写页前序分段的线程）。 */
  historyBaseThreadId?: string;
  /** root meta 的 history_base（bounded 引用：父 rollout 的字节区间）。 */
  historyBase?: CodexHistoryBase;
  /** 会话初始工作目录（项目归因兜底）。 */
  cwd?: string;
}

/** session_meta 的 history_base：指向父 rollout 的一个物理前缀区间。 */
export interface CodexHistoryBase {
  threadId?: string;
  endByteOffset?: number;
  endOrdinalExclusive?: number;
}

/**
 * bounded-fork 验证所需的首事件基线（cc-switch verified_bounded_fork 的
 * `total − last`）与全事件资格：首事件 total/last 两组计数器齐全、所有事件
 * 都带精确 last（input/output 字段在场）且时间戳晚于 fork 时刻。
 */
export interface CodexBoundedForkCandidate {
  /** 首事件 total − last（逐字段；任一组字段不齐全时 undefined）。 */
  baseline?: TokenCountersDelta;
  /** 所有 token 事件与兜底事件都满足资格。 */
  eventsQualify: boolean;
}

/** 逐字段计数器差（与签名同款：字段缺失记 null）。 */
export interface TokenCountersDelta {
  input: number | null;
  cached: number | null;
  output: number | null;
  reasoning: number | null;
  total: number | null;
}

export interface ParsedCodexRollout {
  meta: CodexRolloutMeta;
  /** 是否见到过 session_meta（cc-switch：有计费 token 却没有 meta 的文件不可信）。 */
  rootMetaSeen: boolean;
  /** 全部 token 事件（含零增量），保持文件顺序；重放前缀按它数。 */
  tokenEvents: CodexParsedEvent[];
  /** token_usage_record 兜底补记的事件（挂在补偿它的 token_count 行上）。 */
  usageRecordEvents: CodexParsedEvent[];
  /** total_token_usage 的逐字段最大值（续写页基线解析用）。 */
  highWater?: CodexTokenUsage;
  /** 全文件（含非 token 行）里最晚的信封时间戳；父时间线是否写到 fork 时刻用它判。 */
  maxLineTimestampMs?: number;
  /** bounded-fork 验证候选（有显式父线程 + history_base 时才有意义）。 */
  boundedFork: CodexBoundedForkCandidate;
  hasBillableTokens: boolean;
}

/** 文件名里的 rollout UUID（rollout-…-<uuid>.jsonl，忽略 .zst）。 */
export function codexThreadIdFromFilename(fileName: string): string | undefined {
  const logical = logicalCodexFileName(fileName);
  if (!logical.startsWith("rollout-") || !logical.endsWith(".jsonl")) return undefined;
  const stem = logical.slice(0, -".jsonl".length);
  return normalizeCodexUuid(stem.slice(stem.length - 36));
}

/** 双段文件名（…<uuidA>_<uuidB>.jsonl）里下划线前的线程本体 UUID。 */
export function leadingCodexThreadIdFromFilename(
  fileName: string,
): string | undefined {
  const logical = logicalCodexFileName(fileName);
  if (!logical.startsWith("rollout-") || !logical.endsWith(".jsonl")) return undefined;
  const stem = logical.slice(0, -".jsonl".length);
  const tail = stem.slice(stem.length - 37);
  if (!tail.startsWith("_")) return undefined;
  return normalizeCodexUuid(stem.slice(stem.length - 73, stem.length - 37));
}

/** 去掉 .zst 后的文件名；路径分隔符两种都认（cc-switch logical_file_name）。 */
export function logicalCodexFileName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  return base.endsWith(".jsonl.zst") ? base.slice(0, -".zst".length) : base;
}

/**
 * UUID 归一为小写连字符形式（uuid crate 的 parse+hyphenated 等价：接受
 * 连字符 / 32 位紧凑两种写法）；不是 UUID 返回 undefined。
 */
export function normalizeCodexUuid(value: string): string | undefined {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return value.toLowerCase();
  }
  if (/^[0-9a-f]{32}$/i.test(value)) {
    const hex = value.toLowerCase();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return undefined;
}

/** RFC3339 时间戳 → 毫秒；解析不了返回 undefined。 */
export function parseCodexTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

/**
 * 归一化 Codex 模型名（cc-switch normalize_codex_model）：
 * 转小写 → 剥 provider 前缀（openai/gpt-5 → gpt-5）→ 剥 ISO 日期后缀
 * （-YYYY-MM-DD）→ 剥紧凑日期后缀（-YYYYMMDD）。
 */
export function normalizeCodexModel(raw: string): string {
  let name = raw.toLowerCase();
  const slash = name.lastIndexOf("/");
  if (slash >= 0) name = name.slice(slash + 1);

  if (name.length > 11 && /-\d{4}-\d{2}-\d{2}$/.test(name)) {
    name = name.slice(0, name.length - 11);
  }

  if (name.length > 9) {
    const dash = name.lastIndexOf("-");
    if (dash >= 0 && /^\d{8}$/.test(name.slice(dash + 1))) {
      name = name.slice(0, dash);
    }
  }
  return name;
}

function nonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

/**
 * 解析 TokenUsage 对象：至少含一个已知 token 字段才算（cc-switch
 * parse_cumulative_tokens），缺失字段按 0 补。
 */
export function parseCodexTokenUsage(value: unknown): CodexTokenUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const fields = value as Record<string, unknown>;
  const known = [
    "input_tokens",
    "cached_input_tokens",
    "cache_read_input_tokens",
    "cache_write_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ] as const;
  if (!known.some((field) => field in fields)) return undefined;
  return {
    inputTokens: nonNegativeInteger(fields.input_tokens) ?? 0,
    cachedInputTokens:
      nonNegativeInteger(fields.cached_input_tokens) ??
      nonNegativeInteger(fields.cache_read_input_tokens) ??
      0,
    cacheWriteInputTokens:
      nonNegativeInteger(fields.cache_write_input_tokens) ?? 0,
    outputTokens: nonNegativeInteger(fields.output_tokens) ?? 0,
    reasoningOutputTokens:
      nonNegativeInteger(fields.reasoning_output_tokens) ?? 0,
    totalTokens: nonNegativeInteger(fields.total_tokens) ?? 0,
  };
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null ? (value as Json) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** 计数器字段值（支持别名回退）；字段缺失或非法返回 null。 */
function counterValue(obj: Json, key: string, alias?: string): number | null {
  if (key in obj) return nonNegativeInteger(obj[key]);
  if (alias && alias in obj) return nonNegativeInteger(obj[alias]);
  return null;
}

/** last_token_usage 是否带精确的 input/output（bounded-fork 资格检查用）。 */
function lastCountersExact(info: Json): boolean {
  const last = asObject(info.last_token_usage);
  if (!last) return false;
  return (
    counterValue(last, "input_tokens") !== null &&
    counterValue(last, "output_tokens") !== null
  );
}

/** 提取一组计数器（字段缺失记 null）；不是对象返回 null（签名同款口径）。 */
export function extractCodexCounters(value: unknown): TokenCountersDelta | null {
  const fields = asObject(value);
  if (!fields) return null;
  return {
    input: counterValue(fields, "input_tokens"),
    cached: counterValue(fields, "cached_input_tokens", "cache_read_input_tokens"),
    output: counterValue(fields, "output_tokens"),
    reasoning: counterValue(fields, "reasoning_output_tokens"),
    total: counterValue(fields, "total_tokens"),
  };
}

/** 首事件 total − last 的逐字段基线；任一组字段不齐全返回 undefined。 */
function countersBaseline(
  totalRaw: Json | undefined,
  lastRaw: Json | undefined,
): TokenCountersDelta | undefined {
  if (!totalRaw || !lastRaw) return undefined;
  const sub = (key: string, alias?: string): number | null | undefined => {
    const total = counterValue(totalRaw, key, alias);
    const last = counterValue(lastRaw, key, alias);
    if (total === null || last === null || total < last) return undefined;
    return total - last;
  };
  const input = sub("input_tokens");
  const cached = sub("cached_input_tokens", "cache_read_input_tokens");
  const output = sub("output_tokens");
  const reasoning = sub("reasoning_output_tokens");
  const total = sub("total_tokens");
  if (
    input === undefined || cached === undefined || output === undefined ||
    reasoning === undefined || total === undefined
  ) {
    return undefined;
  }
  return { input, cached, output, reasoning, total };
}

/** 一组计数器的签名；字段缺失记 "null"（与 0 是不同的值，cc-switch Option<u64>）。 */
function countersSignatureKey(value: unknown): CodexSignatureKey | null {
  const fields = asObject(value);
  if (!fields) return null;
  const field = (key: string) =>
    key in fields ? String(nonNegativeInteger(fields[key]) ?? 0) : "null";
  const cached =
    "cached_input_tokens" in fields || "cache_read_input_tokens" in fields
      ? String(
          nonNegativeInteger(fields.cached_input_tokens) ??
            nonNegativeInteger(fields.cache_read_input_tokens) ??
            0,
        )
      : "null";
  return [
    field("input_tokens"),
    cached,
    field("output_tokens"),
    field("reasoning_output_tokens"),
    field("total_tokens"),
  ].join(",");
}

/** token_count 的 info 签名（total 组 + last 组；有任一组即可）。 */
export function codexTokenSignature(info: unknown): CodexSignatureKey | undefined {
  const fields = asObject(info);
  if (!fields) return undefined;
  const total = countersSignatureKey(fields.total_token_usage);
  const last = countersSignatureKey(fields.last_token_usage);
  if (total === null && last === null) return undefined;
  return `${total ?? "null"}|${last ?? "null"}`;
}

/** 兜底补记事件的合成签名（total 组缺失，只有 last）。 */
function syntheticUsageSignature(usage: CodexTokenUsage): CodexSignatureKey {
  return `null|${[
    usage.inputTokens,
    usage.cachedInputTokens,
    "null",
    usage.outputTokens,
    "null",
    usage.inputTokens + usage.outputTokens,
  ].join(",")}`;
}

// ─── 请求耗时估算（cc-switch RequestTimer） ────────────────────────────────

/** 两行时间戳相差不超过该毫秒数视为同批写出（真实请求不可能这么快）。 */
export const CODEX_SAME_FLUSH_SLACK_MS = 100;

/** 估算耗时落在合理范围之外不采纳（cc-switch MIN/MAX_PLAUSIBLE_LATENCY_MS）。 */
export const CODEX_MIN_PLAUSIBLE_LATENCY_MS = 100;
export const CODEX_MAX_PLAUSIBLE_LATENCY_MS = 60 * 60 * 1000;

/** 只看行头这么多字符判断行的种类：时间戳、类型、角色都在行头（cc-switch 同款）。 */
const LINE_HEAD_CHARS = 512;

type TimingKind =
  | "boundary"
  | "toolOutput"
  | "modelOutput"
  | "usageRecord"
  | "turnReset";

function headStringValue(head: string, key: string): string | undefined {
  const needle = `"${key}":"`;
  const start = head.indexOf(needle);
  if (start < 0) return undefined;
  const from = start + needle.length;
  const end = head.indexOf('"', from);
  return end < 0 ? undefined : head.slice(from, end);
}

/**
 * 行头分类（cc-switch classify_timing_line）：
 * - turn_context / 非助手 message（user、developer）→ boundary：下一次请求只会在它之后
 * - `*_output`（工具结果）→ toolOutput：同样是下一次请求的起点
 * - assistant message / reasoning / `*_call` → modelOutput：模型输出项
 * - token_usage_record → usageRecord：响应结束写的用量行
 * - task_started / turn_aborted → turnReset：没等到 token_count 的请求作废
 * 判断不了（头信息不全、类型无关）返回 undefined。
 */
function classifyTimingHead(line: string): { kind: TimingKind; timestampMs: number } | undefined {
  const head = line.slice(0, LINE_HEAD_CHARS);
  const payloadAt = head.indexOf('"payload":{');
  const envelope = payloadAt < 0 ? head : head.slice(0, payloadAt);
  const payloadHead = payloadAt < 0 ? "" : head.slice(payloadAt);
  const timestampMs = parseCodexTimestamp(headStringValue(envelope, "timestamp"));
  if (timestampMs === undefined) return undefined;
  const type = headStringValue(envelope, "type");
  if (type === "turn_context") return { kind: "boundary", timestampMs };
  if (type === "token_usage_record") return { kind: "usageRecord", timestampMs };
  if (type === "response_item") {
    const itemType = headStringValue(payloadHead, "type");
    if (itemType === undefined) return undefined;
    if (itemType === "reasoning") return { kind: "modelOutput", timestampMs };
    if (itemType.endsWith("_call")) return { kind: "modelOutput", timestampMs };
    if (itemType.endsWith("_output")) return { kind: "toolOutput", timestampMs };
    if (itemType === "message") {
      const role = headStringValue(payloadHead, "role");
      if (role === undefined) return undefined;
      return role === "assistant"
        ? { kind: "modelOutput", timestampMs }
        : { kind: "boundary", timestampMs };
    }
    return undefined;
  }
  if (type === "event_msg") {
    const payloadType = headStringValue(payloadHead, "type");
    if (payloadType === "task_started" || payloadType === "turn_aborted") {
      return { kind: "turnReset", timestampMs };
    }
  }
  return undefined;
}

/**
 * item_completed 里模型输出项（Reasoning / AgentMessage）的开始生成时刻
 * （首字）。`started_at_ms` 写在 item 之后、可能超出行头，这类行实测很短，
 * 整行解析；其他类型的项不是模型输出，不看。
 */
function outputItemStartedAtMs(line: string): number | undefined {
  const head = line.slice(0, LINE_HEAD_CHARS);
  const itemAt = head.indexOf('"item":{');
  if (itemAt < 0) return undefined;
  const itemType = headStringValue(head.slice(itemAt), "type");
  if (itemType !== "Reasoning" && itemType !== "AgentMessage") return undefined;
  const payload = asObject((JSON.parse(line) as Json)?.payload);
  const started = payload?.started_at_ms;
  return typeof started === "number" && Number.isFinite(started)
    ? started
    : undefined;
}

/**
 * 按事件顺序估每次请求的耗时（含首字等待）。Codex 日志没有请求级计时，且各
 * 版本事件顺序不一样：
 *
 * - 结束时刻：新版在响应结束时写 token_usage_record（早于 token_count——本机
 *   实测两者相差可达 30 秒），直接用它，但要确认它说的是同一次请求（usage 与
 *   token_count.last 一致）；旧版只有 token_count，有的版本要等工具跑完才写，
 *   表现为「最后一个输出项之后先出现工具结果、token_count 紧跟着写出」，这时
 *   改用最后一个输出项的时刻。开始时刻是这次请求第一个输出项之前最近的一个
 *   起点行（上一次 token_count、工具结果、用户消息、turn_context）。
 * - 2025 年的旧布局把上一次响应的输出项补写在它的 token_count 之后（时间戳
 *   相差 0–1 毫秒），这些不属于下一次请求，直接忽略。
 * - 请求被中断时等不到 token_count，它留下的起点在下一轮 task_started /
 *   turn_aborted 时清掉（不在用户消息上清：Codex 会在响应中途插入 developer
 *   消息，在那里清会把起点挪晚）。
 */
export class CodexRequestTimer {
  private lastBoundaryMs?: number;
  private lastTokenCountMs?: number;
  private requestStartMs?: number;
  private lastModelOutputMs?: number;
  /** 最后一个输出项之后出现的工具结果里最晚的一个；之后再有输出项就清空。 */
  private toolOutputAfterModelOutputMs?: number;
  private usageRecord?: { timestampMs: number; usage: CodexTokenUsage };
  /** 这次请求里最早开始生成的输出项的时刻（item_completed.started_at_ms）。 */
  private firstOutputMs?: number;

  observeLine(line: string): void {
    const classified = classifyTimingHead(line);
    if (classified) {
      switch (classified.kind) {
        case "boundary":
          this.lastBoundaryMs = laterOf(this.lastBoundaryMs, classified.timestampMs);
          return;
        case "toolOutput":
          this.lastBoundaryMs = laterOf(this.lastBoundaryMs, classified.timestampMs);
          if (this.lastModelOutputMs !== undefined) {
            this.toolOutputAfterModelOutputMs = classified.timestampMs;
          }
          return;
        case "modelOutput": {
          const trailsTokenCount =
            this.requestStartMs === undefined &&
            this.lastTokenCountMs !== undefined &&
            classified.timestampMs - this.lastTokenCountMs <= CODEX_SAME_FLUSH_SLACK_MS;
          if (trailsTokenCount) return;
          if (this.requestStartMs === undefined) {
            this.requestStartMs = this.lastBoundaryMs;
          }
          this.lastModelOutputMs = classified.timestampMs;
          this.toolOutputAfterModelOutputMs = undefined;
          return;
        }
        case "usageRecord": {
          // 行头只够判断种类，用量要解析整行；这类行很短。
          try {
            const payload = asObject((JSON.parse(line) as Json)?.payload);
            const usage = parseCodexTokenUsage(payload?.usage);
            this.usageRecord = usage
              ? { timestampMs: classified.timestampMs, usage }
              : undefined;
          } catch {
            this.usageRecord = undefined;
          }
          return;
        }
        case "turnReset":
          this.lastBoundaryMs = laterOf(this.lastBoundaryMs, classified.timestampMs);
          this.requestStartMs = undefined;
          this.lastModelOutputMs = undefined;
          this.toolOutputAfterModelOutputMs = undefined;
          this.usageRecord = undefined;
          this.firstOutputMs = undefined;
          return;
      }
    }

    if (line.includes('"item_completed"') && line.includes('"started_at_ms"')) {
      try {
        const startedAtMs = outputItemStartedAtMs(line);
        if (startedAtMs !== undefined) {
          this.firstOutputMs =
            this.firstOutputMs === undefined
              ? startedAtMs
              : Math.min(this.firstOutputMs, startedAtMs);
        }
      } catch {
        // 整行 JSON 损坏时当作没有首字线索
      }
    }
  }

  /**
   * 遇到一次有用量的 token_count：结算这次请求的耗时与首字，并把此刻记成
   * 下一次请求的起点。`last` 是这次请求自己的精确用量，用来确认
   * token_usage_record 说的是同一次请求。推不出合理窗口返回 undefined。
   */
  finishRequest(
    tokenCountMs: number | undefined,
    last: CodexTokenUsage | undefined,
  ): CodexEstimatedTiming | undefined {
    const startMs = this.requestStartMs ?? this.lastBoundaryMs;
    const firstOutputMs = this.firstOutputMs;
    const record = this.usageRecord;
    this.usageRecord = undefined;
    const recordEndMs =
      record &&
      (last === undefined ||
        (record.usage.inputTokens === last.inputTokens &&
          record.usage.cachedInputTokens === last.cachedInputTokens &&
          record.usage.outputTokens === last.outputTokens))
        ? record.timestampMs
        : undefined;
    const tokenCountWaitedForTools =
      this.toolOutputAfterModelOutputMs !== undefined &&
      (tokenCountMs === undefined ||
        tokenCountMs - this.toolOutputAfterModelOutputMs <= CODEX_SAME_FLUSH_SLACK_MS);
    const endMs =
      recordEndMs ??
      (tokenCountWaitedForTools ? this.lastModelOutputMs : tokenCountMs);

    this.lastBoundaryMs = laterOf(this.lastBoundaryMs, tokenCountMs);
    this.lastTokenCountMs = tokenCountMs;
    this.requestStartMs = undefined;
    this.lastModelOutputMs = undefined;
    this.toolOutputAfterModelOutputMs = undefined;
    this.firstOutputMs = undefined;

    if (startMs === undefined || endMs === undefined) return undefined;
    const latency = endMs - startMs;
    if (
      !Number.isFinite(latency) ||
      latency < CODEX_MIN_PLAUSIBLE_LATENCY_MS ||
      latency > CODEX_MAX_PLAUSIBLE_LATENCY_MS
    ) {
      return undefined;
    }
    return {
      latencyMs: latency,
      firstTokenMs:
        firstOutputMs !== undefined
          ? estimatedFirstTokenMs(startMs, firstOutputMs, latency)
          : undefined,
    };
  }
}

/** finishRequest 的结算产物：耗时（含首字等待）与可推出时的首字时间。 */
export interface CodexEstimatedTiming {
  latencyMs: number;
  firstTokenMs?: number;
}

function laterOf(current: number | undefined, next: number | undefined): number | undefined {
  if (current === undefined) return next;
  if (next === undefined) return current;
  return Math.max(current, next);
}

// ─── rollout 解析状态机 ────────────────────────────────────────────────────

function usageIsZero(usage: CodexTokenUsage): boolean {
  return (
    usage.inputTokens === 0 &&
    usage.cachedInputTokens === 0 &&
    usage.cacheWriteInputTokens === 0 &&
    usage.outputTokens === 0
  );
}

function usageMatches(last: CodexTokenUsage, usage: CodexTokenUsage): boolean {
  return (
    last.inputTokens === usage.inputTokens &&
    last.cachedInputTokens === usage.cachedInputTokens &&
    last.cacheWriteInputTokens === usage.cacheWriteInputTokens &&
    last.outputTokens === usage.outputTokens
  );
}

/** 缓存读与写夹进 input 的不相交份额（cc-switch 同款钳制）。 */
function clampDelta(delta: CodexTokenDelta): CodexTokenDelta {
  const cachedInputTokens = Math.min(delta.cachedInputTokens, delta.inputTokens);
  return {
    inputTokens: delta.inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens: Math.min(
      delta.cacheWriteInputTokens,
      delta.inputTokens - cachedInputTokens,
    ),
    outputTokens: delta.outputTokens,
  };
}

function deltaFromUsage(usage: CodexTokenUsage): CodexTokenDelta {
  return clampDelta({
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheWriteInputTokens: usage.cacheWriteInputTokens,
    outputTokens: usage.outputTokens,
  });
}

function updateHighWater(
  highWater: CodexTokenUsage | undefined,
  current: CodexTokenUsage,
): CodexTokenUsage {
  return {
    inputTokens: Math.max(highWater?.inputTokens ?? 0, current.inputTokens),
    cachedInputTokens: Math.max(
      highWater?.cachedInputTokens ?? 0,
      current.cachedInputTokens,
    ),
    cacheWriteInputTokens: Math.max(
      highWater?.cacheWriteInputTokens ?? 0,
      current.cacheWriteInputTokens,
    ),
    outputTokens: Math.max(highWater?.outputTokens ?? 0, current.outputTokens),
    reasoningOutputTokens: Math.max(
      highWater?.reasoningOutputTokens ?? 0,
      current.reasoningOutputTokens,
    ),
    totalTokens: Math.max(highWater?.totalTokens ?? 0, current.totalTokens),
  };
}

interface PendingUsageRecord {
  key: string;
  usage: CodexTokenUsage;
  timestampMs?: number;
  model: string;
  cwd?: string;
}

export interface CodexParseOptions {
  /**
   * 文件名尾部的 rollout UUID（线程 ID 一致性校验）；解析器不做文件名推断，
   * 由读取器传入。
   */
  filenameThreadId?: string;
  /** 双段文件名下划线前的线程本体 UUID。 */
  filenameLeadingThreadId?: string;
  /**
   * 解析续写页的前序分段累计高水位（首条缺 last 的 token_count 用它补基线，
   * 否则继承来的累计值会被当成一次请求）。返回 "missing-parent" 表示前序
   * 分段缺失，本文件按不可安全计费处理。
   */
  resolveContinuationBaseline?: (
    meta: CodexRolloutMeta,
  ) => CodexTokenUsage | undefined | "missing-parent";
}

/** 元数据不一致、继续计费可能双算时抛出；读取器把整个文件按 skipped 处理。 */
export class CodexRolloutIntegrityError extends Error {}

/**
 * 解析单个 rollout 文件（解压后的 JSONL 文本）。算法逐条对齐 cc-switch 的
 * parse_codex_file_with_index：优先精确的 last_token_usage，缺失时按累计差推
 * 并处理续写页基线；重复快照（限额刷新重发）零增量跳过；token_usage_record
 * 在随后的 token_count.last 全 0 时补记一行。
 */
export function parseCodexRollout(
  content: string,
  options: CodexParseOptions = {},
): ParsedCodexRollout {
  const meta: CodexRolloutMeta = { isContinuation: false };
  meta.leadingThreadId = options.filenameLeadingThreadId;
  let rootMetaSeen = false;
  let currentModel = "unknown";
  // total_token_usage 是会话累计（跨模型、跨限额桶）；last 缺失时按累计差推。
  let totalHighWater: CodexTokenUsage | undefined;
  const lastSignatureBySource = new Map<string | null, CodexSignatureKey>();
  let previousSignature: CodexSignatureKey | undefined;
  let eventIndex = 0;
  const tokenEvents: CodexParsedEvent[] = [];
  const usageRecordEvents: CodexParsedEvent[] = [];
  let pendingUsage: PendingUsageRecord | undefined;
  let hasBillableTokens = false;
  let currentCwd: string | undefined;
  let highWater: CodexTokenUsage | undefined;
  let maxLineTimestampMs: number | undefined;
  // bounded-fork 候选状态：首事件 total/last 的原值（区分「字段缺失」与 0）
  let firstTotalRaw: Json | undefined;
  let firstLastRaw: Json | undefined;
  let firstEventSeen = false;
  let boundedForkEventsQualify = true;
  const timer = new CodexRequestTimer();

  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;

    timer.observeLine(line);
    // 父时间线是否已写到 child fork 时刻要用全文件最晚时间戳判，这里对所有
    // JSON 行都取（不限于 token 行，cc-switch load_parent_timeline 同款）。
    {
      const headTimestamp = parseCodexTimestamp(
        headStringValue(line.slice(0, LINE_HEAD_CHARS), "timestamp"),
      );
      if (headTimestamp !== undefined) {
        maxLineTimestampMs = laterOf(maxLineTimestampMs, headTimestamp);
      }
    }

    const isEventMsg = line.includes('"event_msg"');
    const isTurnContext = line.includes('"turn_context"');
    const isSessionMeta = line.includes('"session_meta"');
    const isUsageRecord = line.includes('"token_usage_record"');
    if (!isEventMsg && !isTurnContext && !isSessionMeta && !isUsageRecord) {
      continue;
    }
    if (
      isEventMsg &&
      !line.includes('"token_count"') &&
      !line.includes('"thread_settings_applied"')
    ) {
      continue;
    }

    let value: Json;
    try {
      value = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    const envelopeType = typeof value.type === "string" ? value.type : undefined;
    const ordinal =
      typeof value.ordinal === "number" && Number.isInteger(value.ordinal)
        ? value.ordinal
        : index;
    const payload = asObject(value.payload);

    if (envelopeType === "session_meta") {
      if (rootMetaSeen) continue;
      rootMetaSeen = true;
      const payloadCwd = nonEmptyString(payload?.cwd);
      if (payloadCwd) currentCwd = payloadCwd;
      const forkedFrom = normalizeParentId(nonEmptyString(payload?.forked_from_id));
      const spawnedFromRaw = nonEmptyString(
        asObject(asObject(asObject(payload?.source)?.subagent)?.thread_spawn)
          ?.parent_thread_id,
      );
      const spawnedFrom = normalizeParentId(spawnedFromRaw);
      let parent: string | undefined;
      if (forkedFrom !== undefined && spawnedFrom !== undefined) {
        if (forkedFrom !== spawnedFrom) {
          throw new CodexRolloutIntegrityError(
            `forked_from_id (${forkedFrom}) 与 thread_spawn.parent_thread_id (${spawnedFrom}) 不一致`,
          );
        }
        parent = forkedFrom;
      } else {
        parent = forkedFrom ?? spawnedFrom;
      }

      const rawThreadId =
        nonEmptyString(payload?.id) ??
        nonEmptyString(payload?.thread_id) ??
        nonEmptyString(payload?.threadId);
      if (rawThreadId) {
        meta.threadId = normalizeCodexUuid(rawThreadId) ?? rawThreadId.toLowerCase();
      }
      meta.rootTimestampMs = parseCodexTimestamp(value.timestamp);
      meta.cwd = currentCwd;

      // 文件名线程 ID 与 root meta ID 的一致性校验（双段文件名两个 UUID 都认）。
      const filenameId = options.filenameThreadId;
      const leadingId = options.filenameLeadingThreadId;
      if (filenameId !== undefined && meta.threadId !== undefined) {
        if (filenameId !== meta.threadId && leadingId !== meta.threadId) {
          throw new CodexRolloutIntegrityError(
            `文件名线程 ID (${filenameId}) 与 root meta ID (${meta.threadId}) 不一致`,
          );
        }
      }

      const historyBaseRaw = asObject(payload?.history_base);
      const historyBaseThreadIdRaw = nonEmptyString(historyBaseRaw?.thread_id);
      meta.historyBaseThreadId = historyBaseThreadIdRaw
        ? normalizeCodexUuid(historyBaseThreadIdRaw) ?? historyBaseThreadIdRaw.toLowerCase()
        : undefined;
      meta.historyBase = {
        threadId: meta.historyBaseThreadId,
        endByteOffset:
          typeof historyBaseRaw?.end_byte_offset === "number" &&
          Number.isFinite(historyBaseRaw.end_byte_offset)
            ? historyBaseRaw.end_byte_offset
            : undefined,
        endOrdinalExclusive:
          typeof historyBaseRaw?.end_ordinal_exclusive === "number" &&
          Number.isFinite(historyBaseRaw.end_ordinal_exclusive)
            ? historyBaseRaw.end_ordinal_exclusive
            : undefined,
      };
      const isPaginated = payload?.history_mode === "paginated";
      const hasHistoryBase = meta.historyBaseThreadId !== undefined;
      const hasParent = parent !== undefined;
      meta.isContinuation =
        leadingId !== undefined && meta.threadId !== undefined && leadingId === meta.threadId
          ? isPaginated || hasHistoryBase || hasParent
          : hasHistoryBase && meta.historyBaseThreadId === meta.threadId;

      if (parent !== undefined) {
        if (parent === filenameId) {
          throw new CodexRolloutIntegrityError(
            "parent_thread_id 与文件名线程 ID 相同",
          );
        }
        if (!meta.isContinuation) {
          meta.parentThreadId = parent;
        }
      }
      continue;
    }

    if (envelopeType === "turn_context") {
      const payloadCwd = nonEmptyString(payload?.cwd);
      if (payloadCwd) currentCwd = payloadCwd;
      const model =
        nonEmptyString(payload?.model) ??
        nonEmptyString(asObject(payload?.info)?.model);
      if (model) currentModel = normalizeCodexModel(model);
      continue;
    }

    if (envelopeType === "token_usage_record") {
      pendingUsage = undefined;
      const usage = parseCodexTokenUsage(payload?.usage);
      if (!usage || usageIsZero(usage)) continue;
      const responseId = nonEmptyString(payload?.response_id) ?? `line${ordinal}`;
      pendingUsage = {
        key: responseId,
        usage,
        timestampMs: parseCodexTimestamp(value.timestamp),
        model: currentModel,
        cwd: currentCwd,
      };
      continue;
    }

    if (envelopeType === "event_msg" && payload) {
      if (payload.type === "thread_settings_applied") {
        const model = nonEmptyString(asObject(payload.thread_settings)?.model);
        if (model && model.trim() !== "") {
          currentModel = normalizeCodexModel(model);
        }
        continue;
      }
      if (payload.type !== "token_count") continue;
      const info = asObject(payload.info);
      if (!info) continue;
      const signature = codexTokenSignature(info);
      if (!signature) continue;

      const model =
        nonEmptyString(info.model) ??
        nonEmptyString(info.model_name) ??
        nonEmptyString(payload.model);
      if (model) currentModel = normalizeCodexModel(model);

      const rateLimits = asObject(payload.rate_limits);
      const snapshotSource = nonEmptyString(rateLimits?.limit_id) ?? null;
      const total = parseCodexTokenUsage(info.total_token_usage);
      const last = parseCodexTokenUsage(info.last_token_usage);

      if (pendingUsage) {
        // 对得上的 last 已经由这条 token_count 入账；last 全 0 是远程压缩把
        // 本次用量只写在 token_usage_record 之后的空快照，需要补记一行。
        const covered = last !== undefined && usageMatches(last, pendingUsage.usage);
        if (!covered && last !== undefined && usageIsZero(last)) {
          const delta = deltaFromUsage(pendingUsage.usage);
          if (
            !(
              delta.inputTokens === 0 &&
              delta.cachedInputTokens === 0 &&
              delta.outputTokens === 0
            )
          ) {
            hasBillableTokens = true;
            if (
              meta.rootTimestampMs === undefined ||
              pendingUsage.timestampMs === undefined ||
              pendingUsage.timestampMs <= meta.rootTimestampMs
            ) {
              boundedForkEventsQualify = false;
            }
            usageRecordEvents.push({
              ordinal,
              signatureKey: syntheticUsageSignature(pendingUsage.usage),
              delta,
              requestKey: `usage:${pendingUsage.key}`,
              timestampMs: pendingUsage.timestampMs,
              model: pendingUsage.model,
              cwd: pendingUsage.cwd,
            });
          }
        }
        pendingUsage = undefined;
      }

      if (!total && !last) continue;
      const duplicate =
        total !== undefined &&
        (lastSignatureBySource.get(snapshotSource) === signature ||
          previousSignature === signature);
      if (total !== undefined) {
        lastSignatureBySource.set(snapshotSource, signature);
      }
      previousSignature = signature;

      let delta: CodexTokenDelta | null;
      if (duplicate) {
        delta = null;
      } else if (last) {
        // 优先精确的 last_token_usage：累计快照可能来自多条独立推进的限额道。
        delta = clampDelta({
          inputTokens: last.inputTokens,
          cachedInputTokens: last.cachedInputTokens,
          cacheWriteInputTokens: last.cacheWriteInputTokens,
          outputTokens: last.outputTokens,
        });
      } else if (total) {
        // 续写页首次出现只有累计的快照时，先恢复前序分段的高水位基线，否则
        // 继承来的累计值会被当成一次请求。
        if (meta.isContinuation && !totalHighWater) {
          const baseline = options.resolveContinuationBaseline?.(meta);
          if (baseline === "missing-parent") {
            throw new CodexRolloutIntegrityError(
              "续写页缺少有效的前序累计用量基线",
            );
          }
          // 前序分段计数器重置（比基线小）时以当前快照为首轮基线。
          totalHighWater =
            baseline !== undefined && total.inputTokens >= baseline.inputTokens
              ? baseline
              : undefined;
        }
        delta = clampDelta({
          inputTokens: Math.max(
            0,
            total.inputTokens - (totalHighWater?.inputTokens ?? 0),
          ),
          cachedInputTokens: Math.max(
            0,
            total.cachedInputTokens - (totalHighWater?.cachedInputTokens ?? 0),
          ),
          cacheWriteInputTokens: Math.max(
            0,
            total.cacheWriteInputTokens - (totalHighWater?.cacheWriteInputTokens ?? 0),
          ),
          outputTokens: Math.max(
            0,
            total.outputTokens - (totalHighWater?.outputTokens ?? 0),
          ),
        });
      } else {
        continue;
      }
      if (total) {
        totalHighWater = updateHighWater(totalHighWater, total);
        highWater = updateHighWater(highWater, total);
      }

      const timestampMs = parseCodexTimestamp(value.timestamp);
      if (!firstEventSeen) {
        firstEventSeen = true;
        firstTotalRaw = asObject(info.total_token_usage);
        firstLastRaw = asObject(info.last_token_usage);
      }
      if (
        !lastCountersExact(info) ||
        timestampMs === undefined ||
        meta.rootTimestampMs === undefined ||
        timestampMs <= meta.rootTimestampMs
      ) {
        boundedForkEventsQualify = false;
      }
      const billable =
        delta !== null &&
        (delta.inputTokens > 0 ||
          delta.cachedInputTokens > 0 ||
          delta.outputTokens > 0);
      let estimatedDurationMs: number | undefined;
      let firstTokenMs: number | undefined;
      let requestKey: string | undefined;
      if (billable && delta) {
        hasBillableTokens = true;
        eventIndex += 1;
        requestKey = String(eventIndex);
        // 重复快照不是一次请求，不参与计时。
        const timing = timer.finishRequest(timestampMs, last);
        estimatedDurationMs = timing?.latencyMs;
        firstTokenMs = timing?.firstTokenMs;
      }

      tokenEvents.push({
        ordinal,
        signatureKey: signature,
        delta,
        requestKey,
        timestampMs,
        model: currentModel,
        cwd: currentCwd,
        estimatedDurationMs,
        firstTokenMs,
      });
    }
  }

  return {
    meta,
    rootMetaSeen,
    tokenEvents,
    usageRecordEvents,
    highWater,
    maxLineTimestampMs,
    boundedFork: {
      baseline: countersBaseline(firstTotalRaw, firstLastRaw),
      eventsQualify: boundedForkEventsQualify,
    },
    hasBillableTokens,
  };
}

/** 显式父线程 ID 的归一（非 UUID 视为脏数据，调用方按不可计费处理）。 */
function normalizeParentId(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const normalized = normalizeCodexUuid(raw);
  if (!normalized) {
    throw new CodexRolloutIntegrityError(
      `显式 parent_thread_id 不是有效 UUID: ${raw}`,
    );
  }
  return normalized;
}

// ─── 父重放前缀（cc-switch matching_replay_prefix） ─────────────────────────

/**
 * 子文件事件签名序列对父时间线签名序列（fork 时刻之前）的最长顺序匹配前缀
 * 数：旧版 Codex 会把父历史复制进子文件，这些事件的签名与父时间线按序一致，
 * 跳过它们避免双算。第一个对不上的事件之后的不再跳（是子会话自己的请求）。
 */
export function matchingCodexReplayPrefix(
  childEvents: ReadonlyArray<Pick<CodexParsedEvent, "signatureKey">>,
  parentSignatures: readonly CodexSignatureKey[],
): number {
  let parentOffset = 0;
  let matched = 0;
  for (const event of childEvents) {
    const relative = parentSignatures.indexOf(event.signatureKey, parentOffset);
    if (relative < 0) break;
    parentOffset = relative + 1;
    matched += 1;
  }
  return matched;
}

/** 父 rollout 的 token 时间线（cc-switch ParentTokenTimeline）。 */
export interface CodexParentTimeline {
  /** 带时间戳的 token 事件签名，保持文件顺序。 */
  events: CodexTimelineEvent[];
  /** 是否存在无有效时间戳的 token 事件：无法安全区分重放。 */
  hasTokenWithoutTimestamp: boolean;
  /** 全文件最晚信封时间戳；父是否已写到 fork 时刻用它判。 */
  maxLineTimestampMs?: number;
}

export function codexTimelineFromParsed(parsed: ParsedCodexRollout): CodexParentTimeline {
  const events: CodexTimelineEvent[] = [];
  let hasTokenWithoutTimestamp = false;
  for (const event of parsed.tokenEvents) {
    if (event.timestampMs === undefined) {
      hasTokenWithoutTimestamp = true;
      continue;
    }
    events.push({ timestampMs: event.timestampMs, signatureKey: event.signatureKey });
  }
  return {
    events,
    hasTokenWithoutTimestamp,
    maxLineTimestampMs: parsed.maxLineTimestampMs,
  };
}

/**
 * 父时间线里 cutoff 之前的签名序列。父时间线存在无时间戳的 token 事件、或尚
 * 未写到 cutoff（fork 时刻）时返回 null：无法安全区分重放，调用方应弃用子文件
 *（cc-switch 的 deferred 同款取舍，宁可少算不双算）。
 */
export function codexParentSignaturesBefore(
  timeline: CodexParentTimeline,
  cutoffMs: number,
): CodexSignatureKey[] | null {
  if (timeline.hasTokenWithoutTimestamp) return null;
  if (timeline.maxLineTimestampMs === undefined || timeline.maxLineTimestampMs < cutoffMs) {
    return null;
  }
  return timeline.events
    .filter((event) => event.timestampMs <= cutoffMs)
    .map((event) => event.signatureKey);
}

// ─── UsageRecord 组装 ──────────────────────────────────────────────────────

/** cwd → 项目标签：路径叶子名；只剩盘符或推不出时 undefined。 */
export function codexProjectLabel(cwd: string | undefined): string | undefined {
  if (typeof cwd !== "string" || cwd.trim() === "") return undefined;
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  const leaf = parts.length > 0 ? parts[parts.length - 1] : undefined;
  return leaf && !/^[A-Za-z]:$/.test(leaf) ? leaf : undefined;
}

export interface CodexRecordContext {
  /** 去重键里的物理 rollout UUID（文件名尾部）。 */
  rolloutId: string;
  /** 会话 ID：root meta 的线程 ID（双段文件名下是前置 UUID）。 */
  sessionId: string;
}

/**
 * 解析产物 → UsageRecord。fresh 口径：inputTokens = input − cached − cache_write
 * （缓存读/写单列）；totalTokens 用上游口径（= input + output）。没有有效时间戳
 * 的事件没法进趋势图，直接丢弃。
 */
export function codexEventsToRecords(
  events: ReadonlyArray<CodexParsedEvent>,
  context: CodexRecordContext,
): UsageRecord[] {
  const records: UsageRecord[] = [];
  for (const event of events) {
    const delta = event.delta;
    if (!delta || !event.requestKey) continue;
    if (event.timestampMs === undefined) continue;
    const freshInput = Math.max(
      0,
      delta.inputTokens - delta.cachedInputTokens - delta.cacheWriteInputTokens,
    );
    const totalTokens = delta.inputTokens + delta.outputTokens;
    const id = `codex:${context.rolloutId}:${event.ordinal}:${event.requestKey}`;
    records.push({
      id,
      requestId: id,
      sessionId: context.sessionId,
      harness: "codex",
      project: codexProjectLabel(event.cwd) ?? "未知项目",
      model: event.model && event.model !== "unknown" ? event.model : "未知模型",
      provider: deriveProvider(event.model || "", "OpenAI"),
      timestamp: event.timestampMs,
      inputTokens: freshInput,
      outputTokens: delta.outputTokens,
      cacheReadTokens: delta.cachedInputTokens,
      cacheCreationTokens: delta.cacheWriteInputTokens,
      totalTokens,
      inputTokenSemantics: "fresh",
      hasTokenUsage: totalTokens > 0,
      credits: 0,
      hasCredit: false,
      estimatedDurationMs: event.estimatedDurationMs,
      ...(event.firstTokenMs === undefined ? {} : { firstTokenMs: event.firstTokenMs }),
      status: "success",
    });
  }
  return records;
}
