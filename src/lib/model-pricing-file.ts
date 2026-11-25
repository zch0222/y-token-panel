import "server-only";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  DEFAULT_MODELS_DEV_SYNC_CONFIG,
  normalizePricingEntry,
  validatePricingEntry,
  type ModelPricingFile,
  type ModelPricingInfo,
  type ModelsDevSyncConfig,
} from "@/lib/model-pricing";

export const MODEL_PRICING_FILE_VERSION = 1;
const MODEL_PRICING_FILE_NAME = "model-pricing.json";

export function getModelPricingFilePath(): string {
  const root = process.env.Y_TOKEN_PANEL_DATA_DIR
    ? path.resolve(process.env.Y_TOKEN_PANEL_DATA_DIR)
    : path.join(homedir(), ".y-token-panel");
  return path.join(root, MODEL_PRICING_FILE_NAME);
}

function normalizeKeyList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.flatMap((value) => {
    if (typeof value !== "string") return [];
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }))).sort();
}

function normalizeSyncConfig(raw: unknown): ModelsDevSyncConfig {
  const value = raw && typeof raw === "object" ? raw as Partial<ModelsDevSyncConfig> : {};
  return {
    autoSyncEnabled: value.autoSyncEnabled !== false,
    includeCommonModels: value.includeCommonModels !== false,
    selectedModelKeys: normalizeKeyList(value.selectedModelKeys),
    excludedCommonModelKeys: normalizeKeyList(value.excludedCommonModelKeys),
    lastSyncAt: typeof value.lastSyncAt === "number" && Number.isSafeInteger(value.lastSyncAt)
      ? value.lastSyncAt
      : null,
    lastSyncError: typeof value.lastSyncError === "string" && value.lastSyncError.trim()
      ? value.lastSyncError.trim().slice(0, 1000)
      : null,
  };
}

function normalizePricingList(raw: unknown): ModelPricingInfo[] {
  if (!Array.isArray(raw)) return [];
  const entries = new Map<string, ModelPricingInfo>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const entry = normalizePricingEntry(item as ModelPricingInfo);
    const error = validatePricingEntry(entry);
    if (error) throw new Error(`model-pricing.json 中 ${entry.modelId || "未知模型"}：${error}`);
    entries.set(entry.modelId, entry);
  }
  return Array.from(entries.values());
}

function normalizeFile(raw: Partial<ModelPricingFile>): ModelPricingFile {
  if ((raw.version ?? MODEL_PRICING_FILE_VERSION) > MODEL_PRICING_FILE_VERSION) {
    throw new Error(`model-pricing.json 版本 ${raw.version} 高于当前支持版本 ${MODEL_PRICING_FILE_VERSION}`);
  }
  const deleted = new Set(normalizeKeyList(raw.deletedModelIds));
  return {
    version: MODEL_PRICING_FILE_VERSION,
    modelsDevSync: normalizeSyncConfig(raw.modelsDevSync),
    models: normalizePricingList(raw.models).filter((entry) => !deleted.has(entry.modelId)),
    deletedModelIds: Array.from(deleted).sort(),
  };
}

export function emptyModelPricingFile(): ModelPricingFile {
  return {
    version: MODEL_PRICING_FILE_VERSION,
    modelsDevSync: { ...DEFAULT_MODELS_DEV_SYNC_CONFIG },
    models: [],
    deletedModelIds: [],
  };
}

/** 读取本地覆盖文件；不存在时返回默认空文件但不主动创建，避免扫描 worker 写用户目录。 */
export function readModelPricingFile(filePath = getModelPricingFilePath()): ModelPricingFile {
  if (!existsSync(filePath)) return emptyModelPricingFile();
  let parsed: Partial<ModelPricingFile>;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<ModelPricingFile>;
  } catch (error) {
    throw new Error(`无法解析模型价格覆盖文件 ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizeFile(parsed);
}

export function writeModelPricingFile(
  file: ModelPricingFile,
  filePath = getModelPricingFilePath(),
): void {
  const normalized = normalizeFile(file);
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  renameSync(temporary, filePath);
}

/** 读取或创建覆盖文件；只有用户显式改配置/价格或执行同步时才落盘。 */
export function loadOrCreateModelPricingFile(filePath = getModelPricingFilePath()): ModelPricingFile {
  const file = readModelPricingFile(filePath);
  if (!existsSync(filePath)) writeModelPricingFile(file, filePath);
  return file;
}

export function updateModelPricingInFile(
  entries: ModelPricingInfo[],
  filePath = getModelPricingFilePath(),
): ModelPricingFile {
  const file = loadOrCreateModelPricingFile(filePath);
  const models = new Map(file.models.map((entry) => [entry.modelId, entry]));
  const updated = new Set<string>();
  for (const raw of entries) {
    const entry = normalizePricingEntry(raw);
    const error = validatePricingEntry(entry);
    if (error) throw new Error(error);
    models.set(entry.modelId, entry);
    updated.add(entry.modelId);
  }
  file.models = Array.from(models.values()).sort((a, b) => a.modelId.localeCompare(b.modelId));
  file.deletedModelIds = file.deletedModelIds.filter((modelId) => !updated.has(modelId));
  writeModelPricingFile(file, filePath);
  return file;
}

export function deleteModelPricingInFile(
  modelId: string,
  filePath = getModelPricingFilePath(),
): ModelPricingFile {
  const trimmed = modelId.trim();
  if (!trimmed) throw new Error("模型 ID 不能为空");
  const file = loadOrCreateModelPricingFile(filePath);
  file.models = file.models.filter((entry) => entry.modelId !== trimmed);
  if (!file.deletedModelIds.includes(trimmed)) file.deletedModelIds.push(trimmed);
  file.deletedModelIds.sort();
  writeModelPricingFile(file, filePath);
  return file;
}

export function saveModelsDevSyncConfig(
  patch: Partial<Pick<ModelsDevSyncConfig, "autoSyncEnabled" | "includeCommonModels" | "selectedModelKeys" | "excludedCommonModelKeys">>,
  filePath = getModelPricingFilePath(),
): ModelsDevSyncConfig {
  const file = loadOrCreateModelPricingFile(filePath);
  file.modelsDevSync = normalizeSyncConfig({ ...file.modelsDevSync, ...patch });
  writeModelPricingFile(file, filePath);
  return file.modelsDevSync;
}

/** 只记录同步结果，避免慢请求覆盖用户在同步期间改过的开关。 */
export function recordModelsDevSyncResult(
  syncedAt: number | null,
  error: string | null,
  filePath = getModelPricingFilePath(),
): ModelsDevSyncConfig {
  const file = loadOrCreateModelPricingFile(filePath);
  if (syncedAt !== null) file.modelsDevSync.lastSyncAt = syncedAt;
  file.modelsDevSync.lastSyncError = error?.trim().slice(0, 1000) || null;
  writeModelPricingFile(file, filePath);
  return file.modelsDevSync;
}
