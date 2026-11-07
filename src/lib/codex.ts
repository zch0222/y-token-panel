import "server-only";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  codexEventsToRecords,
  codexParentSignaturesBefore,
  codexThreadIdFromFilename,
  codexTimelineFromParsed,
  extractCodexCounters,
  leadingCodexThreadIdFromFilename,
  logicalCodexFileName,
  matchingCodexReplayPrefix,
  parseCodexRollout,
  type CodexParentTimeline,
  type CodexRolloutMeta,
  type CodexTokenUsage,
  type ParsedCodexRollout,
  type TokenCountersDelta,
} from "@/lib/codex-session";
import type { HarnessUsage, UsageRecord } from "@/lib/usage";

/**
 * 读取 Codex / ChatGPT 的本地 rollout 会话记录。默认数据目录 ~/.codex（Codex
 * 自身的 CODEX_HOME 环境变量可替换，本机 codex.exe 二进制确认），其下
 * sessions/YYYY/MM/DD/rollout-*.jsonl（7 天不动会被压成 .jsonl.zst）与
 * archived_sessions/。字段语义与解析口径见 src/lib/codex-session.ts 文件头；
 * 跨文件去重与 fork 重放剔除的编排对齐 cc-switch 的
 * sync_codex_usage / resolve_parent_signatures：
 *
 * - 同一逻辑文件名的 .jsonl 与 .jsonl.zst 并存（压缩/解压瞬间）只读普通形态。
 * - 记录 id = codex:<文件名尾部 rollout UUID>:<行 ordinal>:<事件序号>，重扫
 *   结果稳定；thread/revert 的替换 rollout 有新的尾部 UUID，不会互相覆盖。
 * - 有显式父线程的文件先取父时间线 fork 时刻前的签名序列，子事件序列按序
 *   匹配上的前缀是复制来的父事件，跳过；父缺失或没写到 fork 时刻时整个文件
 *   不计入（宁可少算不双算，cc-switch deferred 同款）。
 */

const zstdDecompress: ((buffer: Buffer) => Buffer) | undefined =
  typeof zlib.zstdDecompressSync === "function"
    ? (buffer) => zlib.zstdDecompressSync(buffer)
    : undefined;

function isRolloutFileName(fileName: string): boolean {
  return fileName.endsWith(".jsonl") || fileName.endsWith(".jsonl.zst");
}

async function collectRolloutFiles(
  directory: string,
  maxDepth: number,
): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory() && maxDepth > 0) {
      files.push(...(await collectRolloutFiles(entryPath, maxDepth - 1)));
    } else if (entry.isFile() && isRolloutFileName(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

/** 同一逻辑名的两种形态并存时只留普通形态（Codex 正在写的那份，内容不少于压缩份）。 */
function dedupeSiblingForms(files: string[]): string[] {
  const plain = new Set(
    files
      .filter((file) => !file.endsWith(".jsonl.zst"))
      .map((file) => file.toLowerCase()),
  );
  return files.filter((file) => {
    if (!file.endsWith(".jsonl.zst")) return true;
    return !plain.has(file.slice(0, -".zst".length).toLowerCase());
  });
}

async function readRolloutContent(filePath: string): Promise<string | undefined> {
  try {
    const buffer = await readFile(filePath);
    const content = filePath.endsWith(".jsonl.zst")
      ? zstdDecompress?.(buffer) ?? buffer
      : buffer;
    return content.toString("utf8");
  } catch {
    return undefined;
  }
}

interface RolloutFileEntry {
  path: string;
  fileName: string;
  threadId?: string;
  leadingThreadId?: string;
  content?: string;
  parsed?: ParsedCodexRollout;
}

export async function readCodexUsage(): Promise<HarnessUsage> {
  const root = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(homedir(), ".codex");
  const source = root;

  let scannedFiles = 0;
  let skippedFiles = 0;

  // sessions 目录不存在视为来源不可用；archived_sessions 是可选的平铺归档目录。
  try {
    await stat(path.join(root, "sessions"));
  } catch {
    return {
      harness: "codex",
      records: [],
      scannedFiles: 0,
      skippedFiles: 0,
      source,
      sourceAvailable: false,
    };
  }

  const files = dedupeSiblingForms(
    (
      await Promise.all([
        collectRolloutFiles(path.join(root, "sessions"), 3),
        collectRolloutFiles(path.join(root, "archived_sessions"), 0),
      ])
    )
      .flat()
      .sort((a, b) => a.localeCompare(b)),
  );

  // 线程 UUID → 候选文件（尾部 UUID 与双段文件名的前置 UUID 都登记，cc-switch
  // build_rollout_index 同款），按逻辑文件名排序（日期前缀即时间序）。
  const index = new Map<string, RolloutFileEntry[]>();
  const entries: RolloutFileEntry[] = files.map((filePath) => {
    const fileName = path.basename(filePath);
    return {
      path: filePath,
      fileName,
      threadId: codexThreadIdFromFilename(fileName),
      leadingThreadId: leadingCodexThreadIdFromFilename(fileName),
    };
  });
  for (const entry of entries) {
    for (const id of [entry.threadId, entry.leadingThreadId]) {
      if (!id) continue;
      const list = index.get(id) ?? [];
      list.push(entry);
      index.set(id, list);
    }
  }
  for (const list of index.values()) {
    list.sort((a, b) =>
      logicalCodexFileName(a.fileName).localeCompare(logicalCodexFileName(b.fileName)),
    );
  }

  // 先统一读完（父时间线/续写基线的按需解析是同步的，内容必须先在内存）。
  for (const entry of entries) {
    scannedFiles += 1;
    const content = await readRolloutContent(entry.path);
    if (content === undefined) {
      skippedFiles += 1;
      continue;
    }
    entry.content = content;
  }

  const records: UsageRecord[] = [];
  const seen = new Set<string>();
  const parsing = new Set<string>();

  /** 解析单个文件（带环保护）：元数据不一致等完整性错误按不可计费处理。 */
  function parseEntry(entry: RolloutFileEntry): ParsedCodexRollout | undefined {
    if (entry.parsed) return entry.parsed;
    if (entry.content === undefined || parsing.has(entry.path)) return undefined;
    parsing.add(entry.path);
    try {
      entry.parsed = parseCodexRollout(entry.content, {
        filenameThreadId: entry.threadId,
        filenameLeadingThreadId: entry.leadingThreadId,
        resolveContinuationBaseline: (meta) =>
          resolveContinuationBaseline(entry, meta),
      });
      return entry.parsed;
    } catch {
      return undefined;
    } finally {
      parsing.delete(entry.path);
    }
  }

  /**
   * 续写页首条只有累计的 token_count 时，取前序分段（文件名更早的同线程候选）
   * 的高水位做基线，否则继承来的累计值会被当成一次请求。前序分段是正在解析
   * 的环时跳过该候选；带 history_base 却找不到前序分段时返回 "missing-parent"
   *（cc-switch 同款：防御性暂缓导入）。
   */
  function resolveContinuationBaseline(
    entry: RolloutFileEntry,
    meta: CodexRolloutMeta,
  ): CodexTokenUsage | undefined | "missing-parent" {
    const currentName = logicalCodexFileName(entry.fileName);
    const findBaseline = (threadId: string | undefined): CodexTokenUsage | undefined => {
      if (!threadId) return undefined;
      for (const candidate of [...(index.get(threadId) ?? [])].reverse()) {
        if (
          logicalCodexFileName(candidate.fileName).localeCompare(currentName) >= 0 ||
          candidate === entry ||
          parsing.has(candidate.path)
        ) {
          continue;
        }
        const parsed = parseEntry(candidate);
        if (parsed?.highWater) return parsed.highWater;
      }
      return undefined;
    };
    const own = findBaseline(meta.threadId);
    if (own) return own;
    if (meta.historyBaseThreadId && meta.historyBaseThreadId !== meta.threadId) {
      const inherited = findBaseline(meta.historyBaseThreadId);
      if (inherited) return inherited;
    }
    if (meta.historyBaseThreadId) return "missing-parent";
    return undefined;
  }

  /**
   * 父线程 fork 时刻前的签名序列（cc-switch resolve_parent_signatures）：
   * 同一线程可能有多个文件——同一 rollout 的副本（sessions 与 archived 各一份）
   * 必须 cutoff 前一致；翻页/续写页按文件名时间序拼成一条时间线。对不上或父
   * 没写到 fork 时刻返回 null，调用方弃用子文件（宁可少算不双算）。
   */
  function resolveParentSignatures(
    parentThreadId: string,
    cutoffMs: number,
  ): string[] | null {
    const candidates = index.get(parentThreadId);
    if (!candidates || candidates.length === 0) return null;

    const merged: CodexParentTimeline = {
      events: [],
      hasTokenWithoutTimestamp: false,
      maxLineTimestampMs: undefined,
    };
    const segments = new Map<
      string,
      { timeline: CodexParentTimeline; maxTimestamp?: number }
    >();
    for (const candidate of candidates) {
      const parsed = parseEntry(candidate);
      if (!parsed) return null;
      const timeline = codexTimelineFromParsed(parsed);
      merged.hasTokenWithoutTimestamp ||= timeline.hasTokenWithoutTimestamp;
      const rolloutId = candidate.threadId ?? candidate.fileName;
      const segment = segments.get(rolloutId);
      if (segment) {
        const before = codexParentSignaturesBefore(segment.timeline, cutoffMs);
        const current = codexParentSignaturesBefore(timeline, cutoffMs);
        if (
          before === null ||
          current === null ||
          before.join("\n") !== current.join("\n")
        ) {
          return null;
        }
        // 同一 rollout 的每份副本都必须写到 fork 时刻：取各副本中最早的末尾。
        segment.maxTimestamp =
          segment.maxTimestamp === undefined || timeline.maxLineTimestampMs === undefined
            ? undefined
            : Math.min(segment.maxTimestamp, timeline.maxLineTimestampMs);
        continue;
      }
      merged.events.push(...timeline.events);
      segments.set(rolloutId, {
        timeline,
        maxTimestamp: timeline.maxLineTimestampMs,
      });
    }
    for (const segment of segments.values()) {
      if (segment.maxTimestamp === undefined) continue;
      merged.maxLineTimestampMs = Math.max(
        merged.maxLineTimestampMs ?? -Infinity,
        segment.maxTimestamp,
      );
    }
    return codexParentSignaturesBefore(merged, cutoffMs);
  }

  /**
   * bounded 引用 fork 的验证（cc-switch verified_bounded_fork）：history_base
   * 指向父 rollout 的一个物理字节区间，且区间末尾的累计计数器恰等于子文件
   * 首事件 total − last 时，子文件只记自己的请求，无需父时间线推进到 fork
   * 时刻（翻页父线程已结束、永不推进的场景靠它导入）。
   */
  function verifiedBoundedFork(parsed: ParsedCodexRollout): boolean {
    const parentThreadId = parsed.meta.parentThreadId;
    if (!parentThreadId) return false;
    const base = parsed.meta.historyBase;
    if (!base || base.threadId !== parentThreadId) return false;
    const end = base.endByteOffset;
    const count = base.endOrdinalExclusive;
    if (
      end === undefined || end <= 0 || end > 64 * 1024 * 1024 ||
      count === undefined || count <= 0
    ) {
      return false;
    }
    if (parsed.meta.rootTimestampMs === undefined) return false;
    const baseline = parsed.boundedFork.baseline;
    if (!baseline || !parsed.boundedFork.eventsQualify) return false;
    if (parsed.tokenEvents.length === 0) return false;

    const countersEqual = (left: TokenCountersDelta, right: TokenCountersDelta) =>
      left.input === right.input &&
      left.cached === right.cached &&
      left.output === right.output &&
      left.reasoning === right.reasoning &&
      left.total === right.total;

    let found = false;
    for (const candidate of index.get(parentThreadId) ?? []) {
      // 引用指向一个物理 rollout（文件名尾部 UUID），不是该线程的所有分段
      if (candidate.threadId !== parentThreadId) continue;
      const content = candidate.content;
      const candidateParsed = candidate.parsed ?? parseEntry(candidate);
      if (content === undefined || !candidateParsed) return false;
      let used = 0;
      let previousOrdinal: number | undefined;
      let firstRecord = true;
      let parentTotal: TokenCountersDelta | null = null;
      for (const recordLine of content.split("\n")) {
        if (used >= end) break;
        // 字节窗口按 UTF-8 计（正文含中文），行尾 \n 计 1 字节
        const lineBytes = Buffer.byteLength(recordLine, "utf8") + 1;
        if (used + lineBytes > end) return false;
        used += lineBytes;
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(recordLine) as Record<string, unknown>;
        } catch {
          return false;
        }
        const rawOrdinal = record.ordinal;
        const ordinal =
          typeof rawOrdinal === "number" && Number.isInteger(rawOrdinal)
            ? rawOrdinal
            : undefined;
        if (ordinal === undefined) return false;
        if (firstRecord) {
          const inherited = candidateParsed.meta.historyBase?.endOrdinalExclusive ?? 0;
          const payload = record.payload as { id?: unknown } | undefined;
          if (
            ordinal !== inherited ||
            record.type !== "session_meta" ||
            payload?.id !== parentThreadId
          ) {
            return false;
          }
          firstRecord = false;
        } else if (previousOrdinal === undefined || ordinal !== previousOrdinal + 1) {
          return false;
        }
        previousOrdinal = ordinal;
        if (record.type === "event_msg") {
          const payload = record.payload as
            | { type?: unknown; info?: { total_token_usage?: unknown } }
            | undefined;
          if (payload?.type === "token_count" && payload.info) {
            const counters = extractCodexCounters(payload.info.total_token_usage);
            if (counters) parentTotal = counters;
          }
        }
      }
      if (used !== end || previousOrdinal === undefined || previousOrdinal + 1 !== count) {
        return false;
      }
      if (!parentTotal || !countersEqual(parentTotal, baseline)) return false;
      found = true;
    }
    return found;
  }

  for (const entry of entries) {
    const parsed = parseEntry(entry);
    if (!parsed) {
      if (entry.content !== undefined) skippedFiles += 1;
      continue;
    }
    if (!parsed.hasBillableTokens) continue;
    const rolloutId = entry.threadId;
    if (!rolloutId || !parsed.rootMetaSeen) {
      // 有计费 token 却没有文件名 UUID / session_meta：身份不可信，弃用整份。
      skippedFiles += 1;
      continue;
    }
    const sessionId = parsed.meta.threadId ?? rolloutId;

    let replayPrefix = 0;
    const parentThreadId = parsed.meta.parentThreadId;
    if (parentThreadId && !verifiedBoundedFork(parsed)) {
      if (parsed.meta.rootTimestampMs === undefined) {
        skippedFiles += 1;
        continue;
      }
      const signatures = resolveParentSignatures(
        parentThreadId,
        parsed.meta.rootTimestampMs,
      );
      if (!signatures) {
        skippedFiles += 1;
        continue;
      }
      replayPrefix = matchingCodexReplayPrefix(parsed.tokenEvents, signatures);
    }

    for (const record of codexEventsToRecords(parsed.tokenEvents.slice(replayPrefix), {
      rolloutId,
      sessionId,
    })) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      records.push(record);
    }
    // token_usage_record 兜底补记不经过重放剔除（cc-switch 同款：重放不含它）。
    for (const record of codexEventsToRecords(parsed.usageRecordEvents, {
      rolloutId,
      sessionId,
    })) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      records.push(record);
    }
  }

  records.sort((a, b) => b.timestamp - a.timestamp);
  return {
    harness: "codex",
    records,
    scannedFiles,
    skippedFiles,
    source,
    sourceAvailable: true,
  };
}
