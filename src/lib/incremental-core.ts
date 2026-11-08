import "server-only";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { HarnessId, HarnessUsage, UsageRecord } from "@/lib/usage";
import type {
  UsageIncrementalCommit,
  UsageSessionLogState,
} from "@/lib/usage-store";

/** 游标前尾部指纹字节数；同尺寸或前部重写靠它识别（与 DSH/M3 同款）。 */
export const TAIL_FINGERPRINT_BYTES = 64;

/**
 * Claude 回看窗口字节数：续读前重解析游标前这段内容以重建对话链与块计时
 * （cc-switch CHAIN_SEED_BYTES 同款量级）。窗口外的请求起点不可见，宁可不
 * 估算耗时也不持久化整份链表。
 */
export const CLAUDE_LOOKBACK_BYTES = 256 * 1024;

export interface IncrementalFileBase {
  filePath: string;
  size: number;
  mtimeMs: number;
}

export interface IncrementalStats {
  /** 新增正文（追加区间或整读文件本体）读取的字节数。 */
  bodyBytesRead: number;
  /** 指纹校验与回看窗口读取的字节数。 */
  verificationBytesRead: number;
  /** 回看窗口字节数（仅带链上下文的来源如 Claude；含在 verification 内）。 */
  lookbackBytesRead?: number;
  fullFilesRead: number;
  incrementalFilesRead: number;
  unchangedFiles: number;
  rebuilds: number;
}

export interface IncrementalUsageResult {
  usage: HarnessUsage;
  transaction: UsageIncrementalCommit;
  stats: IncrementalStats;
}

export function emptyIncrementalStats(): IncrementalStats {
  return {
    bodyBytesRead: 0,
    verificationBytesRead: 0,
    lookbackBytesRead: 0,
    fullFilesRead: 0,
    incrementalFilesRead: 0,
    unchangedFiles: 0,
    rebuilds: 0,
  };
}

export function fingerprintAt(buffer: Buffer, end: number): string {
  const start = Math.max(0, end - TAIL_FINGERPRINT_BYTES);
  return createHash("sha256").update(buffer.subarray(start, end)).digest("hex");
}

export async function readRange(
  filePath: string,
  start: number,
  end: number,
): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    if (bytesRead !== buffer.length) throw new Error("文件在增量读取期间发生截断");
    return buffer;
  } finally {
    await handle.close();
  }
}

/** 最后一个完整 LF 行结束（含 LF）的字节偏移；半行留给下一轮。 */
export function lastCompleteLineEnd(buffer: Buffer): number {
  return buffer.lastIndexOf(0x0a) + 1;
}

export function sessionLogState(
  harness: HarnessId,
  file: IncrementalFileBase,
  cursorOffset: number,
  parserStateJson: string | null,
  tailFingerprint: string | null,
): UsageSessionLogState {
  return {
    harness,
    filePath: file.filePath,
    fileSize: file.size,
    mtimeMs: file.mtimeMs,
    cursorOffset,
    parserStateJson,
    tailFingerprint,
    lastError: null,
    updatedAt: 0,
  };
}

/** 所有字节游标来源共用的结构校验；parser state 语义由各 reader 自行解码。 */
export function validCursorShape(state: UsageSessionLogState): boolean {
  return (
    Number.isSafeInteger(state.fileSize) &&
    Number.isSafeInteger(state.cursorOffset) &&
    state.fileSize >= 0 &&
    state.cursorOffset >= 0 &&
    state.cursorOffset <= state.fileSize &&
    Number.isFinite(state.mtimeMs) &&
    state.tailFingerprint !== null
  );
}

/** 与旧 reader 一致的记录排序：时间倒序，id 兜底保证跨轮确定性。 */
export function sortUsageRecords(records: UsageRecord[]): UsageRecord[] {
  records.sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
  return records;
}

/**
 * 按 UsageStore.readNormalizedRecords 的固定键序重建记录。codebuddy /
 * workbuddy 的 parser 在 status 之后追加 estimatedDurationMs，与 DB 读回
 * 键序不同；增量轮的记录一半来自 DB、一半来自 parser，不规范化会导致
 * 内容哈希跨轮漂移（假 changed）。DB 读回的记录本身已是该键序。
 */
export function canonicalRecord(record: UsageRecord): UsageRecord {
  return {
    id: record.id,
    requestId: record.requestId,
    sessionId: record.sessionId,
    harness: record.harness,
    project: record.project,
    model: record.model,
    provider: record.provider,
    timestamp: record.timestamp,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheReadTokens: record.cacheReadTokens,
    cacheCreationTokens: record.cacheCreationTokens,
    totalTokens: record.totalTokens,
    inputTokenSemantics: record.inputTokenSemantics,
    hasTokenUsage: record.hasTokenUsage,
    credits: record.credits,
    hasCredit: record.hasCredit,
    ...(record.reportedCredits === undefined
      ? {}
      : { reportedCredits: record.reportedCredits }),
    ...(record.billable === undefined ? {} : { billable: record.billable }),
    ...(record.contextUsageRatio === undefined
      ? {}
      : { contextUsageRatio: record.contextUsageRatio }),
    ...(record.estimatedDurationMs === undefined
      ? {}
      : { estimatedDurationMs: record.estimatedDurationMs }),
    status: record.status,
  };
}

/** 逐字段比较；两侧都应是 canonicalRecord / DB 读回的规范键序。 */
export function sameUsageRecord(a: UsageRecord, b: UsageRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
