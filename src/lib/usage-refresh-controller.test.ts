import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageResponse } from "@/lib/usage";
import {
  UsageRefreshController,
  type UsageRefreshEnvironment,
} from "@/lib/usage-refresh-controller";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function payload(syncedAt: number): UsageResponse {
  return { records: [], sources: [], scannedFiles: 0, skippedFiles: 0, syncedAt };
}

function createEnvironment() {
  let hidden = false;
  const listeners = new Set<() => void>();
  const environment: UsageRefreshEnvironment = {
    setInterval: (callback, milliseconds) => globalThis.setInterval(callback, milliseconds),
    clearInterval: (timer) => globalThis.clearInterval(timer as NodeJS.Timeout),
    isDocumentHidden: () => hidden,
    subscribeVisibility: (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
  };

  return {
    environment,
    setHidden(next: boolean) {
      hidden = next;
      for (const listener of listeners) listener();
    },
  };
}

async function flushPromises() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

describe("UsageRefreshController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("首次与手动共享 Promise，自动 tick 在 pending 时跳过", async () => {
    const pending = deferred<UsageResponse>();
    const fetchUsage = vi.fn(() => pending.promise);
    const controller = new UsageRefreshController(fetchUsage, createEnvironment().environment);

    const initial = controller.start();
    const manual = controller.refresh();
    expect(manual).toBe(initial);
    expect(controller.getState()).toMatchObject({ loading: true, syncing: true });

    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    expect(controller.getStats()).toEqual({
      requests: 1,
      skippedAutoTicks: 2,
      pendingRequests: 1,
      maxPendingRequests: 1,
    });

    pending.resolve(payload(1));
    await Promise.all([initial, manual]);
    expect(controller.getState()).toMatchObject({
      data: payload(1),
      loading: false,
      refreshing: false,
      syncing: false,
      error: null,
    });
    controller.stop();
  });

  it("后台刷新保留旧数据，手动同步加入后分别维护状态", async () => {
    const fetchUsage = vi.fn<() => Promise<UsageResponse>>().mockResolvedValueOnce(payload(1));
    const controller = new UsageRefreshController(fetchUsage, createEnvironment().environment);
    await controller.start();

    const background = deferred<UsageResponse>();
    fetchUsage.mockReturnValueOnce(background.promise);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(controller.getState()).toMatchObject({
      data: payload(1),
      loading: false,
      refreshing: true,
      syncing: false,
    });

    const manual = controller.refresh();
    expect(controller.getState()).toMatchObject({ refreshing: true, syncing: true });
    expect(fetchUsage).toHaveBeenCalledTimes(2);

    background.resolve(payload(2));
    await manual;
    expect(controller.getState()).toMatchObject({
      data: payload(2),
      loading: false,
      refreshing: false,
      syncing: false,
    });

    const manualOnly = deferred<UsageResponse>();
    fetchUsage.mockReturnValueOnce(manualOnly.promise);
    const manualRequest = controller.refresh();
    expect(controller.getState()).toMatchObject({
      data: payload(2),
      loading: false,
      refreshing: false,
      syncing: true,
    });
    manualOnly.resolve(payload(3));
    await manualRequest;
    expect(controller.getState().data).toEqual(payload(3));
    controller.stop();
  });

  it("自动刷新失败保留最后成功数据，手动重试成功后清除错误", async () => {
    const failedRefresh = deferred<UsageResponse>();
    const fetchUsage = vi
      .fn<() => Promise<UsageResponse>>()
      .mockResolvedValueOnce(payload(1))
      .mockReturnValueOnce(failedRefresh.promise)
      .mockResolvedValueOnce(payload(3));
    const controller = new UsageRefreshController(fetchUsage, createEnvironment().environment);
    await controller.start();

    await vi.advanceTimersByTimeAsync(60_000);
    failedRefresh.reject(new Error("network unavailable"));
    await flushPromises();

    expect(controller.getState()).toMatchObject({
      data: payload(1),
      loading: false,
      refreshing: false,
      syncing: false,
      error: "network unavailable",
    });

    await controller.refresh();
    expect(controller.getState()).toMatchObject({ data: payload(3), error: null });
    controller.stop();
  });

  it("隐藏时暂停自动扫描，恢复可见后只补一轮", async () => {
    const resumed = deferred<UsageResponse>();
    const fetchUsage = vi
      .fn<() => Promise<UsageResponse>>()
      .mockResolvedValueOnce(payload(1))
      .mockReturnValueOnce(resumed.promise);
    const { environment, setHidden } = createEnvironment();
    const controller = new UsageRefreshController(fetchUsage, environment);
    await controller.start();

    setHidden(true);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(fetchUsage).toHaveBeenCalledTimes(1);

    setHidden(false);
    setHidden(false);
    expect(fetchUsage).toHaveBeenCalledTimes(2);
    expect(controller.getState()).toMatchObject({ data: payload(1), refreshing: true });

    resumed.resolve(payload(2));
    await flushPromises();
    expect(controller.getState().data).toEqual(payload(2));
    expect(fetchUsage).toHaveBeenCalledTimes(2);
    controller.stop();
  });

  it("回前台时若已有请求则复用，关闭自动刷新则不补扫", async () => {
    const pending = deferred<UsageResponse>();
    const fetchUsage = vi.fn(() => pending.promise);
    const { environment, setHidden } = createEnvironment();
    const controller = new UsageRefreshController(fetchUsage, environment);
    const initial = controller.start();

    setHidden(true);
    setHidden(false);
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    pending.resolve(payload(1));
    await initial;

    controller.setAutoRefresh(0);
    setHidden(true);
    setHidden(false);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    controller.stop();
  });

  it("假时钟连续 30 分钟、单轮 90 秒时最多只有一个 pending 请求", async () => {
    const fetchUsage = vi.fn<() => Promise<UsageResponse>>(() =>
      new Promise((resolve) => {
        globalThis.setTimeout(() => resolve(payload(Date.now())), 90_000);
      }),
    );
    const controller = new UsageRefreshController(fetchUsage, createEnvironment().environment);
    void controller.start();

    await vi.advanceTimersByTimeAsync(30 * 60_000);

    expect(fetchUsage).toHaveBeenCalledTimes(16);
    expect(controller.getStats()).toEqual({
      requests: 16,
      skippedAutoTicks: 15,
      pendingRequests: 1,
      maxPendingRequests: 1,
    });
    controller.stop();
  });

  it("首载先展示持久化旧快照，再以后台同步结果替换", async () => {
    const synchronized = deferred<UsageResponse>();
    const sync = vi.fn(() => synchronized.promise);
    const query = vi.fn(async () => ({ ...payload(1), revision: 4, snapshotAvailable: true }));
    const controller = new UsageRefreshController(sync, createEnvironment().environment, {
      querySnapshot: query,
    });

    const initial = controller.start();
    await flushPromises();
    expect(query).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject({
      data: { syncedAt: 1, revision: 4 },
      loading: false,
      refreshing: true,
    });

    synchronized.resolve({ ...payload(2), revision: 5, snapshotAvailable: true });
    await initial;
    expect(controller.getState()).toMatchObject({
      data: { syncedAt: 2, revision: 5 },
      loading: false,
      refreshing: false,
      error: null,
    });
    controller.stop();
  });

  it("空数据库响应不写成真实数据，首次同步失败也没有伪造零用量", async () => {
    const synchronized = deferred<UsageResponse>();
    const controller = new UsageRefreshController(
      () => synchronized.promise,
      createEnvironment().environment,
      {
        querySnapshot: async () => ({
          ...payload(0),
          revision: 0,
          snapshotAvailable: false,
          sync: {
            phase: "importing",
            revision: 0,
            hasSnapshot: false,
            startedAt: 1,
            syncedAt: null,
            durationMs: null,
            error: null,
            recordCount: 0,
          },
        }),
      },
    );

    const initial = controller.start();
    await flushPromises();
    expect(controller.getState()).toMatchObject({ data: null, loading: true, error: null });

    synchronized.reject(new Error("import failed"));
    await initial;
    expect(controller.getState()).toMatchObject({
      data: null,
      loading: false,
      error: "import failed",
    });
    controller.stop();
  });
});
