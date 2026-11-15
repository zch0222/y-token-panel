import { describe, expect, it } from "vitest";
import {
  buildTrend,
  createTrendPoints,
  defaultCustomRange,
  filterUsageRecords,
  formatCustomRangeLabel,
  getRangeBounds,
  getTrendGranularity,
  groupRecords,
  resolveRangeBounds,
  summarizeRecords,
  type UsageRecord,
} from "@/lib/usage";

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: "codebuddy:s1:r1",
    requestId: "r1",
    sessionId: "s1",
    harness: "codebuddy",
    project: "demo",
    model: "kimi-k3.1-pro",
    provider: "Moonshot AI",
    timestamp: 1_794_000_000_000,
    inputTokens: 1000,
    outputTokens: 400,
    cacheReadTokens: 800,
    cacheCreationTokens: 0,
    totalTokens: 1400,
    inputTokenSemantics: "total",
    hasTokenUsage: true,
    credits: 1,
    hasCredit: true,
    status: "success",
    ...overrides,
  };
}

describe("summarizeRecords 速度聚合", () => {
  it("速度分子分母只累加满足门槛的请求", () => {
    const summary = summarizeRecords([
      record({ id: "a", outputTokens: 400, estimatedDurationMs: 2000 }), // 计入
      record({ id: "b", outputTokens: 100, estimatedDurationMs: 9000 }), // 输出不足
      record({ id: "c", outputTokens: 500, estimatedDurationMs: 400 }), // 耗时不足
      record({ id: "d", outputTokens: 600, estimatedDurationMs: 3000 }), // 计入
      record({ id: "e", outputTokens: 700 }), // 无耗时（Qoder 形态）
    ]);
    expect(summary.speedOutputTokens).toBe(1000);
    expect(summary.speedDurationMs).toBe(5000);
  });

  it("没有可估算请求时速度字段为零", () => {
    const summary = summarizeRecords([record({ estimatedDurationMs: undefined }), record({ id: "x" })]);
    expect(summary.speedOutputTokens).toBe(0);
    expect(summary.speedDurationMs).toBe(0);
  });

  it("空记录集仍输出完整的速度字段", () => {
    const summary = summarizeRecords([]);
    expect(summary.requests).toBe(0);
    expect(summary.speedOutputTokens).toBe(0);
    expect(summary.speedDurationMs).toBe(0);
  });
});

describe("groupRecords 携带速度字段", () => {
  it("分组统计继承速度分子分母", () => {
    const stats = groupRecords(
      [
        record({ model: "kimi", outputTokens: 400, estimatedDurationMs: 1000 }),
        record({ model: "kimi", outputTokens: 600, estimatedDurationMs: 2000 }),
        record({ model: "deepseek", outputTokens: 250, estimatedDurationMs: 5000 }),
        record({ id: "q1", harness: "qoder", model: "qoder-coder", provider: "Qoder", outputTokens: 900 }),
      ],
      "model",
    );
    const byKey = new Map(stats.map((stat) => [stat.key, stat]));
    expect(byKey.get("kimi")).toMatchObject({
      speedOutputTokens: 1000,
      speedDurationMs: 3000,
    });
    expect(byKey.get("deepseek")).toMatchObject({
      speedOutputTokens: 250,
      speedDurationMs: 5000,
    });
    expect(byKey.get("qoder-coder")).toMatchObject({
      speedOutputTokens: 0,
      speedDurationMs: 0,
    });
  });
});

describe("filterUsageRecords 保留速度字段", () => {
  it("过滤后的记录仍带估算耗时", () => {
    const filtered = filterUsageRecords(
      [
        record({ estimatedDurationMs: 2500 }),
        record({ id: "old", timestamp: 1_700_000_000_000 }),
      ],
      "today",
      "all",
      "all",
      "all",
      new Date(1_794_000_000_000),
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0].estimatedDurationMs).toBe(2500);
  });
});

describe("自定义时间段", () => {
  const now = new Date(2026, 10, 8, 15, 30, 0);
  const custom = {
    start: new Date(2026, 10, 8, 9, 15).getTime(),
    end: new Date(2026, 10, 8, 12, 45).getTime(),
  };

  it("resolveRangeBounds：custom 原样返回边界，缺失时抛错，预设口径不变", () => {
    expect(resolveRangeBounds({ range: "custom", start: 100, end: 200 }, now)).toEqual({
      start: 100,
      end: 200,
    });
    expect(() => resolveRangeBounds({ range: "custom" }, now)).toThrow("自定义时间段缺少 start/end");
    expect(resolveRangeBounds({ range: "today" }, now)).toEqual(getRangeBounds("today", now));
    expect(resolveRangeBounds({ range: "all" }, now)).toEqual({ start: 0, end: Number.POSITIVE_INFINITY });
  });

  it("getTrendGranularity：预设保持原口径，custom 按跨度分档", () => {
    expect(getTrendGranularity("today")).toBe("hour");
    expect(getTrendGranularity("yesterday")).toBe("hour");
    expect(getTrendGranularity("7d")).toBe("day");
    expect(getTrendGranularity("all")).toBe("day");
    const at = (day: number, hour: number, minute = 0) =>
      new Date(2026, 10, day, hour, minute).getTime();
    expect(getTrendGranularity("custom", at(8, 0), at(8, 5, 59))).toBe("minute");
    expect(getTrendGranularity("custom", at(8, 0), at(8, 6))).toBe("minute");
    expect(getTrendGranularity("custom", at(8, 0), at(8, 6, 1))).toBe("hour");
    expect(getTrendGranularity("custom", at(1, 0), at(8, 0))).toBe("hour");
    expect(getTrendGranularity("custom", at(1, 0), at(8, 0, 1))).toBe("day");
    // 边界缺省时安全回退到日期粒度（正常链路由解析层 400 拦截）。
    expect(getTrendGranularity("custom")).toBe("day");
  });

  it("createTrendPoints：custom 分钟桶按分钟铺满并对齐到分钟边界", () => {
    const points = createTrendPoints(
      "custom",
      now,
      [],
      { start: new Date(2026, 10, 8, 10, 2, 30).getTime(), end: new Date(2026, 10, 8, 10, 4).getTime() },
    );
    expect(Array.from(points.keys())).toEqual([
      "2026-11-08 10:02",
      "2026-11-08 10:03",
      "2026-11-08 10:04",
    ]);
    const first = points.get("2026-11-08 10:02");
    expect(first).toMatchObject({ label: "10:02", fullLabel: "2026-11-08 10:02–10:03", tokens: 0 });
  });

  it("createTrendPoints：custom 小时桶同天只显示钟点，跨天带日期前缀", () => {
    // 注意跨度需 > 6 小时才会落在小时粒度档。
    const sameDay = createTrendPoints(
      "custom",
      now,
      [],
      { start: new Date(2026, 10, 8, 8, 0).getTime(), end: new Date(2026, 10, 8, 15, 0).getTime() },
    );
    expect(Array.from(sameDay.keys())).toEqual([
      "2026-11-08 08",
      "2026-11-08 09",
      "2026-11-08 10",
      "2026-11-08 11",
      "2026-11-08 12",
      "2026-11-08 13",
      "2026-11-08 14",
      "2026-11-08 15",
    ]);
    expect(sameDay.get("2026-11-08 08")).toMatchObject({
      label: "08:00",
      fullLabel: "2026-11-08 08:00–09:00",
    });

    const crossDay = createTrendPoints(
      "custom",
      now,
      [],
      { start: new Date(2026, 10, 7, 18, 0).getTime(), end: new Date(2026, 10, 8, 1, 0).getTime() },
    );
    expect(Array.from(crossDay.keys())).toEqual([
      "2026-11-07 18",
      "2026-11-07 19",
      "2026-11-07 20",
      "2026-11-07 21",
      "2026-11-07 22",
      "2026-11-07 23",
      "2026-11-08 00",
      "2026-11-08 01",
    ]);
    expect(crossDay.get("2026-11-07 18")?.label).toBe("11-07 18:00");
    expect(crossDay.get("2026-11-08 01")?.label).toBe("11-08 01:00");
  });

  it("createTrendPoints：custom 按日铺桶，超长跨度只为出现过的日期建桶", () => {
    // 跨度需 > 7 天才会落在日期粒度档。
    const days = createTrendPoints(
      "custom",
      now,
      [],
      { start: new Date(2026, 9, 28, 12, 0).getTime(), end: new Date(2026, 10, 6, 6, 0).getTime() },
    );
    expect(Array.from(days.keys())).toEqual([
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
    ]);
    expect(days.get("2026-10-28")).toMatchObject({ label: "10/28", fullLabel: "2026-10-28" });

    // 397 天跨度：只为出现过的日期建桶（与 all 一致）。
    const longSpan = createTrendPoints(
      "custom",
      now,
      ["2025-12-31", "2026-11-08"],
      { start: new Date(2025, 9, 8, 0, 0).getTime(), end: new Date(2026, 10, 8, 0, 0).getTime() },
    );
    expect(Array.from(longSpan.keys())).toEqual(["2025-12-31", "2026-11-08"]);
  });

  it("createTrendPoints：custom 边界缺省返回空脚手架", () => {
    expect(createTrendPoints("custom", now, []).size).toBe(0);
  });

  it("buildTrend：custom 分钟桶把记录按本地时间分桶", () => {
    const records = [
      record({ id: "a", timestamp: new Date(2026, 10, 8, 10, 2, 15).getTime() }),
      record({ id: "b", timestamp: new Date(2026, 10, 8, 10, 2, 45).getTime() }),
      record({ id: "c", timestamp: new Date(2026, 10, 8, 10, 4).getTime() }),
      // 窗口之外的记录不进任何桶。
      record({ id: "out", timestamp: new Date(2026, 10, 8, 10, 5).getTime() }),
    ];
    const trend = buildTrend(records, "custom", now, {
      start: new Date(2026, 10, 8, 10, 2).getTime(),
      end: new Date(2026, 10, 8, 10, 4).getTime(),
    });
    expect(trend.map((point) => [point.key, point.requests])).toEqual([
      ["2026-11-08 10:02", 2],
      ["2026-11-08 10:03", 0],
      ["2026-11-08 10:04", 1],
    ]);
  });

  it("filterUsageRecords：custom 按闭区间过滤", () => {
    const inRange = record({ id: "in", timestamp: custom.start });
    const outOfRange = record({ id: "out", timestamp: custom.end + 1 });
    expect(
      filterUsageRecords([inRange, outOfRange], "custom", "all", "all", "all", now, "all", "all", custom),
    ).toEqual([inRange]);
    expect(() =>
      filterUsageRecords([inRange], "custom", "all", "all", "all", now, "all", "all"),
    ).toThrow("自定义时间段缺少 start/end");
  });

  it("defaultCustomRange 与 formatCustomRangeLabel", () => {
    const range = defaultCustomRange(new Date(2026, 10, 8, 15, 30));
    expect(range.start).toBe(new Date(2026, 10, 8, 0, 0).getTime());
    expect(range.end).toBe(new Date(2026, 10, 8, 23, 0).getTime());
    expect(
      formatCustomRangeLabel(new Date(2026, 10, 15, 10, 5).getTime(), new Date(2026, 10, 15, 11, 30).getTime()),
    ).toBe("11-15 10:05–11:30");
  });
});
