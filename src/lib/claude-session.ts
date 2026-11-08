import {
  deriveProvider,
  getProjectLabel,
  type UsageRecord,
} from "@/lib/usage";

/**
 * Claude Code 会话转录（~/.claude/projects/<项目>/<会话>.jsonl，每行一个
 * transcript entry）的字段语义依据本机 Claude Code 2.1.317（claude.exe，含
 * Claude Desktop 内嵌版本）的代码反查与真实转录交叉确认，并与 cc-switch 的
 * 会话导入（src-tauri/src/services/session_usage.rs）对齐，不靠字段名望文生义：
 *
 * - `message.usage.{input_tokens, output_tokens, cache_read_input_tokens,
 *   cache_creation_input_tokens}`：Anthropic Messages API 返回的原始用量，由
 *   Claude Code 的 SSE 归并器从 message_start / message_delta 原样拷贝进
 *   message 对象后落盘（claude.exe: `if(r.usage.input_tokens!=null)
 *   s.usage.input_tokens=r.usage.input_tokens` …）。`input_tokens` 不含缓存
 *   读写（两者是并列字段；cost-state 行的 modelUsage 同样把 inputTokens 与
 *   cacheReadInputTokens 分列），因此按「新鲜输入」口径统计。`iterations`
 *   等扩展字段是服务端透传，顶层 usage 即最终计费口径。
 * - 同一 `message.id` 落多行：每次 API 响应按内容块分块入库，每行携带该
 *   时刻的 usage 快照（实测 122 行 assistant 对应 33 个 message id），必须按
 *   message.id 去重；仅写了 message_start 快照（无 stop_reason、output=1）的
 *   请求其 input/cache 已真实计费，也要导入（cc-switch 实测丢弃会低估约 4.1%）。
 * - `timestamp`：该行入库时刻，即该内容块完成的时刻（claude.exe:
 *   `timestamp:new Date().toISOString()`）。
 * - `apiBlockIndex`：块在响应内的序号，首块为 0；旧版日志无此字段。
 * - `parentUuid`：上一条已入库行的 uuid。转录里没有单请求延迟字段
 *   （`durationMs` 只出现在工具结果与 hook 汇总里），耗时只能按
 *   「该消息所有块最晚时间戳 − 请求起点行时间戳」估算；请求起点沿父链回溯，
 *   跳过 `attachment` 行（其时间戳是回复开始后才补记的，不可靠）。
 * - `cwd`：该行请求执行时的工作目录。项目目录名由会话启动时的 cwd 把
 *   所有非字母数字字符替换成 "-" 得来（claude.exe 中该正则紧邻
 *   sessionProjectDir / projectDirCache：`[^a-zA-Z0-9]` → "-"，如
 *   D:\code\y-token-panel → D--code-y-token-panel）。行内 cwd 常指向项目
 *   的子目录（cd 之后、后台任务），把 mangle 后等于目录名的那个 cwd 认作
 *   会话项目根并取其叶子名（以文件为单位确定，同文件共享），整文件都推
 *   不出时按目录名兜底，保持与 Claude Code 自身一致的项目归组。
 * - `cost-state` 行是会话级累计（实测 6.9MB 的会话文件仅 1 行），无法归因到
 *   单请求，因此 Claude Code 记录不参与 Credits 统计；且它按 Claude 自己
 *   的全程累计（含已被清理的失败重试行等），与按当前转录内容求和存在
 *   个位数百分比的小差异，属数据源口径差异（实测独立复算逐行求和与
 *   本解析器一致）。
 * - 转录里没有请求级错误标记（失败的请求不会提交带 usage 的 assistant 行），
 *   与 KCode 同款全部按 success 计。
 */

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ClaudeTranscriptLine {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  apiBlockIndex?: number;
  message?: {
    id?: string;
    model?: string;
    stop_reason?: string | null;
    usage?: ClaudeUsage;
  };
}

export interface ClaudeParseContext {
  /** ~/.claude/projects 下的项目目录名（mangle 后的会话启动 cwd）。 */
  directory: string;
  /** 会话目录 / 文件名兜底的 sessionId；行内一般都带 sessionId。 */
  sessionId: string;
  file: string;
}

/** 估算耗时短于此值视为起点取错（真实请求不可能这么快）。 */
export const CLAUDE_MIN_PLAUSIBLE_LATENCY_MS = 100;

/** 估算耗时超过 1 小时视为中间夹了休眠或长等待，不采纳。 */
export const CLAUDE_MAX_PLAUSIBLE_LATENCY_MS = 60 * 60 * 1000;

/** 沿父链回溯的最大步数：超界视为脏数据（含成环）。 */
export const CLAUDE_MAX_CHAIN_HOPS = 32;

function parseClaudeTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

/** 一行转录在对话链上的位置，只留估算请求耗时用得到的三样。 */
interface ClaudeChainNode {
  parent?: string;
  timestampMs?: number;
  /** attachment 行的时间戳不可靠（回复开始后才补记），找起点时跳过。 */
  isAttachment: boolean;
}

function recordClaudeChainNode(
  chain: Map<string, ClaudeChainNode>,
  line: ClaudeTranscriptLine,
): void {
  if (!line.uuid) return;
  chain.set(line.uuid, {
    parent: line.parentUuid ?? undefined,
    timestampMs: parseClaudeTimestamp(line.timestamp),
    isAttachment: line.type === "attachment",
  });
}

/** 一条回复（同一 message.id 的所有内容块）的计时线索。 */
interface ClaudeMessageTiming {
  /** 文件里最先出现的块的父行，请求起点沿它往上找。 */
  firstParent?: string;
  /** 最先出现的块是否这条回复的第一块；不是的话起点会取晚，宁可不估。 */
  startsAtFirstBlock: boolean;
  /** 各块时间戳（块完成时刻）里最晚的一个，即回复结束。 */
  endMs?: number;
}

function recordClaudeBlockTiming(
  timings: Map<string, ClaudeMessageTiming>,
  line: ClaudeTranscriptLine,
  messageId: string,
): void {
  const blockEndMs = parseClaudeTimestamp(line.timestamp);
  let timing = timings.get(messageId);
  if (!timing) {
    const startsAtFirstBlock =
      line.apiBlockIndex === undefined || line.apiBlockIndex === 0;
    timing = {
      firstParent: line.parentUuid ?? undefined,
      startsAtFirstBlock,
      endMs: blockEndMs,
    };
    timings.set(messageId, timing);
    return;
  }
  if (blockEndMs !== undefined) {
    timing.endMs =
      timing.endMs === undefined
        ? blockEndMs
        : Math.max(timing.endMs, blockEndMs);
  }
}

/**
 * 请求起点：从回复第一块的父行往上，跳过 attachment 行，取第一个别的行
 * （用户消息、工具结果等）的时间戳。父行不在链上（链断裂）或超界返回
 * undefined。上界同时兜住成环的脏数据。
 */
export function resolveClaudeRequestStartMs(
  chain: Map<string, ClaudeChainNode>,
  firstParent?: string,
): number | undefined {
  let cursor = firstParent;
  for (let hop = 0; hop < CLAUDE_MAX_CHAIN_HOPS && cursor; hop += 1) {
    const node = chain.get(cursor);
    if (!node) return undefined;
    if (!node.isAttachment) return node.timestampMs;
    cursor = node.parent;
  }
  return undefined;
}

/** 估算耗时落在合理范围之外返回 undefined（cc-switch estimated_latency_ms 同款）。 */
export function estimateClaudeLatencyMs(
  startMs: number,
  endMs: number,
): number | undefined {
  const latency = endMs - startMs;
  if (!Number.isFinite(latency)) return undefined;
  return latency >= CLAUDE_MIN_PLAUSIBLE_LATENCY_MS &&
    latency <= CLAUDE_MAX_PLAUSIBLE_LATENCY_MS
    ? latency
    : undefined;
}

/** 参与去重的一条 assistant 消息代表候选。 */
interface ClaudeAssistantCandidate {
  messageId: string;
  line: ClaudeTranscriptLine;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

function hasBillableTokens(candidate: ClaudeAssistantCandidate): boolean {
  return (
    candidate.inputTokens > 0 ||
    candidate.outputTokens > 0 ||
    candidate.cacheReadTokens > 0 ||
    candidate.cacheCreationTokens > 0
  );
}

/**
 * 按 message.id 去重：优先保留有 stop_reason 的条目，其次保留
 * output_tokens 更大的（cc-switch 同款：同一 message 的块携带 usage 快照，
 * 最终块最完整）。
 */
function shouldReplaceCandidate(
  existing: ClaudeAssistantCandidate,
  candidate: ClaudeAssistantCandidate,
): boolean {
  const existingHasStop = existing.line.message?.stop_reason != null;
  const candidateHasStop = candidate.line.message?.stop_reason != null;
  if (candidateHasStop && !existingHasStop) return true;
  if (candidateHasStop === existingHasStop) {
    return candidate.outputTokens > existing.outputTokens;
  }
  return false;
}

/** 会话启动 cwd → 项目目录名的变换：所有非字母数字字符替换成 "-"。 */
export function mangleClaudeProjectDirectory(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function claudeCwdLeaf(cwd: string): string | undefined {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  const leaf = parts.length > 0 ? parts[parts.length - 1] : undefined;
  // 只剩盘符（cwd 是驱动器根目录）算不上项目名。
  return leaf && !/^[A-Za-z]:$/.test(leaf) ? leaf : undefined;
}

/**
 * 记录的项目名：mangle 后等于目录名的行内 cwd 是会话项目根，取其叶子名；
 * 其余 cwd（请求执行时的子目录）与缺失情况都回退目录名派生的标签。
 * 会话根以文件为单位确定（同文件共享），子目录行归入会话根。
 */
export function claudeProjectLabel(
  cwd: string | undefined,
  directory: string,
): string | undefined {
  if (typeof cwd === "string" && mangleClaudeProjectDirectory(cwd) === directory) {
    return claudeCwdLeaf(cwd);
  }
  return undefined;
}

/** 增量续读时携带的文件级黏性状态（游标 parser state 的一部分）。 */
export interface ClaudeParseSeed {
  /** 上一轮以文件为单位的会话项目根；回看窗口可能看不到文件首部的 cwd。 */
  sessionProject?: string;
}

/**
 * 解析整个会话文件：单遍扫描建立对话链、块计时并按 message.id 去重收集
 * assistant 用量，随后生成 UsageRecord。耗时只给「写完整了的回复」估算：
 * 有 stop_reason、看得到首块（apiBlockIndex 0 或缺失）、且沿父链能取到落在
 * 合理范围内的起点时间戳。
 */
export function parseClaudeTranscriptFile(
  content: string,
  context: ClaudeParseContext,
  seed?: ClaudeParseSeed,
): UsageRecord[] {
  return parseClaudeTranscriptIncremental(content, context, seed).records;
}

/**
 * 与 parseClaudeTranscriptFile 同一解析体，额外返回文件级会话项目根，供
 * 增量 reader 持久化到游标 parser state 并在下一轮作为 seed 恢复。传入
 * 回看窗口 + 新增字节拼接的内容时，链与计时按窗口重建，窗口外的请求
 * 起点不可见（与 cc-switch 的有界回看口径一致，宁可不估也不猜）。
 */
export function parseClaudeTranscriptIncremental(
  content: string,
  context: ClaudeParseContext,
  seed?: ClaudeParseSeed,
): { records: UsageRecord[]; sessionProject: string | null } {
  const chain = new Map<string, ClaudeChainNode>();
  const timings = new Map<string, ClaudeMessageTiming>();
  const messages = new Map<string, ClaudeAssistantCandidate>();
  // 会话项目根：文件里第一个 mangle 后等于目录名的 cwd 的叶子名。同文件的
  // 记录共享它，请求执行时 cd 进的子目录不改变项目归组。增量续读时以持久
  // 化的值预热，回看窗口中的首个匹配与文件首部语义一致。
  let sessionProject = seed?.sessionProject;

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: ClaudeTranscriptLine;
    try {
      value = JSON.parse(line) as ClaudeTranscriptLine;
    } catch {
      continue;
    }

    recordClaudeChainNode(chain, value);
    sessionProject ??= claudeProjectLabel(value.cwd, context.directory);

    if (value.type !== "assistant") continue;
    const message = value.message;
    if (!message?.id) continue;

    recordClaudeBlockTiming(timings, value, message.id);

    const usage = message.usage;
    if (!usage) continue;

    const candidate: ClaudeAssistantCandidate = {
      messageId: message.id,
      line: value,
      inputTokens: nonNegativeInteger(usage.input_tokens),
      outputTokens: nonNegativeInteger(usage.output_tokens),
      cacheReadTokens: nonNegativeInteger(usage.cache_read_input_tokens),
      cacheCreationTokens: nonNegativeInteger(usage.cache_creation_input_tokens),
    };
    const existing = messages.get(message.id);
    if (!existing || shouldReplaceCandidate(existing, candidate)) {
      messages.set(message.id, candidate);
    }
  }

  const records: UsageRecord[] = [];
  for (const candidate of messages.values()) {
    if (!hasBillableTokens(candidate)) continue;

    const line = candidate.line;
    const timestamp = parseClaudeTimestamp(line.timestamp);
    if (timestamp === undefined) continue;

    const model = line.message?.model ?? "未知模型";
    const totalTokens =
      candidate.inputTokens +
      candidate.outputTokens +
      candidate.cacheReadTokens +
      candidate.cacheCreationTokens;

    // 耗时估算只给写完整了的回复（有 stop_reason）且看得到首块的。
    const timing = timings.get(candidate.messageId);
    let estimatedDurationMs: number | undefined;
    if (timing?.startsAtFirstBlock && line.message?.stop_reason != null) {
      const startMs = resolveClaudeRequestStartMs(chain, timing.firstParent);
      if (startMs !== undefined && timing.endMs !== undefined) {
        estimatedDurationMs = estimateClaudeLatencyMs(startMs, timing.endMs);
      }
    }

    records.push({
      id: `claude:${candidate.messageId}`,
      requestId: candidate.messageId,
      sessionId: line.sessionId ?? context.sessionId,
      harness: "claude",
      project: sessionProject ?? getProjectLabel(context.directory),
      model,
      provider: deriveProvider(model, "Anthropic"),
      timestamp,
      inputTokens: candidate.inputTokens,
      outputTokens: candidate.outputTokens,
      cacheReadTokens: candidate.cacheReadTokens,
      cacheCreationTokens: candidate.cacheCreationTokens,
      totalTokens,
      inputTokenSemantics: "fresh",
      hasTokenUsage: totalTokens > 0,
      credits: 0,
      hasCredit: false,
      estimatedDurationMs,
      status: "success",
    });
  }
  return { records, sessionProject: sessionProject ?? null };
}
