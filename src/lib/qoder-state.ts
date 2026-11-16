import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { UsageRecord } from "@/lib/usage";

/**
 * Qoder 1.1.86 起（qoder-cn-agent-sdk）会话 jsonl 不再写 message.usage，
 * 逐请求 token/credits 只保留在 `<project>/<sessionId>/state.json` 的 s0 段里，
 * 内容为 AES-256-GCM 加密的会话级聚合（total tokens + credits 快照 + 最新一次
 * 请求的 usage）。密钥为 SDK 内置固定主密钥（同机多会话共用），AAD 由
 * sessionId + sha256(规范化 workspace 路径) + segmentKey 组成；workspace 路径
 * 的候选值从会话 jsonl 的 cwd 字段收集。字段语义按本机 Qoder 1.1.86-hotfix.5
 * 的 qoder-worker-runtime 反查确认（gc/cpo/lpo/ddt/FVl）。
 */
const STATE_MASTER_KEY = Buffer.from([
  44, 6, 96, 159, 67, 137, 172, 134, 152, 52, 157, 248, 15, 219, 49, 114, 225,
  17, 195, 37, 71, 151, 145, 95, 214, 226, 9, 169, 250, 96, 125, 232,
]);

/** usage 聚合所在段；SDK 里 xje="s0"，state.json items.s0 与之一一对应。 */
const STATE_USAGE_SEGMENT = "s0";

/** credits 差值低于该阈值视为浮点噪声，不产生补差记录。 */
const CREDIT_DELTA_EPSILON = 1e-9;

interface StateSegmentItem {
  n?: unknown;
  p?: unknown;
  t?: unknown;
}

export interface QoderStateUsage {
  /** 会话累计 tokens（fresh 口径，不含 cache）。缺 total 段时为 null。 */
  total: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  } | null;
  /** 会话累计计费 credits；BYOK 等未观测场景为 undefined。 */
  credits: number | undefined;
  /** credits.byModel 的降序快照，用于差值记录的模型归因。 */
  models: Array<{ model: string; credits: number }>;
  /** 聚合快照更新时刻（epoch 毫秒）。 */
  updatedAt: number | undefined;
}

/** 与 SDK gc() 一致的 workspace 路径规范化（darwin/win32 折叠小写）。 */
function normalizeProjectRoot(root: string): string {
  const resolved = path.resolve(root).replace(/\\/g, "/");
  return process.platform === "darwin" || process.platform === "win32"
    ? resolved.toLowerCase()
    : resolved;
}

/** 与 SDK lpo(cpo(...)) 一致的 AAD 构造（默认 JSON.stringify 键序、无空格）。 */
function segmentAad(sessionId: string, projectRoot: string): Buffer {
  const projectHash = createHash("sha256")
    .update(normalizeProjectRoot(projectRoot), "utf8")
    .digest("hex");
  return Buffer.from(
    JSON.stringify({
      sessionId,
      projectHash,
      segmentKey: STATE_USAGE_SEGMENT,
    }),
    "utf8",
  );
}

function decodeBase64(value: unknown): Buffer | null {
  if (typeof value !== "string" || value === "") return null;
  const buffer = Buffer.from(value, "base64");
  return buffer.length > 0 ? buffer : null;
}

/**
 * 按 SDK ddt.encrypt 同参构造加密段；生产路径只解密不加密，这里供测试构造
 * fixture（与解密共用同一 AAD 构造，避免测试侧口径漂移）。
 */
export function encryptQoderStateSegment(
  payloadJson: string,
  sessionId: string,
  projectRoot: string,
): { n: string; p: string; t: string } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", STATE_MASTER_KEY, nonce);
  cipher.setAAD(segmentAad(sessionId, projectRoot));
  const ciphertext = Buffer.concat([
    cipher.update(payloadJson, "utf8"),
    cipher.final(),
  ]);
  return {
    n: nonce.toString("base64"),
    p: ciphertext.toString("base64"),
    t: cipher.getAuthTag().toString("base64"),
  };
}

/**
 * 按候选 workspace 路径逐个尝试解密 s0 段；全部失败（路径不匹配 / 密钥更替 /
 * 条目损坏）返回 null，由调用方按不可读跳过，不影响其余会话。
 */
export function decryptQoderStateSegment(
  item: StateSegmentItem,
  sessionId: string,
  projectRoots: readonly string[],
): unknown {
  const nonce = decodeBase64(item.n);
  const ciphertext = decodeBase64(item.p);
  const tag = decodeBase64(item.t);
  if (nonce === null || ciphertext === null || tag === null) return null;
  for (const root of projectRoots) {
    if (root === "") continue;
    try {
      const decipher = createDecipheriv("aes-256-gcm", STATE_MASTER_KEY, nonce);
      decipher.setAAD(segmentAad(sessionId, root));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString("utf8");
      return JSON.parse(plaintext) as unknown;
    } catch {
      // 尝试下一个 workspace 候选
    }
  }
  return null;
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

export function parseQoderStateUsage(payload: unknown): QoderStateUsage | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as {
    updatedAt?: unknown;
    total?: unknown;
    credits?: unknown;
  };

  let total: QoderStateUsage["total"] = null;
  if (
    record.total !== null &&
    typeof record.total === "object"
  ) {
    const raw = record.total as Record<string, unknown>;
    const inputTokens = nonNegative(raw.input_tokens);
    const outputTokens = nonNegative(raw.output_tokens);
    const cacheReadTokens = nonNegative(raw.cache_read_input_tokens);
    const cacheCreationTokens = nonNegative(raw.cache_creation_input_tokens);
    if (
      inputTokens !== undefined ||
      outputTokens !== undefined ||
      cacheReadTokens !== undefined ||
      cacheCreationTokens !== undefined
    ) {
      total = {
        inputTokens: inputTokens ?? 0,
        outputTokens: outputTokens ?? 0,
        cacheReadTokens: cacheReadTokens ?? 0,
        cacheCreationTokens: cacheCreationTokens ?? 0,
      };
    }
  }

  let credits: number | undefined;
  const models: Array<{ model: string; credits: number }> = [];
  if (record.credits !== null && typeof record.credits === "object") {
    const raw = record.credits as { total?: unknown; byModel?: unknown };
    const totalCredits = nonNegative(raw.total);
    if (totalCredits !== undefined) credits = totalCredits;
    if (raw.byModel !== null && typeof raw.byModel === "object") {
      for (const [model, value] of Object.entries(
        raw.byModel as Record<string, unknown>,
      )) {
        const modelCredits =
          value !== null && typeof value === "object"
            ? nonNegative((value as { credits?: unknown }).credits)
            : undefined;
        models.push({ model, credits: modelCredits ?? 0 });
      }
      models.sort(
        (a, b) => b.credits - a.credits || a.model.localeCompare(b.model),
      );
    }
  }

  let updatedAt: number | undefined;
  if (typeof record.updatedAt === "string") {
    const parsed = Date.parse(record.updatedAt);
    if (Number.isFinite(parsed)) updatedAt = parsed;
  }

  if (total === null && credits === undefined) return null;
  return { total, credits, models, updatedAt };
}

/** 解析 state.json 文本内容；结构缺失 / 解不出返回 null。 */
export function parseQoderStateContent(
  content: string,
  sessionId: string,
  projectRoots: readonly string[],
): QoderStateUsage | null {
  let document: unknown;
  try {
    document = JSON.parse(content);
  } catch {
    return null;
  }
  if (document === null || typeof document !== "object") return null;
  const items = (document as { items?: unknown }).items;
  if (items === null || typeof items !== "object") return null;
  const item = (items as Record<string, unknown>)[STATE_USAGE_SEGMENT];
  if (item === null || typeof item !== "object") return null;
  return parseQoderStateUsage(
    decryptQoderStateSegment(item as StateSegmentItem, sessionId, projectRoots),
  );
}

/** 读取并解密一个会话的 state.json；不可读 / 解不出返回 null。 */
export async function readQoderStateUsage(
  filePath: string,
  sessionId: string,
  projectRoots: readonly string[],
): Promise<QoderStateUsage | null> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  return parseQoderStateContent(content, sessionId, projectRoots);
}

export function qoderStateRecordId(sessionId: string): string {
  return `qoder:state:${sessionId}`;
}

/** state.json 的发现元数据；增量 reader 在此基础上叠加 size/mtime 游标字段。 */
export interface QoderStateFileMeta {
  filePath: string;
  sessionId: string;
  project: string;
  /** state.json 所在项目目录（workspace 路径候选之一）。 */
  artifactDir: string;
  /** 项目目录名反推的 workspace 路径候选（目录名即路径的 "/" → "-" 形态）。 */
  derivedRoot: string;
}

/** state.json 解密的 workspace 路径候选：jsonl cwd 优先，目录名反推与项目目录兜底。 */
export function qoderStateRootCandidates(
  meta: Pick<QoderStateFileMeta, "artifactDir" | "derivedRoot">,
  cwds: readonly string[] | undefined,
): string[] {
  return [...(cwds ?? []), meta.derivedRoot, meta.artifactDir];
}

/**
 * 全量口径的 state.json 补差装配：逐会话解密聚合、与 jsonl 逐请求记录做差、
 * 追加补差记录。解不开的 state 文件计入 skipped，不影响其余会话。
 */
export async function attachQoderStateRecords(
  stateFiles: readonly QoderStateFileMeta[],
  cwdsBySession: ReadonlyMap<string, readonly string[]>,
  records: UsageRecord[],
): Promise<{ records: UsageRecord[]; skippedFiles: number }> {
  const recordsBySession = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const existing = recordsBySession.get(record.sessionId);
    if (existing === undefined) recordsBySession.set(record.sessionId, [record]);
    else existing.push(record);
  }

  const appended: UsageRecord[] = [];
  let skippedFiles = 0;
  for (const stateFile of stateFiles) {
    let usage: QoderStateUsage | null;
    try {
      usage = await readQoderStateUsage(
        stateFile.filePath,
        stateFile.sessionId,
        qoderStateRootCandidates(
          stateFile,
          cwdsBySession.get(stateFile.sessionId),
        ),
      );
    } catch {
      usage = null;
    }
    if (usage === null) {
      skippedFiles += 1;
      continue;
    }
    const record = buildQoderStateRecord(
      stateFile.sessionId,
      stateFile.project,
      usage,
      recordsBySession.get(stateFile.sessionId) ?? [],
    );
    if (record !== null) appended.push(record);
  }
  return { records: [...records, ...appended], skippedFiles };
}

export function isQoderStateRecord(record: Pick<UsageRecord, "id">): boolean {
  return record.id.startsWith("qoder:state:");
}

interface SessionUsageSums {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  credits: number;
  latestTimestamp: number | undefined;
}

/** 只累计 jsonl 逐请求记录（排除 state 补差记录自身），与 state 聚合同口径。 */
export function sumQoderSessionRecords(
  records: readonly UsageRecord[],
): SessionUsageSums {
  const sums: SessionUsageSums = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    credits: 0,
    latestTimestamp: undefined,
  };
  for (const record of records) {
    if (isQoderStateRecord(record)) continue;
    sums.inputTokens += record.inputTokens;
    sums.outputTokens += record.outputTokens;
    sums.cacheReadTokens += record.cacheReadTokens;
    sums.cacheCreationTokens += record.cacheCreationTokens;
    sums.credits += record.credits;
    if (sums.latestTimestamp === undefined || record.timestamp > sums.latestTimestamp) {
      sums.latestTimestamp = record.timestamp;
    }
  }
  return sums;
}

function positiveDelta(aggregate: number | undefined, summed: number): number {
  if (aggregate === undefined) return 0;
  const delta = aggregate - summed;
  return delta > 0 ? delta : 0;
}

/**
 * 由会话聚合与 jsonl 逐请求和的差值生成一条补差记录：老格式会话（jsonl 已带
 * usage）差值为零不产出；跨版本会话按差值自然衔接；新格式会话（1.1.86+，
 * jsonl 无 usage）差值即整会话用量。返回 null 表示无需补差。
 */
export function buildQoderStateRecord(
  sessionId: string,
  project: string,
  usage: QoderStateUsage | null,
  sessionRecords: readonly UsageRecord[],
): UsageRecord | null {
  if (usage === null) return null;
  const sums = sumQoderSessionRecords(sessionRecords);

  const inputTokens = positiveDelta(usage.total?.inputTokens, sums.inputTokens);
  const outputTokens = positiveDelta(
    usage.total?.outputTokens,
    sums.outputTokens,
  );
  const cacheReadTokens = positiveDelta(
    usage.total?.cacheReadTokens,
    sums.cacheReadTokens,
  );
  const cacheCreationTokens = positiveDelta(
    usage.total?.cacheCreationTokens,
    sums.cacheCreationTokens,
  );
  const totalTokens =
    inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
  const creditDelta = positiveDelta(usage.credits, sums.credits);
  if (totalTokens === 0 && creditDelta <= CREDIT_DELTA_EPSILON) return null;

  const timestamp =
    usage.updatedAt ??
    sums.latestTimestamp ??
    sessionRecords.find((record) => !isQoderStateRecord(record))?.timestamp;
  if (timestamp === undefined) return null;

  const model =
    usage.models[0]?.model ??
    sessionRecords.find((record) => !isQoderStateRecord(record))?.model ??
    "未知模型";
  const hasCredit = usage.credits !== undefined && creditDelta > CREDIT_DELTA_EPSILON;

  return {
    id: qoderStateRecordId(sessionId),
    requestId: sessionId,
    sessionId,
    harness: "qoder",
    project,
    model,
    provider: "Qoder",
    timestamp,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens,
    inputTokenSemantics: "fresh",
    hasTokenUsage: totalTokens > 0,
    credits: hasCredit ? creditDelta : 0,
    hasCredit,
    ...(hasCredit ? { reportedCredits: creditDelta } : {}),
    ...(hasCredit ? { billable: true } : {}),
    status: "success",
  };
}
