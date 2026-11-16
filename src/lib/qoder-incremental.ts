import "server-only";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  canonicalRecord,
  emptyIncrementalStats,
  fingerprintAt,
  lastCompleteLineEnd,
  readRange,
  sessionLogState,
  sortUsageRecords,
  validCursorShape,
  type IncrementalFileBase,
  type IncrementalStats,
  type IncrementalUsageResult,
} from "@/lib/incremental-core";
import {
  attachQoderStateRecords,
  buildQoderStateRecord,
  isQoderStateRecord,
  parseQoderStateContent,
  qoderStateRecordId,
  qoderStateRootCandidates,
  type QoderStateFileMeta,
} from "@/lib/qoder-state";
import { extractQoderCwd, parseSessionLine, qoderDerivedWorkspaceRoot, qoderSource } from "@/lib/qoder";
import { getProjectLabel, type HarnessUsage, type UsageRecord } from "@/lib/usage";
import type {
  UsageIncrementalCommit,
  UsageSessionLogState,
  UsageStore,
} from "@/lib/usage-store";

interface QoderFile extends IncrementalFileBase {
  name: string;
  /** 首层目录名派生、整棵子树共享的项目标签（与全量 reader 一致）。 */
  project: string;
}

interface QoderStateFile extends QoderStateFileMeta, IncrementalFileBase {}

interface Discovery {
  source: string;
  files: QoderFile[];
  stateFiles: QoderStateFile[];
  scannedFiles: number;
  skippedFiles: number;
}

/**
 * 游标 parser state：已提交的完整行数 + 该文件出现过的 workspace cwd 与
 * sessionId（供 state.json 解密的 AAD 候选跨轮携带）。Qoder 一行一条记录、
 * 无跨行状态，唯一需要跨轮携带的是无 request_id/message.id/uuid 时的
 * `${file}:${lineIndex}` 兜底 ID 行号基准，保证与全量 reader 的行号编号一致。
 */
interface QoderCursorState {
  lineCount: number;
  sessionId?: string;
  cwds?: string[];
}

class RebuildRequired extends Error {}

function decodeCursorState(json: string | null): QoderCursorState | null {
  if (json === null) return null;
  try {
    const value = JSON.parse(json) as {
      lineCount?: unknown;
      sessionId?: unknown;
      cwds?: unknown;
    };
    if (value === null || typeof value !== "object") return null;
    if (typeof value.lineCount !== "number" || !Number.isSafeInteger(value.lineCount) || value.lineCount < 0) {
      return null;
    }
    if (
      value.sessionId !== undefined &&
      (typeof value.sessionId !== "string" || value.sessionId === "")
    ) {
      return null;
    }
    if (
      value.cwds !== undefined &&
      (!Array.isArray(value.cwds) ||
        value.cwds.some((entry) => typeof entry !== "string" || entry === ""))
    ) {
      return null;
    }
    return {
      lineCount: value.lineCount,
      ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
      ...(value.cwds === undefined ? {} : { cwds: value.cwds }),
    };
  } catch {
    return null;
  }
}

/** 递归遍历与 readQoderUsage 完全一致；项目标签在首层目录确定后向下传递。 */
async function discoverQoderFiles(source: string): Promise<Discovery> {
  const files: QoderFile[] = [];
  const stateFiles: QoderStateFile[] = [];
  let scannedFiles = 0;
  let skippedFiles = 0;

  const scanDirectory = async (directory: string, project: string, depth: number, isRoot = false): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isRoot && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      skippedFiles += 1;
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await scanDirectory(entryPath, project || getProjectLabel(entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      // 会话目录（<project>/<sessionId>）里的聚合用量库，与 jsonl 同游标机制但整文件重读。
      if (depth === 3 && entry.name === "state.json") {
        scannedFiles += 1;
        try {
          const metadata = await stat(entryPath);
          stateFiles.push({
            filePath: entryPath,
            sessionId: path.basename(directory),
            project: project || "未知项目",
            artifactDir: path.dirname(directory),
            derivedRoot: qoderDerivedWorkspaceRoot(path.basename(path.dirname(directory))),
            size: metadata.size,
            mtimeMs: metadata.mtimeMs,
          });
        } catch {
          skippedFiles += 1;
        }
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;

      scannedFiles += 1;
      try {
        const metadata = await stat(entryPath);
        files.push({
          filePath: entryPath,
          name: entry.name,
          project,
          size: metadata.size,
          mtimeMs: metadata.mtimeMs,
        });
      } catch {
        skippedFiles += 1;
      }
    }
  };

  try {
    await scanDirectory(source, "", 1, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { source, files, stateFiles, scannedFiles, skippedFiles };
  }
  return { source, files, stateFiles, scannedFiles, skippedFiles };
}

function result(
  discovery: Discovery,
  records: UsageRecord[],
  skippedFiles: number,
  cursors: UsageSessionLogState[],
  reset: boolean,
  stats: IncrementalStats,
): IncrementalUsageResult {
  sortUsageRecords(records);
  const usage: HarnessUsage = {
    harness: "qoder",
    records,
    scannedFiles: discovery.scannedFiles,
    skippedFiles: discovery.skippedFiles + skippedFiles,
    source: discovery.source,
    sourceAvailable: true,
  };
  const transaction: UsageIncrementalCommit = {
    harness: "qoder",
    resetCursors: reset,
    resetDedup: reset,
    cursors,
  };
  return { usage, transaction, stats };
}

/** 追加行里的 cwd / sessionId 并入跨轮候选（先见者优先，去重）。 */
function mergeCwds(
  cursorState: QoderCursorState | null,
  lines: readonly string[],
  fallbackSessionId: string,
): { sessionId?: string; cwds?: string[] } {
  let sessionId = cursorState?.sessionId;
  const cwds = [...(cursorState?.cwds ?? [])];
  for (const line of lines) {
    const extracted = extractQoderCwd(line);
    if (extracted.cwd === undefined) continue;
    sessionId ??= extracted.sessionId ?? fallbackSessionId;
    if (!cwds.includes(extracted.cwd)) cwds.push(extracted.cwd);
  }
  return {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(cwds.length === 0 ? {} : { cwds }),
  };
}

function parseLines(
  text: string,
  file: QoderFile,
  startLine: number,
): { records: UsageRecord[]; lineCount: number } {
  const lines = text.split(/\r?\n/);
  const records: UsageRecord[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    const record = parseSessionLine(
      lines[index],
      file.project || "未知项目",
      file.name,
      startLine + index,
    );
    if (record) records.push(record);
  }
  return { records, lineCount: lines.length - 1 };
}

async function importWholeFile(
  file: QoderFile,
  seen: Set<string>,
  stats: IncrementalStats,
): Promise<{ records: UsageRecord[]; cursor: UsageSessionLogState; cwds: { sessionId?: string; cwds?: string[] } }> {
  const buffer = await readFile(file.filePath);
  stats.bodyBytesRead += buffer.length;
  stats.fullFilesRead += 1;
  // 只提交到最后一个完整 LF 行；尾部半行留到下一轮补齐。
  const cursorOffset = lastCompleteLineEnd(buffer);
  const committed = buffer.subarray(0, cursorOffset).toString("utf8");
  const parsed = parseLines(committed, file, 0);
  const records: UsageRecord[] = [];
  for (const record of parsed.records) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    records.push(canonicalRecord(record));
  }
  const lines = committed.split(/\r?\n/);
  const cwdState = mergeCwds(null, lines, path.basename(file.name, ".jsonl"));
  return {
    records,
    cursor: sessionLogState(
      "qoder",
      file,
      cursorOffset,
      JSON.stringify({ lineCount: parsed.lineCount, ...cwdState } satisfies QoderCursorState),
      fingerprintAt(buffer, cursorOffset),
    ),
    cwds: cwdState,
  };
}

function stateCursor(meta: QoderStateFile, buffer: Buffer): UsageSessionLogState {
  return sessionLogState("qoder", meta, buffer.length, null, fingerprintAt(buffer, buffer.length));
}

function appendSessionCwds(
  cwdsBySession: Map<string, string[]>,
  sessionId: string | undefined,
  cwds: string[] | undefined,
): void {
  if (sessionId === undefined || cwds === undefined || cwds.length === 0) return;
  const existing = cwdsBySession.get(sessionId) ?? [];
  for (const cwd of cwds) {
    if (!existing.includes(cwd)) existing.push(cwd);
  }
  cwdsBySession.set(sessionId, existing);
}

async function fullImport(discovery: Discovery, stats: IncrementalStats): Promise<IncrementalUsageResult> {
  const records: UsageRecord[] = [];
  const cursors: UsageSessionLogState[] = [];
  const cwdsBySession = new Map<string, string[]>();
  const seen = new Set<string>();
  let skippedFiles = 0;
  for (const file of discovery.files) {
    try {
      const imported = await importWholeFile(file, seen, stats);
      records.push(...imported.records);
      cursors.push(imported.cursor);
      appendSessionCwds(cwdsBySession, imported.cwds.sessionId, imported.cwds.cwds);
    } catch {
      skippedFiles += 1;
    }
  }
  // state.json 聚合补差与全量 reader 同一装配路径；游标整文件推进。
  const attached = await attachQoderStateRecords(discovery.stateFiles, cwdsBySession, records);
  stats.fullFilesRead += discovery.stateFiles.length;
  for (const meta of discovery.stateFiles) {
    try {
      const buffer = await readFile(meta.filePath);
      stats.bodyBytesRead += buffer.length;
      cursors.push(stateCursor(meta, buffer));
    } catch {
      skippedFiles += 1;
    }
  }
  stats.rebuilds += 1;
  return result(discovery, attached.records, skippedFiles + attached.skippedFiles, cursors, true, stats);
}

/**
 * Qoder 普通 JSONL 字节游标增量 + state.json 聚合整文件增量：
 * jsonl 一行一条记录、无 parser 跨行状态，未变化文件零读取，追加文件校验
 * 游标前 64B 指纹后只读新增完整行，全局 request_id 去重沿用已入库记录
 * （first-wins，与全量 reader 的跨文件 seen 语义一致）。state.json 变化时
 * 整文件重读并重算该会话的补差记录（同 ID 替换）；文件集变化回退来源级重建。
 * 所有写库动作由 UsageStore.commitSnapshot 最终事务提交。
 */
export async function readQoderUsageIncremental(store: UsageStore): Promise<IncrementalUsageResult> {
  const source = qoderSource();
  let discovery: Discovery;
  try {
    discovery = await discoverQoderFiles(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    discovery = { source, files: [], stateFiles: [], scannedFiles: 0, skippedFiles: 0 };
  }
  const stats = emptyIncrementalStats();

  // 保持旧 reader 的 sourceAvailable=false 语义（仅根目录缺失）。
  try {
    await stat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      usage: {
        harness: "qoder",
        records: [],
        scannedFiles: 0,
        skippedFiles: 0,
        source,
        sourceAvailable: false,
      },
      transaction: { harness: "qoder", resetCursors: true, resetDedup: true, cursors: [] },
      stats,
    };
  }

  const previousStates = store.getSessionLogStates("qoder");
  const currentPaths = new Set([
    ...discovery.files.map((file) => file.filePath),
    ...discovery.stateFiles.map((meta) => meta.filePath),
  ]);
  const statePaths = new Set(discovery.stateFiles.map((meta) => meta.filePath));
  const previousByPath = new Map(previousStates.map((state) => [state.filePath, state]));
  if (
    previousStates.length === 0 ||
    previousStates.some((state) => !currentPaths.has(state.filePath) || !validCursorShape(state)) ||
    discovery.files.some((file) => !previousByPath.has(file.filePath)) ||
    discovery.stateFiles.some((meta) => !previousByPath.has(meta.filePath))
  ) {
    return fullImport(discovery, stats);
  }

  const recordsById = new Map(store.readNormalizedRecords("qoder").map((record) => [record.id, record]));
  const cursors: UsageSessionLogState[] = [];
  let skippedFiles = 0;

  // jsonl 游标里的 cwd 候选跨轮携带，供本轮变化的 state.json 解密复用。
  const cwdsBySession = new Map<string, string[]>();
  for (const state of previousStates) {
    if (statePaths.has(state.filePath)) continue;
    const cursorState = decodeCursorState(state.parserStateJson);
    if (cursorState?.sessionId === undefined || cursorState.cwds === undefined) continue;
    const existing = cwdsBySession.get(cursorState.sessionId) ?? [];
    for (const cwd of cursorState.cwds) {
      if (!existing.includes(cwd)) existing.push(cwd);
    }
    cwdsBySession.set(cursorState.sessionId, existing);
  }

  try {
    for (const file of discovery.files) {
      const previous = previousByPath.get(file.filePath)!;
      if (file.size === previous.fileSize && file.mtimeMs === previous.mtimeMs) {
        stats.unchangedFiles += 1;
        cursors.push(previous);
        continue;
      }
      try {
        if (file.size === previous.fileSize || file.size < previous.cursorOffset) {
          throw new RebuildRequired();
        }
        const cursorState = decodeCursorState(previous.parserStateJson);
        if (!cursorState) throw new RebuildRequired();

        let prefix: Buffer = Buffer.alloc(0);
        if (previous.cursorOffset > 0) {
          prefix = await readRange(
            file.filePath,
            Math.max(0, previous.cursorOffset - 64),
            previous.cursorOffset,
          );
          stats.verificationBytesRead += prefix.length;
          if (
            previous.tailFingerprint === null ||
            fingerprintAt(prefix, prefix.length) !== previous.tailFingerprint
          ) {
            throw new RebuildRequired();
          }
        }

        const delta = await readRange(file.filePath, previous.cursorOffset, file.size);
        stats.bodyBytesRead += delta.length;
        stats.incrementalFilesRead += 1;
        const advanced = lastCompleteLineEnd(delta);
        const deltaText = delta.subarray(0, advanced).toString("utf8");
        const parsed = parseLines(deltaText, file, cursorState.lineCount);
        for (const record of parsed.records) {
          // 一行一条记录且无补齐语义：已入库的 request_id 直接沿用（first-wins）。
          if (recordsById.has(record.id)) continue;
          recordsById.set(record.id, canonicalRecord(record));
        }

        const nextOffset = previous.cursorOffset + advanced;
        const basis = Buffer.concat([prefix, delta.subarray(0, advanced)]);
        const cwdState = mergeCwds(
          cursorState,
          deltaText.split(/\r?\n/),
          path.basename(file.name, ".jsonl"),
        );
        cursors.push(
          sessionLogState(
            "qoder",
            file,
            nextOffset,
            JSON.stringify({ lineCount: cursorState.lineCount + parsed.lineCount, ...cwdState } satisfies QoderCursorState),
            advanced > 0 ? fingerprintAt(basis, basis.length) : previous.tailFingerprint,
          ),
        );
      } catch (error) {
        if (error instanceof RebuildRequired) throw error;
        // 读取失败保留已提交进度：不推进该文件游标，也不删除其已有记录。
        skippedFiles += 1;
        cursors.push(previous);
      }
    }

    for (const meta of discovery.stateFiles) {
      const previous = previousByPath.get(meta.filePath)!;
      if (meta.size === previous.fileSize && meta.mtimeMs === previous.mtimeMs) {
        stats.unchangedFiles += 1;
        cursors.push(previous);
        continue;
      }
      try {
        // state.json 是整文件重写语义：变化即整读重算，无截断/同尺寸回退。
        const buffer = await readFile(meta.filePath);
        stats.bodyBytesRead += buffer.length;
        stats.incrementalFilesRead += 1;
        const usage = parseQoderStateContent(
          buffer.toString("utf8"),
          meta.sessionId,
          qoderStateRootCandidates(meta, cwdsBySession.get(meta.sessionId)),
        );
        const sessionRecords = Array.from(recordsById.values()).filter(
          (record) => record.sessionId === meta.sessionId && !isQoderStateRecord(record),
        );
        const record = buildQoderStateRecord(meta.sessionId, meta.project, usage, sessionRecords);
        const recordId = qoderStateRecordId(meta.sessionId);
        if (record === null) {
          // 与全量 reader 口径一致：解不开 / 无需补差时补差记录不保留。
          recordsById.delete(recordId);
        } else {
          recordsById.set(recordId, canonicalRecord(record));
        }
        if (usage === null) skippedFiles += 1;
        cursors.push(stateCursor(meta, buffer));
      } catch {
        // 读取失败保留已提交进度：不推进游标，已有补差记录不动。
        skippedFiles += 1;
        cursors.push(previous);
      }
    }
  } catch (error) {
    if (!(error instanceof RebuildRequired)) throw error;
    return fullImport(discovery, stats);
  }

  return result(discovery, Array.from(recordsById.values()), skippedFiles, cursors, false, stats);
}
