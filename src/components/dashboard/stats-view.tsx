"use client";

import { useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, CircleHelp, Database } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CreditBreakdown } from "@/components/dashboard/credit-breakdown";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  formatCompact,
  formatCredits,
  formatPercent,
  type UsageBucketStat,
  type UsageMonthModelStat,
  type UsageStatsView,
} from "@/lib/usage";

interface StatsViewProps {
  /** /api/usage/stats 聚合结果；null 表示查询失败（错误横幅由面板统一展示）。 */
  stats: UsageStatsView | null;
}

const pad2 = (value: number) => String(value).padStart(2, "0");

function todayKey(now = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** "2026-11-17" → "2026-11-17 · 周二"；非法键原样返回。 */
function formatDayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00`);
  if (Number.isNaN(date.getTime())) return day;
  return `${day} · ${date.toLocaleDateString("zh-CN", { weekday: "short" })}`;
}

/** "2026-11" → "2026年11月"；非法键原样返回。 */
function formatMonthLabel(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number);
  if (!year || !monthNumber) return month;
  return `${year}年${monthNumber}月`;
}

/** 月份键 ±delta；Date 溢出自动滚动跨年。 */
function shiftMonth(month: string, delta: number): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(year, monthNumber - 1 + delta, 1);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function daysInMonth(month: string): number {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(year, monthNumber, 0).getDate();
}

/** 月历单元格（周一起排）：前导 null 补齐首周，其余是 "YYYY-MM-DD" 键。 */
function monthCells(month: string): Array<string | null> {
  const [year, monthNumber] = month.split("-").map(Number);
  const offset = (new Date(year, monthNumber - 1, 1).getDay() + 6) % 7;
  const cells: Array<string | null> = Array.from({ length: offset }, () => null);
  for (let date = 1; date <= daysInMonth(month); date += 1) {
    cells.push(`${month}-${pad2(date)}`);
  }
  return cells;
}

/** 从最早月到最晚月连续铺开（含无记录月），供月度柱状图使用。 */
function monthSpan(keys: string[]): string[] {
  if (keys.length === 0) return [];
  const sorted = [...keys].sort();
  const [endYear, endMonth] = sorted[sorted.length - 1].split("-").map(Number);
  let [year, month] = sorted[0].split("-").map(Number);
  const months: string[] = [];
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${year}-${pad2(month)}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    map.set(key, [...(map.get(key) ?? []), item]);
  }
  return map;
}

type StatsMode = "day" | "month" | "all";
type StatsMetric = "tokens" | "requests";

const modeOptions: Array<{ value: StatsMode; label: string }> = [
  { value: "day", label: "按日" },
  { value: "month", label: "按月" },
  { value: "all", label: "总览" },
];
const metricOptions: Array<{ value: StatsMetric; label: string }> = [
  { value: "tokens", label: "Tokens" },
  { value: "requests", label: "请求数" },
];
const metricLabels: Record<StatsMetric, string> = { tokens: "Tokens", requests: "请求数" };

/** 热力指标值：Tokens 模式下没有 Token 上报的桶回退到请求数，避免热力整片空白。 */
function metricValue(bucket: UsageBucketStat, metric: StatsMetric): number {
  if (metric === "requests") return bucket.requests;
  return bucket.hasTokens ? bucket.tokens : bucket.requests;
}

const HEAT_CLASSES = [
  "bg-muted/40",
  "bg-primary/15",
  "bg-primary/35",
  "bg-primary/55",
  "bg-primary/80",
] as const;

function heatLevel(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  const ratio = value / max;
  return ratio >= 0.7 ? 4 : ratio >= 0.45 ? 3 : ratio >= 0.2 ? 2 : 1;
}

function HeatLegend() {
  return (
    <div className="mt-3 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
      <span>少</span>
      {HEAT_CLASSES.map((levelClass) => (
        <span key={levelClass} className={cn("size-2.5 rounded-[3px]", levelClass)} />
      ))}
      <span>多</span>
    </div>
  );
}

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex items-center rounded-md border border-border/80 p-0.5"
    >
      {options.map((option) => (
        <Button
          key={option.value}
          type="button"
          variant="ghost"
          size="xs"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "text-muted-foreground",
            value === option.value && "bg-muted text-foreground",
          )}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

function StatsPanel({
  title,
  description,
  aside,
  children,
}: {
  title: ReactNode;
  description?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 px-5 py-3.5 sm:px-6">
        <div className="min-w-0">
          <h2 className="text-[13px] font-medium">{title}</h2>
          {description && (
            <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{description}</p>
          )}
        </div>
        {aside}
      </header>
      {children}
    </section>
  );
}

function EmptyNotice({ text, hint }: { text: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      <Database className="mb-3 size-6 text-muted-foreground/50" />
      <div className="text-sm font-medium">{text}</div>
      {hint && <p className="mt-1 text-xs leading-5 text-muted-foreground">{hint}</p>}
    </div>
  );
}

function InlineNotice({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-500/25 bg-amber-500/[0.08] px-3 py-2.5 text-xs leading-5 text-amber-500">
      <CircleHelp className="mt-0.5 size-3.5 shrink-0" />
      {text}
    </div>
  );
}

function StatCell({
  label,
  detail,
  children,
}: {
  label: string;
  detail?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 text-[15px] font-semibold leading-5 tabular-nums">{children}</div>
      {detail && <div className="mt-0.5 text-[10px] leading-4 text-muted-foreground">{detail}</div>}
    </div>
  );
}

/** 选中期（日/月）的汇总条；与用量概览指标卡同一口径。 */
function SummaryStrip({ bucket }: { bucket: UsageBucketStat }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-4 border-b border-border/70 px-5 py-4 sm:grid-cols-5 sm:px-6">
      <StatCell label="请求数">{bucket.requests.toLocaleString("zh-CN")}</StatCell>
      <StatCell
        label="Tokens"
        detail={bucket.hasTokens ? bucket.tokens.toLocaleString("zh-CN") : "未上报"}
      >
        {bucket.hasTokens ? formatCompact(bucket.tokens) : "—"}
      </StatCell>
      <StatCell
        label="计费 Credits"
        detail={bucket.unbilledCredits > 0 ? `另有 ${formatCredits(bucket.unbilledCredits)} 未计费` : undefined}
      >
        {bucket.mixedCreditUnits ? (
          <CreditBreakdown items={bucket.creditsByHarness} className="text-[15px]" />
        ) : (
          formatCredits(bucket.credits, bucket.hasCredit)
        )}
      </StatCell>
      <StatCell label="缓存命中率">
        {bucket.cacheableInputTokens > 0 ? formatPercent(bucket.cacheRate) : "—"}
      </StatCell>
      <StatCell label="成功率">{formatPercent(bucket.successRate)}</StatCell>
    </div>
  );
}

/** 日/月×模型行与全历史聚合共用的形状。 */
interface ModelAggregate {
  model: string;
  provider: string;
  requests: number;
  tokens: number;
  hasTokens: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  credits: number;
  hasCredit: boolean;
}

/** 把 月×模型 行按模型求和成全历史排名；provider 取字典序最小值（与聚合层一致）。 */
function aggregateModels(rows: UsageMonthModelStat[]): ModelAggregate[] {
  const map = new Map<string, ModelAggregate>();
  for (const row of rows) {
    const current = map.get(row.model) ?? {
      model: row.model,
      provider: row.provider,
      requests: 0,
      tokens: 0,
      hasTokens: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      credits: 0,
      hasCredit: false,
    };
    current.requests += row.requests;
    current.tokens += row.tokens;
    current.hasTokens ||= row.hasTokens;
    current.inputTokens += row.inputTokens;
    current.outputTokens += row.outputTokens;
    current.cacheReadTokens += row.cacheReadTokens;
    current.credits += row.credits;
    current.hasCredit ||= row.hasCredit;
    if (row.provider < current.provider) current.provider = row.provider;
    map.set(row.model, current);
  }
  return Array.from(map.values());
}

const MODEL_CHART_LIMIT = 12;

/** 排名排序：所选指标降序，次级按请求数 / Tokens / 名称保证确定性。 */
function sortByMetric(rows: ModelAggregate[], metric: StatsMetric): ModelAggregate[] {
  return [...rows].sort(
    (a, b) =>
      (metric === "tokens" ? b.tokens - a.tokens : b.requests - a.requests) ||
      b.requests - a.requests ||
      b.tokens - a.tokens ||
      a.model.localeCompare(b.model),
  );
}

interface ModelChartRow extends ModelAggregate {
  value: number;
}

function ModelTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: ModelChartRow }>;
}) {
  if (!active || !payload?.[0]) return null;
  const row = payload[0].payload;
  const lines: Array<{ label: string; text: string }> = [
    {
      label: "Tokens",
      text: row.hasTokens ? row.tokens.toLocaleString("zh-CN") : "未上报",
    },
    { label: "请求数", text: `${row.requests.toLocaleString("zh-CN")} 次` },
    { label: "输入 / 输出", text: `${formatCompact(row.inputTokens)} / ${formatCompact(row.outputTokens)}` },
    ...(row.hasCredit
      ? [{ label: "计费 Credits", text: formatCredits(row.credits) }]
      : []),
    ...(row.cacheReadTokens > 0
      ? [{ label: "缓存读取", text: formatCompact(row.cacheReadTokens) }]
      : []),
  ];
  return (
    <div className="min-w-[200px] rounded-lg border border-border bg-popover px-3.5 py-3 shadow-xl">
      <div className="mb-2 break-all font-mono text-xs text-muted-foreground">
        {row.model} <span className="font-sans">· {row.provider}</span>
      </div>
      {lines.map((line) => (
        <div key={line.label} className="flex items-center gap-2 py-0.5 text-sm">
          <span className="text-muted-foreground">{line.label}</span>
          <span className="ml-auto pl-4 font-medium tabular-nums">{line.text}</span>
        </div>
      ))}
    </div>
  );
}

/** 模型用量横向条形图；行按所选指标降序传入，最多取前 MODEL_CHART_LIMIT 个。 */
function ModelBars({
  rows,
  metric,
}: {
  rows: ModelAggregate[];
  metric: StatsMetric;
}) {
  const chartRows = rows.slice(0, MODEL_CHART_LIMIT).map((row) => ({
    ...row,
    // 指标轴保持一致口径：没有 Token 上报的模型在 Tokens 模式下为空柱，由 tooltip 解释。
    value: metric === "tokens" ? (row.hasTokens ? row.tokens : 0) : row.requests,
  }));
  return (
    <ResponsiveContainer
      width="100%"
      height={Math.max(130, chartRows.length * 34 + 16)}
    >
      <BarChart
        layout="vertical"
        data={chartRows}
        margin={{ top: 4, right: 52, left: 0, bottom: 0 }}
        barCategoryGap="26%"
      >
        <CartesianGrid horizontal={false} stroke="var(--border)" strokeDasharray="3 5" />
        <XAxis type="number" hide domain={[0, "dataMax"]} />
        <YAxis
          type="category"
          dataKey="model"
          width={160}
          axisLine={false}
          tickLine={false}
          fontSize={11}
          tickMargin={8}
          tickFormatter={(name: string) =>
            name.length > 18 ? `${name.slice(0, 17)}…` : name
          }
        />
        <Tooltip content={<ModelTooltip />} cursor={{ fill: "var(--muted)", opacity: 0.35 }} />
        <Bar
          dataKey="value"
          fill="var(--primary)"
          radius={[0, 4, 4, 0]}
          maxBarSize={20}
          animationDuration={450}
        >
          <LabelList
            dataKey="value"
            position="right"
            fontSize={11}
            fill="var(--muted-foreground)"
            formatter={(value) => formatCompact(Number(value))}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

interface DayChartPoint {
  /** "YYYY-MM-DD"，点击柱子跳转按日模式用。 */
  day: string;
  /** X 轴刻度：日号。 */
  label: string;
  requests: number;
  tokens: number;
  hasTokens: boolean;
  credits: number;
  hasCredit: boolean;
  value: number;
}

function DayTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: DayChartPoint }>;
}) {
  if (!active || !payload?.[0]) return null;
  const point = payload[0].payload;
  return (
    <div className="min-w-[168px] rounded-lg border border-border bg-popover px-3.5 py-3 shadow-xl">
      <div className="mb-2 text-xs text-muted-foreground">{point.day}</div>
      {[
        {
          label: "Tokens",
          text: point.hasTokens ? point.tokens.toLocaleString("zh-CN") : "未上报",
        },
        { label: "请求数", text: `${point.requests.toLocaleString("zh-CN")} 次` },
        ...(point.hasCredit
          ? [{ label: "计费 Credits", text: formatCredits(point.credits) }]
          : []),
      ].map((line) => (
        <div key={line.label} className="flex items-center gap-2 py-0.5 text-sm">
          <span className="text-muted-foreground">{line.label}</span>
          <span className="ml-auto pl-4 font-medium tabular-nums">{line.text}</span>
        </div>
      ))}
    </div>
  );
}

/** 竖向柱状图（月内每日 / 全部月度共用）；data 已带 value 字段。 */
function UsageBars({
  data,
  onPickDay,
}: {
  data: DayChartPoint[];
  onPickDay?: (day: string) => void;
}) {
  return (
    <ResponsiveContainer width="100%" height={216}>
      <BarChart data={data} margin={{ top: 18, right: 4, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 5" />
        <XAxis
          dataKey="label"
          axisLine={false}
          tickLine={false}
          fontSize={11}
          minTickGap={16}
          tickMargin={10}
        />
        <YAxis
          axisLine={false}
          tickLine={false}
          fontSize={11}
          width={48}
          tickFormatter={formatCompact}
          tickMargin={8}
        />
        <Tooltip content={<DayTooltip />} cursor={{ fill: "var(--muted)", opacity: 0.35 }} />
        <Bar
          dataKey="value"
          fill="var(--primary)"
          radius={[4, 4, 0, 0]}
          maxBarSize={30}
          animationDuration={450}
          className={onPickDay ? "cursor-pointer" : undefined}
          onClick={
            onPickDay
              ? (entry) => {
                  const day = (entry?.payload as DayChartPoint | undefined)?.day;
                  if (day !== undefined) onPickDay(day);
                }
              : undefined
          }
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** 日模式月历：深色为有记录的日期，点击切换右侧当日详情。 */
function DayCalendar({
  month,
  currentMonth,
  dayMap,
  metric,
  selectedDay,
  today,
  onSelectDay,
  onMonthChange,
}: {
  month: string;
  currentMonth: string;
  dayMap: Map<string, UsageBucketStat>;
  metric: StatsMetric;
  selectedDay: string;
  today: string;
  onSelectDay: (day: string) => void;
  onMonthChange: (month: string) => void;
}) {
  const maxValue = Math.max(0, ...Array.from(dayMap.values(), (b) => metricValue(b, metric)));
  return (
    <StatsPanel
      title={formatMonthLabel(month)}
      description="深色日期有记录，点击切换当日详情"
      aside={
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="上个月"
            onClick={() => onMonthChange(shiftMonth(month, -1))}
            className="text-muted-foreground"
          >
            <ChevronLeft />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              onMonthChange(today.slice(0, 7));
              onSelectDay(today);
            }}
            className="text-muted-foreground"
          >
            今天
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="下个月"
            disabled={month >= currentMonth}
            onClick={() => onMonthChange(shiftMonth(month, 1))}
            className="text-muted-foreground"
          >
            <ChevronRight />
          </Button>
        </div>
      }
    >
      <div className="px-4 pb-4 pt-3">
        <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-muted-foreground">
          {["一", "二", "三", "四", "五", "六", "日"].map((weekday) => (
            <div key={weekday} className="py-1">
              {weekday}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {monthCells(month).map((day, index) =>
            day === null ? (
              <div key={`blank-${index}`} className="h-[52px]" />
            ) : (
              <DayCell
                key={day}
                day={day}
                bucket={dayMap.get(day)}
                metric={metric}
                maxValue={maxValue}
                selected={day === selectedDay}
                isToday={day === today}
                onSelect={onSelectDay}
              />
            ),
          )}
        </div>
        <HeatLegend />
      </div>
    </StatsPanel>
  );
}

function DayCell({
  day,
  bucket,
  metric,
  maxValue,
  selected,
  isToday,
  onSelect,
}: {
  day: string;
  bucket: UsageBucketStat | undefined;
  metric: StatsMetric;
  maxValue: number;
  selected: boolean;
  isToday: boolean;
  onSelect: (day: string) => void;
}) {
  const value = bucket === undefined ? 0 : metricValue(bucket, metric);
  const level = heatLevel(value, maxValue);
  return (
    <button
      type="button"
      aria-label={`选择 ${day}`}
      aria-pressed={selected}
      title={
        bucket === undefined
          ? `${day} · 无记录`
          : `${day} · ${bucket.requests} 次请求${
              bucket.hasTokens ? ` · ${bucket.tokens.toLocaleString("zh-CN")} Tokens` : ""
            }${bucket.hasCredit ? ` · ${formatCredits(bucket.credits)} Credits` : ""}`
      }
      onClick={() => onSelect(day)}
      className={cn(
        "flex h-[52px] flex-col items-center justify-center rounded-md border border-transparent text-xs transition",
        HEAT_CLASSES[level],
        level >= 3 ? "text-primary-foreground" : bucket ? "text-foreground" : "text-muted-foreground/55",
        !bucket && "hover:bg-muted/50",
        bucket && "hover:brightness-125",
        selected && "ring-2 ring-inset ring-primary",
        isToday && "outline outline-1 -outline-offset-2 outline-amber-400/70",
      )}
    >
      <span className="tabular-nums leading-4">{Number(day.slice(8))}</span>
      {value > 0 && (
        <span
          className={cn(
            "mt-0.5 text-[10px] leading-3 tabular-nums",
            level >= 3 ? "text-primary-foreground/85" : "text-muted-foreground",
          )}
        >
          {formatCompact(value)}
        </span>
      )}
    </button>
  );
}

/** 月模式年历：12 个月格子，深色为有记录月份。 */
function MonthCalendar({
  year,
  currentYear,
  monthMap,
  metric,
  selectedMonth,
  currentMonth,
  onSelectMonth,
  onYearChange,
}: {
  year: number;
  currentYear: number;
  monthMap: Map<string, UsageBucketStat>;
  metric: StatsMetric;
  selectedMonth: string;
  currentMonth: string;
  onSelectMonth: (month: string) => void;
  onYearChange: (year: number) => void;
}) {
  const maxValue = Math.max(0, ...Array.from(monthMap.values(), (b) => metricValue(b, metric)));
  return (
    <StatsPanel
      title={`${year}年`}
      description="深色月份有记录，点击切换当月详情"
      aside={
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="上一年"
            onClick={() => onYearChange(year - 1)}
            className="text-muted-foreground"
          >
            <ChevronLeft />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              onYearChange(currentYear);
              onSelectMonth(currentMonth);
            }}
            className="text-muted-foreground"
          >
            今年
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="下一年"
            disabled={year >= currentYear}
            onClick={() => onYearChange(year + 1)}
            className="text-muted-foreground"
          >
            <ChevronRight />
          </Button>
        </div>
      }
    >
      <div className="px-4 pb-4 pt-3">
        <div className="grid grid-cols-3 gap-1.5">
          {Array.from({ length: 12 }, (_, index) => {
            const key = `${year}-${pad2(index + 1)}`;
            const bucket = monthMap.get(key);
            const value = bucket === undefined ? 0 : metricValue(bucket, metric);
            const level = heatLevel(value, maxValue);
            return (
              <button
                key={key}
                type="button"
                aria-label={`选择 ${key}`}
                aria-pressed={key === selectedMonth}
                title={
                  bucket === undefined
                    ? `${formatMonthLabel(key)} · 无记录`
                    : `${formatMonthLabel(key)} · ${bucket.requests} 次请求${
                        bucket.hasTokens
                          ? ` · ${bucket.tokens.toLocaleString("zh-CN")} Tokens`
                          : ""
                      }${bucket.hasCredit ? ` · ${formatCredits(bucket.credits)} Credits` : ""}`
                }
                onClick={() => onSelectMonth(key)}
                className={cn(
                  "flex h-16 flex-col items-center justify-center rounded-md border border-transparent px-2 text-xs transition",
                  HEAT_CLASSES[level],
                  level >= 3
                    ? "text-primary-foreground"
                    : bucket
                      ? "text-foreground"
                      : "text-muted-foreground/55",
                  !bucket && "hover:bg-muted/50",
                  bucket && "hover:brightness-125",
                  key === selectedMonth && "ring-2 ring-inset ring-primary",
                )}
              >
                <span className="tabular-nums leading-4">{index + 1}月</span>
                {value > 0 && (
                  <span
                    className={cn(
                      "mt-1 text-[10px] leading-3 tabular-nums",
                      level >= 3 ? "text-primary-foreground/85" : "text-muted-foreground",
                    )}
                  >
                    {formatCompact(value)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <HeatLegend />
      </div>
    </StatsPanel>
  );
}

/** 当日详情：汇总条 + 当日模型用量横向条形图。 */
function DayDetail({
  day,
  bucket,
  modelRows,
  truncatedOut,
  metric,
  today,
}: {
  day: string;
  bucket: UsageBucketStat | undefined;
  modelRows: ModelAggregate[];
  truncatedOut: boolean;
  metric: StatsMetric;
  today: string;
}) {
  return (
    <StatsPanel
      title={
        <span className="inline-flex items-center gap-2">
          {formatDayLabel(day)}
          {day === today && (
            <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              今天
            </span>
          )}
        </span>
      }
      description={bucket === undefined ? "当日无用量记录" : `${bucket.requests} 次请求 · 按 ${metricLabels[metric]} 排名的当日模型用量`}
    >
      {bucket === undefined ? (
        <EmptyNotice text="该日在当前筛选下无用量记录" hint="深色日期为有记录的日期" />
      ) : (
        <>
          <SummaryStrip bucket={bucket} />
          <div className="px-4 pb-4 pt-4 sm:px-5">
            {modelRows.length === 0 ? (
              truncatedOut ? (
                <InlineNotice text="该日的模型明细超出保留窗口（最近约一年），仅有上方汇总。" />
              ) : (
                <EmptyNotice text="该日没有模型用量明细" />
              )
            ) : (
              <ModelBars rows={modelRows} metric={metric} />
            )}
          </div>
        </>
      )}
    </StatsPanel>
  );
}

/** 当月详情：汇总条 + 月内每日柱状图 + 当月模型排名。 */
function MonthDetail({
  month,
  bucket,
  dayMap,
  modelRows,
  metric,
  onPickDay,
}: {
  month: string;
  bucket: UsageBucketStat | undefined;
  dayMap: Map<string, UsageBucketStat>;
  modelRows: ModelAggregate[];
  metric: StatsMetric;
  onPickDay: (day: string) => void;
}) {
  const chartData = useMemo<DayChartPoint[]>(() => {
    const count = daysInMonth(month);
    return Array.from({ length: count }, (_, index) => {
      const day = `${month}-${pad2(index + 1)}`;
      const row = dayMap.get(day);
      return {
        day,
        label: String(index + 1),
        requests: row?.requests ?? 0,
        tokens: row?.tokens ?? 0,
        hasTokens: row?.hasTokens ?? false,
        credits: row?.credits ?? 0,
        hasCredit: row?.hasCredit ?? false,
        value: row === undefined ? 0 : metricValue(row, metric),
      };
    });
  }, [month, dayMap, metric]);

  return (
    <div className="space-y-5">
      <StatsPanel
        title={formatMonthLabel(month)}
        description={
          bucket === undefined
            ? "当月无用量记录"
            : `${bucket.requests} 次请求 · 月内每日 ${metricLabels[metric]}（点击柱子看当日）`
        }
      >
        {bucket === undefined ? (
          <EmptyNotice text="该月在当前筛选下无用量记录" hint="深色月份为有记录的月份" />
        ) : (
          <>
            <SummaryStrip bucket={bucket} />
            <div className="px-4 pb-4 pt-3 sm:px-5">
              <UsageBars data={chartData} onPickDay={onPickDay} />
            </div>
          </>
        )}
      </StatsPanel>
      {bucket !== undefined && (
        <StatsPanel
          title="当月模型用量排名"
          description={`${modelRows.length} 个模型 · 按 ${metricLabels[metric]} 降序`}
        >
          <div className="px-4 pb-4 pt-4 sm:px-5">
            {modelRows.length === 0 ? (
              <EmptyNotice text="当月没有模型用量明细" />
            ) : (
              <ModelBars rows={modelRows} metric={metric} />
            )}
          </div>
        </StatsPanel>
      )}
    </div>
  );
}

/** 总览：全部月份柱状图 + 全历史模型排名。 */
function AllOverview({
  months,
  monthMap,
  modelRows,
  metric,
  hiddenModels,
}: {
  months: string[];
  monthMap: Map<string, UsageBucketStat>;
  modelRows: ModelAggregate[];
  metric: StatsMetric;
  hiddenModels: number;
}) {
  const chartData = months.map((month) => {
    const row = monthMap.get(month);
    return {
      day: formatMonthLabel(month),
      label: month.slice(2),
      requests: row?.requests ?? 0,
      tokens: row?.tokens ?? 0,
      hasTokens: row?.hasTokens ?? false,
      credits: row?.credits ?? 0,
      hasCredit: row?.hasCredit ?? false,
      value: row === undefined ? 0 : metricValue(row, metric),
    };
  });
  return (
    <div className="space-y-5">
      <StatsPanel
        title="月度用量"
        description={`全部月份 · ${metricLabels[metric]}${months.length > 0 ? `（${formatMonthLabel(months[0])} ～ ${formatMonthLabel(months[months.length - 1])}）` : ""}`}
      >
        <div className="px-4 pb-4 pt-3 sm:px-5">
          {months.length === 0 ? (
            <EmptyNotice text="当前筛选下无用量记录" />
          ) : (
            <UsageBars data={chartData} />
          )}
        </div>
      </StatsPanel>
      <StatsPanel
        title="模型用量排名"
        description={`全部时间 · ${modelRows.length} 个模型 · 按 ${metricLabels[metric]} 降序${
          hiddenModels > 0 ? `，其余 ${hiddenModels} 个未展示` : ""
        }`}
      >
        <div className="px-4 pb-4 pt-4 sm:px-5">
          {modelRows.length === 0 ? (
            <EmptyNotice text="当前筛选下无模型用量" />
          ) : (
            <ModelBars rows={modelRows} metric={metric} />
          )}
        </div>
      </StatsPanel>
    </div>
  );
}

export function StatsView({ stats }: StatsViewProps) {
  // 供“今天”标记使用；渲染期间不变，跨午夜由滚动范围失效重查兜底。
  const [today] = useState(todayKey);
  const [mode, setMode] = useState<StatsMode>("day");
  const [metric, setMetric] = useState<StatsMetric>("tokens");
  const [pickedDay, setPickedDay] = useState<string | null>(null);
  const [viewedMonth, setViewedMonth] = useState<string | null>(null);
  const [pickedMonth, setPickedMonth] = useState<string | null>(null);
  const [viewedYear, setViewedYear] = useState<number | null>(null);

  const dayMap = useMemo(
    () => new Map((stats?.daily ?? []).map((bucket) => [bucket.key, bucket])),
    [stats],
  );
  const monthMap = useMemo(
    () => new Map((stats?.monthly ?? []).map((bucket) => [bucket.key, bucket])),
    [stats],
  );
  const dayModelMap = useMemo(
    () => groupBy(stats?.dailyModels ?? [], (row) => row.day),
    [stats],
  );
  const monthModelMap = useMemo(
    () => groupBy(stats?.monthlyModels ?? [], (row) => row.month),
    [stats],
  );

  // daily / monthly 服务端降序返回，首项即最新键。
  const latestDay = stats?.daily[0]?.key ?? null;
  const latestMonth = stats?.monthly[0]?.key ?? null;
  const currentMonth = today.slice(0, 7);
  const currentYear = Number(today.slice(0, 4));

  // 未显式选择时定位到最近有记录的日/月；显式选择跨筛选保持（空桶显示空态）。
  const selectedDay = pickedDay ?? (dayMap.has(today) ? today : latestDay) ?? today;
  const calendarMonth = viewedMonth ?? selectedDay.slice(0, 7);
  const selectedMonth =
    pickedMonth ?? (monthMap.has(currentMonth) ? currentMonth : latestMonth) ?? currentMonth;
  const calendarYear = viewedYear ?? Number(selectedMonth.slice(0, 4));

  const hasAnyTokens =
    (stats?.daily.some((bucket) => bucket.hasTokens) ?? false) ||
    (stats?.monthlyModels.some((row) => row.hasTokens) ?? false);
  // 全库都没有 Token 上报时统一退到请求数口径，避免空图表与空热力。
  const effectiveMetric = hasAnyTokens ? metric : "requests";

  const dayRows = sortByMetric(dayModelMap.get(selectedDay) ?? [], effectiveMetric);
  const monthRows = sortByMetric(monthModelMap.get(selectedMonth) ?? [], effectiveMetric);
  const allRows = useMemo(
    () => sortByMetric(aggregateModels(stats?.monthlyModels ?? []), effectiveMetric),
    [stats, effectiveMetric],
  );
  const allMonths = useMemo(
    () => monthSpan((stats?.monthly ?? []).map((bucket) => bucket.key)),
    [stats],
  );

  const selectDay = (day: string) => {
    setPickedDay(day);
    setViewedMonth(day.slice(0, 7));
  };

  if (stats === null) {
    return (
      <StatsPanel title="统计面板">
        <EmptyNotice
          text="统计数据加载失败"
          hint="请点击上方“重试”，请勿将此状态理解为零用量"
        />
      </StatsPanel>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          ariaLabel="统计粒度"
          value={mode}
          options={modeOptions}
          onChange={setMode}
        />
        <SegmentedControl
          ariaLabel="统计指标"
          value={effectiveMetric}
          options={metricOptions}
          onChange={setMetric}
        />
      </div>

      {mode === "day" && (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
          <DayCalendar
            month={calendarMonth}
            currentMonth={currentMonth}
            dayMap={dayMap}
            metric={effectiveMetric}
            selectedDay={selectedDay}
            today={today}
            onSelectDay={selectDay}
            onMonthChange={setViewedMonth}
          />
          <DayDetail
            day={selectedDay}
            bucket={dayMap.get(selectedDay)}
            modelRows={dayRows}
            truncatedOut={Boolean(
              stats.dailyModelsTruncated &&
                dayMap.has(selectedDay) &&
                (dayModelMap.get(selectedDay)?.length ?? 0) === 0,
            )}
            metric={effectiveMetric}
            today={today}
          />
        </div>
      )}

      {mode === "month" && (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
          <MonthCalendar
            year={calendarYear}
            currentYear={currentYear}
            monthMap={monthMap}
            metric={effectiveMetric}
            selectedMonth={selectedMonth}
            currentMonth={currentMonth}
            onSelectMonth={(month) => {
              setPickedMonth(month);
              setViewedYear(Number(month.slice(0, 4)));
            }}
            onYearChange={setViewedYear}
          />
          <MonthDetail
            month={selectedMonth}
            bucket={monthMap.get(selectedMonth)}
            dayMap={dayMap}
            modelRows={monthRows}
            metric={effectiveMetric}
            onPickDay={(day) => {
              selectDay(day);
              setMode("day");
            }}
          />
        </div>
      )}

      {mode === "all" && (
        <AllOverview
          months={allMonths}
          monthMap={monthMap}
          modelRows={allRows}
          metric={effectiveMetric}
          hiddenModels={Math.max(0, allRows.length - MODEL_CHART_LIMIT)}
        />
      )}
    </div>
  );
}
