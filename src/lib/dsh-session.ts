import { createHash } from "node:crypto";
import { deriveProvider, getProjectLabel, type UsageRecord } from "@/lib/usage";

/**
 * DeepSeek Harness（DSH）会话日志（$DSH_HOME/sessions/<项目目录>/<会话目录>/
 * session.vN.jsonl.zstd）的字段语义依据本机 @deepseek-ai/dsh v0.1.5-rc.2 的
 * dsh-session / dsh-session-persistence-jsonl / dsh-llm 包源码反查确认，
 * 并对齐 cc-switch（src-tauri/src/services/session_usage_dsh.rs）的导入口径，
 * 不靠字段名望文生义：
 *
 * - 文件形态：`.zstd` 是一串首尾相接、各自独立可解的 zstd 帧，每追加一个事件
 *   批次就追加一帧（persistence appendBatch → zstdCompress）；末尾可能有一帧
 *   只写了一半（崩溃残留），必须按帧结构扫描，容忍残缺尾帧，不能整文件一次
 *   解压（zstdDecompressSync 只解第一帧）。同一会话目录里可以并存多个版本
 *   文件（v0/v3/v4 迁移期间的老文件保留），按消息 ID 全局去重兜底。
 * - 事件信封：`{type, seq, time, data}`，`time` 是 Unix 毫秒（SessionEvent）。
 * - 用量挂在 `assistant/message` 事件的 `data.usage`（TokenUsage）：
 *   `inputTokens` 是**不含缓存**的新增输入（三种 token 互不重叠，计费输入 =
 *   input + cacheRead + cacheWrite 之和），`cacheWriteTokens` 是缓存写入，
 *   `totalTokens` 是含聚合 prompt 与 output 的精确全量（缺省时四项相加）。
 *   `reasoningTokens` 与 output 的包含关系源码未说明，不计（cc-switch 同款）。
 * - 模型与路由：`data.message.source.{provider, model}`（AssistantProvenance）；
 *   provider 是 DSH 里的路由名（如 `deepseek-account` 表示 DeepSeek 账号登录），
 *   原样展示。
 * - 耗时：事件日志没有单请求延迟字段，按 `step/start` → `assistant/message`
 *   的 time 差估算（一步 = 一次模型调用 + 它请求的工具执行；含首字等待与
 *   重试，cc-switch latency_ms 同款）。同一步的 start 在用掉后即删除，第二次
 *   尝试不会复用旧起点。
 * - `interrupted: true`（流被取消的前缀）在本机全部会话中从不与 usage 共现
 *   （10742 条计量记录 0 例），计量的都是成功落盘的响应，status 恒为 success。
 * - 日志里没有计费字段（credits），DSH 按账号/API Key 计费，本地不可见。
 */

/** zstd 帧魔数（little-endian 字节序），见 RFC 8878 §3.1。 */
const ZSTD_MAGIC = 0xfd2fb528;

interface DshEventUsage {
  inputTokens?: unknown;
  outputTokens?: unknown;
  totalTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
}

interface DshSource {
  kind?: unknown;
  provider?: unknown;
  model?: unknown;
}

interface DshEvent {
  type?: unknown;
  time?: unknown;
  data?: {
    turn?: unknown;
    step?: unknown;
    interrupted?: unknown;
    usage?: DshEventUsage;
    message?: {
      id?: unknown;
      source?: DshSource;
    };
  };
}

/** TokenUsage 计数字段：非负有限数字才算数（cc-switch token_count 同款，负数/非法值按 0）。 */
function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function finiteTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** step 在事件日志里的键：(turn, step)；缺失字段用同一哨兵值，让 insert/lookup 仍能对上。 */
function stepKey(turn: unknown, step: unknown): string {
  return `${typeof turn === "number" ? turn : "∞"}:${
    typeof step === "number" ? step : "∞"
  }`;
}

/**
 * 按 zstd 帧结构扫描拼接流，返回完整帧的字节区间和可能存在的残缺尾帧起点。
 * 只做结构扫描、不解压：这样才能在不解码的情况下判断「最后一帧是否写完整」。
 * 结构约定（RFC 8878）：帧头（魔数 + descriptor + 可选 FCS/窗口/字典 ID）后是
 * 一串 3 字节块头的块，最后一块带 last 标记，帧尾可选 4 字节校验和。
 */
export function scanZstdFrames(buffer: Buffer): {
  frames: Array<{ start: number; end: number }>;
  tornAt: number | null;
} {
  const frames: Array<{ start: number; end: number }> = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    const torn = () => ({ frames, tornAt: start });
    if (buffer.length - offset < 4) return torn();
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return torn();
    offset += 4;
    if (offset === buffer.length) return torn();

    const descriptor = buffer[offset];
    offset += 1;
    if (descriptor & 0x18) return torn(); // 保留位非零：不是合法帧头
    const contentSizeFlag = descriptor >> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes =
      contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const windowDescriptorBytes = singleSegment ? 0 : 1;
    const remaining =
      windowDescriptorBytes + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remaining) return torn();
    offset += remaining;

    for (;;) {
      if (buffer.length - offset < 3) return torn();
      const header =
        buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
      offset += 3;
      const lastBlock = (header & 1) !== 0;
      const blockType = (header >> 1) & 0x03;
      const blockSize = header >> 3;
      if (blockType === 0x03) return torn(); // 保留块类型：结构损坏
      const payloadBytes = blockType === 0x01 ? 1 : blockSize; // RLE 块载荷固定 1 字节
      if (buffer.length - offset < payloadBytes) return torn();
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return torn();
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames, tornAt: null };
}

/**
 * 逐帧解压 DSH 的拼接 zstd 会话文件：只解完整帧，末尾写了一半的帧忽略；
 * 完整帧解压失败（中间结构损坏）抛错，由调用方按坏文件跳过。
 */
export function decodeZstdFrames(
  buffer: Buffer,
  decompress: (frame: Buffer) => Buffer,
): Buffer {
  const { frames } = scanZstdFrames(buffer);
  const chunks: Buffer[] = [];
  for (const { start, end } of frames) {
    chunks.push(decompress(buffer.subarray(start, end)));
  }
  return Buffer.concat(chunks);
}

/** 只保留末尾带换行的完整行：无换行的最后一行是写了一半的尾巴（DSH scanner 同款规则）。 */
export function completeLines(text: string): string {
  const end = text.lastIndexOf("\n");
  return end === -1 ? "" : text.slice(0, end + 1);
}

/**
 * 项目目录名 → 展示标签。目录名是 DSH `projectKey(cwd)` 的有损编码：
 * `--` + 安全字符（`/ \ :` 折叠成单个 `-`，其余转义成 `~XXXX` 大写十六进制，
 * 去首部连字符、截断到 251 字符）+ `--`；无 cwd 的会话在 `_no-cwd` 目录下。
 */
export function dshProjectLabel(directory: string): string {
  if (directory === "_no-cwd") return "未知项目";
  let inner = directory;
  if (inner.startsWith("--") && inner.endsWith("--") && inner.length > 4) {
    inner = inner.slice(2, -2);
  }
  const decoded = inner.replace(/~([0-9A-Fa-f]{4})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  return getProjectLabel(decoded) || directory;
}

/**
 * 解析一份 DSH 会话日志（已解压的 JSONL 文本）为用量记录。
 * 耗时估算依赖同文件内先行的 `step/start`（跨文件不成立，分叉前缀里也不会
 * 重复出现），找不到起点时 estimatedDurationMs 为 undefined。
 */
export function parseDshSessionLog(
  text: string,
  project: string,
  sessionId: string,
): UsageRecord[] {
  const records: UsageRecord[] = [];
  const stepStarts = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event: DshEvent;
    try {
      event = JSON.parse(line) as DshEvent;
    } catch {
      continue;
    }

    if (event.type === "step/start") {
      const time = finiteTime(event.time);
      if (time !== undefined) {
        stepStarts.set(stepKey(event.data?.turn, event.data?.step), time);
      }
      continue;
    }

    if (event.type !== "assistant/message") continue;
    const data = event.data;
    const usage = data?.usage;
    if (!usage) continue;

    const inputTokens = tokenCount(usage.inputTokens);
    const outputTokens = tokenCount(usage.outputTokens);
    const cacheReadTokens = tokenCount(usage.cacheReadTokens);
    const cacheCreationTokens = tokenCount(usage.cacheWriteTokens);
    if (
      inputTokens === 0 &&
      outputTokens === 0 &&
      cacheReadTokens === 0 &&
      cacheCreationTokens === 0
    ) {
      continue;
    }

    const timestamp = finiteTime(event.time);
    if (timestamp === undefined) continue;

    const totalTokens =
      typeof usage.totalTokens === "number" &&
      Number.isFinite(usage.totalTokens) &&
      usage.totalTokens >= 0
        ? usage.totalTokens
        : inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

    // 按 message id 去重（读取器全局去重）：分叉会话把父会话前缀原样抄进新日志，
    // 同一次模型调用会在多个文件里各出现一次，只应记一次（cc-switch 同款）。
    const messageId =
      nonEmptyString(data?.message?.id) ??
      createHash("sha256").update(line).digest("hex");
    const model = nonEmptyString(data?.message?.source?.model) ?? "未知模型";
    const provider =
      nonEmptyString(data?.message?.source?.provider) ??
      deriveProvider(model, "DeepSeek Harness");

    const key = stepKey(data?.turn, data?.step);
    const stepStart = stepStarts.get(key);
    stepStarts.delete(key);
    const duration =
      stepStart !== undefined && timestamp > stepStart
        ? timestamp - stepStart
        : undefined;

    records.push({
      id: `dsh:${messageId}`,
      requestId: messageId,
      sessionId,
      harness: "dsh",
      project,
      model,
      provider,
      timestamp,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      totalTokens,
      inputTokenSemantics: "fresh",
      hasTokenUsage: totalTokens > 0,
      credits: 0,
      hasCredit: false,
      estimatedDurationMs: duration,
      status: "success",
    });
  }
  return records;
}
