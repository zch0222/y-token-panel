import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  deriveProvider,
  getProjectLabel,
  type UsageRecord,
  type UsageResponse,
} from "@/lib/usage";

interface MessageUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  credit?: number | string;
  prompt_cache_hit_tokens?: number;
  prompt_cache_write_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface ProviderData {
  model?: string;
  requestModelId?: string;
  conversationRequestId?: string;
  messageId?: string;
  rawUsage?: RawUsage;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    inputTokensDetails?: Array<{ cached_tokens?: number }>;
  };
}

interface SessionRecord {
  id?: string;
  timestamp?: number | string;
  status?: string;
  sessionId?: string;
  message?: { usage?: MessageUsage };
  providerData?: ProviderData;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
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

function parseSessionLine(
  line: string,
  project: string,
  file: string,
  lineIndex: number,
): UsageRecord | null {
  let record: SessionRecord;
  try {
    record = JSON.parse(line) as SessionRecord;
  } catch {
    return null;
  }

  const providerData = record.providerData;
  const messageUsage = record.message?.usage;
  const rawUsage = providerData?.rawUsage;
  if (!messageUsage && !providerData?.usage && !rawUsage) return null;

  const timestamp = parseTimestamp(record.timestamp);
  if (timestamp === undefined) return null;

  const inputTokens = firstNumber(
    messageUsage?.input_tokens,
    rawUsage?.prompt_tokens,
    providerData?.usage?.inputTokens,
  ) ?? 0;
  const outputTokens = firstNumber(
    messageUsage?.output_tokens,
    rawUsage?.completion_tokens,
    providerData?.usage?.outputTokens,
  ) ?? 0;
  const cacheReadTokens = firstNumber(
    messageUsage?.cache_read_input_tokens,
    rawUsage?.prompt_cache_hit_tokens,
    rawUsage?.prompt_tokens_details?.cached_tokens,
    rawUsage?.cache_read_input_tokens,
    providerData?.usage?.inputTokensDetails?.[0]?.cached_tokens,
  ) ?? 0;
  const cacheCreationTokens = firstNumber(
    messageUsage?.cache_creation_input_tokens,
    rawUsage?.prompt_cache_write_tokens,
    rawUsage?.cache_creation_input_tokens,
  ) ?? 0;
  const totalTokens = firstNumber(
    messageUsage?.total_tokens,
    rawUsage?.total_tokens,
    providerData?.usage?.totalTokens,
  ) ?? inputTokens + outputTokens;
  const credits = finiteNumber(rawUsage?.credit);
  const sessionId = record.sessionId ?? path.basename(file, ".jsonl");
  const id = record.id ?? providerData?.messageId ?? `${file}:${lineIndex}`;
  const model = providerData?.model ?? providerData?.requestModelId ?? "未知模型";
  const failedStatuses = new Set(["error", "failed", "cancelled", "canceled"]);

  return {
    id: `${sessionId}:${id}`,
    requestId: providerData?.conversationRequestId ?? id,
    sessionId,
    project,
    model,
    provider: deriveProvider(model),
    timestamp,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    credits: credits ?? 0,
    hasCredit: credits !== undefined,
    status: failedStatuses.has(record.status?.toLowerCase() ?? "") ? "error" : "success",
  };
}

export async function readCodeBuddyUsage(): Promise<UsageResponse> {
  const source = process.env.CODEBUDDY_DATA_DIR
    ? path.resolve(process.env.CODEBUDDY_DATA_DIR)
    : path.join(homedir(), ".codebuddy", "projects");
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
        records: [],
        scannedFiles: 0,
        skippedFiles: 0,
        syncedAt: Date.now(),
        source,
        sourceAvailable: false,
      };
    }
    throw error;
  }

  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const directory = path.join(source, project.name);
    let files;
    try {
      files = await readdir(directory, { withFileTypes: true });
    } catch {
      skippedFiles += 1;
      continue;
    }

    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".jsonl")) continue;
      scannedFiles += 1;
      const filePath = path.join(directory, file.name);
      try {
        const content = await readFile(filePath, "utf8");
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (!lines[index].trim()) continue;
          const record = parseSessionLine(
            lines[index],
            getProjectLabel(project.name),
            file.name,
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

  records.sort((a, b) => b.timestamp - a.timestamp);
  return {
    records,
    scannedFiles,
    skippedFiles,
    syncedAt: Date.now(),
    source,
    sourceAvailable: true,
  };
}
