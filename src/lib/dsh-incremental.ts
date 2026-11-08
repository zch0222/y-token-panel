import "server-only";
import { createHash } from "node:crypto";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  decodeDshParserState,
  dshProjectLabel,
  emptyDshParserState,
  parseDshSessionLogIncremental,
  scanZstdFrames,
  type DshParserState,
} from "@/lib/dsh-session";
import type { HarnessUsage, UsageRecord } from "@/lib/usage";
import type {
  UsageIncrementalCommit,
  UsageSessionLogState,
  UsageStore,
} from "@/lib/usage-store";

const TAIL_FINGERPRINT_BYTES = 64;
const zstdDecompressSync: ((buffer: Buffer) => Buffer) | undefined =
  typeof zlib.zstdDecompressSync === "function"
    ? (buffer) => zlib.zstdDecompressSync(buffer)
    : undefined;

interface DshFile {
  filePath: string;
  name: string;
  project: string;
  sessionId: string;
  size: number;
  mtimeMs: number;
}

interface Discovery {
  source: string;
  files: DshFile[];
  skippedFiles: number;
}

export interface DshIncrementalStats {
  bodyBytesRead: number;
  verificationBytesRead: number;
  framesDecoded: number;
  fullFilesRead: number;
  incrementalFilesRead: number;
  unchangedFiles: number;
  rebuilds: number;
}

export interface DshIncrementalResult {
  usage: HarnessUsage;
  transaction: UsageIncrementalCommit;
  stats: DshIncrementalStats;
}

class RebuildRequired extends Error {}

function isSessionLogName(name: string): boolean {
  return (
    name.startsWith("session.") &&
    (name.endsWith(".jsonl") || name.endsWith(".jsonl.zstd"))
  );
}

function dshSource(): string {
  const home =
    process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ""
      ? path.resolve(process.env.DSH_HOME)
      : path.join(homedir(), ".dsh");
  return path.join(home, "sessions");
}

async function discoverDshFiles(source: string): Promise<Discovery> {
  const files: DshFile[] = [];
  let skippedFiles = 0;
  let projects;
  try {
    projects = await readdir(source, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { source, files, skippedFiles };
    }
    throw error;
  }

  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDirectory = path.join(source, project.name);
    let sessions;
    try {
      sessions = await readdir(projectDirectory, { withFileTypes: true });
    } catch {
      skippedFiles += 1;
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const sessionDirectory = path.join(projectDirectory, session.name);
      let entries;
      try {
        entries = await readdir(sessionDirectory, { withFileTypes: true });
      } catch {
        skippedFiles += 1;
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !isSessionLogName(entry.name)) continue;
        const filePath = path.join(sessionDirectory, entry.name);
        try {
          const metadata = await stat(filePath);
          files.push({
            filePath,
            name: entry.name,
            project: dshProjectLabel(project.name),
            sessionId: session.name,
            size: metadata.size,
            mtimeMs: metadata.mtimeMs,
          });
        } catch {
          skippedFiles += 1;
        }
      }
    }
  }
  return { source, files, skippedFiles };
}

function fingerprintAt(buffer: Buffer, end: number): string {
  const start = Math.max(0, end - TAIL_FINGERPRINT_BYTES);
  return createHash("sha256").update(buffer.subarray(start, end)).digest("hex");
}

async function readRange(filePath: string, start: number, end: number): Promise<Buffer> {
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

function cursorState(
  file: DshFile,
  cursorOffset: number,
  parserState: DshParserState,
  tailFingerprint: string | null,
): UsageSessionLogState {
  return {
    harness: "dsh",
    filePath: file.filePath,
    fileSize: file.size,
    mtimeMs: file.mtimeMs,
    cursorOffset,
    parserStateJson: JSON.stringify(parserState),
    tailFingerprint,
    lastError: null,
    updatedAt: 0,
  };
}

function emptyStats(): DshIncrementalStats {
  return {
    bodyBytesRead: 0,
    verificationBytesRead: 0,
    framesDecoded: 0,
    fullFilesRead: 0,
    incrementalFilesRead: 0,
    unchangedFiles: 0,
    rebuilds: 0,
  };
}

function result(
  discovery: Discovery,
  records: UsageRecord[],
  skippedFiles: number,
  cursors: UsageSessionLogState[],
  reset: boolean,
  stats: DshIncrementalStats,
): DshIncrementalResult {
  records.sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
  return {
    usage: {
      harness: "dsh",
      records,
      scannedFiles: discovery.files.length,
      skippedFiles: discovery.skippedFiles + skippedFiles,
      source: discovery.source,
      sourceAvailable: true,
    },
    transaction: {
      harness: "dsh",
      resetCursors: reset,
      resetDedup: reset,
      cursors,
    },
    stats,
  };
}

async function importWholeFile(
  file: DshFile,
  seen: Set<string>,
  stats: DshIncrementalStats,
): Promise<{ records: UsageRecord[]; cursor: UsageSessionLogState }> {
  const buffer = await readFile(file.filePath);
  stats.bodyBytesRead += buffer.length;
  stats.fullFilesRead += 1;
  let bytes: Buffer;
  let cursorOffset: number;
  if (file.name.endsWith(".jsonl.zstd") && zstdDecompressSync) {
    const { frames } = scanZstdFrames(buffer);
    const chunks: Buffer[] = [];
    // 与旧实现一致：任一完整帧解压失败则整文件跳过，不导入该文件的前半部分。
    for (const frame of frames) chunks.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)));
    stats.framesDecoded += frames.length;
    cursorOffset = frames.at(-1)?.end ?? 0;
    bytes = Buffer.concat(chunks);
  } else {
    const lastNewline = buffer.lastIndexOf(0x0a);
    cursorOffset = lastNewline + 1;
    bytes = buffer.subarray(0, cursorOffset);
  }
  const parsed = parseDshSessionLogIncremental(
    bytes,
    file.project,
    file.sessionId,
    emptyDshParserState(),
  );
  const records: UsageRecord[] = [];
  for (const record of parsed.records) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    records.push(record);
  }
  return {
    records,
    cursor: cursorState(
      file,
      cursorOffset,
      parsed.state,
      fingerprintAt(buffer, cursorOffset),
    ),
  };
}

async function fullImport(
  discovery: Discovery,
  stats: DshIncrementalStats,
): Promise<DshIncrementalResult> {
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

function validPrevious(state: UsageSessionLogState): boolean {
  return (
    Number.isSafeInteger(state.fileSize) &&
    Number.isSafeInteger(state.cursorOffset) &&
    state.fileSize >= 0 &&
    state.cursorOffset >= 0 &&
    state.cursorOffset <= state.fileSize &&
    Number.isFinite(state.mtimeMs) &&
    state.parserStateJson !== null &&
    decodeDshParserState(state.parserStateJson) !== null
  );
}

/**
 * DSH 帧级/行级增量读取。所有写库动作由 UsageStore.commitSnapshot 在最终
 * 快照事务中一次提交；本函数只读取数据库快照和日志，不提前推进任何游标。
 */
export async function readDshUsageIncremental(store: UsageStore): Promise<DshIncrementalResult> {
  const source = dshSource();
  let discovery: Discovery;
  try {
    discovery = await discoverDshFiles(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    discovery = { source, files: [], skippedFiles: 0 };
  }
  const previousStates = store.getSessionLogStates("dsh");
  const stats = emptyStats();

  // 保持旧 reader 的 sourceAvailable=false 语义；同时清理游标，避免来源恢复后
  // 仅凭旧游标把此前清空的记录误当作仍存在于归一化表中。
  try {
    await stat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      usage: {
        harness: "dsh",
        records: [],
        scannedFiles: 0,
        skippedFiles: 0,
        source,
        sourceAvailable: false,
      },
      transaction: { harness: "dsh", resetCursors: true, resetDedup: true, cursors: [] },
      stats,
    };
  }

  const currentPaths = new Set(discovery.files.map((file) => file.filePath));
  const previousByPath = new Map(previousStates.map((state) => [state.filePath, state]));
  if (
    previousStates.length === 0 ||
    previousStates.some((state) => !currentPaths.has(state.filePath) || !validPrevious(state)) ||
    // 新文件可能按旧 reader 的目录顺序排在既有副本之前。没有逐文件 provenance
    // 缓存时，必须全量重算全局 winner，不能拿历史 dedup 账本决定可见记录。
    discovery.files.some((file) => !previousByPath.has(file.filePath))
  ) {
    return fullImport(discovery, stats);
  }
  const records = store.readNormalizedRecords("dsh");
  const seen = new Set(store.getDedupKeys("dsh"));
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
      // 同尺寸元数据变化可能意味着任意位置重写；尾部指纹无法证明前缀未变，
      // 因此明确回退来源级重建。增长型续读以 DSH 正常 writer 的 append-only
      // 契约为前提：若外部工具重写前部却保留 size/mtime 或最后 64B，O(delta)
      // 读取无法检测，必须清除该来源游标以强制全量恢复（见 M3 决策记录）。
      if (file.size === previous.fileSize || file.size < previous.cursorOffset) {
        throw new RebuildRequired();
      }

      const parserState = decodeDshParserState(previous.parserStateJson);
      if (!parserState) throw new RebuildRequired();
      const prefixStart = Math.max(0, previous.cursorOffset - TAIL_FINGERPRINT_BYTES);
      let prefix: Buffer = Buffer.alloc(0);
      try {
        if (previous.cursorOffset > 0) {
          prefix = await readRange(file.filePath, prefixStart, previous.cursorOffset);
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
        let bytes: Buffer;
        let advanced: number;
        if (file.name.endsWith(".jsonl.zstd") && zstdDecompressSync) {
          const { frames, invalidAt } = scanZstdFrames(delta);
          if (invalidAt !== null) throw new RebuildRequired();
          const chunks: Buffer[] = [];
          for (const frame of frames) chunks.push(zstdDecompressSync(delta.subarray(frame.start, frame.end)));
          stats.framesDecoded += frames.length;
          advanced = frames.at(-1)?.end ?? 0;
          bytes = Buffer.concat(chunks);
        } else {
          advanced = delta.lastIndexOf(0x0a) + 1;
          bytes = delta.subarray(0, advanced);
        }
        const parsed = parseDshSessionLogIncremental(bytes, file.project, file.sessionId, parserState);
        for (const record of parsed.records) {
          if (seen.has(record.id)) continue;
          seen.add(record.id);
          records.push(record);
        }
        const nextOffset = previous.cursorOffset + advanced;
        const basis = Buffer.concat([prefix, delta]);
        cursors.push(
          cursorState(
            file,
            nextOffset,
            parsed.state,
            advanced > 0
              ? fingerprintAt(basis, prefix.length + advanced)
              : previous.tailFingerprint,
          ),
        );
      } catch (error) {
        if (error instanceof RebuildRequired) throw error;
        // 解压或读取失败不推进游标，也不删除该文件上一轮已经提交的记录。
        skippedFiles += 1;
        cursors.push(previous);
      }
    }
  } catch (error) {
    if (!(error instanceof RebuildRequired)) throw error;
    return fullImport(discovery, stats);
  }

  return result(discovery, records, skippedFiles, cursors, false, stats);
}
