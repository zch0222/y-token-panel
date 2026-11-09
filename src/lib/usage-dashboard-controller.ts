import {
  UsageRefreshController,
  type UsageRefreshEnvironment,
} from "@/lib/usage-refresh-controller";
import {
  DEFAULT_USAGE_FILTERS,
  type UsageQueryFilters,
  type UsageRecordsPage,
  type UsageSyncResult,
  type UsageView,
} from "@/lib/usage";

export interface UsageQuerySection<T> {
  data: T | null;
  /** 首次查询（尚无任何数据）时展示全页骨架。 */
  loading: boolean;
  /** 保留旧数据的后台重查；切换筛选、翻页或 revision 变化时为 true。 */
  updating: boolean;
  error: string | null;
}

export interface UsageDashboardState {
  view: UsageQuerySection<UsageView>;
  records: UsageQuerySection<UsageRecordsPage>;
  /** 手动同步进行中。 */
  syncing: boolean;
  /** 自动 / 回前台触发的后台同步进行中。 */
  refreshing: boolean;
  lastSyncedAt: number | null;
  syncError: string | null;
}

export interface UsageDashboardEnvironment extends UsageRefreshEnvironment {
  now: () => number;
}

export interface UsageDashboardDeps {
  /** 服务端聚合视图查询（/api/usage/query）。 */
  fetchView: (filters: UsageQueryFilters) => Promise<UsageView>;
  /** 请求日志分页查询（/api/usage/records）。 */
  fetchRecords: (filters: UsageQueryFilters, page: number, pageSize: number) => Promise<UsageRecordsPage>;
  /** 触发一次本地同步；返回小结果（revision 等），不携带全部记录。 */
  syncUsage: () => Promise<UsageSyncResult>;
  pageSize?: number;
  /** 滚动范围的分钟级失效间隔。 */
  minuteInvalidationMs?: number;
  environment?: UsageDashboardEnvironment;
}

const browserDashboardEnvironment: UsageDashboardEnvironment = {
  setInterval: (callback, milliseconds) => window.setInterval(callback, milliseconds),
  clearInterval: (timer) => window.clearInterval(timer as number),
  isDocumentHidden: () => document.hidden,
  subscribeVisibility: (callback) => {
    document.addEventListener("visibilitychange", callback);
    return () => document.removeEventListener("visibilitychange", callback);
  },
  now: () => Date.now(),
};

function sameFilters(a: UsageQueryFilters, b: UsageQueryFilters): boolean {
  return (
    a.range === b.range &&
    a.harness === b.harness &&
    a.project === b.project &&
    a.provider === b.provider &&
    a.model === b.model &&
    a.billing === b.billing
  );
}

function queryError(error: unknown): string {
  return error instanceof Error ? error.message : "查询用量数据失败";
}

/**
 * M6 面板数据控制器：聚合视图与日志分页按筛选查询，自动刷新只在 revision
 * 变化或滚动范围（今天等）按分钟失效时重查；切换筛选保留上一份数据。
 * 同步循环（single-flight、自动 tick 跳过、可见性暂停）复用 UsageRefreshController。
 */
export class UsageDashboardController {
  private readonly deps: UsageDashboardDeps;
  private readonly environment: UsageDashboardEnvironment;
  private pageSize: number;
  private readonly minuteInvalidationMs: number;
  private readonly syncLoop: UsageRefreshController<UsageSyncResult>;

  private state: UsageDashboardState = {
    view: { data: null, loading: true, updating: false, error: null },
    records: { data: null, loading: true, updating: false, error: null },
    syncing: false,
    refreshing: false,
    lastSyncedAt: null,
    syncError: null,
  };
  private readonly listeners = new Set<(state: UsageDashboardState) => void>();

  private filters: UsageQueryFilters = DEFAULT_USAGE_FILTERS;
  private page = 0;
  private viewGeneration = 0;
  private recordsGeneration = 0;
  /** 已见过的最高 revision；视图与同步结果共同推进。 */
  private seenRevision: number | null = null;
  private lastSyncData: UsageSyncResult | null = null;
  private lastViewFetchAt = 0;
  private active = false;
  private minuteTimer: unknown = null;
  private unsubscribeVisibility: (() => void) | null = null;

  constructor(deps: UsageDashboardDeps) {
    this.deps = deps;
    this.environment = deps.environment ?? browserDashboardEnvironment;
    this.pageSize = deps.pageSize ?? 10;
    this.minuteInvalidationMs = deps.minuteInvalidationMs ?? 60_000;
    this.syncLoop = new UsageRefreshController(deps.syncUsage, this.environment);
  }

  getState = (): UsageDashboardState => this.state;

  getFilters = (): UsageQueryFilters => this.filters;

  getPage = (): number => this.page;

  getPageSize = (): number => this.pageSize;

  subscribe = (listener: (state: UsageDashboardState) => void): (() => void) => {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  };

  start = (): void => {
    if (this.active) return;
    this.active = true;
    this.lastViewFetchAt = this.environment.now();
    this.unsubscribeVisibility = this.environment.subscribeVisibility(this.onVisibilityChange);
    this.minuteTimer = this.environment.setInterval(
      this.onMinuteTick,
      this.minuteInvalidationMs,
    );
    this.syncLoop.subscribe(this.onSyncState);
    void this.syncLoop.start();
    this.fetchView();
    this.fetchRecords();
  };

  stop = (): void => {
    this.active = false;
    this.syncLoop.stop();
    if (this.minuteTimer !== null) {
      this.environment.clearInterval(this.minuteTimer);
      this.minuteTimer = null;
    }
    this.unsubscribeVisibility?.();
    this.unsubscribeVisibility = null;
  };

  setAutoRefresh = (milliseconds: number): void => {
    this.syncLoop.setAutoRefresh(milliseconds);
  };

  /** 手动同步；重查逻辑与自动刷新一致（只在 revision 变化或存在查询错误时）。 */
  refresh = (): Promise<void> => this.syncLoop.refresh();

  setFilters = (filters: UsageQueryFilters): void => {
    if (sameFilters(filters, this.filters)) return;
    this.filters = filters;
    this.page = 0;
    this.fetchView();
    this.fetchRecords();
  };

  setPage = (page: number): void => {
    const next = Math.max(0, Math.floor(page));
    if (next === this.page) return;
    this.page = next;
    this.fetchRecords();
  };

  setPageSize = (pageSize: number): void => {
    const next = Math.max(1, Math.floor(pageSize));
    if (next === this.pageSize) return;
    this.pageSize = next;
    this.page = 0;
    this.fetchRecords();
  };

  /** 同步或分钟失效后的重查；保留旧数据。 */
  private refetchQueries(): void {
    this.fetchView();
    this.fetchRecords();
  }

  private fetchView(): void {
    const generation = ++this.viewGeneration;
    const filters = this.filters;
    const hasData = this.state.view.data !== null;
    this.lastViewFetchAt = this.environment.now();
    this.patchState({
      view: {
        data: this.state.view.data,
        loading: !hasData,
        updating: hasData,
        error: null,
      },
    });

    void this.deps.fetchView(filters).then(
      (view) => {
        if (generation !== this.viewGeneration) return;
        // 视图可能落后于同步结果见过的 revision（查询与提交交错）；立即重查追平。
        const stale = this.seenRevision !== null && view.revision < this.seenRevision;
        if (!stale) this.seenRevision = view.revision;
        this.patchState({
          view: { data: view, loading: false, updating: false, error: null },
        });
        if (stale) this.fetchView();
      },
      (error) => {
        if (generation !== this.viewGeneration) return;
        this.patchState({
          view: {
            data: this.state.view.data,
            loading: false,
            updating: false,
            error: queryError(error),
          },
        });
      },
    );
  }

  private fetchRecords(): void {
    const generation = ++this.recordsGeneration;
    const filters = this.filters;
    const page = this.page;
    const hasData = this.state.records.data !== null;
    this.patchState({
      records: {
        data: this.state.records.data,
        loading: !hasData,
        updating: hasData,
        error: null,
      },
    });

    void this.deps.fetchRecords(filters, page, this.pageSize).then(
      (records) => {
        if (generation !== this.recordsGeneration) return;
        // 筛选已再次变化时丢弃；服务端页码钳制回填到当前页。
        if (sameFilters(filters, this.filters) && records.page !== this.page) {
          this.page = records.page;
        }
        this.patchState({
          records: { data: records, loading: false, updating: false, error: null },
        });
      },
      (error) => {
        if (generation !== this.recordsGeneration) return;
        this.patchState({
          records: {
            data: this.state.records.data,
            loading: false,
            updating: false,
            error: queryError(error),
          },
        });
      },
    );
  }

  private onSyncState = (syncState: {
    data: UsageSyncResult | null;
    syncing: boolean;
    refreshing: boolean;
    error: string | null;
  }): void => {
    this.patchState({
      syncing: syncState.syncing,
      refreshing: syncState.refreshing,
      syncError: syncState.error,
    });

    const result = syncState.data;
    if (result === null || result === this.lastSyncData) return;
    this.lastSyncData = result;
    this.patchState({ lastSyncedAt: result.syncedAt });

    const hasQueryError =
      this.state.view.error !== null || this.state.records.error !== null;
    if (this.seenRevision === null) {
      // 首轮同步可能先于视图返回：只登记 revision，由在途视图带出数据，
      // 避免启动阶段重复查询；若视图查询已失败，借这次同步立即重试。
      this.seenRevision = result.revision;
      if (hasQueryError) this.refetchQueries();
      return;
    }
    if (result.revision !== this.seenRevision || hasQueryError) {
      this.seenRevision = result.revision;
      this.refetchQueries();
    }
  };

  /** 滚动范围（今天/昨天/近 N 天）按分钟失效：跨午夜后无需新数据也能纠正边界。 */
  private onMinuteTick = (): void => {
    if (!this.active || this.environment.isDocumentHidden()) return;
    if (this.filters.range === "all") return;
    if (this.environment.now() - this.lastViewFetchAt < this.minuteInvalidationMs) return;
    this.refetchQueries();
  };

  private onVisibilityChange = (): void => {
    if (!this.active) return;
    if (this.environment.isDocumentHidden()) return;
    // 同步循环回前台会补一轮同步；这里只补滚动范围的分钟失效。
    if (
      this.filters.range !== "all" &&
      this.environment.now() - this.lastViewFetchAt >= this.minuteInvalidationMs
    ) {
      this.refetchQueries();
    }
  };

  private patchState(patch: Partial<UsageDashboardState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}
