"use client";

import { useState } from "react";
import {
  ArrowDown,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Download,
  FileClock,
  Gauge,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CreditBreakdown } from "@/components/dashboard/credit-breakdown";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  formatAggregateTokensPerSecond,
  formatEstimatedTokensPerSecond,
  type SpeedTotals,
} from "@/lib/speed";
import {
  formatCompact,
  formatCredits,
  formatPercent,
  formatTime,
  getHarnessLabel,
  type GroupStat,
  type HarnessId,
  type UsageGroups,
  type UsageRecord,
  type UsageRecordsPage,
} from "@/lib/usage";

export type DetailTab = "logs" | "providers" | "models" | "projects" | "harnesses";

interface UsageTablesProps {
  /** 服务端聚合的各维度分组（M6 起不再由前端全量计算）。 */
  groups: UsageGroups | null;
  records: UsageRecordsPage | null;
  recordsLoading: boolean;
  page: number;
  onPageChange: (page: number) => void;
  tab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
  filteredCount: number;
  onExport: () => void;
  updating: boolean;
}

const headClass = "h-11 border-border/70 px-4 text-xs font-normal text-muted-foreground";
const cellClass = "border-border/70 px-4 py-3.5 text-[13px] tabular-nums";

const providerColors: Record<string, string> = {
  DeepSeek: "bg-blue-500/15 text-blue-400",
  "Moonshot AI": "bg-violet-500/15 text-violet-400",
  Anthropic: "bg-orange-500/15 text-orange-400",
  OpenAI: "bg-emerald-500/15 text-emerald-400",
  Google: "bg-sky-500/15 text-sky-400",
  "Alibaba Cloud": "bg-cyan-500/15 text-cyan-400",
  Volcengine: "bg-red-500/15 text-red-400",
  MiniMax: "bg-rose-500/15 text-rose-400",
  CodeBuddy: "bg-amber-500/15 text-amber-400",
  Qoder: "bg-violet-500/15 text-violet-400",
  // ZCode 的 provider 字段是它自身的 providerId（如 account:bigmodel-individual-coding-plan）。
  "account:bigmodel-individual-coding-plan": "bg-emerald-500/15 text-emerald-400",
  "account:bigmodel-start-plan": "bg-teal-500/15 text-teal-400",
  "bigmodel-api": "bg-emerald-500/15 text-emerald-400",
};

function ProviderMark({ name, small = false }: { name: string; small?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md font-semibold",
        small ? "size-6 text-[10px]" : "size-7 text-xs",
        providerColors[name] ?? "bg-slate-500/15 text-slate-400",
      )}
      aria-hidden="true"
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function EmptyRow({ colSpan }: { colSpan: number }) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="h-56 text-center">
        <div className="flex flex-col items-center justify-center gap-3 text-muted-foreground">
          <FileClock className="size-8 opacity-45" strokeWidth={1.5} />
          <div>
            <div className="text-sm">当前筛选范围暂无用量</div>
            <div className="mt-1 text-xs opacity-70">切换时间范围或清除筛选后再看看</div>
          </div>
        </div>
      </TableCell>
    </TableRow>
  );
}

const SPEED_HELP =
  "汇总速度 = Σ输出 Tokens ÷ Σ耗时（只统计输出 ≥ 200 且耗时 ≥ 1s 的请求）。CodeBuddy 等会话日志没有精确计时，耗时按时间戳估算且含首字等待，结果偏低，仅作参考；ZCode 与 Antigravity 记录的是精确请求耗时（同样含首字等待，Antigravity 为原生库的首字等待 + 流式时长）。";

const REQUEST_SPEED_HELP =
  "速度 = 输出 Tokens ÷ 耗时（含首字等待）。仅输出 ≥ 200 且耗时 ≥ 1s 的请求展示；Antigravity 使用原生库的精确耗时。";

function RequestSpeedValue({ record }: { record: UsageRecord }) {
  const speed = formatEstimatedTokensPerSecond(record);
  if (speed == null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-baseline gap-0.5" title={REQUEST_SPEED_HELP}>
      <span>≈ {speed}</span>
      <span className="text-[11px] font-normal text-muted-foreground">tok/s</span>
    </span>
  );
}

function SpeedCell({ stat }: { stat: SpeedTotals }) {
  const speed = formatAggregateTokensPerSecond(stat);
  return (
    <TableCell className={cellClass} title={SPEED_HELP}>
      {speed == null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <span className="inline-flex items-baseline gap-0.5">
          <span>≈ {speed}</span>
          <span className="text-[11px] font-normal text-muted-foreground">tok/s</span>
        </span>
      )}
    </TableCell>
  );
}

function GroupTable({ stats, dimension }: { stats: GroupStat[]; dimension: DetailTab }) {
  const firstLabel =
    dimension === "models"
      ? "模型"
      : dimension === "providers"
        ? "供应商"
        : dimension === "harnesses"
          ? "Harness"
          : "项目";
  return (
    <Table className="min-w-[920px]">
      <TableHeader>
        <TableRow className="border-border/70 hover:bg-transparent">
          <TableHead className={cn(headClass, "pl-6")}>{firstLabel}</TableHead>
          <TableHead className={headClass} aria-sort="descending">
            <span className="inline-flex items-center gap-1.5">
              请求数 <ArrowDown className="size-3" />
            </span>
          </TableHead>
          <TableHead className={headClass}>计费 Credits</TableHead>
          <TableHead className={headClass}>Tokens</TableHead>
          <TableHead className={headClass} title={SPEED_HELP}>
            <span className="inline-flex items-center gap-0.5">
              速度 <Gauge className="size-3 text-muted-foreground" />
            </span>
          </TableHead>
          <TableHead className={headClass}>缓存命中率</TableHead>
          <TableHead className={headClass}>成功率</TableHead>
          <TableHead className={cn(headClass, "pr-6 text-right")}>最近使用</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {stats.length === 0 ? (
          <EmptyRow colSpan={8} />
        ) : (
          stats.map((stat) => {
            const label =
              dimension === "harnesses" ? getHarnessLabel(stat.key as HarnessId) : stat.key;
            return (
              <TableRow key={stat.key} className="border-border/70 hover:bg-muted/35">
                <TableCell className={cn(cellClass, "pl-6")}>
                  <div className="flex max-w-[300px] items-center gap-3">
                    <ProviderMark
                      name={dimension === "projects" ? "Y Token" : label}
                      small={dimension !== "providers" && dimension !== "harnesses"}
                    />
                    <span
                      className={cn(
                        "truncate",
                        dimension !== "projects" && dimension !== "harnesses" && "font-mono text-xs",
                      )}
                      title={label}
                    >
                      {label}
                    </span>
                  </div>
                </TableCell>
                <TableCell className={cellClass}>{stat.requests.toLocaleString("zh-CN")}</TableCell>
                <TableCell className={cn(cellClass, "font-medium")}>
                  {stat.mixedCreditUnits ? (
                    <CreditBreakdown items={stat.creditsByHarness} className="max-w-[180px] text-xs" />
                  ) : (
                    <>
                      {formatCredits(stat.credits, stat.hasCredit)}
                      {stat.unbilledCredits > 0 && (
                        <div className="mt-0.5 text-[11px] font-normal text-muted-foreground">
                          另有 {formatCredits(stat.unbilledCredits)} 未计费
                        </div>
                      )}
                    </>
                  )}
                </TableCell>
                <TableCell className={cellClass}>
                  <span title={stat.hasTokens ? stat.tokens.toLocaleString("zh-CN") : "Token 数据未上报"}>
                    {stat.hasTokens ? formatCompact(stat.tokens) : "—"}
                  </span>
                </TableCell>
                <SpeedCell stat={stat} />
                <TableCell className={cellClass}>
                  {stat.cacheableInputTokens > 0 ? formatPercent(stat.cacheRate) : "—"}
                </TableCell>
                <TableCell className={cellClass}>
                  <span className={stat.successRate >= 0.99 ? "text-emerald-500" : "text-amber-500"}>
                    {formatPercent(stat.successRate)}
                  </span>
                </TableCell>
                <TableCell className={cn(cellClass, "pr-6 text-right text-muted-foreground")}>
                  {formatTime(stat.lastUsed)}
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}

function RequestTable({
  records,
  total,
  page,
  pageSize,
  onPageChange,
  onSelect,
}: {
  records: UsageRecord[];
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onSelect: (record: UsageRecord) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const rows = records;

  return (
    <div>
      <Table className="min-w-[1260px]">
        <TableHeader>
          <TableRow className="border-border/70 hover:bg-transparent">
            <TableHead className={cn(headClass, "pl-6")}>时间</TableHead>
            <TableHead className={headClass}>Harness</TableHead>
            <TableHead className={headClass}>项目</TableHead>
            <TableHead className={headClass}>模型</TableHead>
            <TableHead className={cn(headClass, "text-right")}>输入</TableHead>
            <TableHead className={cn(headClass, "text-right")}>输出</TableHead>
            <TableHead className={cn(headClass, "text-right")}>缓存</TableHead>
            <TableHead className={cn(headClass, "text-right")}>总 Tokens</TableHead>
            <TableHead className={cn(headClass, "text-right")} title={SPEED_HELP}>
              <span className="inline-flex items-center gap-0.5">
                速度 <Gauge className="size-3 text-muted-foreground" />
              </span>
            </TableHead>
            <TableHead className={cn(headClass, "text-right")}>Credits</TableHead>
            <TableHead className={cn(headClass, "pr-6 text-right")}>状态</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <EmptyRow colSpan={11} />
          ) : (
            rows.map((record) => (
              <TableRow
                key={record.id}
                tabIndex={0}
                aria-label={`查看 ${record.model} 请求详情`}
                onClick={() => onSelect(record)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") onSelect(record);
                }}
                className="cursor-pointer border-border/70 hover:bg-muted/35 focus-visible:bg-muted/40 focus-visible:outline-none"
              >
                <TableCell className={cn(cellClass, "pl-6 text-muted-foreground")}>
                  {formatTime(record.timestamp)}
                </TableCell>
                <TableCell className={cellClass}>
                  <span className="inline-flex items-center gap-2">
                    <ProviderMark name={getHarnessLabel(record.harness)} small />
                    {getHarnessLabel(record.harness)}
                  </span>
                </TableCell>
                <TableCell className={cellClass}>{record.project}</TableCell>
                <TableCell className={cellClass}>
                  <div className="flex max-w-[230px] items-center gap-2.5">
                    <ProviderMark name={record.provider} small />
                    <span className="truncate font-mono text-xs" title={record.model}>
                      {record.model}
                    </span>
                  </div>
                </TableCell>
                <TableCell className={cn(cellClass, "text-right")}>
                  {record.hasTokenUsage ? formatCompact(record.inputTokens) : "—"}
                </TableCell>
                <TableCell className={cn(cellClass, "text-right")}>
                  {record.hasTokenUsage ? formatCompact(record.outputTokens) : "—"}
                </TableCell>
                <TableCell className={cn(cellClass, "text-right text-muted-foreground")}>
                  {record.hasTokenUsage ? formatCompact(record.cacheReadTokens) : "—"}
                </TableCell>
                <TableCell className={cn(cellClass, "text-right font-medium")}>
                  {record.hasTokenUsage ? formatCompact(record.totalTokens) : "—"}
                </TableCell>
                <TableCell className={cn(cellClass, "text-right")}>
                  <RequestSpeedValue record={record} />
                </TableCell>
                <TableCell className={cn(cellClass, "text-right")}>
                  {record.billable === false ? (
                    <span
                      className="text-muted-foreground"
                      title={`服务端报告 ${formatCredits(record.reportedCredits ?? 0)} Credits，标记为不计费`}
                    >
                      未计费
                    </span>
                  ) : (
                    formatCredits(record.credits, record.hasCredit)
                  )}
                </TableCell>
                <TableCell className={cn(cellClass, "pr-6 text-right")}>
                  {record.status === "success" ? (
                    <span className="inline-flex items-center gap-1.5 text-emerald-500">
                      <CheckCircle2 className="size-3.5" /> 成功
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-red-400">
                      <CircleAlert className="size-3.5" /> 失败
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      <div className="flex h-14 items-center justify-between border-t border-border/70 px-5 text-xs text-muted-foreground">
        <span>共 {total.toLocaleString("zh-CN")} 条请求</span>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="上一页"
            disabled={page === 0}
            onClick={() => onPageChange(Math.max(0, page - 1))}
          >
            <ChevronLeft />
          </Button>
          <span className="min-w-16 text-center tabular-nums">
            {page + 1} / {pageCount}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="下一页"
            disabled={page >= pageCount - 1}
            onClick={() => onPageChange(Math.min(pageCount - 1, page + 1))}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
    </div>
  );
}

function DetailItem({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg border border-border/70 bg-muted/20 px-3.5 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("mt-1.5 break-all text-sm font-medium", mono && "font-mono text-xs")}>{value}</div>
    </div>
  );
}

export function UsageTables({
  groups,
  records,
  recordsLoading,
  page,
  onPageChange,
  tab,
  onTabChange,
  filteredCount,
  onExport,
  updating,
}: UsageTablesProps) {
  // 详情按 (harness, record_id) 查询；先用行内数据乐观展示，返回后替换。
  const [detail, setDetail] = useState<UsageRecord | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const selectRecord = (record: UsageRecord) => {
    setDetail(record);
    setDetailLoading(true);
    const search = new URLSearchParams({
      harness: record.harness,
      recordId: record.id,
    });
    fetch(`/api/usage/records/detail?${search}`, { cache: "no-store" })
      .then(async (response) => (response.ok ? ((await response.json()) as UsageRecord) : null))
      .then((fresh) => {
        if (fresh) setDetail(fresh);
      })
      .catch(() => undefined)
      .finally(() => setDetailLoading(false));
  };

  const emptyGroups: UsageGroups = {
    harness: [],
    provider: [],
    model: [],
    project: [],
  };
  const resolved = groups ?? emptyGroups;
  const tabItems: Array<{ id: DetailTab; label: string; count: number }> = [
    { id: "logs", label: "请求日志", count: filteredCount },
    { id: "harnesses", label: "Harness", count: resolved.harness.length },
    { id: "providers", label: "供应商", count: resolved.provider.length },
    { id: "models", label: "模型", count: resolved.model.length },
    { id: "projects", label: "项目", count: resolved.project.length },
  ];

  return (
    <section id="usage-details" className="panel overflow-hidden">
      <div className="flex min-h-14 flex-wrap items-center justify-between gap-2 border-b border-border/70 pr-3">
        <div role="tablist" aria-label="用量明细" className="flex h-14 items-stretch px-2">
          {tabItems.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => onTabChange(item.id)}
              className={cn(
                "relative flex items-center gap-1.5 px-4 text-[13px] font-medium transition-colors",
                tab === item.id ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
              <span
                className={cn(
                  "rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground",
                  updating && item.id === tab && "animate-pulse",
                )}
              >
                {item.count}
              </span>
              <span
                className={cn(
                  "absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-foreground transition-opacity",
                  tab === item.id ? "opacity-100" : "opacity-0",
                )}
              />
            </button>
          ))}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={filteredCount === 0}
          onClick={onExport}
          className="text-muted-foreground"
        >
          <Download /> 导出 CSV
        </Button>
      </div>

      {tab === "logs" && (
        <RequestTable
          records={records?.records ?? []}
          total={records?.total ?? 0}
          page={page}
          pageSize={records?.pageSize ?? 10}
          onPageChange={onPageChange}
          onSelect={selectRecord}
        />
      )}
      {tab === "harnesses" && <GroupTable stats={resolved.harness} dimension="harnesses" />}
      {tab === "providers" && <GroupTable stats={resolved.provider} dimension="providers" />}
      {tab === "models" && <GroupTable stats={resolved.model} dimension="models" />}
      {tab === "projects" && <GroupTable stats={resolved.project} dimension="projects" />}
      {tab === "logs" && recordsLoading && records === null && (
        <div className="px-5 pb-5 text-xs text-muted-foreground">正在加载请求日志…</div>
      )}

      <Dialog open={detail !== null} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[560px]">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2.5 pr-6">
                  <ProviderMark name={detail.provider} />
                  <span className="font-mono text-sm">{detail.model}</span>
                </DialogTitle>
                <DialogDescription>
                  {formatTime(detail.timestamp)} · {getHarnessLabel(detail.harness)} · {detail.project}
                  {detailLoading ? " · 正在按 ID 查询详情…" : ""}
                </DialogDescription>
              </DialogHeader>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                <DetailItem
                  label="输入 Tokens"
                  value={detail.hasTokenUsage ? detail.inputTokens.toLocaleString("zh-CN") : "未上报"}
                />
                <DetailItem
                  label="输出 Tokens"
                  value={detail.hasTokenUsage ? detail.outputTokens.toLocaleString("zh-CN") : "未上报"}
                />
                <DetailItem
                  label="总 Tokens"
                  value={detail.hasTokenUsage ? detail.totalTokens.toLocaleString("zh-CN") : "未上报"}
                />
                <DetailItem
                  label="缓存读取"
                  value={detail.hasTokenUsage ? detail.cacheReadTokens.toLocaleString("zh-CN") : "未上报"}
                />
                <DetailItem
                  label="缓存写入"
                  value={detail.hasTokenUsage ? detail.cacheCreationTokens.toLocaleString("zh-CN") : "未上报"}
                />
                <DetailItem label="计费 Credits" value={formatCredits(detail.credits, detail.hasCredit)} />
                {detail.estimatedDurationMs !== undefined && (
                  <DetailItem
                    label={detail.harness === "antigravity" ? "耗时" : "估算耗时"}
                    value={`${(detail.estimatedDurationMs / 1000).toFixed(1)} s`}
                  />
                )}
                {detail.estimatedDurationMs !== undefined && (
                  <DetailItem
                    label={detail.harness === "antigravity" ? "速度" : "估算速度"}
                    value={
                      formatEstimatedTokensPerSecond(detail) == null
                        ? "—（未达速度门槛）"
                        : `${detail.harness === "antigravity" ? "" : "≈ "}${formatEstimatedTokensPerSecond(detail)} tok/s`
                    }
                  />
                )}
              </div>
              <div className="space-y-2.5">
                {detail.billable !== undefined && (
                  <DetailItem label="计费状态" value={detail.billable ? "计费" : "不计费"} />
                )}
                {detail.billable === false && detail.reportedCredits !== undefined && (
                  <DetailItem
                    label="服务端报告 Credits"
                    value={`${formatCredits(detail.reportedCredits)}（未扣费）`}
                  />
                )}
                {detail.contextUsageRatio !== undefined && (
                  <DetailItem
                    label="请求时上下文占用"
                    value={formatPercent(detail.contextUsageRatio)}
                  />
                )}
                <DetailItem label="会话 ID" value={detail.sessionId} mono />
                <DetailItem label="请求 ID" value={detail.requestId} mono />
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                {detail.hasTokenUsage
                  ? detail.inputTokenSemantics === "fresh"
                    ? "输入 Tokens 不包含缓存读写；总 Tokens 已合并输入、输出与缓存读写。"
                    : "输入 Tokens 已包含缓存读取；总 Tokens 采用原始 total_tokens，不重复累计。"
                  : "该 Harness 的本地记录未提供有效 Token 数值，仅展示 Credits 与请求信息。"}
                {detail.estimatedDurationMs !== undefined &&
                  (detail.harness === "antigravity"
                    ? " 耗时取自 Antigravity 原生会话库（首字等待 + 流式时长，含首字），速度 = 输出 Tokens ÷ 耗时；仅统计输出 ≥ 200 Tokens 且耗时 ≥ 1s 的请求。"
                    : " 速度与耗时为估算值：按会话时间戳推算（消息完成时刻 − 请求起点），含首字等待，仅统计输出 ≥ 200 Tokens 且耗时 ≥ 1s 的请求。")}
              </p>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
