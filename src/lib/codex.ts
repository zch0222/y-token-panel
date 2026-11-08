import "server-only";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  FILE_IO_CONCURRENCY,
  fingerprintAt,
  lastCompleteLineEnd,
  mapBounded,
} from "@/lib/incremental-core";
import {
  CodexAssembly,
  type CodexRolloutEntry,
} from "@/lib/codex-assembly";
import {
  codexThreadIdFromFilename,
  leadingCodexThreadIdFromFilename,
} from "@/lib/codex-session";
import type { HarnessUsage, UsageRecord } from "@/lib/usage";

/**
 * 读取 Codex / ChatGPT 的本地 rollout 会话记录。默认数据目录 ~/.codex（Codex
 * 自身的 CODEX_HOME 环境变量可替换，本机 codex.exe 二进制确认），其下
 * sessions/YYYY/MM/DD/rollout-*.jsonl（7 天不动会被压成 .jsonl.zst）与
 * archived_sessions/。字段语义与解析口径见 src/lib/codex-session.ts 文件头；
 * 跨文件去重与 fork 重放剔除的编排见 src/lib/codex-assembly.ts（与 cc-switch
 * 的 sync_codex_usage / resolve_parent_signatures 对齐）：
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

/** Codex 数据根目录（CODEX_HOME 可覆盖）。 */
export function codexRoot(): string {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(homedir(), ".codex");
}

export interface CodexDiscoveredFile {
  filePath: string;
  fileName: string;
  size: number;
  mtimeMs: number;
}

export interface CodexDiscovery {
  source: string;
  files: CodexDiscoveredFile[];
  /** stat 失败（被锁/权限等）的文件数：按读取失败计入 skippedFiles。 */
  skippedFiles: number;
}

/**
 * 发现全部 rollout 文件（sessions 三层日期目录 + archived_sessions 平铺），
 * 与全量 reader 同一目录遍历、兄弟形态去重和排序。stat 失败的文件按读取失败
 * 计入 skippedFiles 并退出本轮文件集（持续不可读会在一次来源级重建后稳定）。
 */
export async function discoverCodexRolloutFiles(): Promise<CodexDiscovery> {
  const root = codexRoot();
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
  const statResults = await mapBounded(files, FILE_IO_CONCURRENCY, async (filePath) => {
    try {
      const metadata = await stat(filePath);
      return {
        filePath,
        fileName: path.basename(filePath),
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
      };
    } catch {
      return null;
    }
  });
  const discovered: CodexDiscoveredFile[] = [];
  let skippedFiles = 0;
  for (const result of statResults) {
    if (result === null) skippedFiles += 1;
    else discovered.push(result);
  }
  return { source: root, files: discovered, skippedFiles };
}

/**
 * 读取 rollout 正文（.jsonl.zst 解压）。游标/指纹锚点按形态区分：普通文件用
 * 解压字节里的最后完整 LF 行末；压缩文件没有可移植的解压偏移，用物理字节
 * 大小做锚点（同尺寸重写与增长前缀校验都按压缩字节判断）。读取或解压失败
 * 返回 undefined（调用方按 skippedFiles 处理，与其他来源口径一致）。
 */
export interface CodexRolloutContent {
  /** 解压后的正文（普通文件即原始字节）。 */
  content: Buffer;
  /** 指纹锚点字节偏移。 */
  cursorOffset: number;
  /** 锚点处的前缀指纹。 */
  tailFingerprint: string;
}

export async function readCodexRolloutContent(
  filePath: string,
): Promise<CodexRolloutContent | undefined> {
  try {
    const raw = await readFile(filePath);
    if (!filePath.endsWith(".jsonl.zst")) {
      const cursorOffset = lastCompleteLineEnd(raw);
      return {
        content: raw,
        cursorOffset,
        tailFingerprint: fingerprintAt(raw, cursorOffset),
      };
    }
    return {
      content: zstdDecompress?.(raw) ?? raw,
      cursorOffset: raw.length,
      tailFingerprint: fingerprintAt(raw, raw.length),
    };
  } catch {
    return undefined;
  }
}

export function codexEntryOf(file: {
  filePath: string;
  fileName: string;
}): CodexRolloutEntry {
  return {
    path: file.filePath,
    fileName: file.fileName,
    threadId: codexThreadIdFromFilename(file.fileName),
    leadingThreadId: leadingCodexThreadIdFromFilename(file.fileName),
  };
}

export async function readCodexUsage(): Promise<HarnessUsage> {
  const source = codexRoot();

  let scannedFiles = 0;
  let skippedFiles = 0;

  // sessions 目录不存在视为来源不可用；archived_sessions 是可选的平铺归档目录。
  try {
    await stat(path.join(source, "sessions"));
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

  const discovery = await discoverCodexRolloutFiles();
  // stat 失败的文件与全量读取失败同口径：计入 scanned 与 skipped。
  scannedFiles = discovery.files.length + discovery.skippedFiles;
  skippedFiles += discovery.skippedFiles;
  const entries = discovery.files.map(codexEntryOf);

  // 有界并发读取正文（解压后字节），解析与组装仍按文件序进行。
  const buffers = await mapBounded(
    discovery.files,
    FILE_IO_CONCURRENCY,
    async (file) => readCodexRolloutContent(file.filePath),
  );
  for (const [index, loaded] of buffers.entries()) {
    if (loaded === undefined) {
      skippedFiles += 1;
      continue;
    }
    entries[index]!.content = loaded.content.toString("utf8");
  }

  const assembly = new CodexAssembly(entries);
  const records: UsageRecord[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const result = assembly.assembleEntry(entry, seen);
    records.push(...result.records);
    if (
      result.outcome !== "imported" &&
      result.outcome !== "no-billable" &&
      entry.content !== undefined
    ) {
      skippedFiles += 1;
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
