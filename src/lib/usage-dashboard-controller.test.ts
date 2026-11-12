import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_USAGE_FILTERS,
  type UsageQueryFilters,
  type UsageRecordsPage,
  type UsageSyncResult,
  type UsageView,
  type UsageSyncStatus,
} from "@/lib/usage";
import {
  UsageDashboardController,
  type UsageDashboardEnvironment,
} from "@/lib/usage-dashboard-controller";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createEnvironment(startNow = 1_000_000) {
  let hidden = false;
  let currentNow = startNow;
  const listeners = new Set<() => void>();
  const intervals = new Map<
    unknown,
    { callback: () => void; milliseconds: number; lastFiredAt: number }
  >();
  const environment: UsageDashboardEnvironment = {
    setInterval: (callback, milliseconds) => {
      const timer = { callback, milliseconds, lastFiredAt: currentNow };
      intervals.set(timer, timer);
      return timer;
    },
    clearInterval: (timer) => {
      intervals.delete(timer);
    },
    isDocumentHidden: () => hidden,
    subscribeVisibility: (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    now: () => currentNow,
  };
  return {
    environment,
    /** 只触发已到期的 interval，与真实定时器的周期语义一致。 */
    tickIntervals() {
      for (const timer of Array.from(intervals.values())) {
        if (currentNow - timer.lastFiredAt >= timer.milliseconds) {
          timer.lastFiredAt = currentNow;
          timer.callback();
        }
      }
    },
    advance(milliseconds: number) {
      currentNow += milliseconds;
      this.tickIntervals();
    },
    setHidden(next: boolean) {
      hidden = next;
      for (const listener of listeners) listener();
    },
  };
}

function viewPayload(revision: number): UsageView {
  return {
    revision,
    snapshotAvailable: true,
    syncedAt: revision * 1000,
    sync: syncStatus(revision),
    sources: [],
    scannedFiles: 0,
    skippedFiles: 0,
    summary: {
      requests: revision,
      credits: 0,
      hasCredit: false,
      creditsByHarness: [],
      mixedCreditUnits: false,
      unbilledCredits: 0,
      tokens: 0,
      hasTokens: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheableInputTokens: 0,
      cacheRate: 0,
      successRate: 0,
      speedOutputTokens: 0,
      speedDurationMs: 0,
      firstTokenMedianMs: null,
      estFirstTokenMedianMs: null,
    },
    todaySummary: {
      requests: 0,
      credits: 0,
      hasCredit: false,
      creditsByHarness: [],
      mixedCreditUnits: false,
      unbilledCredits: 0,
      tokens: 0,
      hasTokens: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheableInputTokens: 0,
      cacheRate: 0,
      successRate: 0,
      speedOutputTokens: 0,
      speedDurationMs: 0,
      firstTokenMedianMs: null,
      estFirstTokenMedianMs: null,
    },
    trend: [],
    groups: { harness: [], provider: [], model: [], project: [] },
    facets: { projects: [], providers: [], models: [] },
    filteredCount: revision,
  };
}

function syncStatus(revision: number): UsageSyncStatus {
  return {
    phase: "ready",
    revision,
    hasSnapshot: true,
    startedAt: null,
    syncedAt: revision * 1000,
    durationMs: null,
    error: null,
    recordCount: revision,
  };
}

function syncPayload(revision: number, changed = false): UsageSyncResult {
  return {
    revision,
    changed,
    recordCount: revision,
    syncedAt: revision * 1000,
    sync: syncStatus(revision),
  };
}

function recordsPayload(page: number, total = 30, pageSize = 10): UsageRecordsPage {
  return {
    revision: 1,
    total,
    page,
    pageSize,
    records: [],
  };
}

async function flushPromises() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

const SEVEN_DAYS: UsageQueryFilters = {
  ...DEFAULT_USAGE_FILTERS,
  range: "7d",
};

describe("UsageDashboardController", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("初始加载查询视图与日志首页，并触发一轮同步", async () => {
    const env = createEnvironment();
    const fetchView = vi.fn(async () => viewPayload(3));
    const fetchRecords = vi.fn(async () => recordsPayload(0));
    const syncUsage = vi.fn(async () => syncPayload(3));
    const controller = new UsageDashboardController({
      fetchView,
      fetchRecords,
      syncUsage,
      environment: env.environment,
    });

    controller.start();
    await flushPromises();

    expect(fetchView).toHaveBeenCalledTimes(1);
    expect(fetchView).toHaveBeenCalledWith(DEFAULT_USAGE_FILTERS);
    expect(fetchRecords).toHaveBeenCalledTimes(1);
    expect(fetchRecords).toHaveBeenCalledWith(DEFAULT_USAGE_FILTERS, 0, 10);
    expect(syncUsage).toHaveBeenCalledTimes(1);
    // 初始同步 revision 与视图一致：不重查。
    expect(fetchView).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject({
      view: { data: { revision: 3 }, loading: false, updating: false, error: null },
      records: { data: { page: 0 }, loading: false },
      syncing: false,
      lastSyncedAt: 3000,
      syncError: null,
    });
    controller.stop();
  });

  it("自动同步无新数据时不重查视图与日志（只更新 lastSyncedAt）", async () => {
    const env = createEnvironment();
    const fetchView = vi.fn(async () => viewPayload(5));
    const fetchRecords = vi.fn(async () => recordsPayload(0));
    const syncUsage = vi.fn(async () => syncPayload(5));
    const controller = new UsageDashboardController({
      fetchView,
      fetchRecords,
      syncUsage,
      environment: env.environment,
      minuteInvalidationMs: 60_000,
    });
    controller.start();
    await flushPromises();
    expect(fetchView).toHaveBeenCalledTimes(1);

    // 推进 60s：自动同步 tick 与分钟失效 tick 都到达。
    // 分钟失效要求 >= minuteInvalidationMs 未查询才重查——刚好 60s 会触发一次。
    env.advance(61_000);
    await flushPromises();
    expect(syncUsage).toHaveBeenCalledTimes(2);
    // revision 未变：视图不因同步重查；分钟失效的重查是滚动范围允许的边界纠正。
    const viewCallsAfterMinute = fetchView.mock.calls.length;

    // 再推进 30s（无自动同步、未到分钟阈值）：什么都不应发生。
    env.advance(30_000);
    await flushPromises();
    expect(syncUsage).toHaveBeenCalledTimes(2);
    expect(fetchView.mock.calls.length).toBe(viewCallsAfterMinute);
    expect(fetchRecords.mock.calls.length).toBe(viewCallsAfterMinute);

    // 换成 all 范围后，分钟失效不再重查。
    controller.setFilters({ ...DEFAULT_USAGE_FILTERS, range: "all" });
    await flushPromises();
    const allCalls = fetchView.mock.calls.length;
    env.advance(120_000);
    await flushPromises();
    expect(fetchView.mock.calls.length).toBe(allCalls);
    controller.stop();
  });

  it("revision 变化后自动重查视图与当前页", async () => {
    const env = createEnvironment();
    let revision = 2;
    const fetchView = vi.fn(async () => viewPayload(revision));
    const fetchRecords = vi.fn(async (_filters: UsageQueryFilters, page: number) =>
      recordsPayload(page),
    );
    const syncUsage = vi.fn(async () => syncPayload(revision));
    const controller = new UsageDashboardController({
      fetchView,
      fetchRecords,
      syncUsage,
      environment: env.environment,
      minuteInvalidationMs: Number.MAX_SAFE_INTEGER,
    });
    controller.start();
    await flushPromises();
    controller.setPage(2);
    await flushPromises();
    expect(fetchRecords).toHaveBeenLastCalledWith(DEFAULT_USAGE_FILTERS, 2, 10);

    revision = 3;
    env.advance(60_000 + 1);
    await flushPromises();
    expect(fetchView.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fetchRecords).toHaveBeenLastCalledWith(DEFAULT_USAGE_FILTERS, 2, 10);
    expect(controller.getState().view.data?.revision).toBe(3);
    controller.stop();
  });

  it("切换筛选保留上一份数据，慢的旧响应不会覆盖新筛选结果", async () => {
    const env = createEnvironment();
    const slow = deferred<UsageView>();
    const thirtyDays: UsageQueryFilters = { ...DEFAULT_USAGE_FILTERS, range: "30d" };
    const fetchView = vi.fn()
      .mockResolvedValueOnce(viewPayload(1))
      // 第二次（7d）挂起：模拟慢请求。
      .mockImplementationOnce(() => slow.promise)
      // 第三次（30d）快速返回。
      .mockImplementationOnce(async () => ({ ...viewPayload(2), filteredCount: 42 }));
    const fetchRecords = vi.fn(async () => recordsPayload(0));
    const controller = new UsageDashboardController({
      fetchView,
      fetchRecords,
      syncUsage: async () => syncPayload(1),
      environment: env.environment,
      minuteInvalidationMs: Number.MAX_SAFE_INTEGER,
    });
    controller.start();
    await flushPromises();
    const first = controller.getState().view.data;

    controller.setFilters(SEVEN_DAYS);
    await flushPromises();
    // 慢查询进行中：保留旧数据并标记 updating。
    expect(controller.getState().view).toMatchObject({
      data: first,
      updating: true,
    });
    expect(fetchView).toHaveBeenLastCalledWith(SEVEN_DAYS);

    // 再切到 30d：新请求快速完成并胜出。
    controller.setFilters(thirtyDays);
    await flushPromises();
    expect(controller.getState().view.data).toMatchObject({ revision: 2, filteredCount: 42 });
    expect(controller.getState().view.updating).toBe(false);

    // 旧筛选（7d）的慢响应这时才返回：被代次丢弃，不覆盖 30d 结果。
    slow.resolve({ ...viewPayload(1), filteredCount: 999 });
    await flushPromises();
    expect(controller.getState().view.data).toMatchObject({ revision: 2, filteredCount: 42 });
    controller.stop();
  });

  it("翻页与筛选重置页码；服务端页码钳制会回填", async () => {
    const env = createEnvironment();
    const fetchView = vi.fn(async () => viewPayload(1));
    const fetchRecords = vi.fn(async (filters, page) => recordsPayload(Math.min(page, 2), 25));
    const controller = new UsageDashboardController({
      fetchView,
      fetchRecords,
      syncUsage: async () => syncPayload(1),
      environment: env.environment,
      minuteInvalidationMs: Number.MAX_SAFE_INTEGER,
    });
    controller.start();
    await flushPromises();

    controller.setPage(2);
    await flushPromises();
    expect(controller.getPage()).toBe(2);

    // 越界页被服务端钳制到最后一页（25 条 / 10 每页 = 3 页）。
    controller.setPage(50);
    await flushPromises();
    expect(controller.getPage()).toBe(2);
    expect(controller.getState().records.data?.page).toBe(2);

    // 切换筛选重置回第一页。
    controller.setFilters(SEVEN_DAYS);
    await flushPromises();
    expect(controller.getPage()).toBe(0);
    expect(fetchRecords).toHaveBeenLastCalledWith(SEVEN_DAYS, 0, 10);
    controller.stop();
  });

  it("切换页大小重置到第一页并按新页大小查询", async () => {
    const env = createEnvironment();
    const fetchView = vi.fn(async () => viewPayload(1));
    const fetchRecords = vi.fn(
      async (_filters: UsageQueryFilters, page: number, pageSize: number) =>
        recordsPayload(page, 100, pageSize),
    );
    const controller = new UsageDashboardController({
      fetchView,
      fetchRecords,
      syncUsage: async () => syncPayload(1),
      environment: env.environment,
      minuteInvalidationMs: Number.MAX_SAFE_INTEGER,
    });
    controller.start();
    await flushPromises();

    controller.setPage(2);
    await flushPromises();
    expect(fetchRecords).toHaveBeenLastCalledWith(DEFAULT_USAGE_FILTERS, 2, 10);

    controller.setPageSize(20);
    await flushPromises();
    expect(controller.getPage()).toBe(0);
    expect(controller.getPageSize()).toBe(20);
    expect(fetchRecords).toHaveBeenLastCalledWith(DEFAULT_USAGE_FILTERS, 0, 20);
    expect(controller.getState().records).toMatchObject({
      data: { page: 0, pageSize: 20 },
      loading: false,
      updating: false,
    });

    const requestCount = fetchRecords.mock.calls.length;
    controller.setPageSize(20);
    expect(fetchRecords).toHaveBeenCalledTimes(requestCount);
    controller.stop();
  });

  it("查询失败保留旧数据，下一次成功同步后重查恢复", async () => {
    const env = createEnvironment();
    let failView = false;
    const fetchView = vi.fn(async () => {
      if (failView) throw new Error("boom");
      return viewPayload(4);
    });
    const fetchRecords = vi.fn(async () => recordsPayload(0));
    const controller = new UsageDashboardController({
      fetchView,
      fetchRecords,
      syncUsage: async () => syncPayload(4),
      environment: env.environment,
      minuteInvalidationMs: Number.MAX_SAFE_INTEGER,
    });
    controller.start();
    await flushPromises();
    const good = controller.getState().view.data;

    failView = true;
    controller.setFilters(SEVEN_DAYS);
    await flushPromises();
    expect(controller.getState().view).toMatchObject({
      data: good,
      updating: false,
      error: "boom",
    });

    // revision 未变但存在查询错误：同步完成后重试查询。
    failView = false;
    env.advance(60_000 + 1);
    await flushPromises();
    expect(controller.getState().view.error).toBeNull();
    expect(controller.getState().view.updating).toBe(false);
    controller.stop();
  });

  it("手动同步展示 syncing 状态；同步失败保留数据并可重试", async () => {
    const env = createEnvironment();
    const pending = deferred<UsageSyncResult>();
    const syncUsage = vi.fn(() => pending.promise);
    const controller = new UsageDashboardController({
      fetchView: async () => viewPayload(1),
      fetchRecords: async () => recordsPayload(0),
      syncUsage,
      environment: env.environment,
      minuteInvalidationMs: Number.MAX_SAFE_INTEGER,
    });
    controller.start();
    await flushPromises();

    const manual = controller.refresh();
    expect(controller.getState().syncing).toBe(true);
    pending.resolve(syncPayload(1));
    await manual;
    expect(controller.getState().syncing).toBe(false);
    controller.stop();
  });
});
