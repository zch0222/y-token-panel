/**
 * 模型定价与成本计算的纯逻辑层。计算口径对齐 cc-switch：
 * - 价格单位是 USD / 1M tokens；
 * - inputTokenSemantics="total" 的输入包含缓存读写，计费输入先扣除缓存；
 * - 5 分钟缓存写入按 cacheCreation 单价，1 小时写入按其 1.6 倍；
 * - 内部用 BigInt 纳美元（1 USD = 1e9 nano-USD）避免二进制浮点误差。
 */

export interface ModelPricingInfo {
  modelId: string;
  displayName: string;
  inputCostPerMillion: string;
  outputCostPerMillion: string;
  cacheReadCostPerMillion: string;
  cacheCreationCostPerMillion: string;
}

export interface ModelsDevSyncConfig {
  autoSyncEnabled: boolean;
  includeCommonModels: boolean;
  selectedModelKeys: string[];
  excludedCommonModelKeys: string[];
  lastSyncAt: number | null;
  lastSyncError: string | null;
}

export interface ModelPricingFile {
  version: number;
  modelsDevSync: ModelsDevSyncConfig;
  models: ModelPricingInfo[];
  deletedModelIds: string[];
}

export interface UsageCostInput {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** cacheCreationTokens 中按 1 小时 TTL 写入的子集；缺失按 0。 */
  cacheCreation1hTokens?: number;
  inputTokenSemantics: "fresh" | "total";
}

export interface UsageCostBreakdown {
  inputCostUsd: number;
  outputCostUsd: number;
  cacheReadCostUsd: number;
  cacheCreationCostUsd: number;
  totalCostUsd: number;
}

export interface ParsedModelPricing {
  inputNanoPerMillion: bigint;
  outputNanoPerMillion: bigint;
  cacheReadNanoPerMillion: bigint;
  cacheCreationNanoPerMillion: bigint;
}

const NANO_USD = BigInt(1_000_000_000);
const ONE_MILLION = BigInt(1_000_000);
const NON_ANTHROPIC_CLAUDE_DESKTOP_MARKERS = [
  "abab", "ark-code", "arctic", "astron", "codex", "command-r", "deepseek",
  "doubao", "ernie", "gemini", "gemma", "glm", "gpt", "grok", "hermes",
  "hy3", "hunyuan", "jamba", "kimi", "lfm", "llama", "longcat", "mercury",
  "mimo", "minimax", "mistral", "mixtral", "moonshot", "nemotron", "nova-",
  "openai", "qianfan", "qwen", "seed-", "solar", "stepfun",
];

export const DEFAULT_MODELS_DEV_SYNC_CONFIG: ModelsDevSyncConfig = {
  autoSyncEnabled: true,
  includeCommonModels: true,
  selectedModelKeys: [],
  excludedCommonModelKeys: [],
  lastSyncAt: null,
  lastSyncError: null,
};

/** models.dev 启动同步的最小间隔（cc-switch 同为 6 小时）。 */
export const MODELS_DEV_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const MODELS_DEV_API_URL = "https://models.dev/api.json";
export const MODELS_DEV_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 解析非负十进制价格为「纳美元 / 1M tokens」。价格表是字符串十进制；
 * 超过纳美元精度的尾数按四舍五入处理（误差 < 1e-9 USD / 1M tokens）。
 */
export function parsePriceNanoPerMillion(raw: string): bigint | null {
  const value = raw.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  const whole = match[1].replace(/^0+(?=\d)/, "");
  const fraction = match[2] ?? "";
  const firstNine = fraction.slice(0, 9).padEnd(9, "0");
  let nano = BigInt(whole || "0") * NANO_USD + BigInt(firstNine || "0");
  const roundDigit = fraction.length > 9 ? Number(fraction[9]) : 0;
  if (roundDigit >= 5) nano += BigInt(1);
  return nano;
}

export function validatePrice(raw: string): boolean {
  return parsePriceNanoPerMillion(raw) !== null;
}

export function normalizePricingEntry(entry: ModelPricingInfo): ModelPricingInfo {
  return {
    modelId: entry.modelId.trim(),
    displayName: entry.displayName.trim(),
    inputCostPerMillion: entry.inputCostPerMillion.trim(),
    outputCostPerMillion: entry.outputCostPerMillion.trim(),
    cacheReadCostPerMillion: entry.cacheReadCostPerMillion.trim(),
    cacheCreationCostPerMillion: entry.cacheCreationCostPerMillion.trim(),
  };
}

export function validatePricingEntry(entry: ModelPricingInfo): string | null {
  if (!entry.modelId) return "模型 ID 不能为空";
  if (!entry.displayName) return "显示名称不能为空";
  const fields: Array<[string, string]> = [
    ["输入价格", entry.inputCostPerMillion],
    ["输出价格", entry.outputCostPerMillion],
    ["缓存读取价格", entry.cacheReadCostPerMillion],
    ["缓存写入价格", entry.cacheCreationCostPerMillion],
  ];
  for (const [label, value] of fields) {
    if (!validatePrice(value)) return `${label}必须是非负十进制数`;
  }
  return null;
}

export function parseModelPricing(entry: ModelPricingInfo): ParsedModelPricing | null {
  const input = parsePriceNanoPerMillion(entry.inputCostPerMillion);
  const output = parsePriceNanoPerMillion(entry.outputCostPerMillion);
  const cacheRead = parsePriceNanoPerMillion(entry.cacheReadCostPerMillion);
  const cacheCreation = parsePriceNanoPerMillion(entry.cacheCreationCostPerMillion);
  if (input === null || output === null || cacheRead === null || cacheCreation === null) return null;
  return {
    inputNanoPerMillion: input,
    outputNanoPerMillion: output,
    cacheReadNanoPerMillion: cacheRead,
    cacheCreationNanoPerMillion: cacheCreation,
  };
}

function tokenCostNano(tokens: number, priceNanoPerMillion: bigint): bigint {
  if (!Number.isSafeInteger(tokens) || tokens <= 0 || priceNanoPerMillion === BigInt(0)) return BigInt(0);
  return (BigInt(tokens) * priceNanoPerMillion) / ONE_MILLION;
}

function nanoToUsd(nano: bigint): number {
  return Number(nano) / Number(NANO_USD);
}

/** cc-switch CostCalculator 同款公式；返回各分项与合计（USD）。 */
export function calculateUsageCost(
  usage: UsageCostInput,
  pricing: ParsedModelPricing,
): UsageCostBreakdown {
  const cacheReadTokens = Math.max(0, usage.cacheReadTokens);
  const cacheCreationTokens = Math.max(0, usage.cacheCreationTokens);
  const billableInputTokens = usage.inputTokenSemantics === "total"
    ? Math.max(0, usage.inputTokens - cacheReadTokens - cacheCreationTokens)
    : Math.max(0, usage.inputTokens);

  const inputNano = tokenCostNano(billableInputTokens, pricing.inputNanoPerMillion);
  const outputNano = tokenCostNano(usage.outputTokens, pricing.outputNanoPerMillion);
  const cacheReadNano = tokenCostNano(cacheReadTokens, pricing.cacheReadNanoPerMillion);

  // Claude 1 小时缓存写入价格 = 5 分钟写入价 × 1.6（即 8/5）。
  const cacheCreation1hTokens = Math.min(
    Math.max(0, usage.cacheCreation1hTokens ?? 0),
    cacheCreationTokens,
  );
  const cacheCreation5mTokens = cacheCreationTokens - cacheCreation1hTokens;
  const weightedWriteUnits =
    BigInt(cacheCreation5mTokens) * BigInt(5) + BigInt(cacheCreation1hTokens) * BigInt(8);
  const cacheCreationNano = pricing.cacheCreationNanoPerMillion === BigInt(0) || weightedWriteUnits === BigInt(0)
    ? BigInt(0)
    : (weightedWriteUnits * pricing.cacheCreationNanoPerMillion) / (BigInt(5) * ONE_MILLION);

  const totalNano = inputNano + outputNano + cacheReadNano + cacheCreationNano;
  return {
    inputCostUsd: nanoToUsd(inputNano),
    outputCostUsd: nanoToUsd(outputNano),
    cacheReadCostUsd: nanoToUsd(cacheReadNano),
    cacheCreationCostUsd: nanoToUsd(cacheCreationNano),
    totalCostUsd: nanoToUsd(totalNano),
  };
}

function stripKnownModelNamespace(modelId: string): string | null {
  const claudePosition = modelId.lastIndexOf("claude-");
  if (claudePosition > 0) return modelId.slice(claudePosition);
  for (const marker of [
    "openai.", "anthropic.", "google.", "moonshot.", "moonshotai.",
    "bedrock.", "global.",
  ]) {
    if (modelId.startsWith(marker)) return modelId.slice(marker.length);
  }
  return null;
}

function stripClaudeDesktopNonAnthropicPrefix(modelId: string): string | null {
  if (!modelId.startsWith("claude-")) return null;
  const rest = modelId.slice("claude-".length);
  return NON_ANTHROPIC_CLAUDE_DESKTOP_MARKERS.some((marker) => rest.startsWith(marker))
    ? rest
    : null;
}

function stripBedrockVersionSuffix(modelId: string): string | null {
  const index = modelId.lastIndexOf("-v");
  if (index <= 0) return null;
  const suffix = modelId.slice(index + 2);
  return suffix.length > 0 && /^\d+$/.test(suffix) ? modelId.slice(0, index) : null;
}

function stripModelDateSuffix(modelId: string): string | null {
  const iso = /^(.*)-\d{4}-\d{2}-\d{2}$/.exec(modelId);
  if (iso?.[1]) return iso[1];
  const compact = /^(.*)-(\d{8}|\d{6})$/.exec(modelId);
  if (!compact?.[1] || !compact[2]) return null;
  if (compact[2].length === 8) return compact[1];
  const month = Number(compact[2].slice(2, 4));
  const day = Number(compact[2].slice(4, 6));
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 ? compact[1] : null;
}

function stripReasoningEffortSuffix(modelId: string): string | null {
  for (const suffix of ["-minimal", "-low", "-medium", "-high", "-xhigh"]) {
    if (modelId.endsWith(suffix) && modelId.length > suffix.length) {
      return modelId.slice(0, -suffix.length);
    }
  }
  return null;
}

/** models.dev / 日志模型名归一化；与 cc-switch 的 clean_model_id_for_pricing 对齐。 */
export function normalizeModelIdForPricing(modelId: string): string {
  const afterSlash = modelId.slice(modelId.lastIndexOf("/") + 1);
  const beforeColon = afterSlash.split(":")[0] ?? "";
  let normalized = beforeColon.trim().replace(/@/g, "-").toLowerCase();
  if (normalized.endsWith("[1m]")) normalized = normalized.slice(0, -4).trim();
  return normalized;
}

function isPlaceholderPricingModel(modelId: string): boolean {
  return modelId === "" || modelId === "unknown" || modelId === "null" || modelId === "none";
}

function pushUnique(candidates: string[], candidate: string): boolean {
  if (!candidate || candidates.includes(candidate)) return false;
  candidates.push(candidate);
  return true;
}

/** 精确匹配候选队列；顺序与 cc-switch 的 model_pricing_candidates 一致。 */
export function modelPricingCandidates(modelId: string): string[] {
  const cleaned = normalizeModelIdForPricing(modelId);
  if (isPlaceholderPricingModel(cleaned)) return [];
  const candidates: string[] = [];
  const queue = [cleaned];
  while (queue.length > 0) {
    const candidate = queue.pop()!;
    if (!pushUnique(candidates, candidate)) continue;
    for (const strip of [
      stripKnownModelNamespace,
      stripClaudeDesktopNonAnthropicPrefix,
      stripBedrockVersionSuffix,
      stripModelDateSuffix,
      stripReasoningEffortSuffix,
    ]) {
      const stripped = strip(candidate);
      if (stripped) queue.push(stripped);
    }
    if (candidate.startsWith("claude-") && candidate.includes(".")) {
      queue.push(candidate.replace(/\./g, "-"));
    }
  }
  return candidates;
}

export function shouldTryPricingPrefixMatch(modelId: string): boolean {
  const dashCount = (modelId.match(/-/g) ?? []).length;
  if (modelId.startsWith("claude-")) return dashCount >= 3;
  if (["o1", "o3", "o4", "o5"].some((prefix) => modelId.startsWith(prefix))) {
    return dashCount >= 1;
  }
  return ["gpt-", "gemini-", "deepseek-", "qwen-", "glm-", "kimi-", "minimax-"]
    .some((prefix) => modelId.startsWith(prefix)) && dashCount >= 2;
}

/** 在价格表中查找模型：先候选精确匹配，再按 cc-switch 的受控前缀规则匹配。 */
export function findModelPricing<T extends ModelPricingInfo>(
  rows: Iterable<T>,
  modelId: string,
): { pricing: T; matchedModelId: string } | null {
  const byLowercaseId = new Map<string, T>();
  for (const row of rows) {
    const key = row.modelId.toLowerCase();
    if (!byLowercaseId.has(key)) byLowercaseId.set(key, row);
  }
  const candidates = modelPricingCandidates(modelId);
  for (const candidate of candidates) {
    const exact = byLowercaseId.get(candidate);
    if (exact) return { pricing: exact, matchedModelId: exact.modelId };
  }
  for (const candidate of candidates) {
    if (!shouldTryPricingPrefixMatch(candidate)) continue;
    let best: T | null = null;
    for (const row of byLowercaseId.values()) {
      if (!row.modelId.toLowerCase().startsWith(`${candidate}-`)) continue;
      if (best === null || row.modelId.length < best.modelId.length) best = row;
    }
    if (best) return { pricing: best, matchedModelId: best.modelId };
  }
  return null;
}

/** 美元估算成本的紧凑展示；价格计算本身是估算，不伪装成账单精度。 */
export function formatUsdCost(value: number | undefined, hasCost = value !== undefined): string {
  if (!hasCost || value === undefined || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  const absolute = Math.abs(value);
  const digits = absolute >= 100 ? 2 : absolute >= 1 ? 4 : absolute >= 0.01 ? 4 : 6;
  return `$${value.toFixed(digits).replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1")}`;
}
