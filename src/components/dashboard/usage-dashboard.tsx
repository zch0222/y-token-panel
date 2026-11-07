"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  ChartColumn,
  CircleAlert,
  CircleHelp,
  Database,
  FilterX,
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
import { Sidebar, type DashboardView } from "@/components/dashboard/sidebar";
import { UsageChart, type ChartType } from "@/components/dashboard/usage-chart";
import { UsageTables, type DetailTab } from "@/components/dashboard/usage-tables";
import { cn } from "@/lib/utils";
import {
  buildTrend,
  filterUsageRecords,
  formatCompact,
  formatCredits,
  formatPercent,
  RANGE_OPTIONS,
  summarizeRecords,
  type MetricKey,
  type RangeKey,
  type UsageResponse,
} from "@/lib/usage";

interface MetricCardProps {
  label: string;
  value: string;
  suffix?: string;
  hint: string;
  selected: boolean;
  onClick: () => void;
  className?: string;
}

function MetricCard({
  label,
  value,
  suffix,
  hint,
  selected,
  onClick,
  className,
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
      <div className="mt-2.5 flex min-w-0 items-baseline gap-2">
        <span className="truncate text-[27px] font-semibold leading-none tracking-[-0.025em] tabular-nums">
          {value}
        </span>
        {suffix && <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{suffix}</span>}
      </div>
      <span
        className={cn(
          "absolute inset-x-5 bottom-0 h-0.5 origin-left rounded-full bg-primary transition-transform sm:inset-x-6",
          selected ? "scale-x-100" : "scale-x-0",
        )}
      />
    </button>
  );
}

const viewTitles: Record<DashboardView, { title: string; subtitle: string }> = {
  overview: { title: "用量统计", subtitle: "追踪 CodeBuddy CLI 的 Token 使用与消耗" },
  logs: { title: "请求日志", subtitle: "查看每一次模型调用的 Token 明细" },
  models: { title: "模型分析", subtitle: "比较不同模型的使用量与缓存效率" },
  projects: { title: "项目统计", subtitle: "了解各项目的 CodeBuddy 使用情况" },
};

export function UsageDashboard() {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<RangeKey>("today");
  const [project, setProject] = useState("all");
  const [provider, setProvider] = useState("all");
  const [model, setModel] = useState("all");
  const [metric, setMetric] = useState<MetricKey>("tokens");
  const [chartType, setChartType] = useState<ChartType>("bar");
  const [tab, setTab] = useState<DetailTab>("models");
  const [view, setView] = useState<DashboardView>("overview");
  const [collapsed, setCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(60_000);
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  const loadUsage = useCallback(async () => {
    try {
      const response = await fetch("/api/usage", { cache: "no-store" });
      if (!response.ok) throw new Error("读取用量数据失败");
      const payload = (await response.json()) as UsageResponse;
      setData(payload);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "读取用量数据失败");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const refreshUsage = () => {
    setRefreshing(true);
    setError(null);
    void loadUsage();
  };

  useEffect(() => {
    const timer = window.setTimeout(() => void loadUsage(), 0);
    return () => window.clearTimeout(timer);
  }, [loadUsage]);

  useEffect(() => {
    if (autoRefresh === 0) return;
    const timer = window.setInterval(() => void loadUsage(), autoRefresh);
    return () => window.clearInterval(timer);
  }, [autoRefresh, loadUsage]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  const records = useMemo(() => data?.records ?? [], [data]);
  const referenceTime = useMemo(() => new Date(data?.syncedAt ?? 0), [data]);
  const filteredRecords = useMemo(
    () => filterUsageRecords(records, range, project, provider, model, referenceTime),
    [records, range, project, provider, model, referenceTime],
  );
  const summary = useMemo(() => summarizeRecords(filteredRecords), [filteredRecords]);
  const today = useMemo(
    () => summarizeRecords(filterUsageRecords(records, "today", "all", "all", "all", referenceTime)),
    [records, referenceTime],
  );
  const trend = useMemo(
    () => buildTrend(filteredRecords, range, referenceTime),
    [filteredRecords, range, referenceTime],
  );

  const projects = useMemo(
    () => Array.from(new Set(records.map((record) => record.project))).sort(),
    [records],
  );
  const providers = useMemo(
    () => Array.from(new Set(records.map((record) => record.provider))).sort(),
    [records],
  );
  const models = useMemo(
    () =>
      Array.from(
        new Set(
          records
            .filter((record) => provider === "all" || record.provider === provider)
            .map((record) => record.model),
        ),
      ).sort(),
    [records, provider],
  );

  const hasFilters = range !== "today" || project !== "all" || provider !== "all" || model !== "all";
  const clearFilters = () => {
    setRange("today");
    setProject("all");
    setProvider("all");
    setModel("all");
  };
  const changeView = (next: DashboardView) => {
    setView(next);
    if (next === "logs") setTab("logs");
    if (next === "models") setTab("models");
    if (next === "projects") setTab("projects");
    if (next === "overview") setTab("models");
  };
  const syncLabel = useMemo(() => {
    if (refreshing) return "正在同步";
    if (!data) return "同步数据";
    return "刚刚同步";
  }, [data, refreshing]);

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar
        view={view}
        onViewChange={changeView}
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
        today={today}
        connected={Boolean(data?.sourceAvailable && !error)}
      />

      <main className="min-w-0 flex-1">
        <header className="flex h-[72px] items-center justify-between gap-4 border-b border-border/60 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-br from-amber-300 via-orange-400 to-rose-500 text-white lg:hidden">
              <ChartColumn className="size-5" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-[17px] font-semibold tracking-tight">{viewTitles[view].title}</h1>
              <p className="mt-1 hidden text-[11px] text-muted-foreground sm:block">
                {viewTitles[view].subtitle}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={refreshing}
              onClick={refreshUsage}
              className="h-8 bg-card px-3 text-xs text-muted-foreground hover:text-foreground"
            >
              <RefreshCw className={cn(refreshing && "animate-spin")} />
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
            <div className="ml-auto hidden text-[11px] text-muted-foreground xl:block">
              {filteredRecords.length.toLocaleString("zh-CN")} 条本地记录
            </div>
          </div>

          {error && (
            <div className="mb-4 flex items-center gap-3 rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-400">
              <CircleAlert className="size-4 shrink-0" />
              <span className="flex-1">{error}，请确认 CodeBuddy 本地数据目录可访问。</span>
              <Button type="button" variant="ghost" size="sm" onClick={refreshUsage}>
                重试
              </Button>
            </div>
          )}

          {view === "overview" && (
            <section className="panel mb-5 overflow-hidden">
              <div className="grid grid-cols-2 md:grid-cols-4">
                {loading ? (
                  Array.from({ length: 4 }, (_, index) => (
                    <div key={index} className="border-b border-border/70 p-6 md:border-b-0 md:border-r">
                      <Skeleton className="h-3 w-16" />
                      <Skeleton className="mt-4 h-7 w-24" />
                    </div>
                  ))
                ) : (
                  <>
                    <MetricCard
                      label="总消耗"
                      value={formatCredits(summary.credits, summary.hasCredit)}
                      suffix={summary.hasCredit ? "credits" : undefined}
                      hint="来自 CodeBuddy 原始 credit 字段，不代表美元金额"
                      selected={metric === "credits"}
                      onClick={() => setMetric("credits")}
                      className="border-b border-r md:border-b-0"
                    />
                    <MetricCard
                      label="总请求数"
                      value={summary.requests.toLocaleString("zh-CN")}
                      hint="带有 Token 用量信息的 CodeBuddy API 调用次数"
                      selected={metric === "requests"}
                      onClick={() => setMetric("requests")}
                      className="border-b md:border-b-0 md:border-r"
                    />
                    <MetricCard
                      label="真实消耗 Tokens"
                      value={formatCompact(summary.tokens)}
                      hint="采用原始 total_tokens；输入中已包含缓存读取，不重复计数"
                      selected={metric === "tokens"}
                      onClick={() => setMetric("tokens")}
                      className="border-r"
                    />
                    <MetricCard
                      label="缓存命中率"
                      value={formatPercent(summary.cacheRate)}
                      hint="缓存读取 Tokens ÷ 输入 Tokens"
                      selected={metric === "cacheRate"}
                      onClick={() => setMetric("cacheRate")}
                    />
                  </>
                )}
              </div>
              {!loading && (
                <UsageChart
                  data={trend}
                  metric={metric}
                  hourly={range === "today" || range === "yesterday"}
                  chartType={chartType}
                  onChartTypeChange={setChartType}
                />
              )}
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
          ) : (
            <UsageTables records={filteredRecords} tab={tab} onTabChange={setTab} />
          )}

          <footer className="mt-5 flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] text-muted-foreground/75">
            <span className="inline-flex items-center gap-1.5">
              <Database className="size-3" /> 数据仅在本机读取，不会上传会话内容
            </span>
            <span>
              {data ? `已扫描 ${data.scannedFiles} 个会话文件${data.skippedFiles ? ` · ${data.skippedFiles} 个读取失败` : ""}` : "正在连接本地数据"}
            </span>
          </footer>
        </div>
      </main>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle>用量设置</DialogTitle>
            <DialogDescription>配置本地数据刷新方式与查看统计口径。</DialogDescription>
          </DialogHeader>
          <div className="space-y-5 py-1">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-sm font-medium">自动刷新</div>
                <div className="mt-1 text-xs text-muted-foreground">重新扫描本地会话日志</div>
              </div>
              <Select value={String(autoRefresh)} onValueChange={(value) => setAutoRefresh(Number(value))}>
                <SelectTrigger className="w-[130px]" aria-label="自动刷新间隔">
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
            <div className="rounded-lg border border-border/70 bg-muted/20 p-3.5">
              <div className="text-xs font-medium text-muted-foreground">数据源</div>
              <code className="mt-2 block break-all text-xs leading-5">
                {data?.source ?? "~/.codebuddy/projects"}
              </code>
              <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
                可通过 CODEBUDDY_DATA_DIR 环境变量指定其他 CodeBuddy projects 目录。
              </p>
            </div>
            <div className="rounded-lg border border-border/70 p-3.5 text-xs leading-5 text-muted-foreground">
              <div className="mb-1 font-medium text-foreground">统计说明</div>
              Credits 是 CodeBuddy 原始 credit 字段，不按美元展示。总 Tokens 使用 total_tokens，缓存命中率为缓存读取 ÷ 输入 Tokens。
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
