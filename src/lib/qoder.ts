import "server-only";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  attachQoderStateRecords,
  type QoderStateFileMeta,
} from "@/lib/qoder-state";
import {
  getProjectLabel,
  type HarnessUsage,
  type UsageRecord,
} from "@/lib/usage";

interface QoderMessageUsage {
  request_id?: string;
  input_tokens?: number | string;
  output_tokens?: number | string;
  total_tokens?: number | string;
  cache_read_input_tokens?: number | string;
  cache_creation_input_tokens?: number | string;
  credits?: number | string;
  /** 折扣或促销前的价格，不是实际消耗，不参与统计。 */
  original_credits?: number | string;
  billable?: boolean;
  context_usage_ratio?: number | string;
}

interface QoderSessionRecord {
  type?: string;
  uuid?: string;
  timestamp?: number | string;
  sessionId?: string;
  status?: string;
  isApiErrorMessage?: boolean;
  message?: {
    id?: string;
    model?: string;
    stop_reason?: string;
    usage?: QoderMessageUsage;
  };
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = finiteNumber(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }
  return undefined;
}

/** 单行 → 记录；供全量 reader 与增量 reader 共用同一解析口径。 */
export function parseSessionLine(
  line: string,
  project: string,
  file: string,
  lineIndex: number,
): UsageRecord | null {
  let record: QoderSessionRecord;
  try {
    record = JSON.parse(line) as QoderSessionRecord;
  } catch {
    return null;
  }

  const usage = record.message?.usage;
  if (!usage) return null;
  const timestamp = parseTimestamp(record.timestamp);
  if (timestamp === undefined) return null;

  const inputTokens = firstNumber(usage.input_tokens) ?? 0;
  const outputTokens = firstNumber(usage.output_tokens) ?? 0;
  const cacheReadTokens = firstNumber(usage.cache_read_input_tokens) ?? 0;
  const cacheCreationTokens = firstNumber(usage.cache_creation_input_tokens) ?? 0;
  const totalTokens =
    firstNumber(usage.total_tokens) ??
    inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
  // 与 Qoder 自身的会话积分统计一致：只累计 billable=true 的 credits。
  // billable=false 的请求服务端仍报告非零 credits，但不扣费；缺少 billable 视为计量不完整。
  const reportedCredits = nonNegativeNumber(usage.credits);
  const billable = typeof usage.billable === "boolean" ? usage.billable : undefined;
  const hasCredit =
    billable === false || (billable === true && reportedCredits !== undefined);
  const credits = billable === true ? reportedCredits ?? 0 : 0;
  const sessionId = record.sessionId ?? path.basename(file, ".jsonl");
  const fallbackId = record.message?.id ?? record.uuid ?? `${file}:${lineIndex}`;
  const requestId = usage.request_id ?? fallbackId;
  const failedStatuses = new Set(["error", "failed", "cancelled", "canceled"]);

  return {
    id: `qoder:${requestId}`,
    requestId,
    sessionId,
    harness: "qoder",
    project,
    model: record.message?.model ?? "未知模型",
    provider: "Qoder",
    timestamp,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    inputTokenSemantics: "fresh",
    hasTokenUsage: totalTokens > 0,
    credits,
    hasCredit,
    reportedCredits,
    billable,
    contextUsageRatio: finiteNumber(usage.context_usage_ratio),
    status:
      record.isApiErrorMessage ||
      failedStatuses.has(record.status?.toLowerCase() ?? "") ||
      record.message?.stop_reason === "error"
        ? "error"
        : "success",
  };
}

/** 会话目录内聚合用量文件；<project>/<sessionId>/state.json（compression-v2 等更深层的同名文件不是用量库）。 */
const QODER_STATE_FILE = "state.json";

/** 从一行 jsonl 里提取 cwd（workspace 路径），供 state.json 解密的 AAD 候选。 */
export function extractQoderCwd(line: string): { sessionId?: string; cwd?: string } {
  if (!line.includes("\"cwd\"")) return {};
  try {
    const parsed = JSON.parse(line) as { cwd?: unknown; sessionId?: unknown };
    const cwd = typeof parsed.cwd === "string" && parsed.cwd !== "" ? parsed.cwd : undefined;
    const sessionId =
      typeof parsed.sessionId === "string" && parsed.sessionId !== ""
        ? parsed.sessionId
        : undefined;
    return cwd === undefined ? {} : { sessionId, cwd };
  } catch {
    return {};
  }
}

/** 项目目录名反推 workspace 路径："-Users-zch-code-x" → "/Users/zch/code/x"，"-" → "/"。 */
export function qoderDerivedWorkspaceRoot(projectDirName: string): string {
  return "/" + projectDirName.replace(/^-/, "").replace(/-/g, "/");
}

const QODER_BLOCKED_DIR_NAMES = new Set([
  ".git",
  ".svn",
  ".hg",
  ".vscode",
  ".idea",
  ".husky",
  ".github",
  "node_modules",
  "bower_components",
]);

function resolveQoderConfigDirName(raw: string | undefined): string {
  if (raw === undefined || raw === "") return ".qoder-cn";
  const normalized = raw.normalize("NFC");
  const length = Array.from(normalized).length;
  if (
    length >= 1 &&
    length <= 64 &&
    !normalized.startsWith(" ") &&
    !normalized.endsWith(" ") &&
    !normalized.endsWith(".") &&
    normalized !== "." &&
    normalized !== ".." &&
    /^[\p{L}\p{N}\p{M}._ -]+$/u.test(normalized) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(normalized) &&
    !QODER_BLOCKED_DIR_NAMES.has(normalized.toLocaleLowerCase("en-US"))
  ) {
    return normalized;
  }
  throw new Error("QODERCN_CONFIG_DIR_NAME is not a valid configuration directory name.");
}

export function qoderSource(): string {
  if (process.env.QODER_DATA_DIR) return path.resolve(process.env.QODER_DATA_DIR);
  // 对齐本机 Qoder CN 主进程 WV/pxt 与 qoder-cn-agent-sdk 的 Na/Te：
  // QODERCN_CONFIG_DIR 是完整配置根；未设置时用 QODERCN_CLI_HOME（缺省 homedir）
  // 拼接 QODERCN_CONFIG_DIR_NAME（缺省 .qoder-cn），会话位于其 projects 下。
  const configuredDir = process.env.QODERCN_CONFIG_DIR;
  const root = configuredDir
    ? path.resolve(configuredDir).normalize("NFC")
    : path
        .join(
          path.resolve(process.env.QODERCN_CLI_HOME || homedir()),
          resolveQoderConfigDirName(process.env.QODERCN_CONFIG_DIR_NAME),
        )
        .normalize("NFC");
  return path.join(root, "projects");
}

export async function readQoderUsage(): Promise<HarnessUsage> {
  const source = qoderSource();
  const records: UsageRecord[] = [];
  const seen = new Set<string>();
  const stateFiles: QoderStateFileMeta[] = [];
  const cwdsBySession = new Map<string, string[]>();
  let scannedFiles = 0;
  let skippedFiles = 0;
  let sourceAvailable = true;

  function collectCwd(line: string, fallbackSessionId: string) {
    const { sessionId, cwd } = extractQoderCwd(line);
    if (cwd === undefined) return;
    const key = sessionId ?? fallbackSessionId;
    const existing = cwdsBySession.get(key);
    if (existing === undefined) {
      cwdsBySession.set(key, [cwd]);
    } else if (!existing.includes(cwd)) {
      existing.push(cwd);
    }
  }

  async function scanDirectory(
    directory: string,
    project: string,
    depth: number,
    isRoot = false,
  ) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isRoot && (error as NodeJS.ErrnoException).code === "ENOENT") {
        sourceAvailable = false;
        return;
      }
      if (isRoot) throw error;
      skippedFiles += 1;
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await scanDirectory(
          entryPath,
          project || getProjectLabel(entry.name),
          depth + 1,
        );
        continue;
      }
      if (!entry.isFile()) continue;
      // 会话目录（<project>/<sessionId>）里的聚合用量库。
      if (depth === 3 && entry.name === QODER_STATE_FILE) {
        scannedFiles += 1;
        stateFiles.push({
          filePath: entryPath,
          sessionId: path.basename(directory),
          project: project || "未知项目",
          artifactDir: path.dirname(directory),
          derivedRoot: qoderDerivedWorkspaceRoot(path.basename(path.dirname(directory))),
        });
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;

      scannedFiles += 1;
      try {
        const content = await readFile(entryPath, "utf8");
        const lines = content.split(/\r?\n/);
        const fileSessionId = path.basename(entry.name, ".jsonl");
        for (let index = 0; index < lines.length; index += 1) {
          if (!lines[index].trim()) continue;
          collectCwd(lines[index], fileSessionId);
          const record = parseSessionLine(
            lines[index],
            project || "未知项目",
            entry.name,
            index,
          );
          if (!record || seen.has(record.id)) continue;
          seen.add(record.id);
          records.push(record);
        }
      } catch {
        skippedFiles += 1;
      }
    }
  }

  await scanDirectory(source, "", 1, true);

  // 1.1.86 起逐请求 usage 只保留在加密 state.json 的会话聚合里；按会话差值
  // 补一条记录，与 jsonl 逐请求记录合并后即完整口径（差值为零的老会话不产出）。
  const attached = await attachQoderStateRecords(stateFiles, cwdsBySession, records);
  attached.records.sort((a, b) => b.timestamp - a.timestamp);
  return {
    harness: "qoder",
    records: attached.records,
    scannedFiles,
    skippedFiles: skippedFiles + attached.skippedFiles,
    source,
    sourceAvailable,
  };
}
