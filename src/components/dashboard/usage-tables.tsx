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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  formatCompact,
  formatCredits,
  formatPercent,
  formatTime,
  groupRecords,
  type GroupStat,
  type UsageRecord,
} from "@/lib/usage";

export type DetailTab = "logs" | "providers" | "models" | "projects";

interface UsageTablesProps {
  records: UsageRecord[];
  tab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
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

function GroupTable({ stats, dimension }: { stats: GroupStat[]; dimension: DetailTab }) {
  const firstLabel = dimension === "models" ? "模型" : dimension === "providers" ? "供应商" : "项目";
  return (
    <Table className="min-w-[840px]">
      <TableHeader>
        <TableRow className="border-border/70 hover:bg-transparent">
          <TableHead className={cn(headClass, "pl-6")}>{firstLabel}</TableHead>
          <TableHead className={headClass} aria-sort="descending">
            <span className="inline-flex items-center gap-1.5">
              请求数 <ArrowDown className="size-3" />
            </span>
          </TableHead>
          <TableHead className={headClass}>消耗 Credits</TableHead>
          <TableHead className={headClass}>Tokens</TableHead>
          <TableHead className={headClass}>缓存命中率</TableHead>
          <TableHead className={headClass}>成功率</TableHead>
          <TableHead className={cn(headClass, "pr-6 text-right")}>最近使用</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {stats.length === 0 ? (
          <EmptyRow colSpan={7} />
        ) : (
          stats.map((stat) => (
            <TableRow key={stat.key} className="border-border/70 hover:bg-muted/35">
              <TableCell className={cn(cellClass, "pl-6")}>
                <div className="flex max-w-[300px] items-center gap-3">
                  <ProviderMark
                    name={dimension === "models" ? stat.key : dimension === "providers" ? stat.key : "CodeBuddy"}
                    small={dimension !== "providers"}
                  />
                  <span
                    className={cn("truncate", dimension !== "projects" && "font-mono text-xs")}
                    title={stat.key}
                  >
                    {stat.key}
                  </span>
                </div>
              </TableCell>
              <TableCell className={cellClass}>{stat.requests.toLocaleString("zh-CN")}</TableCell>
              <TableCell className={cn(cellClass, "font-medium")}>
                {formatCredits(stat.credits, stat.hasCredit)}
              </TableCell>
              <TableCell className={cellClass}>
                <span title={stat.tokens.toLocaleString("zh-CN")}>{formatCompact(stat.tokens)}</span>
              </TableCell>
              <TableCell className={cellClass}>{formatPercent(stat.cacheRate)}</TableCell>
              <TableCell className={cellClass}>
                <span className={stat.successRate >= 0.99 ? "text-emerald-500" : "text-amber-500"}>
                  {formatPercent(stat.successRate)}
                </span>
              </TableCell>
              <TableCell className={cn(cellClass, "pr-6 text-right text-muted-foreground")}>
                {formatTime(stat.lastUsed)}
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}

function exportCsv(records: UsageRecord[]) {
  const headers = [
    "时间",
    "项目",
    "供应商",
    "模型",
    "输入 Tokens",
    "输出 Tokens",
    "缓存读取 Tokens",
    "总 Tokens",
    "Credits",
    "状态",
    "会话 ID",
  ];
  const escape = (value: string | number) => `"${String(value).replace(/"/g, '""')}"`;
  const rows = records.map((record) => [
    new Date(record.timestamp).toISOString(),
    record.project,
    record.provider,
    record.model,
    record.inputTokens,
    record.outputTokens,
    record.cacheReadTokens,
    record.totalTokens,
    record.hasCredit ? record.credits : "",
    record.status,
    record.sessionId,
  ]);
  const csv = [headers, ...rows].map((row) => row.map(escape).join(",")).join("\r\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `codebuddy-usage-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function RequestTable({
  records,
  onSelect,
}: {
  records: UsageRecord[];
  onSelect: (record: UsageRecord) => void;
}) {
  const [page, setPage] = useState(0);
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(records.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const rows = records.slice(currentPage * pageSize, currentPage * pageSize + pageSize);

  return (
    <div>
      <Table className="min-w-[1060px]">
        <TableHeader>
          <TableRow className="border-border/70 hover:bg-transparent">
            <TableHead className={cn(headClass, "pl-6")}>时间</TableHead>
            <TableHead className={headClass}>项目</TableHead>
            <TableHead className={headClass}>模型</TableHead>
            <TableHead className={cn(headClass, "text-right")}>输入</TableHead>
            <TableHead className={cn(headClass, "text-right")}>输出</TableHead>
            <TableHead className={cn(headClass, "text-right")}>缓存</TableHead>
            <TableHead className={cn(headClass, "text-right")}>总 Tokens</TableHead>
            <TableHead className={cn(headClass, "text-right")}>Credits</TableHead>
            <TableHead className={cn(headClass, "pr-6 text-right")}>状态</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <EmptyRow colSpan={9} />
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
                <TableCell className={cellClass}>{record.project}</TableCell>
                <TableCell className={cellClass}>
                  <div className="flex max-w-[230px] items-center gap-2.5">
                    <ProviderMark name={record.provider} small />
                    <span className="truncate font-mono text-xs" title={record.model}>
                      {record.model}
                    </span>
                  </div>
                </TableCell>
                <TableCell className={cn(cellClass, "text-right")}>{formatCompact(record.inputTokens)}</TableCell>
                <TableCell className={cn(cellClass, "text-right")}>{formatCompact(record.outputTokens)}</TableCell>
                <TableCell className={cn(cellClass, "text-right text-muted-foreground")}>
                  {formatCompact(record.cacheReadTokens)}
                </TableCell>
                <TableCell className={cn(cellClass, "text-right font-medium")}>
                  {formatCompact(record.totalTokens)}
                </TableCell>
                <TableCell className={cn(cellClass, "text-right")}>
                  {formatCredits(record.credits, record.hasCredit)}
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
        <span>共 {records.length.toLocaleString("zh-CN")} 条请求</span>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="上一页"
            disabled={currentPage === 0}
            onClick={() => setPage(Math.max(0, currentPage - 1))}
          >
            <ChevronLeft />
          </Button>
          <span className="min-w-16 text-center tabular-nums">
            {currentPage + 1} / {pageCount}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="下一页"
            disabled={currentPage >= pageCount - 1}
            onClick={() => setPage(Math.min(pageCount - 1, currentPage + 1))}
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

export function UsageTables({ records, tab, onTabChange }: UsageTablesProps) {
  const [selected, setSelected] = useState<UsageRecord | null>(null);
  const models = groupRecords(records, "model");
  const providers = groupRecords(records, "provider");
  const projects = groupRecords(records, "project");
  const tabItems: Array<{ id: DetailTab; label: string; count: number }> = [
    { id: "logs", label: "请求日志", count: records.length },
    { id: "providers", label: "供应商", count: providers.length },
    { id: "models", label: "模型", count: models.length },
    { id: "projects", label: "项目", count: projects.length },
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
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{item.count}</span>
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
          disabled={records.length === 0}
          onClick={() => exportCsv(records)}
          className="text-muted-foreground"
        >
          <Download /> 导出 CSV
        </Button>
      </div>

      {tab === "logs" && <RequestTable records={records} onSelect={setSelected} />}
      {tab === "providers" && <GroupTable stats={providers} dimension="providers" />}
      {tab === "models" && <GroupTable stats={models} dimension="models" />}
      {tab === "projects" && <GroupTable stats={projects} dimension="projects" />}

      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[560px]">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2.5 pr-6">
                  <ProviderMark name={selected.provider} />
                  <span className="font-mono text-sm">{selected.model}</span>
                </DialogTitle>
                <DialogDescription>
                  {formatTime(selected.timestamp)} · {selected.project}
                </DialogDescription>
              </DialogHeader>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                <DetailItem label="输入 Tokens" value={selected.inputTokens.toLocaleString("zh-CN")} />
                <DetailItem label="输出 Tokens" value={selected.outputTokens.toLocaleString("zh-CN")} />
                <DetailItem label="总 Tokens" value={selected.totalTokens.toLocaleString("zh-CN")} />
                <DetailItem label="缓存读取" value={selected.cacheReadTokens.toLocaleString("zh-CN")} />
                <DetailItem label="缓存写入" value={selected.cacheCreationTokens.toLocaleString("zh-CN")} />
                <DetailItem label="Credits" value={formatCredits(selected.credits, selected.hasCredit)} />
              </div>
              <div className="space-y-2.5">
                <DetailItem label="会话 ID" value={selected.sessionId} mono />
                <DetailItem label="请求 ID" value={selected.requestId} mono />
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                总 Tokens 采用 CodeBuddy 原始 total_tokens 字段；输入 Tokens 已包含缓存读取，不重复累计。
              </p>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
