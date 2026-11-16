import "server-only";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  parseKcodeConfigFile,
  parseKcodeProjectsFile,
  parseKcodeWireFile,
  resolveKcodeProjectName,
  type KcodeConfiguredModel,
} from "@/lib/kcode-session";
import type { HarnessUsage, UsageRecord } from "@/lib/usage";

/**
 * 读取 Kimi Code（kcode）的本地会话 wire 记录。默认数据目录 ~/.kimi-code，
 * 可用 kcode 自身的 KIMI_CODE_HOME 环境变量替换（本机 Kimi Code 主进程与
 * cc-switch 的 kimi_config::data_dir 同款：空白忽略，主进程支持 ~ / ~/ / ~\
 * 展开），其下按 sessions/<workspace>/<session>/agents/<agent>/wire.jsonl
 * 组织。字段语义与解析口径见 src/lib/kcode-session.ts 文件头。
 */
function expandKcodeHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
}

export function kcodeRoot(): string {
  const configured = process.env.KIMI_CODE_HOME?.trim();
  return configured
    ? path.resolve(expandKcodeHome(configured))
    : path.join(homedir(), ".kimi-code");
}

export async function readKcodeUsage(): Promise<HarnessUsage> {
  const root = kcodeRoot();
  const source = path.join(root, "sessions");

  const records: UsageRecord[] = [];
  const seen = new Set<string>();
  let scannedFiles = 0;
  let skippedFiles = 0;

  let workspaces;
  try {
    workspaces = await readdir(source, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        harness: "kcode",
        records: [],
        scannedFiles: 0,
        skippedFiles: 0,
        source,
        sourceAvailable: false,
      };
    }
    throw error;
  }

  const [projectNames, configuredModels] = await Promise.all([
    readOptionalKcodeMap(path.join(root, "projects.json"), parseKcodeProjectsFile),
    readKcodeConfig(path.join(root, "config.toml")),
  ]);

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
        const wirePath = path.join(
          workspaceDir,
          session.name,
          "agents",
          agent.name,
          "wire.jsonl",
        );
        scannedFiles += 1;
        let content: string;
        try {
          content = await readFile(wirePath, "utf8");
        } catch {
          skippedFiles += 1;
          continue;
        }
        for (const record of parseKcodeWireFile(content, {
          project,
          sessionId: session.name,
          agent: agent.name,
          file: wirePath,
          models: configuredModels,
        })) {
          if (seen.has(record.id)) continue;
          seen.add(record.id);
          records.push(record);
        }
      }
    }
  }

  records.sort((a, b) => b.timestamp - a.timestamp);
  return {
    harness: "kcode",
    records,
    scannedFiles,
    skippedFiles,
    source,
    sourceAvailable: true,
  };
}

/** 读取 `~/.kimi-code/config.toml` 的 `[models.*]` 映射；缺失或不可读时返回空 Map。 */
export function readKcodeConfig(
  configPath: string,
): Promise<Map<string, KcodeConfiguredModel>> {
  return readOptionalKcodeMap(configPath, parseKcodeConfigFile);
}

async function readOptionalKcodeMap<V>(
  filePath: string,
  parse: (content: string) => Map<string, V>,
): Promise<Map<string, V>> {
  try {
    return parse(await readFile(filePath, "utf8"));
  } catch {
    // 配置 / 注册表缺失或读失败时退回默认规则，不阻断用量统计。
    return new Map();
  }
}
