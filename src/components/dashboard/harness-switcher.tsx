"use client";

import { Bot, Briefcase, Layers, Moon, Orbit, Pi, Sparkles, SquareTerminal, Telescope, Waves, Zap, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  HARNESS_OPTIONS,
  type HarnessFilter,
  type HarnessId,
  type UsageSource,
} from "@/lib/usage";

interface HarnessSwitcherProps {
  value: HarnessFilter;
  sources: UsageSource[];
  loading: boolean;
  onChange: (harness: HarnessFilter) => void;
}

const icons: Record<"all" | HarnessId, LucideIcon> = {
  all: Layers,
  codebuddy: SquareTerminal,
  workbuddy: Briefcase,
  qoder: Bot,
  zcode: Zap,
  kcode: Moon,
  claude: Sparkles,
  codex: Telescope,
  dsh: Waves,
  antigravity: Orbit,
  pidesktop: Pi,
};

const iconStyles: Record<"all" | HarnessId, string> = {
  all: "bg-sky-500/12 text-sky-500",
  codebuddy: "bg-amber-500/12 text-amber-500",
  workbuddy: "bg-lime-500/12 text-lime-600",
  qoder: "bg-violet-500/12 text-violet-400",
  zcode: "bg-emerald-500/12 text-emerald-400",
  kcode: "bg-rose-500/12 text-rose-400",
  claude: "bg-orange-500/12 text-orange-400",
  codex: "bg-teal-500/12 text-teal-400",
  dsh: "bg-blue-500/12 text-blue-400",
  antigravity: "bg-fuchsia-500/12 text-fuchsia-400",
  pidesktop: "bg-cyan-500/12 text-cyan-400",
};

export function HarnessSwitcher({
  value,
  sources,
  loading,
  onChange,
}: HarnessSwitcherProps) {
  const items: Array<{
    id: HarnessFilter;
    label: string;
    description: string;
  }> = [
    { id: "all", label: "全部 Harness", description: "跨工具汇总" },
    ...HARNESS_OPTIONS,
  ];

  return (
    <section className="panel mb-4 p-1.5" aria-label="Harness 筛选">
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-4 xl:grid-cols-6">
        {items.map((item) => {
          const Icon = icons[item.id];
          const source = sources.find((candidate) => candidate.harness === item.id);
          const selectedSources =
            item.id === "all"
              ? sources
              : sources.filter((candidate) => candidate.harness === item.id);
          const recordCount = selectedSources.reduce(
            (sum, candidate) => sum + candidate.recordCount,
            0,
          );
          const connected = selectedSources.some((candidate) => candidate.sourceAvailable);
          const selected = value === item.id;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(item.id)}
              className={cn(
                "group flex min-w-0 items-center gap-2 rounded-[9px] px-2.5 py-2.5 text-left transition-colors sm:gap-3 sm:px-3.5",
                selected ? "bg-secondary" : "hover:bg-muted/45",
              )}
            >
              <span
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-lg sm:size-9",
                  iconStyles[item.id],
                )}
              >
                <Icon className="size-4 sm:size-[17px]" strokeWidth={1.9} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-medium sm:text-[13px]">{item.label}</span>
                  <span className="hidden rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground md:inline">
                    {loading ? "…" : recordCount.toLocaleString("zh-CN")}
                  </span>
                </span>
                <span className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground sm:text-[11px]">
                  {!loading && source && (
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        connected ? "bg-emerald-400" : "bg-zinc-500",
                      )}
                    />
                  )}
                  <span className="truncate">
                    {loading
                      ? "等待快照"
                      : item.id === "all"
                        ? `${sources.filter((candidate) => candidate.sourceAvailable).length}/${HARNESS_OPTIONS.length} 个来源可用`
                        : source
                          ? connected
                            ? "本地数据已连接"
                            : "未发现数据目录"
                          : item.description}
                  </span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
