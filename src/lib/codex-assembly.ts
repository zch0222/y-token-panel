import "server-only";
import {
  codexEventsToRecords,
  codexParentSignaturesBefore,
  codexTimelineFromParsed,
  extractCodexCounters,
  logicalCodexFileName,
  matchingCodexReplayPrefix,
  parseCodexRollout,
  type CodexParentTimeline,
  type CodexRolloutMeta,
  type ParsedCodexRollout,
  type TokenCountersDelta,
} from "@/lib/codex-session";
import type { UsageRecord } from "@/lib/usage";

/**
 * Codex rollout 的跨文件编排（线程索引、续写基线、父时间线、bounded 引用
 * fork 验证与重放前缀剔除）。原实现内联在 readCodexUsage 里；M5 抽成独立
 * 类，供全量 reader 与依赖缓存增量 reader 共用同一套语义，保证两种路径
 * 在相同文件集上产出逐字段一致的结果。
 *
 * 编排规则（与 cc-switch sync_codex_usage 对齐，详见 src/lib/codex.ts 头注）：
 * - 候选按逻辑文件名排序（日期前缀即时间序），续写基线取更早分段的高水位。
 * - 同一 rollout 的多份副本（sessions 与 archived）在 fork 时刻前必须一致，
 *   且每份都要写到 fork 时刻；对不上返回 null，调用方弃用子文件。
 * - 解析失败 / 身份不可信 / 父依赖不可判定都按「宁可少算不双算」整份弃用。
 *
 * 增量 reader 通过 caches 提供未加载正文文件的派生缓存（父时间线、累计
 * 高水位）；本轮已加载正文的文件永远走现场解析，缓存不会覆盖新内容。
 */

export interface CodexRolloutEntry {
  path: string;
  fileName: string;
  threadId?: string;
  leadingThreadId?: string;
  /** 已加载的解压正文；undefined 表示本轮未加载（增量轮的未变化文件）。 */
  content?: string;
  /** 解析结果缓存（解析一次，父/子双向引用复用）。 */
  parsed?: ParsedCodexRollout;
}

export type CodexFileOutcome =
  /** 计费事件已入账（含零计费记录的合法文件）。 */
  | "imported"
  /** 无计费 token，合法跳过。 */
  | "no-billable"
  /** 父依赖暂不可判定，本轮弃用；依赖变化后应重试。 */
  | "deferred"
  /** 身份不可信（无文件名 UUID / 无 session_meta / 无 root timestamp），弃用。 */
  | "untrusted"
  /** 解析完整性错误或读取失败。 */
  | "unparsable";

export interface CodexDeferredInfo {
  reason: string;
  /** deferred 依赖的父线程 ID；用于增量轮记录父候选文件戳。 */
  parentThreadId?: string;
}

export interface CodexEntryAssembly {
  outcome: CodexFileOutcome;
  records: UsageRecord[];
  deferred?: CodexDeferredInfo;
}

export interface CodexAssemblyCaches {
  /** 未加载正文文件的父时间线缓存；返回 undefined 表示无缓存。 */
  timelineFor(entry: CodexRolloutEntry): CodexParentTimeline | undefined;
  /** 未加载正文文件的累计高水位缓存（续写基线）。 */
  highWaterFor(entry: CodexRolloutEntry): ParsedCodexRollout["highWater"];
}

export const CODEX_DEFER_PARENT_REASON = "父线程时间线缺失或未写到 fork 时刻";

export class CodexAssembly {
  readonly entries: CodexRolloutEntry[];
  /** 线程 UUID → 候选文件（尾部 UUID 与双段文件名的前置 UUID 都登记）。 */
  readonly index: Map<string, CodexRolloutEntry[]>;
  private readonly caches?: CodexAssemblyCaches;
  private readonly parsing = new Set<string>();

  constructor(entries: CodexRolloutEntry[], caches?: CodexAssemblyCaches) {
    this.entries = entries;
    this.caches = caches;
    const index = new Map<string, CodexRolloutEntry[]>();
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
    this.index = index;
  }

  /** 解析单个文件（带环保护）：元数据不一致等完整性错误按不可计费处理。 */
  parseEntry(entry: CodexRolloutEntry): ParsedCodexRollout | undefined {
    if (entry.parsed) return entry.parsed;
    if (entry.content === undefined || this.parsing.has(entry.path)) return undefined;
    this.parsing.add(entry.path);
    try {
      entry.parsed = parseCodexRollout(entry.content, {
        filenameThreadId: entry.threadId,
        filenameLeadingThreadId: entry.leadingThreadId,
        resolveContinuationBaseline: (meta) =>
          this.resolveContinuationBaseline(entry, meta),
      });
      return entry.parsed;
    } catch {
      return undefined;
    } finally {
      this.parsing.delete(entry.path);
    }
  }

  /** 已加载正文的文件现场解析出时间线；未加载的查缓存。 */
  private timelineOf(entry: CodexRolloutEntry): CodexParentTimeline | undefined {
    if (entry.content !== undefined) {
      const parsed = this.parseEntry(entry);
      return parsed ? codexTimelineFromParsed(parsed) : undefined;
    }
    return this.caches?.timelineFor(entry);
  }

  /**
   * 续写页首条只有累计的 token_count 时，取前序分段（文件名更早的同线程候选）
   * 的高水位做基线，否则继承来的累计值会被当成一次请求。前序分段是正在解析
   * 的环时跳过该候选；带 history_base 却找不到前序分段时返回 "missing-parent"
   *（cc-switch 同款：防御性暂缓导入）。
   */
  private resolveContinuationBaseline(
    entry: CodexRolloutEntry,
    meta: CodexRolloutMeta,
  ): ParsedCodexRollout["highWater"] | undefined | "missing-parent" {
    const currentName = logicalCodexFileName(entry.fileName);
    const findBaseline = (
      threadId: string | undefined,
    ): ParsedCodexRollout["highWater"] => {
      if (!threadId) return undefined;
      for (const candidate of [...(this.index.get(threadId) ?? [])].reverse()) {
        if (
          logicalCodexFileName(candidate.fileName).localeCompare(currentName) >= 0 ||
          candidate === entry ||
          this.parsing.has(candidate.path)
        ) {
          continue;
        }
        // 本轮加载了正文的候选现场解析（内容可能已变化，缓存不作数）；
        // 未加载的候选用持久化的高水位缓存。
        const highWater =
          candidate.content !== undefined
            ? this.parseEntry(candidate)?.highWater
            : this.caches?.highWaterFor(candidate);
        if (highWater) return highWater;
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
  resolveParentSignatures(
    parentThreadId: string,
    cutoffMs: number,
  ): string[] | null {
    const candidates = this.index.get(parentThreadId);
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
      const timeline = this.timelineOf(candidate);
      if (!timeline) return null;
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
   * 时刻（翻页父线程已结束、永不推进的场景靠它导入）。需要父文件正文；增量
   * 轮未加载正文的父候选返回 false，由调用方决定是否回退重放路径。
   */
  verifiedBoundedFork(parsed: ParsedCodexRollout): boolean {
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
    for (const candidate of this.index.get(parentThreadId) ?? []) {
      // 引用指向一个物理 rollout（文件名尾部 UUID），不是该线程的所有分段
      if (candidate.threadId !== parentThreadId) continue;
      const content = candidate.content;
      const candidateParsed = candidate.parsed ?? this.parseEntry(candidate);
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

  /**
   * 组装单个文件的记录（全局 seen 以文件序 first-wins）。skippedFiles 计数
   * 由调用方按 outcome 决定：imported / no-billable 不计，其余计 1。
   */
  assembleEntry(entry: CodexRolloutEntry, seen: Set<string>): CodexEntryAssembly {
    const parsed = this.parseEntry(entry);
    if (!parsed) {
      return {
        outcome: "unparsable",
        records: [],
        deferred: { reason: "解析完整性错误或正文不可读" },
      };
    }
    if (!parsed.hasBillableTokens) return { outcome: "no-billable", records: [] };
    const rolloutId = entry.threadId;
    if (!rolloutId || !parsed.rootMetaSeen) {
      // 有计费 token 却没有文件名 UUID / session_meta：身份不可信，弃用整份。
      return {
        outcome: "untrusted",
        records: [],
        deferred: { reason: "含计费 token 但缺少文件名 UUID 或 session_meta" },
      };
    }
    const sessionId = parsed.meta.threadId ?? rolloutId;

    let replayPrefix = 0;
    const parentThreadId = parsed.meta.parentThreadId;
    if (parentThreadId && !this.verifiedBoundedFork(parsed)) {
      if (parsed.meta.rootTimestampMs === undefined) {
        return {
          outcome: "untrusted",
          records: [],
          deferred: { reason: "parented rollout 的 root meta 缺少有效 timestamp" },
        };
      }
      const signatures = this.resolveParentSignatures(
        parentThreadId,
        parsed.meta.rootTimestampMs,
      );
      if (!signatures) {
        return {
          outcome: "deferred",
          records: [],
          deferred: {
            reason: CODEX_DEFER_PARENT_REASON,
            parentThreadId,
          },
        };
      }
      replayPrefix = matchingCodexReplayPrefix(parsed.tokenEvents, signatures);
    }

    const records: UsageRecord[] = [];
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
    return { outcome: "imported", records };
  }
}
