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

function expandDshHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

export function dshSource(): string {
  // @deepseek-ai/dsh-home-paths 的 resolveDshHome：显式参数 > 非空白
  // DSH_HOME > ~/.dsh，并只展开 ~、~/ 与 ~\；显式参数由调用方传入，
  // 不是 settings.yaml 中的持久配置，面板无需虚构该配置项。
  const fromEnv = process.env.DSH_HOME;
  const home =
    fromEnv !== undefined && fromEnv.trim().length > 0
      ? fromEnv
      : path.join(homedir(), ".dsh");
  return path.join(path.resolve(expandDshHome(home)), "sessions");
}

export async function readDshUsage(): Promise<HarnessUsage> {
  const source = dshSource();
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

  records.sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
  return {
    harness: "dsh",
    records,
    scannedFiles,
    skippedFiles,
    source,
    sourceAvailable: true,
  };
}
