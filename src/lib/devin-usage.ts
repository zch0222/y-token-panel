import { deriveProvider, type UsageRecord } from "@/lib/usage";

/**
 * Devin（Devin Desktop / Devin CLI，Windsurf 分支 + Rust CLI "chisel"）用量记录
 * （sessions.db 的 message_nodes 表 join sessions 表）的字段语义，全部依据本机
 * Devin 1.141.2 的代码与真实数据反查确认（devin.exe 二进制内嵌 SQL/serde 字段
 * 表、cli/share/devin/docs 官方文档、sessions.db 的 sqlite_master DDL 与 309 条
 * assistant 行实测），不靠字段名望文生义：
 *
 * - 表结构由 devin.exe（chisel-agent/src/session_db，refinery 迁移 V1–V20）建立：
 *   message_nodes(row_id 自增主键, session_id, node_id, parent_node_id,
 *   chat_message TEXT 存 ACP ChatMessage JSON, created_at, metadata 列)；
 *   sessions(id 为两词 slug, working_directory NOT NULL, model, hidden,
 *   cogs_json …)。V5 起每条消息一行（消息森林），per-message 用量在
 *   chat_message 的 metadata.metrics 里。
 * - 一行 = 一次模型生成的条件：chat_message.role="assistant" 且
 *   metadata.metrics 非空。实测 309 条 assistant 行全部带 request_id + metrics +
 *   finish_reason，user/system/tool 行（telemetry.source 分别为 user/sysprompt/
 *   tool_result 等）的 metrics 恒为 null，即只有 source="assistant"
 *   （operation="inference"）的行携带用量。
 * - metrics（serde struct PerformanceMetrics 12 字段，二进制字段表与数据一致）：
 *   input_tokens 是不含缓存的新鲜输入——实测 6+ 行满足
 *   context_input_tokens = input_tokens + cache_read_tokens +
 *   cache_creation_tokens（如 24603+19255+9078=52936；Gemini 无缓存行
 *   31915=31915），对应面板 inputTokenSemantics:"fresh"。Devin 界面的
 *   "Input tokens" 维度展示 input+cache_creation（服务端 response_dimensions），
 *   是展示口径而非字段本义。
 * - cache_creation_1h_tokens：本机 309 行从未出现（serde 对 None 跳过序列化），
 *   与 cache_creation_tokens 的包含关系无代码证据，不累加以免重复计数。
 * - num_tokens：assistant 行 100%（309/309）等于 output_tokens，是生成消息的
 *   token 数而非输入+输出总量，不采用。
 * - ttft_ms / total_time_ms：CLI 原生精确计时（实测 ttft 10416 + 11156 tok ×
 *   tpot 10.049ms ≈ total_time 122532，闭环成立）；total_time 含首字等待，
 *   对应面板 firstTokenMs（精确口径）与 estimatedDurationMs。
 * - created_at 列：Unix 秒（CLI 启动日志 newest_last_activity_at=1794605525），
 *   ×1000 转毫秒；chat_message 内的 started_generation_at / created_at 是同源
 *   的 RFC3339 字符串，列更直接。
 * - metadata.request_id：每次生成的 UUID，实测 assistant 行必带；缺失时回退
 *   row_id（自增整数，行级稳定）。
 * - metadata.generation_model：本次生成的模型 id（如 claude-opus-5-5-xhigh），
 *   回退 sessions.model（会话默认模型）；id→显示名映射来自服务端 model_configs
 *   缓存（存在不规则 id 如 claude-opus-4.7），本地无稳定规则，面板直接用原始 id。
 * - finish_reason：实测取值 stop / tool_calls，windsurf-api-client 另处理
 *   max_tokens / content_filter；没有 error 终态——失败请求不落带 metrics 的行
 *   （本地无失败样本可证），因此有 metrics 的行一律按 success。
 * - Credits：sessions.cogs_json 本机全为 {"total_credit_cost":0,"total_acu_cost":
 *   0.0}，chat_message 的 committed_credit_cost / committed_acu_cost 从未持久化
 *   （计费在服务端，serde 对 None 跳过），Devin 记录不参与 Credits 统计。
 * - sessions.hidden=1 是内部辅助会话（V15 迁移注释：summarizer 等不进用户会话
 *   列表）；其生成同样是真实模型消耗，用量照常计入。
 * - 同一 (session_id, request_id) 会有多行：上下文压缩（compaction）重写消息
 *   森林时按 compact/prior_node_ids 血缘复制节点，树簿记重存也会再落一行。
 *   实测这些副本的 message_id 与 metrics 完全一致（本机 251 行去重后 82 个
 *   请求，全部命中重复组），因此按 request_id 去重防止同一次生成被重复计费；
 *   保留最早一行——原始行的 created_at 等于生成时刻，压缩副本的 created_at
 *   是重写时刻（实测晚约 8 分钟，跨天时会掉进错误的统计桶）。
 * - sessions.working_directory：会话工作目录（NOT NULL），项目名取目录叶子
 *   （与 CodeBuddy / Qoder / ZCode 的项目标签口径一致）。
 */

/** message_nodes × sessions 查询结果行（见文件头）。 */
export interface DevinMessageRow {
  row_id: number | null;
  session_id: string | null;
  node_id?: number | null;
  /** Unix 秒。 */
  created_at: number | null;
  /** ACP ChatMessage JSON 字符串。 */
  chat_message: string | null;
  /** join sessions 表得到的工作目录。 */
  working_directory?: string | null;
  /** join sessions 表得到的会话默认模型。 */
  session_model?: string | null;
}

/** 与 zcode 的 integer()（Oh）同款防御：非有限数按 0、负数截 0、小数截断取整。 */
export function clampDevinInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/**
 * 项目名取 working_directory 的最后一段；目录缺失或空时返回“未知项目”
 * （与 zcodeProjectLabel 同口径）。
 */
export function devinProjectLabel(directory: string | null | undefined): string {
  if (typeof directory !== "string" || directory.trim() === "") {
    return "未知项目";
  }
  const segments = directory.replace(/[\\/]+$/, "").split(/[\\/]/);
  const base = segments[segments.length - 1]?.trim();
  return base ? base : "未知项目";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstNonEmptyString(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/**
 * message_nodes 一行 → UsageRecord。created_at 非法（缺失 / 非正）、
 * chat_message 损坏、role 不是 assistant 或没有 metrics 的行返回 null，
 * 与其他 Harness “没有可用用量即丢弃”的口径一致。
 */
export function parseDevinMessageRow(row: DevinMessageRow): UsageRecord | null {
  const timestampSeconds = Number(row.created_at);
  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) return null;

  let message: unknown;
  try {
    message = JSON.parse(typeof row.chat_message === "string" ? row.chat_message : "");
  } catch {
    return null;
  }
  if (!isPlainRecord(message) || message.role !== "assistant") return null;
  const metadata = isPlainRecord(message.metadata) ? message.metadata : null;
  if (!metadata) return null;
  // metrics 键存在但为 null（user 行的常态）时同样按无用量丢弃。
  const metrics = isPlainRecord(metadata.metrics) ? metadata.metrics : null;
  if (!metrics) return null;

  const inputTokens = clampDevinInteger(metrics.input_tokens);
  const outputTokens = clampDevinInteger(metrics.output_tokens);
  const cacheReadTokens = clampDevinInteger(metrics.cache_read_tokens);
  const cacheCreationTokens = clampDevinInteger(metrics.cache_creation_tokens);
  // metrics 没有总量字段（num_tokens 只是输出量），总量按四项求和。
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

  const durationRaw = Number(metrics.total_time_ms);
  const estimatedDurationMs =
    Number.isFinite(durationRaw) && durationRaw > 0 ? Math.round(durationRaw) : undefined;
  const ttftRaw = Number(metrics.ttft_ms);
  let firstTokenMs =
    Number.isFinite(ttftRaw) && ttftRaw > 0 ? Math.round(ttftRaw) : undefined;
  if (
    firstTokenMs !== undefined &&
    estimatedDurationMs !== undefined &&
    firstTokenMs > estimatedDurationMs
  ) {
    // 与 zcode 同款防御：首字不可能晚于请求完成，越界视为脏值丢弃。
    firstTokenMs = undefined;
  }

  const sessionId = typeof row.session_id === "string" && row.session_id ? row.session_id : "";
  // 实测 assistant 行必带 request_id；防御缺失时回退 row_id（行级稳定）。
  const requestId = firstNonEmptyString(
    typeof metadata.request_id === "string" ? metadata.request_id : undefined,
    row.row_id === null || row.row_id === undefined ? undefined : String(row.row_id),
  );
  if (!requestId) return null;
  const model =
    firstNonEmptyString(
      typeof metadata.generation_model === "string" ? metadata.generation_model : undefined,
      row.session_model,
    ) ?? "未知模型";

  return {
    id: `devin:${sessionId}:${requestId}`,
    requestId,
    sessionId,
    harness: "devin",
    project: devinProjectLabel(row.working_directory),
    model,
    provider: deriveProvider(model, "Devin"),
    timestamp: Math.round(timestampSeconds * 1000),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    inputTokenSemantics: "fresh",
    hasTokenUsage: totalTokens > 0,
    credits: 0,
    hasCredit: false,
    ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
    ...(estimatedDurationMs === undefined ? {} : { estimatedDurationMs }),
    status: "success",
  };
}

/**
 * 从 message_nodes 读取的 SQL。json_valid 防御个别损坏行让整个查询报错；
 * role/metrics 过滤见文件头（message_nodes.metadata 是另一列，不要与
 * chat_message 内的 metadata 键混淆）。
 */
export const DEVIN_USAGE_SQL = `
  select
    m.row_id,
    m.session_id,
    m.node_id,
    m.created_at,
    m.chat_message,
    s.working_directory,
    s.model as session_model
  from message_nodes m
  join sessions s on s.id = m.session_id
  where json_valid(m.chat_message)
    and json_extract(m.chat_message, '$.role') = 'assistant'
    and json_extract(m.chat_message, '$.metadata.metrics') is not null
  order by m.created_at asc, m.row_id asc
`;

export interface DevinUsageCollection {
  records: UsageRecord[];
  /** 有用量记录的会话数（作为面板“已扫描会话文件”数）。 */
  sessionCount: number;
}

/**
 * 把 SQL 查询结果行收集成 UsageRecord 列表（时间倒序，同刻按 id 升序稳定
 * 排序）。同一 session 的同一 request_id 是压缩副本 / 树重存（见文件头），
 * 按 first-wins 去重：SQL 已按 created_at 升序，保留的是最早（原始）一行，
 * 使记录时间戳为生成时刻而非压缩重写时刻。
 */
export function collectDevinUsage(rows: unknown[]): DevinUsageCollection {
  const records = new Map<string, UsageRecord>();
  const sessions = new Set<string>();
  for (const row of rows) {
    const record = parseDevinMessageRow(row as DevinMessageRow);
    if (!record) continue;
    if (records.has(record.id)) continue;
    records.set(record.id, record);
    if (record.sessionId) sessions.add(record.sessionId);
  }
  const sorted = Array.from(records.values()).sort(
    (a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id),
  );
  return { records: sorted, sessionCount: sessions.size };
}
