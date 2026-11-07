import { cn } from "@/lib/utils";
import { formatCredits, type CreditBreakdownItem } from "@/lib/usage";

/** 不同 Harness 的 Credits 单位不同，分列展示而不是相加。 */
export function CreditBreakdown({
  items,
  className,
}: {
  items: CreditBreakdownItem[];
  className?: string;
}) {
  return (
    <div className={cn("space-y-1 tabular-nums", className)}>
      {items.map((item) => (
        <div key={item.harness} className="flex items-baseline justify-between gap-3">
          <span className="truncate text-[11px] font-normal text-muted-foreground">{item.label}</span>
          <span>{formatCredits(item.credits)}</span>
        </div>
      ))}
    </div>
  );
}
