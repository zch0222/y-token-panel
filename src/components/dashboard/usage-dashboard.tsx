"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  ChartColumn,
  CircleAlert,
  CircleHelp,
  Database,
  FilterX,
  Menu,
  Moon,
  RefreshCw,
  Settings2,
  Sun,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { BalanceView } from "@/components/dashboard/balance-view";
import { CreditBreakdown } from "@/components/dashboard/credit-breakdown";
import { HarnessSwitcher } from "@/components/dashboard/harness-switcher";
import { MobileNavigation, Sidebar, type DashboardView } from "@/components/dashboard/sidebar";
import { InstallAppButton } from "@/components/pwa/install-app-button";
import { UsageChart, type ChartType } from "@/components/dashboard/usage-chart";
import { UsageTables, type DetailTab } from "@/components/dashboard/usage-tables";
import { cn } from "@/lib/utils";
import { UsageDashboardController } from "@/lib/usage-dashboard-controller";
import {
  BILLING_OPTIONS,
  formatCompact,
  formatCredits,
  formatPercent,
  formatTime,
  getHarnessLabel,
  HARNESS_OPTIONS,
  RANGE_OPTIONS,
  summarizeRecords,
  type BillingFilter,
  type CreditBreakdownItem,
  type HarnessFilter,
  type MetricKey,
  type RangeKey,
  type UsageQueryFilters,
  type UsageRecordsPage,
  type UsageSummary,
  type UsageSyncResult,
  type UsageView,
} from "@/lib/usage";

interface MetricCardProps {
  label: string;
  value: string;
  suffix?: string;
  hint: string;
  selected: boolean;
  onClick: () => void;
  className?: string;
  /** 设置后按 Harness 分列展示，替代单一数值。 */
  breakdown?: CreditBreakdownItem[];
  detail?: string;
}

function MetricCard({
  label,
  value,
  suffix,
  hint,
  selected,
  onClick,
  className,
  breakdown,
  detail,
}: MetricCardProps) {
  return (
    <button
      type="button"
      title={hint}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "relative min-w-0 border-border/70 px-5 py-5 text-left transition-colors hover:bg-muted/20 sm:px-6",
        selected && "bg-muted/20",
        className,
      )}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {label}
        <CircleHelp className="size-3 opacity-60" />
      </div>
      {breakdown ? (
        <CreditBreakdown items={breakdown} className="mt-2.5 text-[15px] font-semibold" />
      ) : (
        <div className="mt-2.5 flex min-w-0 items-baseline gap-2">
          <span className="truncate text-[27px] font-semibold leading-none tracking-[-0.025em] tabular-nums">
            {value}
          </span>
          {suffix && <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{suffix}</span>}
        </div>
      )}
      {detail && <div className="mt-2 truncate text-[11px] text-muted-foreground">{detail}</div>}
      <span
        className={cn(
          "absolute inset-x-5 bottom-0 h-0.5 origin-left rounded-full bg-primary transition-transform sm:inset-x-6",
          selected ? "scale-x-100" : "scale-x-0",
        )}
      />
    </button>
  );
}

const BACKGROUND_REQUEST_NOTE =
  "Qoder 的 auto-mode 分类器、会话标题、compact 等后台请求不写入本地会话，未计入";

/** 设置弹窗里各 Harness 数据源与环境变量的兜底说明。 */
const HARNESS_SOURCE_HINTS: Record<
  string,
  { source: string; envHint: string }
> = {
  codebuddy: {
    source: "~/.codebuddy/projects",
    envHint: "CODEBUDDY_DATA_DIR 指定其他 projects 目录，或 CODEBUDDY_CONFIG_DIR 指定配置根目录",
  },
  workbuddy: {
    source: "~/.workbuddy/projects",
    envHint: "WORKBUDDY_DATA_DIR 或 WORKBUDDY_CONFIG_DIR 指定其他 .workbuddy 配置根目录",
  },
  qoder: {
    source: "~/.qoder-cn/projects",
    envHint: "QODER_DATA_DIR 指定其他 projects 目录，或 QODERCN_CONFIG_DIR 指定配置根目录",
  },
  zcode: {
    source: "~/.zcode/cli/db/db.sqlite",
    envHint: "ZCODE_DATA_DIR 指定其他 .zcode 根目录；也跟随 ZCODE_SESSION_DB_PATH 与 cli/config.json",
  },
  kcode: {
    source: "~/.kimi-code/sessions",
    envHint: "KIMI_CODE_HOME 环境变量指定其他 .kimi-code 根目录（其下需有 sessions）",
  },
  claude: {
    source: "~/.claude/projects",
    envHint: "CLAUDE_CONFIG_DIR 环境变量指定其他 .claude 根目录（其下需有 projects）",
  },
  codex: {
    source: "~/.codex/sessions",
    envHint: "CODEX_HOME 环境变量指定其他 .codex 根目录（其下需有 sessions）",
  },
  antigravity: {
    source: "~/.gemini/antigravity/brain",
    envHint: "ANTIGRAVITY_DATA_DIR 指定其他 Antigravity 数据根目录（其下需有 brain）",
  },
  dsh: {
    source: "~/.dsh/sessions",
    envHint: "DSH_HOME 环境变量指定其他 .dsh 根目录（其下需有 sessions）",
  },
};

function getChartNotice(
  metric: MetricKey,
  summary: UsageSummary,
  harness: HarnessFilter,
): { title: string; description: string } | null {
  if (metric === "credits" && summary.mixedCreditUnits) {
    return {
      title: "不同 Harness 的 Credits 无法合并",
      description: `${summary.creditsByHarness.map((item) => item.label).join("、")} 的 Credits 不是同一计量单位，请切换到单个 Harness 查看 Credits 趋势。`,
    };
  }
  if (
    (metric === "tokens" && !summary.hasTokens) ||
    (metric === "cacheRate" && summary.cacheableInputTokens === 0)
  ) {
    return {
      title: "当前范围没有可用的 Token 数据",
      description:
        harness === "qoder"
          ? "Qoder 当前本地日志只报告 Credits 和请求信息，Token 字段未提供有效数值。"
          : "切换到 Credits 或请求数查看趋势，或选择包含 Token 记录的其他 Harness。",
    };
  }
  return null;
}

const viewTitles: Record<DashboardView, { title: string; subtitle: string }> = {
  overview: { title: "用量统计", subtitle: "集中追踪 AI Harness 的 Token、Credits 与请求" },
  logs: { title: "请求日志", subtitle: "查看每一次模型调用的本地用量明细" },
  models: { title: "模型分析", subtitle: "比较不同模型的使用量与缓存效率" },
  projects: { title: "项目统计", subtitle: "了解各项目在不同 Harness 中的使用情况" },
  harnesses: { title: "Harness 对比", subtitle: "比较不同 AI Harness 的请求与消耗" },
  balance: { title: "余额查询", subtitle: "查询供应商账户余额与额度，内置限流保护" },
};

function usageQuerySearch(filters: UsageQueryFilters, extra: Record<string, string> = {}): string {
  return new URLSearchParams({
    range: filters.range,
    harness: filters.harness,
    project: filters.project,
    provider: filters.provider,
    model: filters.model,
    billing: filters.billing,
    ...extra,
  }).toString();
}

async function fetchUsageView(filters: UsageQueryFilters): Promise<UsageView> {
  const response = await fetch(`/api/usage/query?${usageQuerySearch(filters)}`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error("读取用量统计失败");
  return (await response.json()) as UsageView;
}

async function fetchUsageRecordsPage(
  filters: UsageQueryFilters,
  page: number,
  pageSize: number,
): Promise<UsageRecordsPage> {
  const response = await fetch(
    `/api/usage/records?${usageQuerySearch(filters, { page: String(page), pageSize: String(pageSize) })}`,
    { cache: "no-store" },
  );
  if (!response.ok) throw new Error("读取请求日志失败");
  return (await response.json()) as UsageRecordsPage;
}

async function syncUsageResult(): Promise<UsageSyncResult> {
  const response = await fetch("/api/usage/sync", {
    method: "POST",
    cache: "no-store",
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as
      | { detail?: string; error?: string }
      | null;
    throw new Error(payload?.detail ?? payload?.error ?? "同步用量数据失败");
  }
  return (await response.json()) as UsageSyncResult;
}

export function UsageDashboard() {
  const [controller] = useState(
    () =>
      new UsageDashboardController({
        fetchView: fetchUsageView,
        fetchRecords: fetchUsageRecordsPage,
        syncUsage: syncUsageResult,
      }),
  );
  const [dashboardState, setDashboardState] = useState(controller.getState);
  const { view: viewSection, records: recordsSection, syncing, refreshing, lastSyncedAt, syncError } =
    dashboardState;
  const view = viewSection.data;
  const [range, setRange] = useState<RangeKey>("today");
  const [harness, setHarness] = useState<HarnessFilter>("all");
  const [project, setProject] = useState("all");
  const [provider, setProvider] = useState("all");
  const [model, setModel] = useState("all");
  const [billing, setBilling] = useState<BillingFilter>("all");
  const [metric, setMetric] = useState<MetricKey>("tokens");
  const [chartType, setChartType] = useState<ChartType>("bar");
  const [tab, setTab] = useState<DetailTab>("models");
  const [viewName, setView] = useState<DashboardView>("overview");
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(60_000);
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  const refreshUsage = () => {
    void controller.refresh();
  };

  useEffect(() => {
    const unsubscribe = controller.subscribe(setDashboardState);
    controller.start();
    return () => {
      controller.stop();
      unsubscribe();
    };
  }, [controller]);

  useEffect(() => {
    controller.setAutoRefresh(autoRefresh);
  }, [autoRefresh, controller]);

  // 筛选变化交给控制器统一查询；切换时保留上一份数据（updating 状态）。
  const filters = useMemo<UsageQueryFilters>(
    () => ({ range, harness, project, provider, model, billing }),
    [range, harness, project, provider, model, billing],
  );
  useEffect(() => {
    controller.setFilters(filters);
  }, [controller, filters]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  const loading = viewSection.loading;
  const emptySummary = useMemo(() => summarizeRecords([]), []);
  const summary = view?.summary ?? emptySummary;
  const today = view?.todaySummary ?? emptySummary;
  const trend = view?.trend ?? [];
  const chartNotice = view === null ? null : getChartNotice(metric, summary, harness);
  const activeSources = useMemo(
    () =>
      view?.sources.filter((source) => harness === "all" || source.harness === harness) ?? [],
    [view, harness],
  );
  const projects = view?.facets.projects ?? [];
  const providers = view?.facets.providers ?? [];
  const models = view?.facets.models ?? [];
  const filteredCount = view?.filteredCount ?? 0;
  const updating = viewSection.updating || recordsSection.updating;
  const hasData = view !== null;

  const changeHarness = (next: HarnessFilter) => {
    setHarness(next);
    setProject("all");
    setProvider("all");
    setModel("all");
    setMetric(next === "qoder" ? "credits" : "tokens");
  };
  const hasFilters =
    range !== "today" ||
    harness !== "all" ||
    project !== "all" ||
    provider !== "all" ||
    model !== "all" ||
    billing !== "all";
  const clearFilters = () => {
    setRange("today");
    setHarness("all");
    setProject("all");
    setProvider("all");
    setModel("all");
    setBilling("all");
    setMetric("tokens");
  };
  const changeView = (next: DashboardView) => {
    setView(next);
    if (next === "logs") setTab("logs");
    if (next === "models") setTab("models");
    if (next === "projects") setTab("projects");
    if (next === "harnesses") setTab("harnesses");
    if (next === "overview") setTab("models");
  };
  const syncLabel = useMemo(() => {
    if (syncing) return "正在同步";
    if (!view && loading) return "首次导入中";
    if (refreshing) return "后台刷新中";
    return "同步数据";
  }, [view, loading, refreshing, syncing]);

  const exportCsv = () => {
    const link = document.createElement("a");
    link.href = `/api/usage/export?${usageQuerySearch(filters)}`;
    link.rel = "noopener";
    document.documentElement.appendChild(link);
    link.click();
    link.remove();
  };

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar
        view={viewName}
        onViewChange={changeView}
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
        today={today}
        connected={Boolean(activeSources.some((source) => source.sourceAvailable) && !syncError)}
      />

      <main className="min-w-0 flex-1">
        <header className="flex h-[72px] items-center justify-between gap-4 border-b border-border/60 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="打开主导航"
              onClick={() => setMobileNavigationOpen(true)}
              className="-ml-1 shrink-0 text-muted-foreground lg:hidden"
            >
              <Menu />
            </Button>
            <div className="hidden size-9 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-br from-amber-300 via-orange-400 to-rose-500 text-white sm:flex lg:hidden">
              <ChartColumn className="size-5" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-[17px] font-semibold tracking-tight">{viewTitles[viewName].title}</h1>
              <p className="mt-1 hidden text-[11px] text-muted-foreground sm:block">
                {viewTitles[viewName].subtitle}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <InstallAppButton />
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-label={syncLabel}
              title={lastSyncedAt === null ? undefined : `上次同步 ${formatTime(lastSyncedAt)}`}
              disabled={syncing}
              onClick={refreshUsage}
              className="h-8 bg-card px-3 text-xs text-muted-foreground hover:text-foreground"
            >
              <RefreshCw className={cn((refreshing || syncing) && "animate-spin")} />
              <span className="hidden sm:inline">{syncLabel}</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              className="text-muted-foreground"
            >
              {theme === "dark" ? <Sun /> : <Moon />}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="用量设置"
              onClick={() => setSettingsOpen(true)}
              className="text-muted-foreground"
            >
              <Settings2 />
            </Button>
          </div>
        </header>

        <div className="mx-auto w-full max-w-[1500px] px-4 py-5 sm:px-6 sm:py-6">
          {viewName === "balance" ? (
            <BalanceView />
          ) : (
          <>
          <HarnessSwitcher
            value={harness}
            sources={view?.sources ?? []}
            loading={!view}
            onChange={changeHarness}
          />

          <div className="mb-5 flex flex-wrap items-center gap-2">
            <Select value={range} onValueChange={(value) => setRange((value as RangeKey | null) ?? "today")}>
              <SelectTrigger className="h-9 min-w-[118px] border-border bg-card text-xs" aria-label="时间范围">
                <CalendarDays className="mr-1 size-3.5 text-muted-foreground" />
                <SelectValue>{RANGE_OPTIONS.find((option) => option.value === range)?.label}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {RANGE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <span className="mx-1 hidden h-4 w-px bg-border sm:block" />

            <Select value={project} onValueChange={(value) => setProject(value ?? "all")}>
              <SelectTrigger className="h-9 min-w-[130px] max-w-[190px] border-border bg-card text-xs" aria-label="项目筛选">
                <SelectValue placeholder="全部项目">{project === "all" ? "全部项目" : project}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部项目</SelectItem>
                {projects.map((item) => (
                  <SelectItem key={item} value={item}>{item}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={provider}
              onValueChange={(value) => {
                setProvider(value ?? "all");
                setModel("all");
              }}
            >
              <SelectTrigger className="h-9 min-w-[132px] border-border bg-card text-xs" aria-label="供应商筛选">
                <SelectValue placeholder="全部供应商">{provider === "all" ? "全部供应商" : provider}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部供应商</SelectItem>
                {providers.map((item) => (
                  <SelectItem key={item} value={item}>{item}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={model} onValueChange={(value) => setModel(value ?? "all")}>
              <SelectTrigger className="h-9 min-w-[150px] max-w-[230px] border-border bg-card text-xs" aria-label="模型筛选">
                <SelectValue placeholder="全部模型">{model === "all" ? "全部模型" : model}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部模型</SelectItem>
                {models.map((item) => (
                  <SelectItem key={item} value={item}>
                    <span className="font-mono text-xs">{item}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={billing}
              onValueChange={(value) => setBilling((value as BillingFilter | null) ?? "all")}
            >
              <SelectTrigger className="h-9 min-w-[132px] border-border bg-card text-xs" aria-label="计费状态筛选">
                <SelectValue>{BILLING_OPTIONS.find((option) => option.value === billing)?.label}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {BILLING_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {hasFilters && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={clearFilters}
                className="h-9 text-xs text-muted-foreground"
              >
                <FilterX /> 清除筛选
              </Button>
            )}
            <div className="ml-auto hidden items-center gap-1.5 text-[11px] text-muted-foreground xl:flex">
              {updating && <RefreshCw className="size-3 animate-spin" />}
              {filteredCount.toLocaleString("zh-CN")} 条本地记录
            </div>
          </div>

          {!view && loading && (
            <div className="mb-4 rounded-lg border border-sky-500/20 bg-sky-500/[0.06] px-4 py-3 text-xs leading-5 text-sky-500">
              首次导入正在后台 worker 中进行，页面与其他本地 API 无需等待扫描完成。导入成功后会显示真实用量；空数据库不会按 0 条真实记录展示。
            </div>
          )}

          {syncError && (
            <div className="mb-4 flex items-center gap-3 rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              <CircleAlert className="size-4 shrink-0" />
              <span className="flex-1">{syncError}，请检查本地数据目录和数据库状态。</span>
              <Button type="button" variant="ghost" size="sm" onClick={refreshUsage}>
                重试
              </Button>
            </div>
          )}

          {viewSection.error && (
            <div className="mb-4 flex items-center gap-3 rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              <CircleAlert className="size-4 shrink-0" />
              <span className="flex-1">{viewSection.error}，请检查本地数据库状态。</span>
              <Button type="button" variant="ghost" size="sm" onClick={refreshUsage}>
                重试
              </Button>
            </div>
          )}

          {recordsSection.error && (
            <div role="alert" className="mb-4 flex items-center gap-3 rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              <CircleAlert className="size-4 shrink-0" />
              <span className="flex-1">{recordsSection.error}，请求日志可能不是最新数据。</span>
              <Button type="button" variant="ghost" size="sm" onClick={refreshUsage}>
                重试
              </Button>
            </div>
          )}

          {hasData && activeSources.some((source) => !source.sourceAvailable) && (
            <div className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3 text-xs leading-5 text-amber-500">
              未找到 {activeSources.filter((source) => !source.sourceAvailable).map((source) => getHarnessLabel(source.harness)).join("、")} 的数据目录；其他 Harness 的统计不受影响。
            </div>
          )}

          {viewName === "overview" && (
            <section className="panel mb-5 overflow-hidden">
              <div className="grid grid-cols-2 md:grid-cols-4">
                {loading ? (
                  Array.from({ length: 4 }, (_, index) => (
                    <div key={index} className="border-b border-border/70 p-6 md:border-b-0 md:border-r">
                      <Skeleton className="h-3 w-16" />
                      <Skeleton className="mt-4 h-7 w-24" />
                    </div>
                  ))
                ) : !hasData || !view.snapshotAvailable ? (
                  <div className="col-span-full flex min-h-32 flex-col items-center justify-center px-6 py-8 text-center">
                    <Database className="mb-3 size-6 text-muted-foreground/50" />
                    <div className="text-sm font-medium">尚无可显示的用量快照</div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      首次导入失败或尚未完成，不会将缺失数据显示为真实的 0 条用量。
                    </p>
                  </div>
                ) : (
                  <>
                    <MetricCard
                      label="计费 Credits"
                      value={formatCredits(summary.credits, summary.hasCredit)}
                      suffix={summary.hasCredit ? "credits" : undefined}
                      breakdown={summary.mixedCreditUnits ? summary.creditsByHarness : undefined}
                      detail={
                        !summary.mixedCreditUnits && summary.unbilledCredits > 0
                          ? `另有 ${formatCredits(summary.unbilledCredits)} 未计费`
                          : undefined
                      }
                      hint={`只计入服务端标记为计费的请求，不计费请求的报告值单列，不代表美元金额${
                        summary.mixedCreditUnits ? "；不同 Harness 的 Credits 单位不同，分别列出" : ""
                      }；${BACKGROUND_REQUEST_NOTE}`}
                      selected={metric === "credits"}
                      onClick={() => setMetric("credits")}
                      className="border-b border-r md:border-b-0"
                    />
                    <MetricCard
                      label="总请求数"
                      value={summary.requests.toLocaleString("zh-CN")}
                      hint={`按上游请求 ID 去重后的本地模型调用次数；${BACKGROUND_REQUEST_NOTE}`}
                      selected={metric === "requests"}
                      onClick={() => setMetric("requests")}
                      className="border-b md:border-b-0 md:border-r"
                    />
                    <MetricCard
                      label="真实消耗 Tokens"
                      value={summary.hasTokens ? formatCompact(summary.tokens) : "—"}
                      hint={
                        summary.hasTokens
                          ? "按各 Harness 的输入与缓存语义归一统计，不重复计数"
                          : "当前本地日志未提供有效 Token 数值"
                      }
                      selected={metric === "tokens"}
                      onClick={() => setMetric("tokens")}
                      className="border-r"
                    />
                    <MetricCard
                      label="缓存命中率"
                      value={
                        summary.cacheableInputTokens > 0
                          ? formatPercent(summary.cacheRate)
                          : "—"
                      }
                      hint="缓存读取 Tokens ÷ 可缓存输入 Tokens"
                      selected={metric === "cacheRate"}
                      onClick={() => setMetric("cacheRate")}
                    />
                  </>
                )}
              </div>
              {hasData &&
                view.snapshotAvailable &&
                (chartNotice ? (
                  <div className="flex h-[292px] flex-col items-center justify-center border-t border-border/70 px-6 text-center">
                    <CircleHelp className="mb-3 size-7 text-muted-foreground/50" strokeWidth={1.5} />
                    <div className="text-sm font-medium">{chartNotice.title}</div>
                    <p className="mt-1.5 max-w-md text-xs leading-5 text-muted-foreground">
                      {chartNotice.description}
                    </p>
                  </div>
                ) : (
                  <UsageChart
                    data={trend}
                    metric={metric}
                    hourly={range === "today" || range === "yesterday"}
                    chartType={chartType}
                    onChartTypeChange={setChartType}
                  />
                ))}
            </section>
          )}

          {loading ? (
            <div className="panel p-5">
              <Skeleton className="h-8 w-72" />
              <Skeleton className="mt-6 h-10 w-full" />
              {Array.from({ length: 5 }, (_, index) => (
                <Skeleton key={index} className="mt-3 h-12 w-full" />
              ))}
            </div>
          ) : hasData && view.snapshotAvailable ? (
            <UsageTables
              groups={view.groups}
              records={recordsSection.data}
              recordsLoading={recordsSection.loading || recordsSection.updating}
              page={controller.getPage()}
              pageSize={controller.getPageSize()}
              onPageChange={(page) => controller.setPage(page)}
              onPageSizeChange={(pageSize) => controller.setPageSize(pageSize)}
              tab={tab}
              onTabChange={setTab}
              filteredCount={filteredCount}
              onExport={exportCsv}
              updating={updating}
            />
          ) : (
            <div className="panel px-5 py-10 text-center text-sm text-muted-foreground">
              {view && !view.snapshotAvailable && view.sync.phase === "importing"
                ? "首次导入正在进行，完成后会自动展示真实用量。"
                : "暂无已提交的用量快照。可点击“同步数据”重试，旧快照（如存在）不会因同步失败被清空。"}
            </div>
          )}

          <footer className="mt-5 flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-muted-foreground/75">
            <span className="inline-flex items-center gap-1.5">
              <Database className="size-3" /> 数据仅在本机读取，不会上传会话内容
            </span>
            <span>
              {view
                ? `已扫描 ${activeSources.reduce((sum, source) => sum + source.scannedFiles, 0)} 个会话文件${
                    activeSources.some((source) => source.skippedFiles > 0)
                      ? ` · ${activeSources.reduce((sum, source) => sum + source.skippedFiles, 0)} 个读取失败`
                      : ""
                  }`
                : "正在连接本地数据"}
              {lastSyncedAt !== null && ` · 上次同步 ${formatTime(lastSyncedAt)}`}
            </span>
          </footer>
          </>
          )}
        </div>
      </main>

      <MobileNavigation
        view={viewName}
        onViewChange={changeView}
        open={mobileNavigationOpen}
        onOpenChange={setMobileNavigationOpen}
      />

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>用量设置</DialogTitle>
            <DialogDescription>配置本地日志扫描方式与查看统计口径。</DialogDescription>
          </DialogHeader>
          <div className="space-y-5 py-1">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium">日志扫描间隔</div>
                <div className="mt-1 text-xs text-muted-foreground">后台增量导入会话；统计视图仅在数据变化后刷新</div>
              </div>
              <Select value={String(autoRefresh)} onValueChange={(value) => setAutoRefresh(Number(value))}>
                <SelectTrigger className="w-[130px]" aria-label="日志扫描间隔">
                  <SelectValue>
                    {autoRefresh === 0 ? "关闭" : autoRefresh === 30000 ? "每 30 秒" : autoRefresh === 60000 ? "每 1 分钟" : "每 5 分钟"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">关闭</SelectItem>
                  <SelectItem value="30000">每 30 秒</SelectItem>
                  <SelectItem value="60000">每 1 分钟</SelectItem>
                  <SelectItem value="300000">每 5 分钟</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2.5">
              <div className="text-xs font-medium text-muted-foreground">本地数据源</div>
              {HARNESS_OPTIONS.map((option) => {
                const source = view?.sources.find((candidate) => candidate.harness === option.id);
                return (
                  <div key={option.id} className="rounded-lg border border-border/70 bg-muted/20 p-3.5">
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="font-medium">{option.label}</span>
                      <span className={source?.sourceAvailable ? "text-emerald-500" : "text-muted-foreground"}>
                        {source ? source.sourceAvailable ? `${source.recordCount} 条请求` : "目录不可用" : "等待扫描"}
                      </span>
                    </div>
                    <code className="mt-2 block break-all text-xs leading-5">
                      {source?.source ?? HARNESS_SOURCE_HINTS[option.id]?.source}
                    </code>
                    <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
                      可通过 {HARNESS_SOURCE_HINTS[option.id]?.envHint}。
                    </p>
                  </div>
                );
              })}
            </div>
            <div className="rounded-lg border border-border/70 p-3.5 text-xs leading-5 text-muted-foreground">
              <div className="mb-1 font-medium text-foreground">统计说明</div>
              Credits 采用各 Harness 原始字段，不按美元展示。Qoder 与其自身的会话积分统计一致，只计入服务端标记为计费（billable）的请求，不计费请求的报告值单独显示。不同 Harness 的 Credits 单位不同，全部视图中分别列出。{BACKGROUND_REQUEST_NOTE}，实际扣费以 Qoder 的 /usage 为准。请求按上游 ID 去重。CodeBuddy 输入包含缓存读取，Qoder 输入按不含缓存读写处理。Qoder 当前全零 Token 字段视为未上报，不参与 Token 与缓存统计。ZCode 数据来自其本地 SQLite 用量库（model_usage 表，仅保留最近 30 天），输入含缓存读写，无 Credits 字段；每行对应一次上游请求尝试（含重试），耗时为精确计时。Claude Code 数据来自其本地会话转录（~/.claude/projects，含子 agent 转录），按响应 message ID 去重，输入不含缓存读写，无 Credits 字段；耗时会话日志未记录，按时间戳沿父链估算（含首字等待）。Codex / ChatGPT 数据来自其本地 rollout 会话（~/.codex/sessions 与 archived_sessions，含 .jsonl.zst 压缩形态），优先取每次请求的精确 last_token_usage，输入不含缓存读写（缓存读/写单列），无 Credits 字段；限额刷新重发的重复快照去重，子 agent / 翻页续写按 cc-switch 口径剔除父历史重放，耗时会话日志未记录，按各行时间戳估算（含首字等待）。DeepSeek Harness 数据来自其本地会话日志（~/.dsh/sessions，逐帧压缩的 .jsonl.zstd，含 v3/v4 与子 agent 会话），按响应 message ID 去重（分叉会话复制的前缀不重复计，同目录多版本文件不双算），输入不含缓存读写（缓存读/写单列），无 Credits 字段；耗时按 step/start 到响应事件的时间差估算（含首字等待与重试）。Antigravity 数据来自其本地会话转录（~/.gemini/antigravity/brain 与 ~/.gemini/antigravity-cli/brain），只统计状态为 DONE 的模型响应与压缩检查点；输入不含缓存读取，输出已包含思考，无 Credits 字段；耗时取自原生会话库的首字等待 + 流式时长，压缩检查点不计耗时；模型按会话内的 Model Selection 切换事件继承，缺失时记为未知模型。
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
