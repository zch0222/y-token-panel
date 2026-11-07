import path from "node:path";
import {
  deriveEstimatedDurationMs,
  finiteNumber,
  parseTimestamp,
  type SessionRecord,
} from "@/lib/codebuddy-session";
import {
  deriveProvider,
  type UsageRecord,
} from "@/lib/usage";

/**
 * WorkBuddy（腾讯 CodeBuddy 衍生的桌面 / CLI agent）会话记录的字段语义，
 * 全部依据本机 WorkBuddy 2.137.1 的 CLI bundle（resources/
 * app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs，@genie/agent-cli 2.165.0）
 * 与 ~/.workbuddy/projects 下的真实会话文件反查确认，不靠字段名望文生义：
 *
 * - 存储布局：会话文件在 `<配置根>/projects/<压缩 cwd>/<sessionId>.jsonl`
 *   （getWorkbuddyConfigDir = WORKBUDDY_CONFIG_DIR || ~/.workbuddy；压缩规则
 *   compressWorkspacePathName：把 `/\:` 换成 `-`、折叠连续 `-`，超 255 字节
 *   截断到 180 字节再拼 djb2-base36 哈希）。子 agent 会话在
 *   `<压缩 cwd>/<父 sessionId>/subagents/agent-*.jsonl`（getSessionFilePath：
 *   会话 id 以 `agent-` 开头且有父会话时进 subagents 子目录）。项目目录直下
 *   以 `agent-` 开头的 .jsonl 是宿主绑定前的遗留（SessionFacetService 扫描
 *   会跳过），本读取器同样跳过。
 * - 每行一个 history item 原样 JSON（SessionStore.append：JSON.stringify +
 *   换行追加）。同一 id 可能出现多行：条目先不带 usage 入库、响应结束补全
 *   usage 后再次持久化（本机实测 1665 行里 93 行是重复 id，其中 69 行是
 *   「无 usage → 有 usage」的补写）。官方读取 loadLane 用 `Map<id,item>` 按
 *   id 覆盖，因此去重口径是后行覆盖前行（last-wins）。
 * - 携带 usage 的条目类型只有三种（transformItemForSaveAsync 只给
 *   `message` / `assistant` / `function_call` 补 `message.usage`；OpenAI
 *   Responses API 的用量走独立事实条目 `model-usage`）：
 *   - `message`（role=assistant，纯文本回复）与 `function_call`（工具调用）：
 *     usage 在 `providerData`；
 *   - `model-usage`（事实类型，off-chain）：providerData.usage 为归一化用量。
 *   `credit-usage`（图片生成 / ACP 队友的阶段级 credit 事件，只有 credit 没有
 *   token 和模型）不解析：无法归因到模型维度，且本机数据未出现。
 * - `providerData.usage`（归一化，chat/responses 两条路径都会写）：`requests`
 *   恒为 1（一次 API 请求）；`inputTokens` 是**含缓存读取 + 缓存写入的总输入**
 *   （getCurrentContextUsage 在 OpenAI 风格 rawUsage 存在时用
 *   `inputTokens − cacheRead − cacheCreation` 才得到新鲜输入），对应面板
 *   inputTokenSemantics: "total"；`totalTokens` = 输入总量 + 输出；
 *   `inputTokensDetails[].cached_tokens` / `outputTokensDetails[].reasoning_tokens`
 *   是分量明细。
 * - `providerData.rawUsage`（提供方原始 usage）：缓存读取按 UsageUtils.
 *   getCacheReadTokens 的回退链取**第一个正数**：`cache_read_input_tokens` →
 *   `cacheReadInputTokens` → `inputTokensDetails.cached_tokens`（数组求和）→
 *   `prompt_tokens_details.cached_tokens` → `prompt_cache_hit_tokens`；缓存
 *   写入 getCacheCreationTokens：`cache_creation_input_tokens` →
 *   `cacheCreationInputTokens` → `prompt_cache_write_tokens` →
 *   `prompt_cache_miss_tokens`（DeepSeek 风格的 cache miss 在官方口径里计入
 *   缓存写入）。
 * - `credit`：服务端在 SSE 流的 usage 对象里逐请求上报（parseSSEChunk 读取，
 *   collectRequestCreditsFromHistory 只累计有限正值），是真实计费口径。
 *   官方按 `${conversationRequestId} message:${messageId}` 去重后累加成
 *   workbuddy.db session_usage.credit_json（按 requestId 聚合、保留 2 位）；
 *   本解析器按 `${sessionId}|${messageId}` 后行覆盖去重，与官方口径一致。
 * - `model`：实际执行的模型 id（providerData.model），缺省回退请求的
 *   `requestModelId`；`requestModelName` 只是展示名，不作模型键。
 * - `conversationRequestId`：一次用户请求（turn）的 id，该 turn 内多次模型
 *   调用共享；`messageId` 唯一标识一次模型响应（assistant 消息）。
 * - `timestamp`：条目入库时刻的 epoch 毫秒（transformItemForSaveAsync 对缺失
 *   时间戳的条目补 Date.now()）；usage 在响应完成后随条目补写，所以带 usage
 *   的重写行时间戳 ≈ 该次模型请求的完成时刻。
 * - `status`：Responses 风格的 `completed` / `in_progress` / `failed` /
 *   `cancelled` 等；`providerData.error` 存在同样视为失败。
 * - `cwd`：保存时对非事实条目补的会话工作目录（transformItemForSaveAsync：
 *   `S.cwd = cwd ?? getWorkDir()`）；事实条目（model-usage）没有，回退到
 *   同文件其他条目的 cwd（官方 extractCwdFromProjectDir 同样取文件首个
 *   非空行的 cwd）。项目名取 cwd 最后一段。
 * - 会话日志没有首字计时与单请求延迟；耗时与 CodeBuddy 同源格式，沿
 *   parentId 父链回溯到 user 消息 / function_call_result（请求边界）估算，
 *   含首字等待（复用 codebuddy-session 的 deriveEstimatedDurationMs）。
 */

interface WorkBuddyMessageUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface WorkBuddyTokenDetails {
  cached_tokens?: number;
  reasoning_tokens?: number;
}

interface WorkBuddyRawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  credit?: number | string;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_cache_write_tokens?: number;
  cache_read_input_tokens?: number;
  cacheReadInputTokens?: number;
  cache_creation_input_tokens?: number;
  cacheCreationInputTokens?: number;
  prompt_tokens_details?: WorkBuddyTokenDetails;
  completion_tokens_details?: WorkBuddyTokenDetails;
}

interface WorkBuddyNormalizedUsage {
  requests?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  credit?: number | string;
  inputTokensDetails?: WorkBuddyTokenDetails | WorkBuddyTokenDetails[];
  outputTokensDetails?: WorkBuddyTokenDetails | WorkBuddyTokenDetails[];
}

interface WorkBuddyProviderData {
  messageId?: string;
  model?: string;
  requestModelId?: string;
  requestModelName?: string;
  traceId?: string;
  conversationRequestId?: string;
  requestId?: string;
  agent?: string;
  stageId?: string;
  error?: unknown;
  rawUsage?: WorkBuddyRawUsage;
  usage?: WorkBuddyNormalizedUsage;
}

/**
 * 会话条目。与 codebuddy-session 的 SessionRecord 结构兼容（父链回溯复用其
 * 实现）；差异点是 parentId 在官方数据里可为 null（链起点），因此在传入
 * 复用函数处做一次显式断言，运行时 null 会被当作「无父级」处理。
 */
export interface WorkBuddySessionRecord {
  id?: string;
  parentId?: string | null;
  timestamp?: number | string;
  type?: string;
  role?: string;
  status?: string;
  sessionId?: string;
  cwd?: string;
  message?: { usage?: WorkBuddyMessageUsage };
  providerData?: WorkBuddyProviderData;
  [key: string]: unknown;
}

/** 携带 usage 的条目类型（见文件头：其余类型的 usage 语义未知，不解析）。 */
const USAGE_ITEM_TYPES = new Set(["message", "assistant", "function_call", "model-usage"]);

const FAILED_STATUSES = new Set(["error", "failed", "cancelled", "canceled", "aborted"]);

function num(value: unknown): number | undefined {
  return finiteNumber(value);
}

/**
 * 移植 UsageUtils.getCacheReadTokens 的 firstPositiveTokenCount：取第一个
 * 有限正数，全非正时为 0。官方实现只认 `typeof i === "number" && i > 0`。
 */
function firstPositiveTokenCount(...values: Array<number | undefined>): number {
  for (const value of values) {
    if (value !== undefined && value > 0) return value;
  }
  return 0;
}

/** inputTokensDetails（数组形态）里 cached_tokens 求和；单对象取其值。 */
function detailsCachedTokens(
  details: WorkBuddyTokenDetails | WorkBuddyTokenDetails[] | undefined,
): number | undefined {
  if (Array.isArray(details)) {
    return details.reduce((sum, entry) => sum + (num(entry?.cached_tokens) ?? 0), 0);
  }
  return num(details?.cached_tokens);
}

/**
 * 缓存读取分量，回退链逐位对齐 UsageUtils.getCacheReadTokens：
 * cache_read_input_tokens → cacheReadInputTokens → inputTokensDetails.cached_tokens
 * （数组求和）→ prompt_tokens_details.cached_tokens → prompt_cache_hit_tokens。
 */
export function workbuddyCacheReadTokens(
  usage: WorkBuddyRawUsage | WorkBuddyNormalizedUsage | undefined,
): number {
  if (!usage) return 0;
  const raw = usage as WorkBuddyRawUsage;
  const normalized = usage as WorkBuddyNormalizedUsage;
  return firstPositiveTokenCount(
    num(raw.cache_read_input_tokens),
    num(raw.cacheReadInputTokens),
    detailsCachedTokens(normalized.inputTokensDetails),
    num(raw.prompt_tokens_details?.cached_tokens),
    num(raw.prompt_cache_hit_tokens),
  );
}

/**
 * 缓存写入分量，回退链逐位对齐 UsageUtils.getCacheCreationTokens：
 * cache_creation_input_tokens → cacheCreationInputTokens →
 * prompt_cache_write_tokens → prompt_cache_miss_tokens。
 */
export function workbuddyCacheCreationTokens(
  usage: WorkBuddyRawUsage | WorkBuddyNormalizedUsage | undefined,
): number {
  if (!usage) return 0;
  const raw = usage as WorkBuddyRawUsage;
  return firstPositiveTokenCount(
    num(raw.cache_creation_input_tokens),
    num(raw.cacheCreationInputTokens),
    num(raw.prompt_cache_write_tokens),
    num(raw.prompt_cache_miss_tokens),
  );
}

/** 项目名取 cwd 最后一段（与 CodeBuddy / ZCode 的目录叶子名口径一致）。 */
export function workbuddyProjectLabel(cwd: string | undefined): string | undefined {
  if (typeof cwd !== "string" || cwd.trim() === "") return undefined;
  const segments = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  const base = segments[segments.length - 1]?.trim();
  return base ? base : undefined;
}

function firstNumber(...values: Array<number | undefined>): number | undefined {
  for (const value of values) {
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * 单条 usage 条目 → UsageRecord。时间戳非法（缺失 / 非法字符串）时返回 null，
 * 与其他 Harness「没有可用时间戳即丢弃」的口径一致。
 */
export function parseWorkBuddyUsageRecord(
  record: WorkBuddySessionRecord,
  file: string,
  lineIndex: number,
  fallbackProject: string,
): UsageRecord | null {
  const providerData = record.providerData;
  const normalized = providerData?.usage;
  const raw = providerData?.rawUsage;
  const messageUsage = record.message?.usage;
  if (!normalized && !raw && !messageUsage) return null;

  const timestamp = parseTimestamp(record.timestamp);
  if (timestamp === undefined) return null;

  // 官方缓存口径以 rawUsage 优先、归一化 usage 兜底（getCacheReadTokens 的
  // 调用点统一传 `rawUsage || usage`）。
  const cacheSource = raw ?? normalized;
  // 老格式记录只有 message.usage（保存时由官方 getCacheReadTokens 派生，
  // 仅在 > 0 时写入），providerData 缺失时回退到它。
  const cacheReadTokens =
    workbuddyCacheReadTokens(cacheSource) ||
    num(messageUsage?.cache_read_input_tokens) ||
    0;
  const cacheCreationTokens =
    workbuddyCacheCreationTokens(cacheSource) ||
    num(messageUsage?.cache_creation_input_tokens) ||
    0;
  const inputTokens =
    firstNumber(
      num(normalized?.inputTokens),
      num(raw?.prompt_tokens),
      num(messageUsage?.input_tokens),
    ) ?? 0;
  const outputTokens =
    firstNumber(
      num(normalized?.outputTokens),
      num(raw?.completion_tokens),
      num(messageUsage?.output_tokens),
    ) ?? 0;
  const reportedTotal =
    firstNumber(
      num(normalized?.totalTokens),
      num(raw?.total_tokens),
      num(messageUsage?.total_tokens),
    ) ?? inputTokens + outputTokens;
  // credit 由服务端逐请求上报（SSE usage.credit）；官方读取顺序 rawUsage 优先。
  const credit = firstNumber(num(raw?.credit), num(normalized?.credit));

  const sessionId = record.sessionId ?? path.basename(file, ".jsonl");
  const messageId = providerData?.messageId ?? record.id ?? `${file}:${lineIndex}`;
  const model = providerData?.model || providerData?.requestModelId || "未知模型";
  const failed =
    FAILED_STATUSES.has(record.status?.toLowerCase() ?? "") ||
    providerData?.error !== undefined;

  return {
    id: `workbuddy:${sessionId}:${messageId}`,
    requestId: providerData?.conversationRequestId ?? providerData?.requestId ?? messageId,
    sessionId,
    harness: "workbuddy",
    project: workbuddyProjectLabel(record.cwd) ?? fallbackProject,
    model,
    provider: deriveProvider(model, "WorkBuddy"),
    timestamp,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: reportedTotal,
    inputTokenSemantics: "total",
    hasTokenUsage: reportedTotal > 0,
    credits: credit ?? 0,
    hasCredit: credit !== undefined,
    status: failed ? "error" : "success",
  };
}

/**
 * 解析整个会话文件：
 * 1. 逐行 JSON 解析，按 id 后行覆盖建全量条目表（官方 loadLane 口径）；
 * 2. 文件级 cwd 取首个非空条目的 cwd（官方 extractCwdFromProjectDir）；
 * 3. usage 条目按 `${sessionId}|${messageId}` 后行覆盖去重（官方
 *    collectRequestCreditsFromHistory 的 message 粒度）；
 * 4. 对胜出条目沿父链估算请求耗时。
 */
export function parseWorkBuddySession(content: string, file: string): UsageRecord[] {
  const lines = content.split(/\r?\n/);
  const byId = new Map<string, WorkBuddySessionRecord>();
  const items: WorkBuddySessionRecord[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let item: WorkBuddySessionRecord;
    try {
      item = JSON.parse(line) as WorkBuddySessionRecord;
    } catch {
      continue;
    }
    items.push(item);
    if (typeof item.id === "string" && item.id) byId.set(item.id, item);
  }

  const fileCwd = workbuddyProjectLabel(
    items.find((item) => typeof item.cwd === "string" && item.cwd.trim() !== "")?.cwd,
  );
  const fallbackProject = fileCwd ?? "未知项目";
  const winners = new Map<
    string,
    { record: UsageRecord; item: WorkBuddySessionRecord }
  >();

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item.type || !USAGE_ITEM_TYPES.has(item.type)) continue;
    const record = parseWorkBuddyUsageRecord(item, file, index, fallbackProject);
    if (!record) continue;
    // 去重键 = record.id，即 `${sessionId}|${messageId}`（后行覆盖）。
    winners.set(record.id, { record, item });
  }

  return Array.from(winners.values()).map(({ record, item }) => ({
    ...record,
    // 结构兼容 codebuddy 的 SessionRecord（见 WorkBuddySessionRecord 说明）；
    // parentId 为 null 时官方父链回溯视为「无父级」。
    estimatedDurationMs: deriveEstimatedDurationMs(
      item as unknown as SessionRecord,
      byId as unknown as Map<string, SessionRecord>,
    ),
  }));
}
