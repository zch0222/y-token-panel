"use client";

import {
  ChartColumn,
  Database,
  FolderKanban,
  LayoutDashboard,
  ListChecks,
  Boxes,
  Blocks,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  formatCompact,
  formatCredits,
  type UsageSummary,
} from "@/lib/usage";

export type DashboardView = "overview" | "logs" | "models" | "projects" | "harnesses";

interface SidebarProps {
  view: DashboardView;
  onViewChange: (view: DashboardView) => void;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  today: UsageSummary;
  connected: boolean;
}

const navigation = [
  { id: "overview" as const, label: "用量概览", icon: LayoutDashboard },
  { id: "logs" as const, label: "请求日志", icon: ListChecks },
  { id: "models" as const, label: "模型分析", icon: Boxes },
  { id: "harnesses" as const, label: "Harness 对比", icon: Blocks },
  { id: "projects" as const, label: "项目统计", icon: FolderKanban },
];

export function Sidebar({
  view,
  onViewChange,
  collapsed,
  onCollapsedChange,
  today,
  connected,
}: SidebarProps) {
  return (
    <aside
      className={cn(
        "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-200 lg:flex",
        collapsed ? "w-[76px]" : "w-[224px]",
      )}
    >
      <div
        className={cn(
          "flex h-[72px] items-center border-b border-border/70",
          collapsed ? "justify-center px-3" : "gap-3 px-5",
        )}
      >
        <div className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-br from-amber-300 via-orange-400 to-rose-500 text-white shadow-[0_5px_18px_rgba(244,146,64,0.2)]">
          <ChartColumn className="size-5" strokeWidth={2.2} />
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <div className="text-[15px] font-semibold tracking-[0.12em]">Y TOKEN</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">AI Harness Monitor</div>
          </div>
        )}
      </div>

      <div className={cn("flex-1 py-5", collapsed ? "px-3" : "px-3")}>
        {!collapsed && (
          <div className="mb-2 px-3 text-[11px] font-medium tracking-wider text-muted-foreground/70">
            工作台
          </div>
        )}
        <nav className="space-y-1" aria-label="主导航">
          {navigation.map((item) => {
            const Icon = item.icon;
            const active = view === item.id;
            return (
              <button
                key={item.id}
                type="button"
                title={collapsed ? item.label : undefined}
                aria-current={active ? "page" : undefined}
                onClick={() => onViewChange(item.id)}
                className={cn(
                  "flex h-10 w-full items-center rounded-lg text-sm transition-colors",
                  collapsed ? "justify-center" : "gap-3 px-3",
                  active
                    ? "bg-secondary font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                <Icon className={cn("size-[17px]", active && "text-primary")} />
                {!collapsed && <span>{item.label}</span>}
              </button>
            );
          })}
        </nav>
      </div>

      <div className={cn("border-t border-border/70", collapsed ? "p-3" : "p-4")}>
        {!collapsed ? (
          <div className="mb-4 rounded-xl border border-border/80 bg-card/70 p-3.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>今日消耗</span>
              <span className="text-[10px] text-muted-foreground/70">Credits</span>
            </div>
            <div className="mt-2 text-xl font-semibold tabular-nums">
              {formatCredits(today.credits, today.hasCredit)}
            </div>
            <div className="mt-1.5 text-[11px] text-muted-foreground">
              {today.hasTokens ? `${formatCompact(today.tokens)} Tokens · ` : ""}
              {today.requests} 次请求
            </div>
          </div>
        ) : (
          <div className="mb-3 flex justify-center" title="本地数据源">
            <Database className="size-4 text-muted-foreground" />
          </div>
        )}
        <div
          className={cn(
            "flex items-center",
            collapsed ? "justify-center" : "justify-between gap-2 px-1",
          )}
        >
          {!collapsed && (
            <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  connected ? "bg-emerald-400" : "bg-zinc-500",
                )}
              />
              <span className="truncate">{connected ? "本地数据已连接" : "等待数据源"}</span>
            </div>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
            onClick={() => onCollapsedChange(!collapsed)}
            className="text-muted-foreground"
          >
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </Button>
        </div>
      </div>
    </aside>
  );
}
