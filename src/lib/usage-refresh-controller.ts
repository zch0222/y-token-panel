import type { UsageResponse } from "@/lib/usage";

export type UsageLoadTrigger = "initial" | "auto" | "manual" | "visibility";

export interface UsageViewState<T = UsageResponse> {
  data: T | null;
  /** 仅在没有任何成功数据时展示全页 loading。 */
  loading: boolean;
  /** 自动或回前台触发的后台刷新。 */
  refreshing: boolean;
  /** 用户手动同步；可叠加在同一个后台请求上。 */
  syncing: boolean;
  error: string | null;
}

export interface UsageRefreshStats {
  requests: number;
  skippedAutoTicks: number;
  pendingRequests: number;
  maxPendingRequests: number;
}

export interface UsageRefreshEnvironment {
  setInterval: (callback: () => void, milliseconds: number) => unknown;
  clearInterval: (timer: unknown) => void;
  isDocumentHidden: () => boolean;
  subscribeVisibility: (callback: () => void) => () => void;
}

export interface UsageRefreshOptions {
  /** 首载同步前先查询持久化快照；空快照响应不会作为真实零用量展示。 */
  querySnapshot?: () => Promise<UsageResponse>;
}

const browserEnvironment: UsageRefreshEnvironment = {
  setInterval: (callback, milliseconds) => window.setInterval(callback, milliseconds),
  clearInterval: (timer) => window.clearInterval(timer as number),
  isDocumentHidden: () => document.hidden,
  subscribeVisibility: (callback) => {
    document.addEventListener("visibilitychange", callback);
    return () => document.removeEventListener("visibilitychange", callback);
  },
};

const initialState: UsageViewState<never> = {
  data: null,
  loading: true,
  refreshing: false,
  syncing: false,
  error: null,
};

/**
 * 前端用量请求与自动刷新协调器。
 *
 * 所有触发源共享同一个 in-flight Promise；固定周期 tick 遇到 pending 只记为
 * 跳过，不向后端排队。控制器不依赖 React，便于用假时钟验证长时间运行。
 * M6 起负载类型参数化：同步循环返回小结果，聚合查询由 dashboard 控制器管理。
 */
export class UsageRefreshController<T = UsageResponse> {
  private state: UsageViewState<T> = initialState as UsageViewState<T>;
  private readonly listeners = new Set<(state: UsageViewState<T>) => void>();
  private inFlight: Promise<void> | null = null;
  private requestGeneration = 0;
  private active = false;
  private visible = true;
  private autoRefreshMs = 60_000;
  private timer: unknown = null;
  private unsubscribeVisibility: (() => void) | null = null;
  private requestCount = 0;
  private skippedAutoTicks = 0;
  private maxPendingRequests = 0;

  constructor(
    private readonly fetchUsage: () => Promise<T>,
    private readonly environment: UsageRefreshEnvironment = browserEnvironment,
    private readonly options: UsageRefreshOptions = {},
  ) {}

  getState = (): UsageViewState<T> => this.state;

  getStats = (): UsageRefreshStats => ({
    requests: this.requestCount,
    skippedAutoTicks: this.skippedAutoTicks,
    pendingRequests: this.inFlight ? 1 : 0,
    maxPendingRequests: this.maxPendingRequests,
  });

  subscribe = (listener: (state: UsageViewState<T>) => void): (() => void) => {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  };

  start = (): Promise<void> => {
    if (this.active) return this.inFlight ?? Promise.resolve();

    this.active = true;
    this.visible = !this.environment.isDocumentHidden();
    this.unsubscribeVisibility = this.environment.subscribeVisibility(this.onVisibilityChange);
    this.restartTimer();
    return this.load("initial");
  };

  stop = (): void => {
    this.active = false;
    this.clearTimer();
    this.unsubscribeVisibility?.();
    this.unsubscribeVisibility = null;
  };

  setAutoRefresh = (milliseconds: number): void => {
    this.autoRefreshMs = milliseconds;
    this.restartTimer();
  };

  refresh = (): Promise<void> => this.load("manual");

  private setState(patch: Partial<UsageViewState<T>>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private load(trigger: UsageLoadTrigger): Promise<void> {
    if (this.inFlight) {
      if (trigger === "manual" && !this.state.syncing) this.setState({ syncing: true });
      return this.inFlight;
    }

    const generation = ++this.requestGeneration;
    const hasData = this.state.data !== null;
    this.requestCount += 1;
    this.maxPendingRequests = Math.max(this.maxPendingRequests, 1);
    this.setState({
      loading: !hasData,
      refreshing: hasData && trigger !== "manual",
      syncing: trigger === "manual",
      error: trigger === "manual" ? null : this.state.error,
    });

    const promise = (async () => {
      try {
        if (trigger === "initial" && this.options.querySnapshot) {
          try {
            const snapshot = await this.options.querySnapshot();
            if (
              generation === this.requestGeneration &&
              snapshot.snapshotAvailable !== false
            ) {
              this.setState({
                // querySnapshot 只用于 UsageResponse 形态的快照负载（M6 前的用法）。
                data: snapshot as unknown as T,
                loading: false,
                refreshing: true,
                error: null,
              });
            }
          } catch {
            // 查询失败不妨碍后续独立同步重建快照；最终错误以同步结果为准。
          }
        }

        const payload = await this.fetchUsage();
        if (generation === this.requestGeneration) {
          this.setState({ data: payload, error: null });
        }
      } catch (caught) {
        if (generation === this.requestGeneration) {
          this.setState({
            error: caught instanceof Error ? caught.message : "读取用量数据失败",
          });
        }
      } finally {
        if (generation === this.requestGeneration) {
          this.inFlight = null;
          this.setState({ loading: false, refreshing: false, syncing: false });
        }
      }
    })();

    this.inFlight = promise;
    return promise;
  }

  private onVisibilityChange = (): void => {
    const wasVisible = this.visible;
    this.visible = !this.environment.isDocumentHidden();
    if (!this.active) return;

    if (!this.visible) {
      this.clearTimer();
      return;
    }

    this.restartTimer();
    if (!wasVisible && this.autoRefreshMs > 0) void this.load("visibility");
  };

  private restartTimer(): void {
    this.clearTimer();
    if (!this.active || !this.visible || this.autoRefreshMs === 0) return;
    this.timer = this.environment.setInterval(this.onAutoTick, this.autoRefreshMs);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.environment.clearInterval(this.timer);
    this.timer = null;
  }

  private onAutoTick = (): void => {
    if (!this.active || !this.visible || this.autoRefreshMs === 0) return;
    if (this.inFlight) {
      this.skippedAutoTicks += 1;
      return;
    }
    void this.load("auto");
  };
}
