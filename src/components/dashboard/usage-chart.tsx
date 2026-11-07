"use client";

import { BarChart3, LineChart } from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  formatCompact,
  formatCredits,
  formatPercent,
  type MetricKey,
  type TrendPoint,
} from "@/lib/usage";

export type ChartType = "bar" | "area";

interface UsageChartProps {
  data: TrendPoint[];
  metric: MetricKey;
  hourly: boolean;
  chartType: ChartType;
  onChartTypeChange: (type: ChartType) => void;
}

const metricLabels: Record<MetricKey, string> = {
  credits: "Credits",
  requests: "请求数",
  tokens: "Tokens",
  cacheRate: "缓存命中率",
};

function formatMetric(value: number, metric: MetricKey): string {
  if (metric === "tokens") return `${Math.round(value).toLocaleString("zh-CN")} Tokens`;
  if (metric === "credits") return `${formatCredits(value)} Credits`;
  if (metric === "cacheRate") return formatPercent(value);
  return `${Math.round(value).toLocaleString("zh-CN")} 次请求`;
}

function ChartTooltip({
  active,
  payload,
  metric,
}: {
  active?: boolean;
  payload?: Array<{ payload: TrendPoint }>;
  metric: MetricKey;
}) {
  if (!active || !payload?.[0]) return null;
  const point = payload[0].payload;
  return (
    <div className="min-w-[168px] rounded-lg border border-border bg-popover px-3.5 py-3 shadow-xl">
      <div className="mb-2 text-xs text-muted-foreground">{point.fullLabel}</div>
      <div className="flex items-center gap-2 text-sm font-medium">
        <span className="size-2 rounded-[2px] bg-primary" />
        <span>{metricLabels[metric]}</span>
        <span className="ml-auto pl-4 tabular-nums">{formatMetric(point[metric], metric)}</span>
      </div>
    </div>
  );
}

export function UsageChart({
  data,
  metric,
  hourly,
  chartType,
  onChartTypeChange,
}: UsageChartProps) {
  const axisFormatter = (value: number) => {
    if (metric === "cacheRate") return `${Math.round(value * 100)}%`;
    if (metric === "requests") return Math.round(value).toString();
    return formatCompact(value);
  };
  const sharedAxes = (
    <>
      <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 5" />
      <XAxis
        dataKey="label"
        axisLine={false}
        tickLine={false}
        fontSize={11}
        minTickGap={28}
        tickMargin={12}
      />
      <YAxis
        axisLine={false}
        tickLine={false}
        fontSize={11}
        width={48}
        tickFormatter={axisFormatter}
        domain={metric === "cacheRate" ? [0, 1] : [0, "auto"]}
        tickMargin={8}
      />
      <Tooltip
        content={<ChartTooltip metric={metric} />}
        cursor={{ fill: "var(--muted)", opacity: 0.35 }}
      />
    </>
  );

  return (
    <div className="border-t border-border/70 px-4 pb-3 pt-4 sm:px-5">
      <div className="mb-1 flex items-center justify-between px-1">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/80">{metricLabels[metric]}</span>
          <span>·</span>
          <span>{hourly ? "按小时" : "按日期"}</span>
        </div>
        <div className="flex items-center rounded-md border border-border/80 p-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="柱状图"
            aria-pressed={chartType === "bar"}
            onClick={() => onChartTypeChange("bar")}
            className={cn("text-muted-foreground", chartType === "bar" && "bg-muted text-foreground")}
          >
            <BarChart3 />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="面积图"
            aria-pressed={chartType === "area"}
            onClick={() => onChartTypeChange("area")}
            className={cn("text-muted-foreground", chartType === "area" && "bg-muted text-foreground")}
          >
            <LineChart />
          </Button>
        </div>
      </div>
      <div className="h-[248px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          {chartType === "bar" ? (
            <BarChart data={data} margin={{ top: 18, right: 4, left: 0, bottom: 0 }}>
              {sharedAxes}
              <Bar
                dataKey={metric}
                fill="var(--primary)"
                radius={[5, 5, 2, 2]}
                maxBarSize={40}
                animationDuration={450}
              />
            </BarChart>
          ) : (
            <AreaChart data={data} margin={{ top: 18, right: 4, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="usage-area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.42} />
                  <stop offset="95%" stopColor="var(--primary)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              {sharedAxes}
              <Area
                type="monotone"
                dataKey={metric}
                stroke="var(--primary)"
                strokeWidth={2.2}
                fill="url(#usage-area)"
                activeDot={{ r: 4, strokeWidth: 2, fill: "var(--card)" }}
                animationDuration={450}
              />
            </AreaChart>
          )}
        </ResponsiveContainer>
      </div>
    </div>
  );
}
