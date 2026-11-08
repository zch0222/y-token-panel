import "server-only";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  parseAntigravityTranscript,
  projectLabelFromWorkspaceUris,
} from "@/lib/antigravity-session";
import { readGenerationTimings } from "@/lib/antigravity-timing";
import type { IncrementalFileBase } from "@/lib/incremental-core";
import type { HarnessUsage, UsageRecord } from "@/lib/usage";
import type { WholeFileAuxiliary } from "@/lib/wholefile-incremental";

/**
 * Antigravity 数据源：默认读取本机 Antigravity IDE 的
 * ~/.gemini/antigravity/brain/<会话>/.system_generated/logs/transcript.jsonl，
 * 以及 agy CLI 的同构目录 ~/.gemini/antigravity-cli/brain（两者都存在时合并、
 * 同一会话 ID 只算一次）。字段语义见 src/lib/antigravity-session.ts 文件头。
 *
 * ANTIGRAVITY_DATA_DIR 是面板专用覆盖：指向含 brain/ 与
 * conversation_summaries.db 的 Antigravity 数据根目录，便于指定其他安装或
 * 测试注入。未设置时同时尝试 IDE 与 CLI 两个默认根。
 */

export const UNKNOWN_ANTIGRAVITY_PROJECT = "未知项目";

/**
 * 解析口径版本。记录内容语义变化（例如新增原生耗时）时递增：整读型增量只重读
 * 变化文件，旧记录不会自动重算；这里把版本当成稳定的“伴随文件”参与游标校验，
 * 版本不一致就触发一次来源级重建，让已入库记录按新口径重新解析。
 */
export const ANTIGRAVITY_PARSER_VERSION = 2;
export const ANTIGRAVITY_PARSER_MARKER = "antigravity:parser-version";

const TRANSCRIPT_NAMES = ["transcript.jsonl", "transcript_full.jsonl"] as const;

export interface AntigravityPathOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string;
}

/** 默认 IDE 根优先；两者都缺失时按第一个根报告数据目录。 */
export function antigravityRoots({
  env = process.env,
  homeDir = homedir(),
}: AntigravityPathOptions = {}): string[] {
  const override = env.ANTIGRAVITY_DATA_DIR?.trim();
  if (override) return [path.resolve(override)];
  return [
    path.join(homeDir, ".gemini", "antigravity"),
    path.join(homeDir, ".gemini", "antigravity-cli"),
  ];
}

export interface AntigravityTranscriptFile extends IncrementalFileBase {
  conversationId: string;
  project: string;
  /** 原生会话库：提供每次生成的精确耗时（首字 + 流式）。 */
  conversationDbPath: string;
}

export interface AntigravityDiscovery {
  source: string;
  files: AntigravityTranscriptFile[];
  scannedFiles: number;
  skippedFiles: number;
  /** 项目归属只在 discovery 时读取，不作为触发重建的伴随文件；这里只放解析版本标记。 */
  auxiliaries: WholeFileAuxiliary[];
}

/**
 * conversation_summaries 只提供项目归属；模型与用量都来自转录本身。读取失败
 * （库不存在、被锁、schema 不同）时退回「未知项目」，不影响用量导入。
 */
async function readConversationProjects(dbPath: string): Promise<Map<string, string>> {
  const projects = new Map<string, string>();
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return projects;
  }

  let db: InstanceType<typeof DatabaseSync>;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return projects;
  }

  try {
    const rows = db
      .prepare("SELECT conversation_id, workspace_uris FROM conversation_summaries")
      .all() as unknown as Array<{ conversation_id?: unknown; workspace_uris?: unknown }>;
    for (const row of rows) {
      if (typeof row.conversation_id !== "string" || typeof row.workspace_uris !== "string") {
        continue;
      }
      const label = projectLabelFromWorkspaceUris(row.workspace_uris);
      if (label) projects.set(row.conversation_id, label);
    }
  } catch {
    // 索引库 schema 变化或读取失败：项目名退回未知，不影响记录本身。
  } finally {
    try {
      db.close();
    } catch {
      // 忽略关闭失败。
    }
  }
  return projects;
}

async function transcriptPath(logsDir: string): Promise<string | undefined> {
  for (const name of TRANSCRIPT_NAMES) {
    const filePath = path.join(logsDir, name);
    try {
      if ((await stat(filePath)).isFile()) return filePath;
    } catch {
      // 该形态不存在，尝试下一种。
    }
  }
  return undefined;
}

/**
 * 发现全部会话转录。只读 logs 目录下的紧凑转录（没有时回退全量）；brain 下
 * 的非会话目录（如 tempmediaStorage）没有 .system_generated，直接跳过。
 */
export async function discoverAntigravityTranscripts(
  options: AntigravityPathOptions = {},
): Promise<AntigravityDiscovery> {
  const roots = antigravityRoots(options);
  const files: AntigravityTranscriptFile[] = [];
  let scannedFiles = 0;
  let skippedFiles = 0;
  let source: string | undefined;

  for (const root of roots) {
    const brain = path.join(root, "brain");
    try {
      if (!(await stat(brain)).isDirectory()) continue;
    } catch {
      continue;
    }
    source ??= brain;

    let conversations;
    try {
      conversations = await readdir(brain, { withFileTypes: true });
    } catch {
      skippedFiles += 1;
      continue;
    }

    const projects = await readConversationProjects(
      path.join(root, "conversation_summaries.db"),
    );

    for (const entry of conversations) {
      if (!entry.isDirectory()) continue;
      const logs = path.join(brain, entry.name, ".system_generated", "logs");
      try {
        if (!(await stat(logs)).isDirectory()) continue;
      } catch {
        continue;
      }

      const filePath = await transcriptPath(logs);
      if (!filePath) {
        skippedFiles += 1;
        continue;
      }
      try {
        const metadata = await stat(filePath);
        scannedFiles += 1;
        files.push({
          filePath,
          size: metadata.size,
          mtimeMs: metadata.mtimeMs,
          conversationId: entry.name,
          project: projects.get(entry.name) ?? UNKNOWN_ANTIGRAVITY_PROJECT,
          conversationDbPath: path.join(root, "conversations", `${entry.name}.db`),
        });
      } catch {
        skippedFiles += 1;
      }
    }
  }

  return {
    source: source ?? path.join(roots[0]!, "brain"),
    files,
    scannedFiles,
    skippedFiles,
    auxiliaries: [
      {
        filePath: ANTIGRAVITY_PARSER_MARKER,
        size: ANTIGRAVITY_PARSER_VERSION,
        mtimeMs: 0,
        fingerprint: `antigravity-parser-v${ANTIGRAVITY_PARSER_VERSION}`,
      },
    ],
  };
}

export async function readAntigravityUsage(
  options: AntigravityPathOptions = {},
): Promise<HarnessUsage> {
  const discovery = await discoverAntigravityTranscripts(options);
  const records = new Map<string, UsageRecord>();
  let skippedFiles = discovery.skippedFiles;

  for (const file of discovery.files) {
    try {
      const content = await readFile(file.filePath, "utf8");
      for (const record of parseAntigravityTranscript(
        content,
        file.conversationId,
        file.project,
        { timings: readGenerationTimings(file.conversationDbPath) },
      )) {
        records.set(record.id, record);
      }
    } catch {
      skippedFiles += 1;
    }
  }

  let sourceAvailable = false;
  try {
    sourceAvailable = (await stat(discovery.source)).isDirectory();
  } catch {
    sourceAvailable = false;
  }

  const sorted = Array.from(records.values()).sort(
    (a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id),
  );
  return {
    harness: "antigravity",
    records: sorted,
    scannedFiles: discovery.scannedFiles,
    skippedFiles,
    source: discovery.source,
    sourceAvailable,
  };
}
