import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addBalanceProvider,
  listBalanceState,
  queryBalance,
  removeBalanceProvider,
  updateBalanceProvider,
} from "@/lib/balance-store";
import { MIN_QUERY_INTERVAL_MS, RATE_LIMIT_COOLDOWN_MS } from "@/lib/balance-throttle";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const deepseekBody = {
  is_available: true,
  balance_infos: [{ currency: "CNY", total_balance: "66.60" }],
};

let dataDir: string;

beforeEach(async () => {
  vi.useFakeTimers();
  dataDir = await mkdtemp(path.join(tmpdir(), "y-token-panel-balance-"));
  process.env.Y_TOKEN_PANEL_DATA_DIR = dataDir;
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env.Y_TOKEN_PANEL_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

async function addDeepseek(): Promise<string> {
  const provider = await addBalanceProvider({
    name: "DeepSeek 主号",
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-test-1234567890abcdef",
    kind: "auto",
  });
  return provider.id;
}

describe("供应商配置 CRUD", () => {
  it("auto 类型按 Base URL 自动识别供应商", async () => {
    const provider = await addBalanceProvider({
      name: "DS",
      baseUrl: "https://api.deepseek.com/",
      apiKey: "sk-test-1234567890abcdef",
      kind: "auto",
    });
    expect(provider.kind).toBe("deepseek");
    expect(provider.apiKeyMasked).toBe("sk-tes···cdef");
  });

  it("未识别的地址回落到通用模板", async () => {
    const provider = await addBalanceProvider({
      name: "中转站",
      baseUrl: "https://relay.example.com/v1",
      apiKey: "sk-relay-key-000111",
      kind: "auto",
    });
    expect(provider.kind).toBe("general");
  });

  it("非 newapi 供应商缺少 API Key 时报错", async () => {
    await expect(
      addBalanceProvider({ name: "无 Key", baseUrl: "https://api.deepseek.com", apiKey: "", kind: "auto" }),
    ).rejects.toThrow("请填写 API Key");
  });

  it("列表只返回脱敏视图，明文 Key 不落响应、不落缓存", async () => {
    const id = await addDeepseek();
    const state = await listBalanceState();
    expect(state.providers).toHaveLength(1);
    expect(state.providers[0].apiKeyMasked).toBe("sk-tes···cdef");
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("sk-test-1234567890abcdef");
    expect(state.cache[id]).toBeDefined();
  });

  it("编辑时 API Key 留空表示保持不变，更换 Key 会清空限流缓存", async () => {
    const id = await addDeepseek();
    const fetchMock = vi.fn(async () => jsonResponse(deepseekBody));
    await queryBalance(id, { fetchImpl: fetchMock as unknown as typeof fetch });

    const before = await listBalanceState();
    expect(before.cache[id].nextEligibleAt).toBeGreaterThan(Date.now());

    // 留空 Key：名称更新，凭据不变 → 缓存保留。
    await updateBalanceProvider(id, { name: "改名" });
    const unchanged = await listBalanceState();
    expect(unchanged.providers[0].name).toBe("改名");
    expect(unchanged.cache[id].nextEligibleAt).toBe(before.cache[id].nextEligibleAt);

    // 更换 Key：允许立即重新查询。
    await updateBalanceProvider(id, { apiKey: "sk-new-key-987654321" });
    const reset = await listBalanceState();
    expect(reset.cache[id].nextEligibleAt).toBe(0);
    expect(reset.cache[id].cooldownUntil).toBe(0);
  });

  it("删除供应商会连同缓存一起移除", async () => {
    const id = await addDeepseek();
    expect(await removeBalanceProvider(id)).toBe(true);
    const state = await listBalanceState();
    expect(state.providers).toHaveLength(0);
    expect(state.cache[id]).toBeUndefined();
    expect(await removeBalanceProvider(id)).toBe(false);
  });
});

describe("queryBalance 限流与防风控", () => {
  it("查询成功写入 lastSuccess，最小间隔内再查直接回缓存", async () => {
    const id = await addDeepseek();
    const fetchMock = vi.fn(async () => jsonResponse(deepseekBody));

    const first = await queryBalance(id, { fetchImpl: fetchMock as unknown as typeof fetch });
    expect(first.status).toBe("fetched");
    expect(first.result?.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const state = await listBalanceState();
    expect(state.cache[id].lastSuccess?.data[0].remaining).toBe(66.6);
    expect(state.cache[id].nextEligibleAt).toBeGreaterThan(Date.now());

    // 手动刷新连点：服务端节流，不发起第二次真实请求。
    const second = await queryBalance(id, { fetchImpl: fetchMock as unknown as typeof fetch });
    expect(second.status).toBe("throttled");
    expect(second.result?.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 间隔结束后放行真实外呼。
    await vi.advanceTimersByTimeAsync(MIN_QUERY_INTERVAL_MS + 1_000);
    const third = await queryBalance(id, { fetchImpl: fetchMock as unknown as typeof fetch });
    expect(third.status).toBe("fetched");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("同一供应商的并发查询共享同一个 in-flight 请求", async () => {
    const id = await addDeepseek();
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );

    const first = queryBalance(id, { fetchImpl: fetchMock as unknown as typeof fetch });
    const second = queryBalance(id, { fetchImpl: fetchMock as unknown as typeof fetch });
    // 等真实外呼挂起后再放行响应，确保两个并发调用共享同一 in-flight Promise。
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveFetch(jsonResponse(deepseekBody));
    const [outcomeA, outcomeB] = await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcomeA.status).toBe("fetched");
    expect(outcomeB.status).toBe("fetched");
    expect(outcomeA.result?.success).toBe(true);
    expect(outcomeB.result?.success).toBe(true);
  });

  it("网络抖动只重试一次（1.5s 后），重试成功不进冷却", async () => {
    const id = await addDeepseek();
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("fetch failed");
      return jsonResponse(deepseekBody);
    });

    const pending = queryBalance(id, { fetchImpl: fetchMock as unknown as typeof fetch });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_500);
    const outcome = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outcome.status).toBe("fetched");
    expect(outcome.result?.success).toBe(true);

    const state = await listBalanceState();
    expect(state.cache[id].cooldownUntil).toBe(0);
  });

  it("HTTP 429 不重试，进入 5 分钟冷却并保留上次成功值", async () => {
    const id = await addDeepseek();
    const okMock = vi.fn(async () => jsonResponse(deepseekBody));
    await queryBalance(id, { fetchImpl: okMock as unknown as typeof fetch });

    await vi.advanceTimersByTimeAsync(MIN_QUERY_INTERVAL_MS + 1_000);
    const limitedMock = vi.fn(
      async () => jsonResponse({ message: "too many requests" }, 429),
    );
    const outcome = await queryBalance(id, { fetchImpl: limitedMock as unknown as typeof fetch });

    expect(limitedMock).toHaveBeenCalledTimes(1); // 429 不重试
    expect(outcome.status).toBe("fetched");
    expect(outcome.result?.success).toBe(false);
    expect(outcome.result?.errorKind).toBe("transient");

    const state = await listBalanceState();
    expect(state.cache[id].cooldownUntil).toBeGreaterThan(Date.now());
    expect(state.cache[id].lastSuccess?.data[0].remaining).toBe(66.6); // keep-last-good

    // 冷却期内再查：直接返回缓存，不外呼。
    const blocked = await queryBalance(id, { fetchImpl: limitedMock as unknown as typeof fetch });
    expect(blocked.status).toBe("cooldown");
    expect(limitedMock).toHaveBeenCalledTimes(1);

    // 冷却 + 最小间隔都结束后恢复查询。
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_COOLDOWN_MS + MIN_QUERY_INTERVAL_MS + 1_000);
    const recovered = await queryBalance(id, { fetchImpl: okMock as unknown as typeof fetch });
    expect(recovered.status).toBe("fetched");
  });

  it("HTTP 401 判定 Key 失效（确定性失败，不进冷却）", async () => {
    const id = await addDeepseek();
    const fetchMock = vi.fn(async () => jsonResponse({ error: "bad key" }, 401));

    const outcome = await queryBalance(id, { fetchImpl: fetchMock as unknown as typeof fetch });
    expect(outcome.result?.success).toBe(false);
    expect(outcome.result?.data?.[0].isValid).toBe(false);
    expect(outcome.result?.data?.[0].invalidMessage).toContain("Key 已失效");
    expect(fetchMock).toHaveBeenCalledTimes(1); // 确定性失败不重试

    const state = await listBalanceState();
    expect(state.cache[id].cooldownUntil).toBe(0);
  });

  it("查询不存在的供应商返回确定性错误", async () => {
    const outcome = await queryBalance("missing-id");
    expect(outcome.result?.success).toBe(false);
    expect(outcome.result?.error).toBe("供应商不存在");
  });

  it("外呼期间删除供应商不会写回孤儿缓存", async () => {
    const id = await addDeepseek();
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () => new Promise<Response>((resolve) => (resolveFetch = resolve)),
    );
    const pending = queryBalance(id, { fetchImpl: fetchMock as unknown as typeof fetch });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await removeBalanceProvider(id);
    resolveFetch(jsonResponse(deepseekBody));
    await pending;

    const state = await listBalanceState();
    expect(state.providers).toHaveLength(0);
    expect(Object.keys(state.cache)).toHaveLength(0);
  });
});

describe("持久化", () => {
  it("配置与缓存写入 balance.json（Y_TOKEN_PANEL_DATA_DIR 可覆盖位置）", async () => {
    const id = await addDeepseek();
    await queryBalance(id, {
      fetchImpl: vi.fn(async () => jsonResponse(deepseekBody)) as unknown as typeof fetch,
    });
    const raw = await readFile(path.join(dataDir, "balance.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      providers: { id: string; apiKey: string }[];
      cache: Record<string, { lastSuccess: { data: unknown[] } }>;
    };
    expect(parsed.providers[0].id).toBe(id);
    // 文件是本机存储，明文 Key 允许存在；对 HTTP 只暴露脱敏视图。
    expect(parsed.providers[0].apiKey).toBe("sk-test-1234567890abcdef");
    expect(parsed.cache[id].lastSuccess.data).toHaveLength(1);
  });
});
