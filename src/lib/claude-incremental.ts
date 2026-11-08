import "server-only";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { claudeSource } from "@/lib/claude";
import {
  parseClaudeTranscriptIncremental,
  type ClaudeParseContext,
} from "@/lib/claude-session";
import {
  CLAUDE_LOOKBACK_BYTES,
  canonicalRecord,
  emptyIncrementalStats,
  fingerprintAt,
  lastCompleteLineEnd,
  readRange,
  sameUsageRecord,
  sessionLogState,
  sortUsageRecords,
  validCursorShape,
  type IncrementalFileBase,
  type IncrementalStats,
  type IncrementalUsageResult,
} from "@/lib/incremental-core";
import type { HarnessUsage, UsageRecord } from "@/lib/usage";
import type {
  UsageIncrementalCommit,
  UsageSessionLogState,
  UsageStore,
} from "@/lib/usage-store";

interface ClaudeFile extends IncrementalFileBase {
  name: string;
  directory: string;
}

interface Discovery {
  source: string;
  files: ClaudeFile[];
  scannedFiles: number;
  skippedFiles: number;
}

/** 游标 parser state：文件级黏性的会话项目根（可 null 表示整文件推不出）。 */
interface ClaudeCursorState {
  sessionProject: string | null;
}

class RebuildRequired extends Error {}

function parseContextOf(file: ClaudeFile): ClaudeParseContext {
  return {
    directory: file.directory,
    sessionId: path.basename(file.filePath, ".jsonl"),
    file: file.name,
  };
}

function decodeCursorState(json: string | null): ClaudeCursorState | null {
  if (json === null) return null;
  try {
    const value = JSON.parse(json) as { sessionProject?: unknown };
    if (value === null || typeof value !== "object") return null;
    const { sessionProject } = value;
    if (sessionProject !== null && typeof sessionProject !== "string") return null;
    return { sessionProject: sessionProject ?? null };
  } catch {
    return null;
  }
}

/** 目录遍历与 readClaudeUsage 完全一致（主会话 / subagents / workflows 三层）。 */
async function discoverClaudeFiles(source: string): Promise<Discovery> {
  const files: ClaudeFile[] = [];
  let scannedFiles = 0;
  let skippedFiles = 0;

  const importEntry = async (filePath: string, directory: string) => {
    scannedFiles += 1;
    try {
      const metadata = await stat(filePath);
      files.push({ filePath, name: path.basename(filePath), directory, size: metadata.size, mtimeMs: metadata.mtimeMs });
    } catch {
      skippedFiles += 1;
    }
  };

  let projects;
  try {
    projects = await readdir(source, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { source, files, scannedFiles, skippedFiles };
    }
    throw error;
  }

  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(source, project.name);
    let entries;
    try {
      entries = await readdir(projectDir, { withFileTypes: true });
    } catch {
      skippedFiles += 1;
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(projectDir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        await importEntry(entryPath, project.name);
        continue;
      }
      if (!entry.isDirectory()) continue;

      const subagentsDir = path.join(entryPath, "subagents");
      let subagents;
      try {
        subagents = await readdir(subagentsDir, { withFileTypes: true });
      } catch {
        // 会话目录下没有 subagents 属正常（tool-results / memory 等）。
        continue;
      }

      for (const agent of subagents) {
        const agentPath = path.join(subagentsDir, agent.name);
        if (agent.isFile() && agent.name.endsWith(".jsonl")) {
          await importEntry(agentPath, project.name);
          continue;
        }
        if (!agent.isDirectory() || agent.name !== "workflows") continue;

        let workflows;
        try {
          workflows = await readdir(agentPath, { withFileTypes: true });
        } catch {
          skippedFiles += 1;
          continue;
        }
        for (const workflow of workflows) {
          if (!workflow.isDirectory()) continue;
          const workflowDir = path.join(agentPath, workflow.name);
          let workflowFiles;
          try {
            workflowFiles = await readdir(workflowDir, { withFileTypes: true });
          } catch {
            skippedFiles += 1;
            continue;
          }
          for (const file of workflowFiles) {
            if (file.isFile() && file.name.endsWith(".jsonl")) {
              await importEntry(path.join(workflowDir, file.name), project.name);
            }
          }
        }
      }
    }
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
    harness: "claude",
    records,
    scannedFiles: discovery.scannedFiles,
    skippedFiles: discovery.skippedFiles + skippedFiles,
    source: discovery.source,
    sourceAvailable: true,
  };
  const transaction: UsageIncrementalCommit = {
    harness: "claude",
    resetCursors: reset,
    resetDedup: reset,
    cursors,
  };
  return { usage, transaction, stats };
}

async function importWholeFile(
  file: ClaudeFile,
  seen: Set<string>,
  stats: IncrementalStats,
): Promise<{ records: UsageRecord[]; cursor: UsageSessionLogState }> {
  const buffer = await readFile(file.filePath);
  stats.bodyBytesRead += buffer.length;
  stats.fullFilesRead += 1;
  // 只提交到最后一个完整 LF 行；尾部半行（writer 未写完）留到下一轮补齐。
  const cursorOffset = lastCompleteLineEnd(buffer);
  const parsed = parseClaudeTranscriptIncremental(
    buffer.subarray(0, cursorOffset).toString("utf8"),
    parseContextOf(file),
  );
  const records: UsageRecord[] = [];
  for (const record of parsed.records) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    records.push(canonicalRecord(record));
  }
  return {
    records,
    cursor: sessionLogState(
      "claude",
      file,
      cursorOffset,
      JSON.stringify({ sessionProject: parsed.sessionProject } satisfies ClaudeCursorState),
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
 * 等输出快照的候选补齐判定：输出更大的一定是更新的块快照；等输出时只允许
 * 补充尚无耗时的记录，已有耗时的记录视为完整 winner，避免回看窗口截断把
 * 全量视角下的最终块劣化成窗口内候选。
 */
function claudeCandidateImproves(existing: UsageRecord, candidate: UsageRecord): boolean {
  if (candidate.outputTokens !== existing.outputTokens) {
    return candidate.outputTokens > existing.outputTokens;
  }
  if (existing.estimatedDurationMs !== undefined) return false;
  return !sameUsageRecord(existing, candidate);
}

/**
 * Claude 转录字节级增量读取。未变化文件零正文读取；追加文件先校验游标前
 * 64B 指纹，再读取游标前至多 256KB 回看窗口重建对话链与块计时，与新增完整
 * 行一起交给与全量 reader 完全相同的解析体。后续块补齐（stop_reason / 更大
 * output / 耗时）按上述候选规则更新已入库记录。所有写库动作仍由
 * UsageStore.commitSnapshot 在最终快照事务中一次提交。
 */
export async function readClaudeUsageIncremental(store: UsageStore): Promise<IncrementalUsageResult> {
  const source = claudeSource();
  let discovery: Discovery;
  try {
    discovery = await discoverClaudeFiles(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    discovery = { source, files: [], scannedFiles: 0, skippedFiles: 0 };
  }
  const stats = emptyIncrementalStats();

  // 保持旧 reader 的 sourceAvailable=false 语义；来源恢复后靠重建恢复记录。
  try {
    await stat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      usage: {
        harness: "claude",
        records: [],
        scannedFiles: 0,
        skippedFiles: 0,
        source,
        sourceAvailable: false,
      },
      transaction: { harness: "claude", resetCursors: true, resetDedup: true, cursors: [] },
      stats,
    };
  }

  const previousStates = store.getSessionLogStates("claude");
  const currentPaths = new Set(discovery.files.map((file) => file.filePath));
  const previousByPath = new Map(previousStates.map((state) => [state.filePath, state]));
  if (
    previousStates.length === 0 ||
    previousStates.some((state) => !currentPaths.has(state.filePath) || !validCursorShape(state)) ||
    // 与 DSH/M3 相同的边界：没有逐文件 provenance 时，文件集变化必须全量
    // 重算跨文件 first-wins 去重，不能拿历史账本决定可见记录。
    discovery.files.some((file) => !previousByPath.has(file.filePath))
  ) {
    return fullImport(discovery, stats);
  }

  // 增量轮的记录底座来自已提交的归一化记录；游标通过后只叠加/更新。
  const recordsById = new Map(store.readNormalizedRecords("claude").map((record) => [record.id, record]));
  const seen = new Set<string>();
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
        // 同尺寸元数据变化可能意味着任意位置重写；截断同样无法续读。两者
        // 都明确回退来源级重建（正常 Claude writer 按 append-only 追加写入）。
        if (file.size === previous.fileSize || file.size < previous.cursorOffset) {
          throw new RebuildRequired();
        }
        const cursorState = decodeCursorState(previous.parserStateJson);
        if (!cursorState) throw new RebuildRequired();

        const lookbackStart = Math.max(0, previous.cursorOffset - CLAUDE_LOOKBACK_BYTES);
        let lookback: Buffer = Buffer.alloc(0);
        if (previous.cursorOffset > 0) {
          lookback = await readRange(file.filePath, lookbackStart, previous.cursorOffset);
        stats.verificationBytesRead += lookback.length;
        stats.lookbackBytesRead = (stats.lookbackBytesRead ?? 0) + lookback.length;
          if (
            previous.tailFingerprint === null ||
            fingerprintAt(lookback, lookback.length) !== previous.tailFingerprint
          ) {
            throw new RebuildRequired();
          }
        }

        const delta = await readRange(file.filePath, previous.cursorOffset, file.size);
        stats.bodyBytesRead += delta.length;
        stats.incrementalFilesRead += 1;
        const advanced = lastCompleteLineEnd(delta);
        const nextOffset = previous.cursorOffset + advanced;

      // 回看窗口从第一个完整 LF 行对齐：窗口起点不是文件头时首行必是被截断
      // 的半行，跳过它；否则整段都是完整行，直接使用。
      const windowStart =
        lookbackStart === 0 ? 0 : lookback.indexOf(0x0a) + 1;
      const window =
        lookback.subarray(windowStart).toString("utf8") +
        delta.subarray(0, advanced).toString("utf8");
        const parsed = parseClaudeTranscriptIncremental(window, parseContextOf(file), {
          sessionProject: cursorState.sessionProject ?? undefined,
        });
        for (const record of parsed.records) {
          const candidate = canonicalRecord(record);
          const existing = recordsById.get(candidate.id);
          if (existing) {
            if (claudeCandidateImproves(existing, candidate)) {
              recordsById.set(candidate.id, candidate);
            }
            continue;
          }
          if (seen.has(candidate.id)) continue;
          seen.add(candidate.id);
          recordsById.set(candidate.id, candidate);
        }

        const basis = Buffer.concat([lookback, delta.subarray(0, advanced)]);
        cursors.push(
          sessionLogState(
            "claude",
            file,
            nextOffset,
            JSON.stringify({ sessionProject: parsed.sessionProject } satisfies ClaudeCursorState),
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
