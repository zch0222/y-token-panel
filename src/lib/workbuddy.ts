import "server-only";
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseWorkBuddySession } from "@/lib/workbuddy-session";
import type { HarnessUsage, UsageRecord } from "@/lib/usage";

/**
 * 读取 WorkBuddy（CodeBuddy 衍生）本地会话用量。
 *
 * 数据源与去重口径见 src/lib/workbuddy-session.ts 文件头。布局只认官方
 * getSessionJsonlLayout 的两种形态：
 * - `projects/<压缩 cwd>/<sessionId>.jsonl`（主会话；`agent-` 前缀的遗留文件
 *   跳过，与 SessionFacetService 扫描一致）；
 * - `projects/<压缩 cwd>/<父 sessionId>/subagents/agent-*.jsonl`（子 agent 会话，
 *   用量同样真实发生，计入）。
 * 其余目录（workflows / tool-results / stdio 等）不含会话记录，不扫描。
 *
 * 配置根目录：优先读取 WORKBUDDY_DATA_DIR（面板测试覆盖及 WorkBuddy
 * daemon-app-server-main.js 同名根目录变量），其次 WorkBuddy 自身的
 * WORKBUDDY_CONFIG_DIR（workbuddy-product-config.js 的 resolveWorkbuddyConfigDir
 * 与 codebuddy-lite-wb.mjs 的 getWorkbuddyConfigDir），默认 ~/.workbuddy。
 * 注：workbuddy-paths2.js 中的 WORKBUDDY_INSTANCE_NUMBER 仅用于窗口名与 URI
 * scheme，不改变配置目录；面板同进程同时读取 CodeBuddy，故此处故意不回退读取
 * CODEBUDDY_CONFIG_DIR，避免把 WorkBuddy 误指到 CodeBuddy 目录。
 */
export function workBuddySource(): string {
  const dataDir = process.env.WORKBUDDY_DATA_DIR?.trim();
  const configDir = process.env.WORKBUDDY_CONFIG_DIR?.trim();
  const root = dataDir
    ? path.resolve(dataDir)
    : configDir
      ? path.resolve(configDir)
      : path.join(homedir(), ".workbuddy");
  return path.join(root, "projects");
}

export async function readWorkBuddyUsage(): Promise<HarnessUsage> {
  const source = workBuddySource();

  const records: UsageRecord[] = [];
  const seen = new Set<string>();
  let scannedFiles = 0;
  let skippedFiles = 0;
  let sourceAvailable = true;

  const collect = async (filePath: string) => {
    scannedFiles += 1;
    try {
      const content = await readFile(filePath, "utf8");
      for (const record of parseWorkBuddySession(content, path.basename(filePath))) {
        if (seen.has(record.id)) continue;
        seen.add(record.id);
        records.push(record);
      }
    } catch {
      skippedFiles += 1;
    }
  };

  let projects: Dirent[];
  try {
    projects = await readdir(source, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      sourceAvailable = false;
      projects = [];
    } else {
      throw error;
    }
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
        // 子 agent 会话：<sessionId>/subagents/agent-*.jsonl
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

  records.sort((a, b) => b.timestamp - a.timestamp);
  return {
    harness: "workbuddy",
    records,
    scannedFiles,
    skippedFiles,
    source,
    sourceAvailable,
  };
}
