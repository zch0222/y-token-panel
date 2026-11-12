import type { UsageRecord } from "@/lib/usage";

/**
 * ZCode 用量记录（~/.zcode/cli/db/db.sqlite 的 model_usage 表，join session 表取
 * workspace 目录）的字段语义，全部依据本机 ZCode CLI bundle
 * （resources/glm/zcode.cjs）反查确认，不靠字段名望文生义：
 *
 * - 表结构由 zcode 的 SQLite migration 建立；写入方是 recordModelUsage
 *   （bundle 内 nBr，insert ... on conflict(id) do update），每次模型网络请求
 *   尝试（含重试，attempt_index 递增）结束时由 usage 事实记录器（bundle 内
 *   E1）调用一次，因此一行 = 一次真实的上游模型请求尝试。
 * - `id`：`usage_model_<querySource>_<assistantMessageId|spanId|qs:startedAt>_<attemptIndex>`
 *   （bundle 内 d$a），主键唯一，upsert 幂等，无需额外去重。
 * - `input_tokens`：取自 AI SDK 扁平化 usage 的 inputTokens。扁平化函数（bundle
 *   内 Fvn）写的是 `inputTokens: e.inputTokens.total`，而各 provider 适配器的
 *   结构化 usage 里 inputTokens.total 一律是「含缓存读取 + 缓存写入的总输入」
 *   （anthropic 适配器 Pto：total = input_tokens + cache_creation + cache_read，
 *   noCache 才是不含缓存的 input_tokens）。所以该列含缓存，对应面板的
 *   inputTokenSemantics: "total"。
 * - `cache_read_input_tokens` / `cache_creation_input_tokens`：input 侧的缓存
 *   读取 / 写入分量（Fvn 的 inputTokenDetails.cacheReadTokens / cacheWriteTokens）。
 * - `provider_total_tokens`：usage.totalTokens = 输入总量 + 输出（Fvn：
 *   Q4(inputTokens.total, outputTokens.total)），可为 NULL。
 * - `computed_total_tokens`：写入时 MCs(input, cacheCreation, cacheRead) + output，
 *   即「input>0 ? input : 缓存分量之和」+ 输出，NOT NULL。
 * - `status`：check 约束 running/completed/error/cancelled；E1 在请求结束时写入
 *   最终状态。usage 取 t.result.usage，失败时回退最后一次 model_request_failed
 *   事件携带的 usage，所以 error 行也可能有 token 数（本机实测为 0）。
 * - `started_at` / `completed_at` / `duration_ms`：epoch 毫秒；duration_ms =
 *   completedAt − startedAt（请求起点到完成的墙钟，含首字等待），是精确值而非
 *   估算，可直接当速度统计的耗时。
 * - `first_token_at` / `time_to_first_token_ms`：JJo 取首个非空 text_delta /
 *   reasoning_delta 流事件（Ge.ModelStreaming）的时刻记 firstTokenAt，TTFT =
 *   firstTokenAt − startedAt（HC 写入）；非流式或无 delta 的请求为 NULL
 *   （本机 3558 行中 2296 行有值）。优先取 time_to_first_token_ms，缺失时用
 *   first_token_at − started_at 推；须落在 (0, duration_ms] 内。
 * - 保留策略：pruneUsage（bundle 内 JNe）在每次写入后删除 started_at 早于
 *   30 天的行，所以库里最多只有最近 30 天。
 * - 未采用 ~/.zcode/cli/rollout/model-io-*.jsonl 做数据源：writeModelIODebugRecord
 *   （bundle 内 Wuo）在未开启 modelIoFullRetentionEnabled 时按 mtime 只保留最新
 *   2 个会话文件（rotateModelIOFiles），历史覆盖远不如 SQLite。
 */

/** model_usage 表查询结果行（session 表只取 directory 做 项目名）。 */
export interface ZcodeModelUsageRow {
  id: string | null;
  logical_request_id?: string | null;
  attempt_index?: number | null;
  session_id: string | null;
  query_source?: string | null;
  provider_id: string | null;
  model_id: string | null;
  status: string | null;
  started_at: number | null;
  duration_ms?: number | null;
  first_token_at?: number | null;
  time_to_first_token_ms?: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens?: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  provider_total_tokens?: number | null;
  computed_total_tokens: number | null;
  /** join session 表得到的 workspace 目录（如 D:\code\y-token-panel），可为 NULL。 */
  session_directory?: string | null;
}

/**
 * zcode 的 integer()（bundle 内 Oh）：非有限数按 0，负数截断为 0，小数截断取整。
 * DB 列本身是 integer，这里防御外部传入的脏值。
 */
export function clampInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/**
 * 移植 zcode 读侧的 inputSideTokensFromStoredUsage（bundle 内 NCs）：判断
 * input_tokens 是否已含缓存分量，返回「含缓存的输入总量」。
 *
 * - input ≤ 0：输入侧只有缓存分量之和；
 * - 缓存分量之和 ≤ 0：输入侧就是 input；
 * - 两者都 > 0：用 provider_total_tokens（缺失用 computed_total_tokens）对齐
 *   「input+output」与「input+缓存+output」哪个更接近，更接近者胜；无法判断
 *   时按已含缓存（返回 input）——与 Fvn 写入语义一致。
 */
export function zcodeInputSideTokens(row: ZcodeModelUsageRow): number {
  const input = clampInteger(row.input_tokens);
  const cache =
    clampInteger(row.cache_creation_input_tokens) +
    clampInteger(row.cache_read_input_tokens);
  if (input <= 0) return cache;
  if (cache <= 0) return input;
  const output = clampInteger(row.output_tokens);
  const total = clampInteger(
    row.provider_total_tokens ?? row.computed_total_tokens,
  );
  if (total > 0) {
    const totalWithoutCache = Math.abs(total - (input + output));
    const totalWithCache = Math.abs(total - (input + cache + output));
    if (totalWithCache < totalWithoutCache) return input + cache;
  }
  return input;
}

/**
 * 项目名取 session.directory 的最后一段（与 CodeBuddy / Qoder 的项目标签同为
 * 目录叶子名口径）；目录缺失或空时返回“未知项目”。
 */
export function zcodeProjectLabel(directory: string | null | undefined): string {
  if (typeof directory !== "string" || directory.trim() === "") {
    return "未知项目";
  }
  const segments = directory.replace(/[\\/]+$/, "").split(/[\\/]/);
  const base = segments[segments.length - 1]?.trim();
  return base ? base : "未知项目";
}

/**
 * model_usage 一行 → UsageRecord。started_at 非法（缺失 / 非正）时返回 null，
 * 与其他 Harness “没有可用时间戳即丢弃”的口径一致。
 *
 * - credits：zcode 的 model_usage 没有 Credits 字段，恒为 hasCredit: false；
 * - 状态：completed 记 success，其余（error / cancelled / 未落终态的 running）
 *   都按未成功记 error；
 * - 耗时：duration_ms 是精确的请求墙钟（含首字等待），直接作为速度统计输入。
 */
export function parseZcodeUsageRow(
  row: ZcodeModelUsageRow,
): UsageRecord | null {
  if (typeof row?.id !== "string" || row.id === "") return null;
  const timestamp = Number(row.started_at);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;

  const inputTokens = zcodeInputSideTokens(row);
  const outputTokens = clampInteger(row.output_tokens);
  const cacheReadTokens = clampInteger(row.cache_read_input_tokens);
  const cacheCreationTokens = clampInteger(row.cache_creation_input_tokens);
  // zcode 读侧口径：provider_total_tokens ?? computed_total_tokens；都缺/为 0
  // 时退回 输入+输出，保证有 token 的行不会算出 0 总量。
  const storedTotal = clampInteger(
    row.provider_total_tokens ?? row.computed_total_tokens,
  );
  const totalTokens =
    storedTotal > 0 ? storedTotal : inputTokens + outputTokens;
  const durationMs = Number(row.duration_ms);
  const estimatedDurationMs =
    Number.isFinite(durationMs) && durationMs > 0
      ? Math.trunc(durationMs)
      : undefined;
  // TTFT 优先取原生 time_to_first_token_ms；缺失时按 first_token_at − started_at
  // 推（写入方就是这一减法）；两者都要求落在 (0, duration] 内才算可信。
  const storedTtft = Number(row.time_to_first_token_ms);
  const firstTokenAt = Number(row.first_token_at);
  let firstTokenMs: number | undefined;
  if (Number.isFinite(storedTtft) && storedTtft > 0) {
    firstTokenMs = storedTtft;
  } else if (Number.isFinite(firstTokenAt) && firstTokenAt > 0) {
    firstTokenMs = firstTokenAt - timestamp;
  }
  if (
    firstTokenMs === undefined ||
    !Number.isFinite(firstTokenMs) ||
    firstTokenMs <= 0 ||
    (estimatedDurationMs !== undefined && firstTokenMs > estimatedDurationMs)
  ) {
    firstTokenMs = undefined;
  }

  return {
    id: `zcode:${row.id}`,
    requestId: row.id,
    sessionId: row.session_id ?? "",
    harness: "zcode",
    project: zcodeProjectLabel(row.session_directory),
    model: row.model_id || "未知模型",
    provider: row.provider_id || "ZCode",
    timestamp,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    inputTokenSemantics: "total",
    hasTokenUsage: totalTokens > 0,
    credits: 0,
    hasCredit: false,
    estimatedDurationMs,
    ...(firstTokenMs === undefined ? {} : { firstTokenMs: Math.round(firstTokenMs) }),
    status: row.status === "completed" ? "success" : "error",
  };
}

/** 从 model_usage 读取的 SQL（left join session 取 workspace 目录，见文件头）。 */
export const ZCODE_USAGE_SQL = `
  select
    m.id,
    m.logical_request_id,
    m.attempt_index,
    m.session_id,
    m.query_source,
    m.provider_id,
    m.model_id,
    m.status,
    m.started_at,
    m.duration_ms,
    m.first_token_at,
    m.time_to_first_token_ms,
    m.input_tokens,
    m.output_tokens,
    m.reasoning_tokens,
    m.cache_creation_input_tokens,
    m.cache_read_input_tokens,
    m.provider_total_tokens,
    m.computed_total_tokens,
    s.directory as session_directory
  from model_usage m
  left join session s on s.id = m.session_id
  order by m.started_at desc
`;

export interface ZcodeUsageCollection {
  records: UsageRecord[];
  /** 有用量记录的会话数（作为面板“已扫描会话文件”数）。 */
  sessionCount: number;
}

/**
 * 把 SQL 查询结果行收集成 UsageRecord 列表（时间倒序）。model_usage 的 id 是
 * 主键且写入走 upsert，一行一请求尝试，天然无重复；时间戳非法的行丢弃。
 */
export function collectZcodeUsage(rows: unknown[]): ZcodeUsageCollection {
  const records: UsageRecord[] = [];
  const sessions = new Set<string>();
  for (const row of rows) {
    const typed = row as ZcodeModelUsageRow;
    if (typeof typed?.session_id === "string" && typed.session_id) {
      sessions.add(typed.session_id);
    }
    const record = parseZcodeUsageRow(typed);
    if (!record) continue;
    records.push(record);
  }
  records.sort((a, b) => b.timestamp - a.timestamp);
  return { records, sessionCount: sessions.size };
}
