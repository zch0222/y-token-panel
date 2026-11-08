import "server-only";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
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
import { parseSessionLine } from "@/lib/qoder";
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

interface Discovery {
  source: string;
  files: QoderFile[];
  scannedFiles: number;
  skippedFiles: number;
}

/**
 * 游标 parser state：已提交的完整行数。Qoder 一行一条记录、无跨行状态，
 * 唯一需要跨轮携带的是无 request_id/message.id/uuid 时的 `${file}:${lineIndex}`
 * 兜底 ID 行号基准，保证与全量 reader 的行号编号一致。
 */
interface QoderCursorState {
  lineCount: number;
}

class RebuildRequired extends Error {}

function qoderSource(): string {
  return process.env.QODER_DATA_DIR
    ? path.resolve(process.env.QODER_DATA_DIR)
    : path.join(homedir(), ".qoder-cn", "projects");
}

function decodeCursorState(json: string | null): QoderCursorState | null {
  if (json === null) return null;
  try {
    const value = JSON.parse(json) as { lineCount?: unknown };
    if (value === null || typeof value !== "object") return null;
    if (typeof value.lineCount !== "number" || !Number.isSafeInteger(value.lineCount) || value.lineCount < 0) {
      return null;
    }
    return { lineCount: value.lineCount };
  } catch {
    return null;
  }
}

/** 递归遍历与 readQoderUsage 完全一致；项目标签在首层目录确定后向下传递。 */
async function discoverQoderFiles(source: string): Promise<Discovery> {
  const files: QoderFile[] = [];
  let scannedFiles = 0;
  let skippedFiles = 0;

  const scanDirectory = async (directory: string, project: string, isRoot = false): Promise<void> => {
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
        await scanDirectory(entryPath, project || getProjectLabel(entry.name));
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

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
    await scanDirectory(source, "", true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { source, files, scannedFiles, skippedFiles };
  }
  return { source, files, scannedFiles, skippedFiles };
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
): Promise<{ records: UsageRecord[]; cursor: UsageSessionLogState }> {
  const buffer = await readFile(file.filePath);
  stats.bodyBytesRead += buffer.length;
  stats.fullFilesRead += 1;
  // 只提交到最后一个完整 LF 行；尾部半行留到下一轮补齐。
  const cursorOffset = lastCompleteLineEnd(buffer);
  const parsed = parseLines(buffer.subarray(0, cursorOffset).toString("utf8"), file, 0);
  const records: UsageRecord[] = [];
  for (const record of parsed.records) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    records.push(canonicalRecord(record));
  }
  return {
    records,
    cursor: sessionLogState(
      "qoder",
      file,
      cursorOffset,
      JSON.stringify({ lineCount: parsed.lineCount } satisfies QoderCursorState),
      fingerprintAt(buffer, cursorOffset),
    ),
  };
}

async function fullImport(discovery: Discovery, stats: IncrementalStats): Promise<IncrementalUsageResult> {
  const records: UsageRecord[] = [];
  const cursors: UsageSessionLogState[] = [];
  const seen = new Set<string>();
  let skippedFiles = 0;
  for (const file of discovery.files) {
    try {
      const imported = await importWholeFile(file, seen, stats);
      records.push(...imported.records);
      cursors.push(imported.cursor);
    } catch {
      skippedFiles += 1;
    }
  }
  stats.rebuilds += 1;
  return result(discovery, records, skippedFiles, cursors, true, stats);
}

/**
 * Qoder 普通 JSONL 字节游标增量。一行一条记录、无 parser 跨行状态：
 * 未变化文件零读取；追加文件校验游标前 64B 指纹后只读新增完整行；全局
 * request_id 去重沿用已入库记录（first-wins，与全量 reader 的跨文件 seen
 * 语义一致）。所有写库动作由 UsageStore.commitSnapshot 最终事务提交。
 */
export async function readQoderUsageIncremental(store: UsageStore): Promise<IncrementalUsageResult> {
  const source = qoderSource();
  let discovery: Discovery;
  try {
    discovery = await discoverQoderFiles(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    discovery = { source, files: [], scannedFiles: 0, skippedFiles: 0 };
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
  const currentPaths = new Set(discovery.files.map((file) => file.filePath));
  const previousByPath = new Map(previousStates.map((state) => [state.filePath, state]));
  if (
    previousStates.length === 0 ||
    previousStates.some((state) => !currentPaths.has(state.filePath) || !validCursorShape(state)) ||
    discovery.files.some((file) => !previousByPath.has(file.filePath))
  ) {
    return fullImport(discovery, stats);
  }

  const recordsById = new Map(store.readNormalizedRecords("qoder").map((record) => [record.id, record]));
  const cursors: UsageSessionLogState[] = [];
  let skippedFiles = 0;

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
        const parsed = parseLines(
          delta.subarray(0, advanced).toString("utf8"),
          file,
          cursorState.lineCount,
        );
        for (const record of parsed.records) {
          // 一行一条记录且无补齐语义：已入库的 request_id 直接沿用（first-wins）。
          if (recordsById.has(record.id)) continue;
          recordsById.set(record.id, canonicalRecord(record));
        }

        const nextOffset = previous.cursorOffset + advanced;
        const basis = Buffer.concat([prefix, delta.subarray(0, advanced)]);
        cursors.push(
          sessionLogState(
            "qoder",
            file,
            nextOffset,
            JSON.stringify({
              lineCount: cursorState.lineCount + parsed.lineCount,
            } satisfies QoderCursorState),
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
  } catch (error) {
    if (!(error instanceof RebuildRequired)) throw error;
    return fullImport(discovery, stats);
  }

  return result(discovery, Array.from(recordsById.values()), skippedFiles, cursors, false, stats);
}
