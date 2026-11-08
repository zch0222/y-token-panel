import "server-only";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  detectBalanceKind,
  getBalanceKindLabel,
  maskApiKey,
  type BalanceCacheEntry,
  type BalanceData,
  type BalanceKind,
  type BalanceProviderConfig,
  type BalanceProviderView,
  type BalanceResult,
} from "@/lib/balance";
import { fetchBalance } from "@/lib/balance-query";
import {
  MIN_QUERY_INTERVAL_MS,
  TRANSIENT_RETRY_COUNT,
  TRANSIENT_RETRY_DELAY_MS,
  cooldownFor,
  decideQuery,
  shouldRetryTransient,
} from "@/lib/balance-throttle";

/**
 * 余额供应商配置 + 查询缓存的持久化层，以及带限流的查询入口。
 *
 * 存储：~/.y-token-panel/balance.json（Y_TOKEN_PANEL_DATA_DIR 环境变量可替换
 * ~/.y-token-panel 根目录，风格与其他 Harness 读取器一致）。API Key 只存本机文件，
 * 对外（HTTP 接口）仅暴露脱敏视图。
 *
 * 防风控（对齐并强化 cc-switch）：
 * - decideQuery 在服务端强制最小查询间隔与失败冷却，手动刷新连点也只回缓存；
 * - nextEligibleAt 在外呼前落盘：外呼进行中进程重启也不会立刻重打；
 * - 同一供应商的并发查询共享同一个 in-flight Promise；
 * - 查询成功才更新 lastSuccess（keep-last-good），瞬时失败保留旧快照；
 * - 冷却 / 节流状态持久化，dev server 重启不放开限制。
 */

interface BalanceStoreFile {
  version: 1;
  providers: BalanceProviderConfig[];
  cache: Record<string, BalanceCacheEntry>;
}

export interface BalanceQueryOutcome {
  status: "fetched" | "throttled" | "cooldown";
  fetchedAt: number;
  result: BalanceResult | null;
  /** throttled / cooldown 时还需等多久才允许真实外呼。 */
  waitMs?: number;
  reason?: string | null;
}

export interface BalanceProviderInput {
  name: string;
  baseUrl: string;
  apiKey: string;
  kind: BalanceKind | "auto";
  accessToken?: string;
  userId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  organizationId?: string;
  projectId?: string;
}

export interface BalanceProviderPatch {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  kind?: BalanceKind | "auto";
  accessToken?: string;
  userId?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  organizationId?: string;
  projectId?: string;
}

function emptyStore(): BalanceStoreFile {
  return { version: 1, providers: [], cache: {} };
}

export function getBalanceStorePath(): string {
  const root = process.env.Y_TOKEN_PANEL_DATA_DIR
    ? path.resolve(process.env.Y_TOKEN_PANEL_DATA_DIR)
    : path.join(homedir(), ".y-token-panel");
  return path.join(root, "balance.json");
}

async function readStore(): Promise<BalanceStoreFile> {
  try {
    const content = await readFile(getBalanceStorePath(), "utf8");
    const parsed = JSON.parse(content) as Partial<BalanceStoreFile>;
    if (!Array.isArray(parsed.providers)) return emptyStore();
    return {
      version: 1,
      providers: parsed.providers,
      cache: parsed.cache && typeof parsed.cache === "object" ? parsed.cache : {},
    };
  } catch {
    // 文件不存在或损坏：视为空配置，首次写入时重建。
    return emptyStore();
  }
}

// 所有读改写操作串行执行，避免并发写互相覆盖。
let writeQueue: Promise<unknown> = Promise.resolve();

async function mutate<T>(fn: (store: BalanceStoreFile) => Promise<T> | T): Promise<T> {
  const task = writeQueue.then(async () => {
    const store = await readStore();
    const result = await fn(store);
    await writeStore(store);
    return result;
  });
  // 队列自身不因单个失败而中断。
  writeQueue = task.catch(() => undefined);
  return task;
}

async function writeStore(store: BalanceStoreFile): Promise<void> {
  const target = getBalanceStorePath();
  const tmp = `${target}.${process.pid}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await rename(tmp, target);
}

function freshCacheEntry(): BalanceCacheEntry {
  return {
    lastResult: null,
    lastFetchedAt: 0,
    lastSuccess: null,
    nextEligibleAt: 0,
    cooldownUntil: 0,
    cooldownReason: null,
  };
}

function toProviderView(config: BalanceProviderConfig): BalanceProviderView {
  return {
    id: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    kind: config.kind,
    kindLabel: getBalanceKindLabel(config.kind),
    apiKeyMasked: maskApiKey(config.apiKey),
    accessTokenMasked: config.accessToken ? maskApiKey(config.accessToken) : undefined,
    userId: config.userId,
    accessKeyId: config.accessKeyId,
    secretAccessKeyMasked: config.secretAccessKey ? maskApiKey(config.secretAccessKey) : undefined,
    organizationId: config.organizationId,
    projectId: config.projectId,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

function resolveKind(kind: BalanceKind | "auto", baseUrl: string): BalanceKind {
  if (kind !== "auto") return kind;
  return detectBalanceKind(baseUrl) ?? "general";
}

/** 读取全部供应商（脱敏）与各自的缓存 / 限流状态；不触发任何外呼。 */
export async function listBalanceState(): Promise<{
  providers: BalanceProviderView[];
  cache: Record<string, BalanceCacheEntry>;
  storePath: string;
}> {
  const store = await readStore();
  // 只暴露现存供应商的缓存，隔离历史孤儿条目。
  const cache: Record<string, BalanceCacheEntry> = {};
  for (const provider of store.providers) {
    const entry = store.cache[provider.id];
    if (entry) cache[provider.id] = entry;
  }
  return {
    providers: store.providers.map(toProviderView),
    cache,
    storePath: getBalanceStorePath(),
  };
}

export async function addBalanceProvider(input: BalanceProviderInput): Promise<BalanceProviderView> {
  const name = input.name.trim();
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  if (!name) throw new Error("请填写供应商名称");
  if (!baseUrl) throw new Error("请填写供应商地址（Base URL）");
  const kind = resolveKind(input.kind, baseUrl);
  const apiKey = input.apiKey.trim();
  const accessKeyId = (input.accessKeyId ?? "").trim();
  const secretAccessKey = (input.secretAccessKey ?? "").trim();
  const organizationId = (input.organizationId ?? "").trim();
  const projectId = (input.projectId ?? "").trim();
  if (kind === "volcengine") {
    if (!accessKeyId || !secretAccessKey) {
      throw new Error("火山方舟需要填写账号 AccessKey ID 与 Secret（非推理 API Key）");
    }
  } else if (kind === "zhipu_team") {
    if (!apiKey || !organizationId || !projectId) {
      throw new Error("GLM 团队版需要填写 API Key、组织 ID 与项目 ID");
    }
  } else if (kind === "newapi") {
    if (!(input.accessToken ?? "").trim()) throw new Error("请填写 Access Token");
  } else if (!apiKey) {
    throw new Error("请填写 API Key");
  }

  const now = Date.now();
  const config: BalanceProviderConfig = {
    id: randomUUID(),
    name,
    baseUrl,
    apiKey,
    kind,
    accessToken: (input.accessToken ?? "").trim() || undefined,
    userId: (input.userId ?? "").trim() || undefined,
    accessKeyId: accessKeyId || undefined,
    secretAccessKey: secretAccessKey || undefined,
    organizationId: organizationId || undefined,
    projectId: projectId || undefined,
    createdAt: now,
    updatedAt: now,
  };

  return mutate((store) => {
    store.providers.push(config);
    store.cache[config.id] = freshCacheEntry();
    return toProviderView(config);
  });
}

export async function updateBalanceProvider(
  id: string,
  patch: BalanceProviderPatch,
): Promise<BalanceProviderView | null> {
  return mutate((store) => {
    const config = store.providers.find((provider) => provider.id === id);
    if (!config) return null;

    const nextBaseUrl = (patch.baseUrl ?? config.baseUrl).trim().replace(/\/+$/, "");
    const nextKind = patch.kind ? resolveKind(patch.kind, nextBaseUrl) : config.kind;
    // 留空 = 不修改 Key / Secret。
    const nextApiKey = patch.apiKey !== undefined ? patch.apiKey.trim() : config.apiKey;
    const nextAccessToken =
      patch.accessToken !== undefined ? patch.accessToken.trim() || undefined : config.accessToken;
    const nextAccessKeyId =
      patch.accessKeyId !== undefined ? patch.accessKeyId.trim() || undefined : config.accessKeyId;
    const nextSecretAccessKey =
      patch.secretAccessKey !== undefined
        ? patch.secretAccessKey.trim() || undefined
        : config.secretAccessKey;
    const nextOrganizationId =
      patch.organizationId !== undefined
        ? patch.organizationId.trim() || undefined
        : config.organizationId;
    const nextProjectId =
      patch.projectId !== undefined ? patch.projectId.trim() || undefined : config.projectId;

    const credentialsChanged =
      nextKind !== config.kind ||
      nextBaseUrl !== config.baseUrl ||
      nextApiKey !== config.apiKey ||
      nextAccessToken !== config.accessToken ||
      nextAccessKeyId !== config.accessKeyId ||
      nextSecretAccessKey !== config.secretAccessKey ||
      nextOrganizationId !== config.organizationId ||
      nextProjectId !== config.projectId;

    config.name = patch.name !== undefined ? patch.name.trim() || config.name : config.name;
    config.baseUrl = nextBaseUrl;
    config.kind = nextKind;
    config.apiKey = nextApiKey;
    config.accessToken = nextAccessToken;
    config.userId = patch.userId !== undefined ? patch.userId.trim() || undefined : config.userId;
    config.accessKeyId = nextAccessKeyId;
    config.secretAccessKey = nextSecretAccessKey;
    config.organizationId = nextOrganizationId;
    config.projectId = nextProjectId;
    config.updatedAt = Date.now();

    // 凭据 / 端点变化后允许立即重新查询（清空节流与冷却），旧的额度快照不再可信。
    if (credentialsChanged) {
      store.cache[id] = freshCacheEntry();
    }
    return toProviderView(config);
  });
}

export async function removeBalanceProvider(id: string): Promise<boolean> {
  return mutate((store) => {
    const index = store.providers.findIndex((provider) => provider.id === id);
    if (index === -1) return false;
    store.providers.splice(index, 1);
    delete store.cache[id];
    return true;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 同一供应商的并发查询共享同一个 Promise（in-flight 去重）。
const inflightQueries = new Map<string, Promise<BalanceQueryOutcome>>();

/**
 * 查询某供应商余额（服务端强制限流）：
 * 最小间隔内 / 冷却中直接返回缓存结果，不发真实请求。
 */
export function queryBalance(
  id: string,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<BalanceQueryOutcome> {
  const existing = inflightQueries.get(id);
  if (existing) return existing;

  const task = executeQuery(id, options).finally(() => {
    inflightQueries.delete(id);
  });
  inflightQueries.set(id, task);
  return task;
}

async function executeQuery(
  id: string,
  options: { fetchImpl?: typeof fetch },
): Promise<BalanceQueryOutcome> {
  const store = await readStore();
  const config = store.providers.find((provider) => provider.id === id);
  if (!config) {
    return {
      status: "fetched",
      fetchedAt: Date.now(),
      result: { success: false, data: null, error: "供应商不存在", errorKind: "deterministic" },
    };
  }
  const entry = store.cache[id] ?? freshCacheEntry();
  const decision = decideQuery(entry, Date.now());
  if (decision.action !== "fetch") {
    return {
      status: decision.action === "skip-cooldown" ? "cooldown" : "throttled",
      fetchedAt: entry.lastFetchedAt,
      result: entry.lastResult,
      waitMs: decision.waitMs,
      reason: decision.action === "skip-cooldown" ? decision.reason : null,
    };
  }

  // 外呼前先落盘 nextEligibleAt：即使本轮请求中途进程退出，重启后也不会立刻重打。
  await mutate((current) => {
    // 外呼期间供应商可能已被删除，不再写入孤儿缓存。
    if (!current.providers.some((provider) => provider.id === id)) return;
    const target = current.cache[id] ?? freshCacheEntry();
    target.nextEligibleAt = Date.now() + MIN_QUERY_INTERVAL_MS;
    current.cache[id] = target;
  });

  let result = await fetchBalance(config, options.fetchImpl);
  // 瞬时失败（网络 / 5xx）重试一次，429 不重试（对齐 cc-switch retry:1 / 1.5s）。
  let attempts = 0;
  while (!result.success && attempts < TRANSIENT_RETRY_COUNT && shouldRetryTransient(result)) {
    attempts += 1;
    await sleep(TRANSIENT_RETRY_DELAY_MS);
    result = await fetchBalance(config, options.fetchImpl);
  }

  const finishedAt = Date.now();
  const cooldown = cooldownFor(result, finishedAt);

  await mutate((current) => {
    // 外呼期间供应商可能已被删除，不再写入孤儿缓存。
    if (!current.providers.some((provider) => provider.id === id)) return;
    const target = current.cache[id] ?? freshCacheEntry();
    target.lastResult = result;
    target.lastFetchedAt = finishedAt;
    if (cooldown) {
      target.cooldownUntil = cooldown.until;
      target.cooldownReason = cooldown.reason;
    } else {
      target.cooldownUntil = 0;
      target.cooldownReason = null;
    }
    // 查询成功才更新 lastSuccess（keep-last-good）；失败保留旧快照。
    if (result.success && result.data) {
      const snapshotData: BalanceData[] = result.data;
      target.lastSuccess = { data: snapshotData, fetchedAt: finishedAt };
    }
    current.cache[id] = target;
  });

  return { status: "fetched", fetchedAt: finishedAt, result };
}
