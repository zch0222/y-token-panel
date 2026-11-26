import {
  DEFAULT_MODELS_DEV_SYNC_CONFIG,
  MODELS_DEV_API_URL,
  MODELS_DEV_MAX_RESPONSE_BYTES,
  MODELS_DEV_SYNC_INTERVAL_MS,
  errorMessage,
  normalizeModelIdForPricing,
  type ModelPricingInfo,
  type ModelsDevSyncConfig,
} from "@/lib/model-pricing";

export interface ModelsDevCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface ModelsDevModel {
  name?: string;
  release_date?: string;
  cost?: ModelsDevCost;
  modalities?: { input?: string[]; output?: string[] };
  status?: string;
}

export interface ModelsDevProvider {
  name?: string;
  models?: Record<string, ModelsDevModel>;
}

export type ModelsDevResponse = Record<string, ModelsDevProvider>;

export interface ModelsDevEntry {
  key: string;
  providerId: string;
  providerName: string;
  modelId: string;
  normalizedId: string;
  modelName: string;
  releaseDate: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const NON_TEXT_MODEL_MARKERS = [
  "audio", "deprecated", "embedding", "image", "moderation", "realtime",
  "transcribe", "tts", "video",
];
const NON_TEXT_OUTPUT_MODALITIES = new Set(["audio", "image", "video"]);

function isTextPricingModel(modelId: string, model?: ModelsDevModel): boolean {
  if (model?.status?.toLowerCase() === "deprecated") return false;
  const outputs = model?.modalities?.output?.map((modality) => modality.toLowerCase());
  if (
    outputs?.length &&
    (!outputs.includes("text") || outputs.some((modality) => NON_TEXT_OUTPUT_MODALITIES.has(modality)))
  ) {
    return false;
  }
  const searchable = `${modelId} ${model?.name ?? ""}`.toLowerCase();
  return !NON_TEXT_MODEL_MARKERS.some((marker) => searchable.includes(marker));
}

export function formatModelsDevPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0 || value >= 1e12) return "0";
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "") || "0";
}

/** 展开 models.dev，只保留有输入或输出单价的文本模型。 */
export function flattenModelsDev(data: ModelsDevResponse): ModelsDevEntry[] {
  const entries: ModelsDevEntry[] = [];
  for (const [providerId, provider] of Object.entries(data)) {
    if (!provider || typeof provider !== "object") continue;
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      if (!isTextPricingModel(modelId, model)) continue;
      const input = typeof model?.cost?.input === "number" ? model.cost.input : null;
      const output = typeof model?.cost?.output === "number" ? model.cost.output : null;
      if (input === null && output === null) continue;
      const normalizedId = normalizeModelIdForPricing(modelId);
      if (!normalizedId) continue;
      entries.push({
        key: `${providerId}/${modelId}`,
        providerId,
        providerName: provider.name || providerId,
        modelId,
        normalizedId,
        modelName: model?.name || modelId,
        releaseDate: typeof model?.release_date === "string" ? model?.release_date : "",
        input: input ?? 0,
        output: output ?? 0,
        cacheRead: typeof model?.cost?.cache_read === "number" ? model.cost.cache_read : 0,
        cacheWrite: typeof model?.cost?.cache_write === "number" ? model.cost.cache_write : 0,
      });
    }
  }
  entries.sort((a, b) => b.releaseDate.localeCompare(a.releaseDate) || a.modelName.localeCompare(b.modelName));
  return entries;
}

const COMMON_MODEL_LIMIT_PER_FAMILY = 6;
const COMMON_FAMILY_RULES: Array<{
  providers: ReadonlySet<string>;
  matches: (modelId: string) => boolean;
}> = [
  { providers: new Set(["anthropic"]), matches: (id) => id.startsWith("claude-") },
  { providers: new Set(["openai"]), matches: (id) => id.startsWith("gpt-") || id.startsWith("o1-") || id.startsWith("o3-") || id.startsWith("o4-") },
  { providers: new Set(["google"]), matches: (id) => id.startsWith("gemini-") },
  { providers: new Set(["xai"]), matches: (id) => id.startsWith("grok-") },
  { providers: new Set(["deepseek"]), matches: (id) => id.startsWith("deepseek-") },
  { providers: new Set(["alibaba"]), matches: (id) => id.startsWith("qwen") },
  { providers: new Set(["xiaomi"]), matches: (id) => id.startsWith("mimo-") },
  { providers: new Set(["longcat"]), matches: (id) => id.startsWith("longcat-") },
  { providers: new Set(["moonshotai"]), matches: (id) => id.startsWith("kimi-") },
  { providers: new Set(["minimax-cn"]), matches: (id) => id.startsWith("minimax-m") },
  { providers: new Set(["zai"]), matches: (id) => id.startsWith("glm-") },
];

export function getCommonModelKeys(entries: ModelsDevEntry[]): Set<string> {
  const keys = new Set<string>();
  for (const rule of COMMON_FAMILY_RULES) {
    let count = 0;
    for (const entry of entries) {
      if (!rule.providers.has(entry.providerId) || !rule.matches(entry.modelId.toLowerCase())) continue;
      keys.add(entry.key);
      count += 1;
      if (count >= COMMON_MODEL_LIMIT_PER_FAMILY) break;
    }
  }
  return keys;
}

export function resolveModelsDevSelection(
  entries: ModelsDevEntry[],
  config: ModelsDevSyncConfig,
): ModelsDevEntry[] {
  const explicit = new Set(config.selectedModelKeys);
  const excluded = new Set(config.excludedCommonModelKeys);
  const common = config.includeCommonModels ? getCommonModelKeys(entries) : new Set<string>();
  return entries.filter((entry) => explicit.has(entry.key) || (common.has(entry.key) && !excluded.has(entry.key)));
}

export function toModelPricing(entries: ModelsDevEntry[]): ModelPricingInfo[] {
  const byModelId = new Map<string, ModelPricingInfo>();
  for (const entry of entries) {
    if (byModelId.has(entry.normalizedId)) continue;
    byModelId.set(entry.normalizedId, {
      modelId: entry.normalizedId,
      displayName: entry.modelName,
      inputCostPerMillion: formatModelsDevPrice(entry.input),
      outputCostPerMillion: formatModelsDevPrice(entry.output),
      cacheReadCostPerMillion: formatModelsDevPrice(entry.cacheRead),
      cacheCreationCostPerMillion: formatModelsDevPrice(entry.cacheWrite),
    });
  }
  return Array.from(byModelId.values());
}

/** 服务端拉取 models.dev；Node fetch 自动解压 gzip，统一限制解压后响应大小。 */
export async function fetchModelsDev(): Promise<ModelsDevResponse> {
  const response = await fetch(MODELS_DEV_API_URL, {
    signal: AbortSignal.timeout(15_000),
    headers: { accept: "application/json", "accept-encoding": "gzip" },
  });
  if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MODELS_DEV_MAX_RESPONSE_BYTES) {
    throw new Error(`models.dev response too large: ${length} bytes`);
  }
  const body = await response.arrayBuffer();
  if (body.byteLength > MODELS_DEV_MAX_RESPONSE_BYTES) {
    throw new Error(`models.dev response too large: ${body.byteLength} bytes`);
  }
  return JSON.parse(Buffer.from(body).toString("utf8")) as ModelsDevResponse;
}

export interface ModelsDevSyncResult {
  skipped: boolean;
  selected: number;
  imported: number;
  changed: number;
  syncedAt: number | null;
}

/** 由 API 路由注入 store，避免这个纯编排模块与 SQLite 单例循环依赖。 */
export async function syncModelsDevPricingWithStore(
  store: {
    updateModelPricingBatch: (entries: ModelPricingInfo[]) => number;
  },
  file: {
    load: () => { modelsDevSync: ModelsDevSyncConfig };
    recordResult: (syncedAt: number | null, error: string | null) => unknown;
  },
  force = false,
): Promise<ModelsDevSyncResult> {
  const initial = file.load().modelsDevSync;
  const recentlySynced = initial.lastSyncAt !== null && Date.now() - initial.lastSyncAt < MODELS_DEV_SYNC_INTERVAL_MS;
  if (!force && (!initial.autoSyncEnabled || recentlySynced)) {
    return { skipped: true, selected: 0, imported: 0, changed: 0, syncedAt: initial.lastSyncAt };
  }
  try {
    const data = await fetchModelsDev();
    // 拉取期间用户可能改过开关，按最新配置决定是否导入。
    const latest = file.load().modelsDevSync;
    if (!force && !latest.autoSyncEnabled) {
      return { skipped: true, selected: 0, imported: 0, changed: 0, syncedAt: latest.lastSyncAt };
    }
    const selected = resolveModelsDevSelection(flattenModelsDev(data), latest);
    const pricing = toModelPricing(selected);
    const changed = pricing.length > 0 ? store.updateModelPricingBatch(pricing) : 0;
    const syncedAt = Date.now();
    file.recordResult(syncedAt, null);
    return { skipped: false, selected: selected.length, imported: pricing.length, changed, syncedAt };
  } catch (error) {
    const message = errorMessage(error);
    try {
      file.recordResult(null, message);
    } catch {
      // 记录同步失败不应覆盖原始网络/解析错误。
    }
    throw error;
  }
}

export { DEFAULT_MODELS_DEV_SYNC_CONFIG };
