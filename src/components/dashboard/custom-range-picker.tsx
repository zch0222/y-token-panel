"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { defaultCustomRange } from "@/lib/usage";

type Precision = "hour" | "minute";

interface CustomRangePickerProps {
  /** 当前已应用的时间段；null 时以默认窗口（今天 00 时 ～ 23 时）为草稿。 */
  value: { start: number; end: number } | null;
  onApply: (range: { start: number; end: number }) => void;
}

interface DraftRange {
  startDay: string;
  startHour: number;
  startMinute: number;
  endDay: string;
  endHour: number;
  endMinute: number;
}

const pad = (value: number) => String(value).padStart(2, "0");
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const MINUTES = Array.from({ length: 60 }, (_, minute) => minute);

function dayString(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 解析 YYYY-MM-DD；组件回读校验，拦截 2026-02-31 之类的溢出日期。 */
function parseDay(day: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const [year, month, date] = match.slice(1).map(Number);
  const parsed = new Date(year, month - 1, date);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== date
  ) {
    return null;
  }
  return parsed;
}

function draftFromRange(range: { start: number; end: number }): DraftRange {
  const startDate = new Date(range.start);
  const endDate = new Date(range.end);
  return {
    startDay: dayString(range.start),
    startHour: startDate.getHours(),
    startMinute: startDate.getMinutes(),
    endDay: dayString(range.end),
    endHour: endDate.getHours(),
    endMinute: endDate.getMinutes(),
  };
}

function draftToTimestamp(day: string, hour: number, minute: number): number | null {
  const parsed = parseDay(day);
  if (parsed === null) return null;
  parsed.setHours(hour, minute, 0, 0);
  return parsed.getTime();
}

const precisionOptions: Array<{ value: Precision; label: string }> = [
  { value: "hour", label: "小时" },
  { value: "minute", label: "分钟" },
];

/**
 * 触发器按内容自适应宽度（w-fit）并给最小宽度撑开排版：写死 px 会把「精度 小时」
 * 「00 时」这类短文本压进 SelectValue 的 line-clamp-1 里截断（字号、缩放、字体回退
 * 都会改变文本宽度）。
 */
const precisionTriggerClass = "h-8 w-fit min-w-[104px] border-border bg-card text-xs";
const unitTriggerClass = "h-8 w-fit min-w-[78px] border-border bg-card text-xs";

/**
 * 自定义时间段选择器：默认小时精度（分钟下拉隐藏），切到分钟后可选分钟；
 * 草稿本地维护，点「应用」才提交，避免逐次下拉触发查询。
 */
export function CustomRangePicker({ value, onApply }: CustomRangePickerProps) {
  const initial = value ?? defaultCustomRange();
  const [draft, setDraft] = useState<DraftRange>(() => draftFromRange(initial));
  // 上次应用的值带分钟则默认分钟精度，否则小时精度。
  const [precision, setPrecision] = useState<Precision>(() =>
    value !== null && (new Date(value.start).getMinutes() !== 0 || new Date(value.end).getMinutes() !== 0)
      ? "minute"
      : "hour",
  );

  const start = draftToTimestamp(draft.startDay, draft.startHour, draft.startMinute);
  const end = draftToTimestamp(draft.endDay, draft.endHour, draft.endMinute);
  const missingDate = start === null || end === null;
  const invalidSpan = !missingDate && start !== null && end !== null && start >= end;

  const changePrecision = (next: Precision) => {
    setPrecision(next);
    // 收回小时精度时把分钟归零，保证应用值与所选精度一致。
    if (next === "hour") {
      setDraft((previous) => ({ ...previous, startMinute: 0, endMinute: 0 }));
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border/70 bg-card/60 px-2 py-1.5">
      <Select value={precision} onValueChange={(next) => changePrecision((next as Precision | null) ?? "hour")}>
        <SelectTrigger size="sm" className={precisionTriggerClass} aria-label="时间精度">
          <span className="mr-auto text-muted-foreground">精度</span>
          <SelectValue>{precisionOptions.find((option) => option.value === precision)?.label}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {precisionOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <span className="text-xs text-muted-foreground">开始</span>
      <input
        type="date"
        aria-label="开始日期"
        value={draft.startDay}
        onChange={(event) => setDraft((previous) => ({ ...previous, startDay: event.target.value }))}
        className="h-8 rounded-lg border border-border bg-card px-2 text-xs outline-none focus-visible:border-ring"
      />
      <Select
        value={draft.startHour}
        onValueChange={(hour) => setDraft((previous) => ({ ...previous, startHour: (hour as number | null) ?? 0 }))}
      >
        <SelectTrigger size="sm" className={unitTriggerClass} aria-label="开始小时">
          <SelectValue>{pad(draft.startHour)} 时</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {HOURS.map((hour) => (
            <SelectItem key={hour} value={hour}>{pad(hour)} 时</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {precision === "minute" && (
        <Select
          value={draft.startMinute}
          onValueChange={(minute) => setDraft((previous) => ({ ...previous, startMinute: (minute as number | null) ?? 0 }))}
        >
          <SelectTrigger size="sm" className={unitTriggerClass} aria-label="开始分钟">
            <SelectValue>{pad(draft.startMinute)} 分</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {MINUTES.map((minute) => (
              <SelectItem key={minute} value={minute}>{pad(minute)} 分</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <span className="text-xs text-muted-foreground">～</span>

      <span className="text-xs text-muted-foreground">结束</span>
      <input
        type="date"
        aria-label="结束日期"
        value={draft.endDay}
        onChange={(event) => setDraft((previous) => ({ ...previous, endDay: event.target.value }))}
        className="h-8 rounded-lg border border-border bg-card px-2 text-xs outline-none focus-visible:border-ring"
      />
      <Select
        value={draft.endHour}
        onValueChange={(hour) => setDraft((previous) => ({ ...previous, endHour: (hour as number | null) ?? 0 }))}
      >
        <SelectTrigger size="sm" className={unitTriggerClass} aria-label="结束小时">
          <SelectValue>{pad(draft.endHour)} 时</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {HOURS.map((hour) => (
            <SelectItem key={hour} value={hour}>{pad(hour)} 时</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {precision === "minute" && (
        <Select
          value={draft.endMinute}
          onValueChange={(minute) => setDraft((previous) => ({ ...previous, endMinute: (minute as number | null) ?? 0 }))}
        >
          <SelectTrigger size="sm" className={unitTriggerClass} aria-label="结束分钟">
            <SelectValue>{pad(draft.endMinute)} 分</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {MINUTES.map((minute) => (
              <SelectItem key={minute} value={minute}>{pad(minute)} 分</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      <Button
        type="button"
        size="sm"
        className="h-8 px-3 text-xs"
        disabled={missingDate || invalidSpan}
        onClick={() => {
          if (start === null || end === null || start >= end) return;
          onApply({ start, end });
        }}
      >
        应用
      </Button>
      {(missingDate || invalidSpan) && (
        <span className="text-xs text-red-400">
          {missingDate ? "请选择有效的开始/结束日期" : "结束时间需晚于开始时间"}
        </span>
      )}
    </div>
  );
}
