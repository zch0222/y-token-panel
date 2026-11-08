import "server-only";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  canonicalRecord,
  emptyIncrementalStats,
  FILE_IO_CONCURRENCY,
  fingerprintAt,
  mapBounded,
  readRange,
  sessionLogState,
  sortUsageRecords,
  TAIL_FINGERPRINT_BYTES,
  validCursorShape,
  type IncrementalStats,
  type IncrementalUsageResult,
} from "@/lib/incremental-core";
import {
  codexTimelineFromParsed,
  type CodexParentTimeline,
  type CodexTokenUsage,
} from "@/lib/codex-session";
import {
  CodexAssembly,
  type CodexEntryAssembly,
  type CodexFileOutcome,
  type CodexRolloutEntry,
} from "@/lib/codex-assembly";
import {
  codexEntryOf,
  codexRoot,
  discoverCodexRolloutFiles,
  readCodexRolloutContent,
  type CodexDiscoveredFile,
  type CodexRolloutContent,
} from "@/lib/codex";
import type { HarnessUsage, UsageRecord } from "@/lib/usage";
import type {
  UsageIncrementalCommit,
  UsageSessionLogState,
  UsageStore,
} from "@/lib/usage-store";

/**
 * Codex 依赖缓存增量（M5）。变化文件从头解析（不套用普通字节续读——fork
 * 重放、续写基线和 bounded 引用都依赖跨文件状态），但把「解析后的派生物」
 * 持久化到 session_log_sync.parser_state_json，供后续轮次零读取复用：
 *
 * - 父时间线（fork 时刻前的签名序列）：被引用为父线程的文件才缓存，多个
 *   fork 共享；事件数超过上限的文件不缓存，回退按需整读。
 * - 累计高水位（续写页基线）：所有文件都缓存（很小）。
 * - replay prefix 不单独缓存：子文件未变化时其记录直接来自归一化库，
 *   变化时用父时间线现算（内存操作，成本可忽略）。
 * - deferred 原因与父候选文件戳（path/size/mtime）：父文件追加或替换后
 *   戳变化，未变化的 deferred 子文件重新尝试导入；父候选集合不变则零读取
 *   跳过（cc-switch PendingEntry 同款，不做永久 mtime 跳过）。
 *
 * 文件身份戳：Node.js 的 stat 在 Windows 上不提供 volume/file id（dev=0、
 * ino=undefined），跨平台可移植的身份只有 size + mtime；再叠加游标前 64B
 * 尾部指纹识别同尺寸/前缀重写（与 M3/M4 相同防御边界）。父文件替换（size
 * 或 mtime 变化）即重新加载正文与时间线，旧时间线不复用。
 *
 * 缓存版本：CODEX_STATE_VERSION 不匹配的 parser_state 一律来源级重建；
 * 需要强制重建时删除该 harness 的 session_log_sync 行（或提升版本号）。
 * 缓存生命周期与文件一一对应（每文件一行），来源级重建时整表重写，不随
 * 历史无限增长。
 */

const CODEX_STATE_VERSION = 1;
/** 父时间线缓存的事件数上限：超限文件回退按需整读，防止单文件缓存过大。 */
const MAX_TIMELINE_CACHE_EVENTS = 20_000;

type CodexOutcomeState = CodexFileOutcome | "read-failed";

interface CodexTimelineState {
  ts: number[];
  sig: string[];
  noTs: boolean;
  maxTs: number | null;
}

interface CodexDeferState {
  reason: string;
  /** deferred 依赖的父线程；重试时按 index 重取候选文件戳对比。 */
  parentThreadId?: string;
  /** 记录时的依赖候选 (path,size,mtime) 列表；变化即重试。 */
  parentStamps?: Array<[string, number, number]>;
}

interface CodexFileState {
  v: number;
  outcome: CodexOutcomeState;
  /** 解析出的 meta 摘要（unparsable/read-failed 时为 null）。 */
  meta: { threadId?: string; parentThreadId?: string } | null;
  highWater: CodexTokenUsage | null;
  timeline: CodexTimelineState | null;
  defer: CodexDeferState | null;
}

const CODEX_OUTCOMES = new Set<string>([
  "imported",
  "no-billable",
  "deferred",
  "untrusted",
  "unparsable",
  "read-failed",
]);

function decodeCodexFileState(json: string | null): CodexFileState | null {
  if (json === null) return null;
  try {
    const value = JSON.parse(json) as Partial<CodexFileState>;
    if (
      value === null ||
      typeof value !== "object" ||
      value.v !== CODEX_STATE_VERSION ||
      typeof value.outcome !== "string" ||
      !CODEX_OUTCOMES.has(value.outcome) ||
      (value.meta !== null && typeof value.meta !== "object") ||
      (value.defer !== null && typeof value.defer !== "object")
    ) {
      return null;
    }
    return value as CodexFileState;
  } catch {
    return null;
  }
}

function timelineFromState(state: CodexTimelineState): CodexParentTimeline {
  return {
    events: state.ts.map((timestampMs, index) => ({
      timestampMs,
      signatureKey: state.sig[index]!,
    })),
    hasTokenWithoutTimestamp: state.noTs,
    maxLineTimestampMs: state.maxTs ?? undefined,
  };
}

function timelineToState(timeline: CodexParentTimeline): CodexTimelineState {
  return {
    ts: timeline.events.map((event) => event.timestampMs),
    sig: timeline.events.map((event) => event.signatureKey),
    noTs: timeline.hasTokenWithoutTimestamp,
    maxTs: timeline.maxLineTimestampMs ?? null,
  };
}

function result(
  discovery: { source: string; files: CodexDiscoveredFile[]; skippedFiles: number },
  records: UsageRecord[],
  skippedFiles: number,
  cursors: UsageSessionLogState[],
  reset: boolean,
  stats: IncrementalStats,
): IncrementalUsageResult {
  sortUsageRecords(records);
  const usage: HarnessUsage = {
    harness: "codex",
    records,
    scannedFiles: discovery.files.length + discovery.skippedFiles,
    skippedFiles,
    source: discovery.source,
    sourceAvailable: true,
  };
  const transaction: UsageIncrementalCommit = {
    harness: "codex",
    resetCursors: reset,
    resetDedup: reset,
    cursors,
  };
  return { usage, transaction, stats };
}

export async function readCodexUsageIncremental(store: UsageStore): Promise<IncrementalUsageResult> {
  const root = codexRoot();
  const stats = emptyIncrementalStats();

  // sessions 目录不存在视为来源不可用（与全量 reader 同语义）。
  try {
    await stat(path.join(root, "sessions"));
  } catch {
    return {
      usage: {
        harness: "codex",
        records: [],
        scannedFiles: 0,
        skippedFiles: 0,
        source: root,
        sourceAvailable: false,
      },
      transaction: { harness: "codex", resetCursors: true, resetDedup: true, cursors: [] },
      stats,
    };
  }

  const discovery = await discoverCodexRolloutFiles();
  const entries = discovery.files.map(codexEntryOf);
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const fileByPath = new Map(discovery.files.map((file) => [file.filePath, file]));

  // 变化文件（含读取失败）的持久缓存一律作废：内容可能已改写。
  const cacheExcluded = new Set<string>();
  const decodedByPath = new Map<string, CodexFileState | null>();
  const caches = {
    timelineFor: (entry: CodexRolloutEntry): CodexParentTimeline | undefined => {
      if (cacheExcluded.has(entry.path)) return undefined;
      const state = decodedByPath.get(entry.path);
      return state?.timeline ? timelineFromState(state.timeline) : undefined;
    },
    highWaterFor: (entry: CodexRolloutEntry): CodexTokenUsage | undefined => {
      if (cacheExcluded.has(entry.path)) return undefined;
      return decodedByPath.get(entry.path)?.highWater ?? undefined;
    },
  };
  const assembly = new CodexAssembly(entries, caches);

  const stampsOf = (threadId?: string): Array<[string, number, number]> => {
    if (!threadId) return [];
    return (assembly.index.get(threadId) ?? [])
      .map((entry) => fileByPath.get(entry.path))
      .filter((file): file is CodexDiscoveredFile => file !== undefined)
      .map((file) => [file.filePath, file.size, file.mtimeMs] as [string, number, number]);
  };
  const siblingStamps = (entry: CodexRolloutEntry): Array<[string, number, number]> =>
    [...stampsOf(entry.threadId), ...stampsOf(entry.leadingThreadId)].filter(
      ([filePath]) => filePath !== entry.path,
    );
  const stampsDiffer = (
    left: Array<[string, number, number]> | undefined,
    right: Array<[string, number, number]> | undefined,
  ): boolean => {
    if (!left || !right) return true;
    return (
      left.length !== right.length ||
      left.some(
        ([path, size, mtimeMs], index) =>
          path !== right[index]![0] || size !== right[index]![1] || mtimeMs !== right[index]![2],
      )
    );
  };

  const previousStates = store.getSessionLogStates("codex");
  const previousByPath = new Map(previousStates.map((state) => [state.filePath, state]));
  const currentPaths = new Set(discovery.files.map((file) => file.filePath));

  // ── 增量资格：文件集一致、游标完整、缓存版本可解码 ──────────────────────
  const eligible =
    previousStates.length > 0 &&
    previousStates.length === discovery.files.length &&
    previousStates.every(
      (state) => currentPaths.has(state.filePath) && validCursorShape(state),
    ) &&
    discovery.files.every((file) => previousByPath.has(file.filePath));
  if (!eligible) return fullRebuild(discovery, entries, stats);
  for (const state of previousStates) {
    const decodedState = decodeCodexFileState(state.parserStateJson);
    if (!decodedState) return fullRebuild(discovery, entries, stats);
    decodedByPath.set(state.filePath, decodedState);
  }

  // ── 分类：未变化 / 变化（增长型追加）/ 非法（同尺寸重写或截断 → 重建） ──
  const changedFiles: CodexDiscoveredFile[] = [];
  for (const file of discovery.files) {
    const previous = previousByPath.get(file.filePath)!;
    if (file.size === previous.fileSize && file.mtimeMs === previous.mtimeMs) continue;
    if (file.size <= previous.fileSize) return fullRebuild(discovery, entries, stats);
    changedFiles.push(file);
  }
  const changedPaths = new Set(changedFiles.map((file) => file.filePath));
  for (const filePath of changedPaths) cacheExcluded.add(filePath);

  // ── deferred 重试：依赖候选文件戳变化才重读，否则零读取保持 deferred ────
  const reattemptPaths = new Set<string>();
  for (const file of discovery.files) {
    if (changedPaths.has(file.filePath)) continue;
    const state = decodedByPath.get(file.filePath)!;
    const entry = entryByPath.get(file.filePath)!;
    if (state.outcome === "read-failed") {
      reattemptPaths.add(file.filePath);
      continue;
    }
    if (state.outcome === "deferred" && state.defer) {
      if (
        stampsDiffer(
          state.defer.parentStamps,
          stampsOf(state.defer.parentThreadId),
        )
      ) {
        reattemptPaths.add(file.filePath);
      }
      continue;
    }
    if (state.outcome === "unparsable" && state.defer) {
      if (stampsDiffer(state.defer.parentStamps, siblingStamps(entry))) {
        reattemptPaths.add(file.filePath);
      }
    }
  }

  // ── 同一物理 rollout 的副本（同尾部 UUID）一起重解析：归一化记录按
  //    rolloutId 归属，混合新旧副本会产生陈旧记录（无逐副本 provenance）。──
  const toParse = new Set<string>([...changedPaths, ...reattemptPaths]);
  for (let growing = true; growing; ) {
    growing = false;
    for (const file of discovery.files) {
      if (toParse.has(file.filePath)) continue;
      const entry = entryByPath.get(file.filePath)!;
      if (!entry.threadId) continue;
      const siblingChanged = (assembly.index.get(entry.threadId) ?? []).some(
        (candidate) => candidate !== entry && toParse.has(candidate.path),
      );
      if (siblingChanged) {
        toParse.add(file.filePath);
        cacheExcluded.add(file.filePath);
        growing = true;
      }
    }
  }

  // ── 阶段 1：有界并发读取待解析文件正文 ──────────────────────────────────
  const loaded = new Map<string, CodexRolloutContent>();
  const readFailed = new Set<string>();
  const toParseFiles = discovery.files.filter((file) => toParse.has(file.filePath));
  const loadedBuffers = await mapBounded(toParseFiles, FILE_IO_CONCURRENCY, async (file) =>
    readCodexRolloutContent(file.filePath),
  );
  for (const [index, loadedFile] of loadedBuffers.entries()) {
    const file = toParseFiles[index]!;
    if (loadedFile === undefined) {
      readFailed.add(file.filePath);
      toParse.delete(file.filePath);
      continue;
    }
    loaded.set(file.filePath, loadedFile);
    stats.bodyBytesRead += loadedFile.content.length;
  }
  stats.incrementalFilesRead = loaded.size;

  // ── 增长型追加的前缀指纹校验：前缀被改写（含同尺寸后续增长）即重建 ──────
  for (const file of changedFiles) {
    if (readFailed.has(file.filePath)) continue;
    const previous = previousByPath.get(file.filePath)!;
    if (file.filePath.endsWith(".jsonl.zst")) {
      // 压缩形态的锚点是物理字节：只读游标前 64B 压缩前缀核对。
      const raw = await readRange(
        file.filePath,
        Math.max(0, previous.cursorOffset - TAIL_FINGERPRINT_BYTES),
        previous.cursorOffset,
      );
      stats.verificationBytesRead += raw.length;
      if (
        previous.tailFingerprint === null ||
        fingerprintAt(raw, raw.length) !== previous.tailFingerprint
      ) {
        return fullRebuild(discovery, entries, stats);
      }
      continue;
    }
    const loadedFile = loaded.get(file.filePath)!;
    if (
      previous.cursorOffset > loadedFile.content.length ||
      previous.tailFingerprint === null ||
      fingerprintAt(loadedFile.content, previous.cursorOffset) !== previous.tailFingerprint
    ) {
      return fullRebuild(discovery, entries, stats);
    }
    stats.verificationBytesRead += TAIL_FINGERPRINT_BYTES;
  }

  for (const [filePath, loadedFile] of loaded) {
    entryByPath.get(filePath)!.content = loadedFile.content.toString("utf8");
  }

  // ── 阶段 2：解析待组装文件（续写基线可从缓存高水位或已加载前序解析） ────
  for (const entry of entries) {
    if (toParse.has(entry.path)) assembly.parseEntry(entry);
  }

  // ── 阶段 3：按解析出的 meta 补载依赖文件正文 ────────────────────────────
  //   bounded 引用 fork 的父候选需要正文（字节区间计数器校验）；
  //   普通父线程候选缺时间线缓存时整读一次供解析，此后缓存命中零读取。
  const dependencyLoads: CodexRolloutEntry[] = [];
  for (const entry of entries) {
    if (!toParse.has(entry.path)) continue;
    const parentThreadId = entry.parsed?.meta.parentThreadId;
    if (!parentThreadId) continue;
    const bounded =
      entry.parsed?.meta.historyBase?.threadId === parentThreadId;
    for (const candidate of assembly.index.get(parentThreadId) ?? []) {
      if (toParse.has(candidate.path) || readFailed.has(candidate.path)) continue;
      const cached = decodedByPath.get(candidate.path);
      if (bounded || cached?.timeline == null) {
        if (!loaded.has(candidate.path) && !dependencyLoads.includes(candidate)) {
          dependencyLoads.push(candidate);
        }
      }
    }
  }
  const dependencyBuffers = await mapBounded(
    dependencyLoads,
    FILE_IO_CONCURRENCY,
    async (entry) => readCodexRolloutContent(entry.path),
  );
  for (const [index, loadedFile] of dependencyBuffers.entries()) {
    const entry = dependencyLoads[index]!;
    if (loadedFile === undefined) continue;
    loaded.set(entry.path, loadedFile);
    stats.bodyBytesRead += loadedFile.content.length;
    stats.dependencyFilesRead = (stats.dependencyFilesRead ?? 0) + 1;
    entry.content = loadedFile.content.toString("utf8");
  }

  // ── 阶段 4：按文件序组装。未变化 imported 文件的记录直接来自归一化库；
  //    同 rolloutId 副本已被并入 toParse，库内记录不会混入旧副本版本。 ────
  const recordsByRollout = new Map<string, UsageRecord[]>();
  for (const record of store.readNormalizedRecords("codex")) {
    if (!record.id.startsWith("codex:")) continue;
    const rest = record.id.slice("codex:".length);
    const rolloutId = rest.slice(0, rest.indexOf(":"));
    if (!rolloutId) continue;
    const list = recordsByRollout.get(rolloutId) ?? [];
    list.push(record);
    recordsByRollout.set(rolloutId, list);
  }

  const records: UsageRecord[] = [];
  const seen = new Set<string>();
  const freshStates = new Map<string, CodexFileState>();
  let skippedFiles = discovery.skippedFiles;

  for (const file of discovery.files) {
    const entry = entryByPath.get(file.filePath)!;
    if (toParse.has(file.filePath)) {
      const assembled = assembly.assembleEntry(entry, seen);
      if (assembled.outcome !== "imported" && assembled.outcome !== "no-billable") {
        skippedFiles += 1;
      }
      for (const record of assembled.records) records.push(canonicalRecord(record));
      freshStates.set(file.filePath, stateFromAssembly(entry, assembled, stampsOf, siblingStamps));
      continue;
    }
    const state = decodedByPath.get(file.filePath)!;
    if (readFailed.has(file.filePath)) {
      skippedFiles += 1;
      // 内容可能已变化（这也是重新读取的原因），旧缓存派生物全部作废。
      freshStates.set(file.filePath, {
        v: CODEX_STATE_VERSION,
        outcome: "read-failed",
        meta: null,
        highWater: null,
        timeline: null,
        defer: null,
      });
      continue;
    }
    stats.unchangedFiles += 1;
    if (state.outcome === "imported") {
      for (const record of recordsByRollout.get(entry.threadId ?? "") ?? []) {
        if (seen.has(record.id)) continue;
        seen.add(record.id);
        records.push(record);
      }
    } else if (state.outcome !== "no-billable") {
      // deferred / untrusted / unparsable：与全量 reader 同口径计入 skipped；
      // no-billable 是合法无计费文件，不计。
      skippedFiles += 1;
    }
  }

  // ── 游标与缓存定稿 ───────────────────────────────────────────────────────
  const cursors = finalizeCursors({
    discovery,
    entries,
    previousByPath,
    decodedByPath,
    freshStates,
    loaded,
  });

  return result(discovery, records, skippedFiles, cursors, false, stats);
}

function stateFromAssembly(
  entry: CodexRolloutEntry,
  assembled: CodexEntryAssembly,
  stampsOf: (threadId?: string) => Array<[string, number, number]>,
  siblingStamps: (entry: CodexRolloutEntry) => Array<[string, number, number]>,
): CodexFileState {
  let defer: CodexDeferState | null = null;
  if (assembled.outcome === "deferred" && assembled.deferred?.parentThreadId) {
    defer = {
      reason: assembled.deferred.reason,
      parentThreadId: assembled.deferred.parentThreadId,
      parentStamps: stampsOf(assembled.deferred.parentThreadId),
    };
  } else if (assembled.outcome === "unparsable") {
    // 解析完整性错误可能由前序分段缺失引起（续写基线 missing-parent 抛出），
    // 记录同线程候选戳：前序分段变化后重试；内容固有错误重试结果不变。
    defer = {
      reason: assembled.deferred?.reason ?? "解析完整性错误",
      parentStamps: siblingStamps(entry),
    };
  }
  return {
    v: CODEX_STATE_VERSION,
    outcome: assembled.outcome,
    meta: entry.parsed
      ? {
          threadId: entry.parsed.meta.threadId,
          parentThreadId: entry.parsed.meta.parentThreadId,
        }
      : null,
    highWater: entry.parsed?.highWater ?? null,
    timeline: null,
    defer,
  };
}

interface FinalizeCursorsInput {
  discovery: { files: CodexDiscoveredFile[] };
  entries: CodexRolloutEntry[];
  /** 增量轮的上一轮游标（重建轮为空 Map）。 */
  previousByPath: Map<string, UsageSessionLogState>;
  /** 增量轮的未变化文件缓存（重建轮为空 Map）。 */
  decodedByPath: Map<string, CodexFileState | null>;
  freshStates: Map<string, CodexFileState>;
  loaded: Map<string, CodexRolloutContent>;
}

/**
 * 为全部文件生成最终游标行与缓存 state：
 * - 本轮解析过的文件（toParse + 依赖补载）刷新 meta / highWater / timeline；
 * - timeline 只为「被引用为父线程」的文件持久化，且事件数受上限约束；
 * - 未解析文件保留上一轮缓存（timeline 不再被引用时丢弃，防无限增长）；
 * - 有本轮正文的文件游标推进到最后完整 LF 行；其余沿用上一轮进度；重建轮
 *   读取失败的文件用空游标占位（下一轮按 read-failed 重试）。
 */
function finalizeCursors(input: FinalizeCursorsInput): UsageSessionLogState[] {
  const { discovery, entries, previousByPath, decodedByPath, freshStates, loaded } = input;
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));

  const referencedThreads = new Set<string>();
  for (const entry of entries) {
    const parent =
      entry.parsed?.meta.parentThreadId ??
      decodedByPath.get(entry.path)?.meta?.parentThreadId;
    if (parent) referencedThreads.add(parent);
  }
  const timelineWanted = (entry: CodexRolloutEntry): boolean =>
    [entry.threadId, entry.leadingThreadId].some(
      (id) => id !== undefined && referencedThreads.has(id),
    );

  const states = new Map<string, CodexFileState>(freshStates);
  for (const file of discovery.files) {
    if (states.has(file.filePath)) continue;
    const cached = decodedByPath.get(file.filePath);
    const entry = entryByPath.get(file.filePath)!;
    const parsed = entry.parsed;
    // 依赖补载但未重新组装的未变化文件：只刷新解析派生物，outcome/defer
    // 保持上一轮（文件未变化，组装结论仍有效）。
    states.set(
      file.filePath,
      parsed && cached
        ? {
            v: CODEX_STATE_VERSION,
            outcome: cached.outcome,
            meta: {
              threadId: parsed.meta.threadId,
              parentThreadId: parsed.meta.parentThreadId,
            },
            highWater: parsed.highWater ?? null,
            timeline: null,
            defer: cached.defer,
          }
        : (cached ?? {
            v: CODEX_STATE_VERSION,
            outcome: "read-failed",
            meta: null,
            highWater: null,
            timeline: null,
            defer: null,
          }),
    );
  }

  const cursors: UsageSessionLogState[] = [];
  for (const file of discovery.files) {
    const entry = entryByPath.get(file.filePath)!;
    const state = states.get(file.filePath)!;
    const parsedTimeline = entry.parsed
      ? codexTimelineFromParsed(entry.parsed)
      : undefined;
    if (parsedTimeline) {
      state.timeline =
        parsedTimeline.events.length <= MAX_TIMELINE_CACHE_EVENTS
          ? timelineToState(parsedTimeline)
          : null;
    } else if (!timelineWanted(entry)) {
      state.timeline = null;
    }

    const loadedFile = loaded.get(file.filePath);
    if (loadedFile !== undefined) {
      cursors.push(
        sessionLogState(
          "codex",
          file,
          loadedFile.cursorOffset,
          JSON.stringify(state),
          loadedFile.tailFingerprint,
        ),
      );
      continue;
    }
    const previous = previousByPath.get(file.filePath);
    cursors.push(
      sessionLogState(
        "codex",
        file,
        previous?.cursorOffset ?? 0,
        JSON.stringify(state),
        previous?.tailFingerprint ?? fingerprintAt(Buffer.alloc(0), 0),
      ),
    );
  }
  return cursors;
}

/** 来源级全量重建：整读全部文件，与全量 reader 同一编排产出记录与缓存。 */
async function fullRebuild(
  discovery: { source: string; files: CodexDiscoveredFile[]; skippedFiles: number },
  entries: CodexRolloutEntry[],
  stats: IncrementalStats,
): Promise<IncrementalUsageResult> {
  const buffers = await mapBounded(
    discovery.files,
    FILE_IO_CONCURRENCY,
    async (file) => readCodexRolloutContent(file.filePath),
  );
  const loaded = new Map<string, CodexRolloutContent>();
  let skippedFiles = discovery.skippedFiles;
  for (const [index, loadedFile] of buffers.entries()) {
    if (loadedFile === undefined) {
      skippedFiles += 1;
      continue;
    }
    loaded.set(discovery.files[index]!.filePath, loadedFile);
    stats.bodyBytesRead += loadedFile.content.length;
    stats.fullFilesRead += 1;
    entries[index]!.content = loadedFile.content.toString("utf8");
  }

  const assembly = new CodexAssembly(entries);
  const fileByPath = new Map(discovery.files.map((file) => [file.filePath, file]));
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const stampsOf = (threadId?: string): Array<[string, number, number]> => {
    if (!threadId) return [];
    return (assembly.index.get(threadId) ?? [])
      .map((entry) => fileByPath.get(entry.path))
      .filter((file): file is CodexDiscoveredFile => file !== undefined)
      .map((file) => [file.filePath, file.size, file.mtimeMs] as [string, number, number]);
  };
  const siblingStamps = (entry: CodexRolloutEntry): Array<[string, number, number]> =>
    [...stampsOf(entry.threadId), ...stampsOf(entry.leadingThreadId)].filter(
      ([filePath]) => filePath !== entry.path,
    );

  const records: UsageRecord[] = [];
  const seen = new Set<string>();
  const freshStates = new Map<string, CodexFileState>();
  for (const file of discovery.files) {
    const entry = entryByPath.get(file.filePath)!;
    if (entry.content === undefined) {
      // 读取失败：保留可重试状态（下一轮总是重新尝试读取）。
      skippedFiles += 1;
      freshStates.set(file.filePath, {
        v: CODEX_STATE_VERSION,
        outcome: "read-failed",
        meta: null,
        highWater: null,
        timeline: null,
        defer: null,
      });
      continue;
    }
    const assembled = assembly.assembleEntry(entry, seen);
    if (assembled.outcome !== "imported" && assembled.outcome !== "no-billable") {
      skippedFiles += 1;
    }
    for (const record of assembled.records) records.push(canonicalRecord(record));
    freshStates.set(file.filePath, stateFromAssembly(entry, assembled, stampsOf, siblingStamps));
  }

  const cursors = finalizeCursors({
    discovery,
    entries,
    previousByPath: new Map(),
    decodedByPath: new Map(),
    freshStates,
    loaded,
  });

  stats.rebuilds += 1;
  return result(discovery, records, skippedFiles, cursors, true, stats);
}
