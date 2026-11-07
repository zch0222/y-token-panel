import "server-only";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parseClaudeTranscriptFile } from "@/lib/claude-session";
import type { HarnessUsage, UsageRecord } from "@/lib/usage";

/**
 * 读取 Claude Code 的本地会话转录。默认数据目录 ~/.claude，可用 Claude Code
 * 自身的 CLAUDE_CONFIG_DIR 环境变量替换（claude.exe 中配置目录即取该变量，
 * 缺省 ~/.claude），其下按 projects/<项目目录>/<会话>.jsonl 组织；子 agent
 * 转录在 projects/<项目目录>/<会话>/subagents/*.jsonl，Workflow 子 agent 再深
 * 一层 workflows/wf_<id>/*.jsonl（目录布局与 cc-switch 的会话收集一致）。
 * 字段语义与解析口径见 src/lib/claude-session.ts 文件头。
 */
export async function readClaudeUsage(): Promise<HarnessUsage> {
  const root = process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(homedir(), ".claude");
  const source = path.join(root, "projects");

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
        harness: "claude",
        records: [],
        scannedFiles: 0,
        skippedFiles: 0,
        source,
        sourceAvailable: false,
      };
    }
    throw error;
  }

  const importFile = async (file: string, directory: string) => {
    scannedFiles += 1;
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      skippedFiles += 1;
      return;
    }
    for (const record of parseClaudeTranscriptFile(content, {
      directory,
      sessionId: path.basename(file, ".jsonl"),
      file: path.basename(file),
    })) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      records.push(record);
    }
  };

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
      // 项目目录下的 <会话>.jsonl 是主会话转录。
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        await importFile(entryPath, project.name);
        continue;
      }
      if (!entry.isDirectory()) continue;

      // <会话>/subagents/*.jsonl 与 subagents/workflows/wf_<id>/*.jsonl 是
      // 子 agent 转录，格式与主会话相同。
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
          await importFile(agentPath, project.name);
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
          let files;
          try {
            files = await readdir(workflowDir, { withFileTypes: true });
          } catch {
            skippedFiles += 1;
            continue;
          }
          for (const file of files) {
            if (file.isFile() && file.name.endsWith(".jsonl")) {
              await importFile(path.join(workflowDir, file.name), project.name);
            }
          }
        }
      }
    }
  }

  records.sort((a, b) => b.timestamp - a.timestamp);
  return {
    harness: "claude",
    records,
    scannedFiles,
    skippedFiles,
    source,
    sourceAvailable: true,
  };
}
