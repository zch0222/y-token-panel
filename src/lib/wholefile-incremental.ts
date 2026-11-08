import "server-only";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  canonicalRecord,
  emptyIncrementalStats,
  FILE_IO_CONCURRENCY,
  fingerprintAt,
  lastCompleteLineEnd,
  mapBounded,
  readRange,
  sessionLogState,
  sortUsageRecords,
  validCursorShape,
  type IncrementalFileBase,
  type IncrementalStats,
  type IncrementalUsageResult,
} from "@/lib/incremental-core";
import { codeBuddySource } from "@/lib/codebuddy";
import { parseSessionFile } from "@/lib/codebuddy-session";
import { readdir } from "node:fs/promises";
import { kcodeRoot } from "@/lib/kcode";
import {
  parseKcodeProjectsFile,
  parseKcodeWireFile,
  resolveKcodeProjectName,
} from "@/lib/kcode-session";
import { workBuddySource } from "@/lib/workbuddy";
import { parseWorkBuddySession } from "@/lib/workbuddy-session";
import { getProjectLabel, type HarnessId, type HarnessUsage, type UsageRecord } from "@/lib/usage";
import type {
  UsageIncrementalCommit,
  UsageSessionLogState,
  UsageStore,
} from "@/lib/usage-store";

class RebuildRequired extends Error {}

/**
 * 不直接产记录、但影响记录口径的伴随文件（KCode projects.json 的项目注册
 * 表）。出现、消失或内容变化都触发来源级重建——注册表变化会改写所有记录
 * 的 project 归组，靠逐文件替换无法补齐未变化文件的旧标签。
 */
export interface WholeFileAuxiliary {
  filePath: string;
  size: number | null;
  mtimeMs: number | null;
  fingerprint: string | null;
}

export interface WholeFileDiscovery<F extends IncrementalFileBase> {
  source: string;
  files: F[];
  scannedFiles: number;
  skippedFiles: number;
  auxiliaries: WholeFileAuxiliary[];
}

export interface WholeFileHarnessConfig<F extends IncrementalFileBase> {
  harness: HarnessId;
  discover(): Promise<WholeFileDiscovery<F>>;
  parseFile(file: F, content: string): UsageRecord[];
}

function auxiliaryCursor(
  harness: HarnessId,
  aux: WholeFileAuxiliary,
): UsageSessionLogState {
  return {
    harness,
    filePath: aux.filePath,
    fileSize: aux.size ?? 0,
    mtimeMs: aux.mtimeMs ?? 0,
    cursorOffset: aux.size ?? 0,
    parserStateJson: null,
    tailFingerprint: aux.fingerprint,
    lastError: null,
    updatedAt: 0,
  };
}

function result<F extends IncrementalFileBase>(
  config: WholeFileHarnessConfig<F>,
  discovery: WholeFileDiscovery<F>,
  records: UsageRecord[],
  skippedFiles: number,
  cursors: UsageSessionLogState[],
  reset: boolean,
  stats: IncrementalStats,
): IncrementalUsageResult {
  sortUsageRecords(records);
  const usage: HarnessUsage = {
    harness: config.harness,
    records,
    scannedFiles: discovery.scannedFiles,
    skippedFiles: discovery.skippedFiles + skippedFiles,
    source: discovery.source,
    sourceAvailable: true,
  };
  const transaction: UsageIncrementalCommit = {
    harness: config.harness,
    resetCursors: reset,
    resetDedup: reset,
    cursors,
  };
  return { usage, transaction, stats };
}

/** 读取并解析单个文件；读取或解析失败返回 null（由调用方按 skipped 处理）。 */
async function loadWholeFile<F extends IncrementalFileBase>(
  config: WholeFileHarnessConfig<F>,
  file: F,
  stats: IncrementalStats,
): Promise<{ records: UsageRecord[]; cursor: UsageSessionLogState }> {
  const buffer = await readFile(file.filePath);
  stats.bodyBytesRead += buffer.length;
  stats.fullFilesRead += 1;
  const parsed = config.parseFile(file, buffer.toString("utf8"));
  // 游标语义与字节游标来源一致：只认到最后一个完整 LF 行；变化文件下一轮
  // 整文件重读，尾部半行会被 parser 正常解析（与全量 reader 口径一致）。
  const cursorOffset = lastCompleteLineEnd(buffer);
  return {
    records: parsed,
    cursor: sessionLogState(
      config.harness,
      file,
      cursorOffset,
      null,
      fingerprintAt(buffer, cursorOffset),
    ),
  };
}

async function fullImport<F extends IncrementalFileBase>(
  config: WholeFileHarnessConfig<F>,
  discovery: WholeFileDiscovery<F>,
  stats: IncrementalStats,
): Promise<IncrementalUsageResult> {
  // 冷导入按 FILE_IO_CONCURRENCY 有界并发读取/解析（M5）；去重与游标推进
  // 仍按文件序串行，first-wins 与全量 reader 口径不变。
  const loaded = await mapBounded(discovery.files, FILE_IO_CONCURRENCY, async (file) => {
    try {
      return await loadWholeFile(config, file, stats);
    } catch {
      return null;
    }
  });
  const records: UsageRecord[] = [];
  const cursors: UsageSessionLogState[] = [];
  const seen = new Set<string>();
  let skippedFiles = 0;
  for (const item of loaded) {
    if (item === null) {
      skippedFiles += 1;
      continue;
    }
    for (const record of item.records) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      records.push(canonicalRecord(record));
    }
    cursors.push(item.cursor);
  }
  for (const aux of discovery.auxiliaries) {
    if (aux.size === null) continue;
    cursors.push(auxiliaryCursor(config.harness, aux));
  }
  stats.rebuilds += 1;
  return result(config, discovery, records, skippedFiles, cursors, true, stats);
}

/** 伴随文件与上一轮一致才放行；出现 / 消失 / 变化都来源级重建。 */
function verifyAuxiliaries(
  previousByPath: Map<string, UsageSessionLogState>,
  auxiliaries: WholeFileAuxiliary[],
): void {
  for (const aux of auxiliaries) {
    const previous = previousByPath.get(aux.filePath);
    if (aux.size === null) {
      if (previous) throw new RebuildRequired();
      continue;
    }
    if (
      !previous ||
      previous.fileSize !== aux.size ||
      previous.mtimeMs !== aux.mtimeMs ||
      previous.tailFingerprint !== aux.fingerprint
    ) {
      throw new RebuildRequired();
    }
  }
}

/**
 * 整读型增量引擎：未变化文件零读取；变化文件整文件重读（parser 依赖游标
 * 之前的父链 / last-wins / 状态机上下文，字节续读会丢失口径）；已入库的
 * 同 ID 记录被本轮解析结果替换（覆盖 last-wins 补写与计时补齐），新记录
 * 按 in-round first-wins 跨文件去重。文件集变化、伴随文件变化、同尺寸
 * 元数据变化、截断或游标前指纹失配都回退来源级重建。
 */
export async function readWholeFileUsageIncremental<F extends IncrementalFileBase>(
  store: UsageStore,
  config: WholeFileHarnessConfig<F>,
): Promise<IncrementalUsageResult> {
  const discovery = await config.discover();
  const stats = emptyIncrementalStats();

  try {
    await stat(discovery.source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {
      usage: {
        harness: config.harness,
        records: [],
        scannedFiles: 0,
        skippedFiles: 0,
        source: discovery.source,
        sourceAvailable: false,
      },
      transaction: { harness: config.harness, resetCursors: true, resetDedup: true, cursors: [] },
      stats,
    };
  }

  const previousStates = store.getSessionLogStates(config.harness);
  const auxPaths = new Set(discovery.auxiliaries.map((aux) => aux.filePath));
  const previousByPath = new Map(previousStates.map((state) => [state.filePath, state]));
  const currentPaths = new Set(discovery.files.map((file) => file.filePath));
  const previousFileStates = previousStates.filter((state) => !auxPaths.has(state.filePath));

  if (previousStates.length > 0) {
    try {
      verifyAuxiliaries(previousByPath, discovery.auxiliaries);
    } catch (error) {
      if (!(error instanceof RebuildRequired)) throw error;
      return fullImport(config, discovery, stats);
    }
  }

  if (
    previousStates.length === 0 ||
    previousFileStates.length !== discovery.files.length ||
    previousFileStates.some((state) => !currentPaths.has(state.filePath) || !validCursorShape(state)) ||
    discovery.files.some((file) => !previousByPath.has(file.filePath))
  ) {
    return fullImport(config, discovery, stats);
  }

  const recordsById = new Map(
    store.readNormalizedRecords(config.harness).map((record) => [record.id, record]),
  );
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
        if (file.size === previous.fileSize || file.size < previous.cursorOffset) {
          throw new RebuildRequired();
        }
        if (previous.cursorOffset > 0) {
          const prefix = await readRange(
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

        // 前缀校验通过后整文件重读：parser 需要游标之前的完整上下文。
        const buffer = await readFile(file.filePath);
        stats.bodyBytesRead += buffer.length;
        stats.incrementalFilesRead += 1;
        for (const record of config.parseFile(file, buffer.toString("utf8"))) {
          const candidate = canonicalRecord(record);
          if (seen.has(candidate.id)) continue;
          seen.add(candidate.id);
          recordsById.set(candidate.id, candidate);
        }
        const cursorOffset = lastCompleteLineEnd(buffer);
        cursors.push(
          sessionLogState(
            config.harness,
            file,
            cursorOffset,
            null,
            fingerprintAt(buffer, cursorOffset),
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
    return fullImport(config, discovery, stats);
  }

  for (const aux of discovery.auxiliaries) {
    if (aux.size === null) continue;
    cursors.push(auxiliaryCursor(config.harness, aux));
  }

  return result(
    config,
    discovery,
    Array.from(recordsById.values()),
    skippedFiles,
    cursors,
    false,
    stats,
  );
}

// ---------------------------------------------------------------------------
// CodeBuddy
// ---------------------------------------------------------------------------

interface CodeBuddyFile extends IncrementalFileBase {
  name: string;
  project: string;
}

async function discoverCodeBuddyFiles(): Promise<WholeFileDiscovery<CodeBuddyFile>> {
  const source = codeBuddySource();
  const files: CodeBuddyFile[] = [];
  let scannedFiles = 0;
  let skippedFiles = 0;

  let projects;
  try {
    projects = await readdir(source, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { source, files, scannedFiles, skippedFiles, auxiliaries: [] };
  }

  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const directory = path.join(source, project.name);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      skippedFiles += 1;
      continue;
    }
    for (const file of entries) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      scannedFiles += 1;
      const filePath = path.join(directory, file.name);
      try {
        const metadata = await stat(filePath);
        files.push({
          filePath,
          name: file.name,
          project: getProjectLabel(project.name),
          size: metadata.size,
          mtimeMs: metadata.mtimeMs,
        });
      } catch {
        skippedFiles += 1;
      }
    }
  }
  return { source, files, scannedFiles, skippedFiles, auxiliaries: [] };
}

export function readCodeBuddyUsageIncremental(store: UsageStore): Promise<IncrementalUsageResult> {
  return readWholeFileUsageIncremental(store, {
    harness: "codebuddy",
    discover: discoverCodeBuddyFiles,
    parseFile: (file, content) => parseSessionFile(content, file.project, file.name),
  });
}

// ---------------------------------------------------------------------------
// WorkBuddy
// ---------------------------------------------------------------------------

interface WorkBuddyFile extends IncrementalFileBase {
  name: string;
}

async function discoverWorkBuddyFiles(): Promise<WholeFileDiscovery<WorkBuddyFile>> {
  const source = workBuddySource();
  const files: WorkBuddyFile[] = [];
  let scannedFiles = 0;
  let skippedFiles = 0;

  const collect = async (filePath: string) => {
    scannedFiles += 1;
    try {
      const metadata = await stat(filePath);
      files.push({
        filePath,
        name: path.basename(filePath),
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
      });
    } catch {
      skippedFiles += 1;
    }
  };

  let projects;
  try {
    projects = await readdir(source, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { source, files, scannedFiles, skippedFiles, auxiliaries: [] };
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
      if (entry.isDirectory()) {
        // 子 agent 会话：<sessionId>/subagents/*.jsonl
        const subagentsDir = path.join(entryPath, "subagents");
        let subagents;
        try {
          subagents = await readdir(subagentsDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const subagent of subagents) {
          if (subagent.isFile() && subagent.name.endsWith(".jsonl")) {
            await collect(path.join(subagentsDir, subagent.name));
          }
        }
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      // 主会话文件；agent- 前缀的遗留宿主文件跳过（官方扫描口径）。
      if (entry.name.startsWith("agent-")) continue;
      await collect(entryPath);
    }
  }
  return { source, files, scannedFiles, skippedFiles, auxiliaries: [] };
}

export function readWorkBuddyUsageIncremental(store: UsageStore): Promise<IncrementalUsageResult> {
  return readWholeFileUsageIncremental(store, {
    harness: "workbuddy",
    discover: discoverWorkBuddyFiles,
    parseFile: (file, content) => parseWorkBuddySession(content, file.name),
  });
}

// ---------------------------------------------------------------------------
// KCode
// ---------------------------------------------------------------------------

interface KcodeFile extends IncrementalFileBase {
  context: {
    project: string;
    sessionId: string;
    agent: string;
    file: string;
  };
}

async function discoverKcodeFiles(): Promise<WholeFileDiscovery<KcodeFile>> {
  const root = kcodeRoot();
  const source = path.join(root, "sessions");
  const files: KcodeFile[] = [];
  let scannedFiles = 0;
  let skippedFiles = 0;
  const auxiliaries: WholeFileAuxiliary[] = [];

  // projects.json 项目注册表：影响全部记录的 project 归组，纳入重建触发。
  const projectsPath = path.join(root, "projects.json");
  let projectNames = new Map<string, string>();
  try {
    const [metadata, content] = await Promise.all([stat(projectsPath), readFile(projectsPath)]);
    auxiliaries.push({
      filePath: projectsPath,
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      fingerprint: fingerprintAt(content, content.length),
    });
    try {
      projectNames = parseKcodeProjectsFile(content.toString("utf8"));
    } catch {
      // 注册表内容损坏时退回目录名解析（与全量 reader 一致）。
    }
  } catch {
    auxiliaries.push({ filePath: projectsPath, size: null, mtimeMs: null, fingerprint: null });
  }

  let workspaces;
  try {
    workspaces = await readdir(source, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { source, files, scannedFiles, skippedFiles, auxiliaries };
  }

  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = path.join(source, workspace.name);
    const project = resolveKcodeProjectName(workspace.name, projectNames);
    let sessions;
    try {
      sessions = await readdir(workspaceDir, { withFileTypes: true });
    } catch {
      skippedFiles += 1;
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      // 主 agent 与每个子 agent（agents/agent-N 等）各写一份 wire。
      let agents;
      try {
        agents = await readdir(path.join(workspaceDir, session.name, "agents"), {
          withFileTypes: true,
        });
      } catch {
        skippedFiles += 1;
        continue;
      }
      for (const agent of agents) {
        if (!agent.isDirectory()) continue;
        const wirePath = path.join(workspaceDir, session.name, "agents", agent.name, "wire.jsonl");
        scannedFiles += 1;
        try {
          const metadata = await stat(wirePath);
          files.push({
            filePath: wirePath,
            size: metadata.size,
            mtimeMs: metadata.mtimeMs,
            context: {
              project,
              sessionId: session.name,
              agent: agent.name,
              file: wirePath,
            },
          });
        } catch {
          skippedFiles += 1;
        }
      }
    }
  }
  return { source, files, scannedFiles, skippedFiles, auxiliaries };
}

export function readKcodeUsageIncremental(store: UsageStore): Promise<IncrementalUsageResult> {
  return readWholeFileUsageIncremental(store, {
    harness: "kcode",
    discover: discoverKcodeFiles,
    parseFile: (file, content) => parseKcodeWireFile(content, file.context),
  });
}
