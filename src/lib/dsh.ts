import "server-only";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  completeLines,
  decodeZstdFrames,
  dshProjectLabel,
  parseDshSessionLog,
} from "@/lib/dsh-session";
import type { HarnessUsage, UsageRecord } from "@/lib/usage";

const zstdDecompressSync: ((buffer: Buffer) => Buffer) | undefined =
  typeof zlib.zstdDecompressSync === "function"
    ? (buffer) => zlib.zstdDecompressSync(buffer)
    : undefined;

/** 只认 DSH 的会话日志：session.<版本>.jsonl 或 session.<版本>.jsonl.zstd（v0 原名 session.jsonl.zstd）。 */
function isSessionLogName(name: string): boolean {
  return (
    name.startsWith("session.") &&
    (name.endsWith(".jsonl") || name.endsWith(".jsonl.zstd"))
  );
}

export async function readDshUsage(): Promise<HarnessUsage> {
  // DSH 自身的 home 解析顺序（dsh-home-paths）：显式配置 > $DSH_HOME（空白视为
  // 未设置）> ~/.dsh。会话固定在其下的 sessions/ 目录。
  const home =
    process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ""
      ? path.resolve(process.env.DSH_HOME)
      : path.join(homedir(), ".dsh");
  const source = path.join(home, "sessions");
  const records: UsageRecord[] = [];
  const seen = new Set<string>();
  let scannedFiles = 0;
  let skippedFiles = 0;

  let projects;
  try {
    projects = await readdir(source, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        harness: "dsh",
        records: [],
        scannedFiles: 0,
        skippedFiles: 0,
        source,
        sourceAvailable: false,
      };
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
      let files;
      try {
        files = await readdir(sessionDirectory, { withFileTypes: true });
      } catch {
        skippedFiles += 1;
        continue;
      }

      for (const file of files) {
        if (!file.isFile() || !isSessionLogName(file.name)) continue;
        scannedFiles += 1;
        const filePath = path.join(sessionDirectory, file.name);
        try {
          const buffer = await readFile(filePath);
          // 同一会话目录可能并存多个版本文件（v0/v3/v4 迁移保留的旧代），
          // 重复内容靠消息 ID 全局去重，这里不做版本挑选。
          const text =
            file.name.endsWith(".jsonl.zstd") && zstdDecompressSync
              ? completeLines(decodeZstdFrames(buffer, zstdDecompressSync).toString("utf8"))
              : completeLines(buffer.toString("utf8"));
          for (const record of parseDshSessionLog(
            text,
            dshProjectLabel(project.name),
            session.name,
          )) {
            if (seen.has(record.id)) continue;
            seen.add(record.id);
            records.push(record);
          }
        } catch {
          skippedFiles += 1;
        }
      }
    }
  }

  records.sort((a, b) => b.timestamp - a.timestamp);
  return {
    harness: "dsh",
    records,
    scannedFiles,
    skippedFiles,
    source,
    sourceAvailable: true,
  };
}
