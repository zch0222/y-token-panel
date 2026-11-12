import type { AntigravityGenerationTiming } from "@/lib/antigravity-timing";
import { deriveProvider, type UsageRecord } from "@/lib/usage";

/**
 * Antigravity（Google Antigravity IDE / agy CLI）本地会话转录的字段语义，依据
 * 本机 Antigravity IDE 的 language_server（resources/bin/language_server.exe）
 * 反查确认，并对照 cc-switch 的参考实现
 * （src-tauri/src/services/session_usage_agy.rs）。证据来自真实会话与
 * conversations/<id>.db，不按字段名望文生义：
 *
 * - 位置：<appDataDir>/brain/<conversation-id>/.system_generated/logs/
 *   transcript.jsonl（紧凑版，长文本被截断）与 transcript_full.jsonl（全量）。
 *   两者的用量字段一致；面板只要元数据，优先读紧凑版。
 * - 每行一个 step：step_index / source / type / status / created_at；
 *   PLANNER_RESPONSE 另有 thinking / tool_calls，CHECKPOINT 有 content。
 * - 只有 PLANNER_RESPONSE 与 CHECKPOINT 带用量：
 *   input_tokens / cache_read_tokens / output_tokens。
 *   * CHECKPOINT 是上下文压缩（compaction）请求：本机 conversations/<id>.db 中
 *     step_type=23，metadata 是完整 ModelUsageStats（含 bot- 消息 ID 与
 *     response ID），说明它是一次真实模型调用，不是前序请求的累计值——实测
 *     该步 14736/243879/7507，而同会话此前 25 次响应合计
 *     250004/2915062/24183，量级完全不同。
 *   * input_tokens 是**不含缓存**的新鲜输入：实测同一响应
 *     input_tokens=24011、cache_read_tokens=117055；若 input 含缓存，
 *     这两个值不可能同时成立。故 inputTokenSemantics = "fresh"。
 *   * output_tokens **已包含思考**：conversations/<id>.db 的 ModelUsageStats
 *     字段 9（thinking_output_tokens）与 10（response_output_tokens）之和
 *     等于字段 3（output_tokens）：289+125=414、160+89=249、163+7344=7507。
 *     面板不再额外加思考 token。
 *   * 转录没有 cache_write_tokens（cc-switch 读取的该键在本机数据中不存在），
 *     缓存写入按 0 处理。
 * - 转录没有模型字段。用户切换模型时，Antigravity 把
 *   "The user changed setting `Model Selection` from X to Y." 写进 USER_INPUT
 *   的 <USER_SETTINGS_CHANGE> 段；按 step 顺序继承最近一次切换（cc-switch
 *   同款）。从未出现切换的会话记为「未知模型」，不按当前供应商反推。
 * - 只导入 status === "DONE" 且至少一项用量非零的响应（cc-switch 同款）；
 *   转录没有计费字段，记录恒为 hasCredit: false。
 * - 转录没有单请求耗时（created_at 只到秒、没有完成时刻）。PLANNER_RESPONSE 的
 *   精确耗时由 antigravity-timing.ts 从原生库的首字 + 流式 Duration 读出后传入；
 *   CHECKPOINT 的原生 generation 引用指向下一条生成，不参与耗时。
 */

/** transcript 里可能出现的 step 字段；未知字段一律忽略。 */
interface AntigravityTranscriptStep {
  step_index?: unknown;
  source?: unknown;
  type?: unknown;
  status?: unknown;
  created_at?: unknown;
  input_tokens?: unknown;
  cache_read_tokens?: unknown;
  output_tokens?: unknown;
  content?: unknown;
}

const UNKNOWN_MODEL = "未知模型";

/**
 * 只匹配 Antigravity 自己写入 <USER_SETTINGS_CHANGE> 的固定句式，避免把正文里
 * 提到 "Model Selection" 的文档内容当成切换事件。模型名里允许出现点号
 * （如 Gemini 3.8 Flash），因此句末只认「句号 + 空白」。
 */
const MODEL_SELECTION_CHANGE =
  /The user changed setting `Model Selection` from [^\n`]*? to ([^\n`]+?)\.(?=\s|$)/;

export function modelFromSettingsChange(content: string): string | undefined {
  const match = MODEL_SELECTION_CHANGE.exec(content);
  const model = match?.[1]?.trim();
  if (!model || model.toLowerCase() === "none") return undefined;
  return model;
}

/** 非负整数用量；缺失、负数、非数值一律按 0（不改变已有口径）。 */
function countOf(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed);
  }
  return 0;
}

function timestampOf(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isDone(step: AntigravityTranscriptStep): boolean {
  return step.status === "DONE";
}

function hasUsage(step: AntigravityTranscriptStep): boolean {
  return step.type === "PLANNER_RESPONSE" || step.type === "CHECKPOINT";
}

/**
 * 单份转录 → 记录；全量 reader 与增量 reader 共用。同一 step_index 重复写入
 * 时取最后一条（Antigravity 会把 RUNNING 行改写成 DONE）。
 */
export interface AntigravityParseOptions {
  /** step 索引 → 原生库记录的精确计时；只有 PLANNER_RESPONSE 使用。 */
  timings?: ReadonlyMap<number, AntigravityGenerationTiming>;
}

export function parseAntigravityTranscript(
  content: string,
  conversationId: string,
  project: string,
  { timings }: AntigravityParseOptions = {},
): UsageRecord[] {
  const records = new Map<string, UsageRecord>();
  let currentModel: string | undefined;

  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let step: AntigravityTranscriptStep;
    try {
      step = JSON.parse(line) as AntigravityTranscriptStep;
    } catch {
      // 尾部半行或损坏行：跳过，下一轮完整后自然会再读到。
      continue;
    }

    if (step.type === "USER_INPUT" && typeof step.content === "string") {
      const model = modelFromSettingsChange(step.content);
      if (model) currentModel = model;
      continue;
    }
    if (!hasUsage(step) || !isDone(step)) continue;

    const stepIndex =
      typeof step.step_index === "number" && Number.isSafeInteger(step.step_index)
        ? step.step_index
        : undefined;
    const timestamp = timestampOf(step.created_at);
    if (stepIndex === undefined || timestamp === undefined) continue;

    const inputTokens = countOf(step.input_tokens);
    const outputTokens = countOf(step.output_tokens);
    const cacheReadTokens = countOf(step.cache_read_tokens);
    const totalTokens = inputTokens + outputTokens + cacheReadTokens;
    if (totalTokens === 0) continue;

    const model = currentModel ?? UNKNOWN_MODEL;
    const requestId = `${conversationId}:${stepIndex}`;
    const timing =
      step.type === "PLANNER_RESPONSE" ? timings?.get(stepIndex) : undefined;
    records.set(`antigravity:${requestId}`, {
      id: `antigravity:${requestId}`,
      requestId,
      sessionId: conversationId,
      harness: "antigravity",
      project,
      model,
      provider: deriveProvider(model, "Antigravity"),
      timestamp,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens: 0,
      totalTokens,
      inputTokenSemantics: "fresh",
      hasTokenUsage: true,
      credits: 0,
      hasCredit: false,
      ...(timing === undefined
        ? {}
        : { estimatedDurationMs: timing.durationMs, firstTokenMs: timing.firstTokenMs }),
      status: "success",
    });
  }

  return Array.from(records.values());
}

/**
 * conversation_summaries.workspace_uris 是 JSON 数组（如
 * ["file:///d%3A/code/y-token-panel"]）。取第一个能解析出的工作区目录名，
 * 与其它 Harness 的 project 标签口径一致（目录 basename）。
 */
export function projectLabelFromWorkspaceUris(value: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  for (const entry of parsed) {
    if (typeof entry !== "string") continue;
    const label = projectLabelFromUri(entry);
    if (label) return label;
  }
  return undefined;
}

function projectLabelFromUri(uri: string): string | undefined {
  if (!uri.startsWith("file:")) return undefined;
  let pathname = uri.slice("file:".length);
  if (pathname.startsWith("//")) {
    const slash = pathname.indexOf("/", 2);
    pathname = slash >= 0 ? pathname.slice(slash) : "";
  }
  if (!pathname) return undefined;
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // 非法转义：保留原始形式，交给 basename 处理。
  }
  const normalized = decoded.replace(/^\/([a-zA-Z]:)/, "$1").replace(/[\\/]+$/, "");
  const basename = normalized.split(/[\\/]/).pop();
  return basename || undefined;
}
