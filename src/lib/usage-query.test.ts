import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTrend,
  filterUsageRecords,
  groupRecords,
  summarizeRecords,
  type GroupDimension,
  type HarnessId,
  type UsageBucketStat,
  type UsageQueryFilters,
  type UsageRecord,
  type UsageResponse,
  type UsageSource,
} from "@/lib/usage";
import {
  DEFAULT_RECORDS_PAGE_SIZE,
  MAX_RECORDS_PAGE_SIZE,
  parseUsageQueryParams,
} from "@/lib/usage-query";
import { UsageStore } from "@/lib/usage-store";

const stores: UsageStore[] = [];
const directories: string[] = [];

function openStore(): UsageStore {
  const directory = mkdtempSync(path.join(tmpdir(), "y-token-usage-query-"));
  directories.push(directory);
  const store = new UsageStore(path.join(directory, "usage.sqlite"));
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length) stores.pop()?.close();
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

/** 固定种子 LCG：随机化数据可复现，失败时能定位。 */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const HARNESS_IDS: HarnessId[] = [
  "claude",
  "codebuddy",
  "qoder",
  "dsh",
  "codex",
  "zcode",
  "kcode",
  "workbuddy",
];
const PROJECTS = ["project-alpha", "project-beta", "项目中文"];
const PROVIDERS = ["Anthropic", "OpenAI", "DeepSeek"];
const MODELS = ["claude-sonnet", "gpt-5", "deepseek-v3"];

function generateRecords(count: number, seed: number): UsageRecord[] {
  const random = createRandom(seed);
  const day = 24 * 60 * 60 * 1000;
  const now = new Date(2026, 10, 8, 15, 30, 0).getTime();
  const records: UsageRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const harness = HARNESS_IDS[Math.floor(random() * HARNESS_IDS.length)];
    const hasCredit = random() < 0.5;
    const billableRoll = random();
    const billable =
      billableRoll < 0.2 ? undefined : billableRoll < 0.5 ? false : true;
    // 时间戳覆盖今天、昨天、近 7/30 天与更早的历史日期。
    const timestamp =
      now - Math.floor(random() * 40 * day) - Math.floor(random() * 3_600_000);
    const inputTokens = Math.floor(random() * 5000);
    const outputTokens = Math.floor(random() * 400);
    const cacheRead = Math.floor(random() * 3000);
    const cacheCreation = Math.floor(random() * 2000);
    records.push({
      id: `${harness}:record-${index}`,
      requestId: `request-${index}`,
      sessionId: `session-${index % 7}`,
      harness,
      project: PROJECTS[Math.floor(random() * PROJECTS.length)],
      model: MODELS[Math.floor(random() * MODELS.length)],
      provider: PROVIDERS[Math.floor(random() * PROVIDERS.length)],
      timestamp,
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheRead,
      cacheCreationTokens: cacheCreation,
      totalTokens: inputTokens + outputTokens + cacheRead + cacheCreation,
      inputTokenSemantics: random() < 0.5 ? "fresh" : "total",
      hasTokenUsage: random() < 0.9,
      credits: hasCredit ? Number((random() * 3).toFixed(4)) : 0,
      hasCredit,
      ...(billable === false ? { billable, reportedCredits: Number((random() * 2).toFixed(4)) } : billable === true ? { billable } : {}),
      ...(random() < 0.3 ? { contextUsageRatio: random() } : {}),
      ...(random() < 0.7 ? { estimatedDurationMs: Math.floor(random() * 8000) + 1 } : {}),
      status: random() < 0.95 ? "success" : "error",
    });
  }
  return records;
}

function sourceOf(harness: HarnessId, recordCount: number): UsageSource {
  return {
    harness,
    recordCount,
    scannedFiles: 2,
    skippedFiles: harness === "dsh" ? 1 : 0,
    source: `/tmp/${harness}`,
    sourceAvailable: true,
  };
}

function commitRecords(store: UsageStore, records: UsageRecord[]): void {
  const counts = new Map<HarnessId, number>();
  for (const record of records) counts.set(record.harness, (counts.get(record.harness) ?? 0) + 1);
  const usage: UsageResponse = {
    records,
    sources: Array.from(counts, ([harness, recordCount]) => sourceOf(harness, recordCount)),
    scannedFiles: records.length,
    skippedFiles: 1,
    syncedAt: new Date(2026, 10, 8, 15, 31, 0).getTime(),
  };
  store.commitSnapshot(usage, usage.syncedAt);
}

/** SQL 聚合与 JS 管线（filterUsageRecords + summarizeRecords 等）逐字段对比。 */
function expectCloseSummary(
  actual: ReturnType<typeof summarizeRecords>,
  expected: ReturnType<typeof summarizeRecords>,
): void {
  expect(actual.requests).toBe(expected.requests);
  expect(actual.tokens).toBe(expected.tokens);
  expect(actual.inputTokens).toBe(expected.inputTokens);
  expect(actual.outputTokens).toBe(expected.outputTokens);
  expect(actual.cacheReadTokens).toBe(expected.cacheReadTokens);
  expect(actual.cacheableInputTokens).toBe(expected.cacheableInputTokens);
  expect(actual.hasTokens).toBe(expected.hasTokens);
  expect(actual.hasCredit).toBe(expected.hasCredit);
  expect(actual.mixedCreditUnits).toBe(expected.mixedCreditUnits);
  expect(actual.unbilledCredits).toBeCloseTo(expected.unbilledCredits, 8);
  expect(actual.credits).toBeCloseTo(expected.credits, 8);
  expect(actual.speedOutputTokens).toBe(expected.speedOutputTokens);
  expect(actual.speedDurationMs).toBeCloseTo(expected.speedDurationMs, 6);
  expect(actual.cacheRate).toBeCloseTo(expected.cacheRate, 12);
  expect(actual.successRate).toBeCloseTo(expected.successRate, 12);
  expect(actual.creditsByHarness.map((item) => item.harness)).toEqual(
    expected.creditsByHarness.map((item) => item.harness),
  );
  for (let index = 0; index < expected.creditsByHarness.length; index += 1) {
    expect(actual.creditsByHarness[index].credits).toBeCloseTo(
      expected.creditsByHarness[index].credits,
      8,
    );
  }
}

const FILTER_CASES: UsageQueryFilters[] = [
  { range: "today", harness: "all", project: "all", provider: "all", model: "all", billing: "all" },
  { range: "yesterday", harness: "all", project: "all", provider: "all", model: "all", billing: "all" },
  { range: "7d", harness: "all", project: "all", provider: "all", model: "all", billing: "all" },
  { range: "30d", harness: "all", project: "all", provider: "all", model: "all", billing: "all" },
  { range: "all", harness: "all", project: "all", provider: "all", model: "all", billing: "all" },
  { range: "today", harness: "claude", project: "all", provider: "all", model: "all", billing: "all" },
  { range: "7d", harness: "qoder", project: "project-alpha", provider: "OpenAI", model: "gpt-5", billing: "billable" },
  { range: "all", harness: "all", project: "项目中文", provider: "all", model: "all", billing: "unbilled" },
  { range: "30d", harness: "dsh", project: "all", provider: "DeepSeek", model: "all", billing: "all" },
  // custom 三档粒度：≤6h 分钟、≤7d 小时（跨午夜）、更长按日。
  {
    range: "custom",
    start: new Date(2026, 10, 8, 9, 0).getTime(),
    end: new Date(2026, 10, 8, 12, 30).getTime(),
    harness: "all", project: "all", provider: "all", model: "all", billing: "all",
  },
  {
    range: "custom",
    start: new Date(2026, 10, 7, 20, 0).getTime(),
    end: new Date(2026, 10, 8, 14, 0).getTime(),
    harness: "claude", project: "all", provider: "all", model: "all", billing: "all",
  },
  {
    range: "custom",
    start: new Date(2026, 9, 10, 0, 0).getTime(),
    end: new Date(2026, 10, 6, 23, 0).getTime(),
    harness: "all", project: "all", provider: "all", model: "all", billing: "unbilled",
  },
];


function stripCostFields(record: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!record) return record;
  const core = { ...record };
  for (const key of [
    "pricingModel", "hasCost", "inputCostUsd", "outputCostUsd",
    "cacheReadCostUsd", "cacheCreationCostUsd", "totalCostUsd",
  ]) {
    delete core[key];
  }
  return core;
}

describe("UsageStore 聚合查询与 JS 口径一致性", () => {
  it.each(FILTER_CASES.map((filters) => [JSON.stringify(filters), filters] as const))(
    "筛选 %s 的汇总、趋势与分组与 JS 全量管线一致",
    (_name, filters) => {
      const store = openStore();
      const records = generateRecords(400, 20261108);
      commitRecords(store, records);
      const now = new Date(2026, 10, 8, 15, 30, 0);
      const view = store.queryView(filters, now);

      expect(view.snapshotAvailable).toBe(true);
      const custom = { start: filters.start, end: filters.end };
      const expectedRecords = filterUsageRecords(
        records,
        filters.range,
        filters.project,
        filters.provider,
        filters.model,
        now,
        filters.harness,
        filters.billing,
        custom,
      );
      expect(view.filteredCount).toBe(expectedRecords.length);
      expectCloseSummary(view.summary, summarizeRecords(expectedRecords));

      // 侧栏今日消耗只按 Harness 过滤。
      const expectedToday = filterUsageRecords(
        records,
        "today",
        "all",
        "all",
        "all",
        now,
        filters.harness,
      );
      expectCloseSummary(view.todaySummary, summarizeRecords(expectedToday));

      const expectedTrend = buildTrend(expectedRecords, filters.range, now, custom);
      expect(view.trend.length).toBe(expectedTrend.length);
      for (let index = 0; index < expectedTrend.length; index += 1) {
        expect(view.trend[index].key).toBe(expectedTrend[index].key);
        expect(view.trend[index].label).toBe(expectedTrend[index].label);
        expect(view.trend[index].fullLabel).toBe(expectedTrend[index].fullLabel);
        expect(view.trend[index].requests).toBe(expectedTrend[index].requests);
        expect(view.trend[index].tokens).toBe(expectedTrend[index].tokens);
        expect(view.trend[index].credits).toBeCloseTo(expectedTrend[index].credits, 8);
        expect(view.trend[index].unbilledCredits).toBeCloseTo(expectedTrend[index].unbilledCredits, 8);
        expect(view.trend[index].inputTokens).toBe(expectedTrend[index].inputTokens);
        expect(view.trend[index].cacheReadTokens).toBe(expectedTrend[index].cacheReadTokens);
        expect(view.trend[index].cacheableInputTokens).toBe(expectedTrend[index].cacheableInputTokens);
        expect(view.trend[index].cacheRate).toBeCloseTo(expectedTrend[index].cacheRate, 12);
      }

      for (const dimension of ["harness", "provider", "model", "project"] as GroupDimension[]) {
        const expectedGroups = groupRecords(expectedRecords, dimension);
        const actualGroups = view.groups[dimension];
        expect(actualGroups.map((group) => group.key)).toEqual(
          expectedGroups.map((group) => group.key),
        );
        for (let index = 0; index < expectedGroups.length; index += 1) {
          expect(actualGroups[index].lastUsed).toBe(expectedGroups[index].lastUsed);
          expectCloseSummary(actualGroups[index], expectedGroups[index]);
        }
      }

      // facet 与前端口径一致：只按 Harness（模型另加供应商）过滤，不随范围收窄。
      const harnessRecords = records.filter(
        (record) => filters.harness === "all" || record.harness === filters.harness,
      );
      expect(view.facets.projects).toEqual(
        Array.from(new Set(harnessRecords.map((record) => record.project))).sort(),
      );
      expect(view.facets.providers).toEqual(
        Array.from(new Set(harnessRecords.map((record) => record.provider))).sort(),
      );
      expect(view.facets.models).toEqual(
        Array.from(
          new Set(
            harnessRecords
              .filter((record) => filters.provider === "all" || record.provider === filters.provider)
              .map((record) => record.model),
          ),
        ).sort(),
      );
    },
  );

  it("跨午夜后同一筛选以新 now 计算得到纠正后的“今天”口径", () => {
    const store = openStore();
    const beforeMidnight = new Date(2026, 10, 8, 23, 59, 0);
    const afterMidnight = new Date(2026, 10, 9, 0, 1, 0);
    // 11-07 与 11-08 各一条。
    const records = [
      ...generateRecords(1, 1).map((record, index) => ({
        ...record,
        id: `midnight-a-${index}`,
        timestamp: new Date(2026, 10, 7, 12, 0, 0).getTime(),
      })),
      ...generateRecords(2, 2).map((record, index) => ({
        ...record,
        id: `midnight-b-${index}`,
        timestamp: new Date(2026, 10, 8, 12, 0, 0).getTime(),
      })),
    ];
    commitRecords(store, records);
    const filters: UsageQueryFilters = {
      range: "today",
      harness: "all",
      project: "all",
      provider: "all",
      model: "all",
      billing: "all",
    };
    expect(store.queryView(filters, beforeMidnight).summary.requests).toBe(2);
    const after = store.queryView(filters, afterMidnight);
    expect(after.summary.requests).toBe(0);
    // “昨天”在跨午夜后正好覆盖 11-08。
    expect(store.queryView({ ...filters, range: "yesterday" }, afterMidnight).summary.requests).toBe(2);
  });

  it("custom 时间段跨午夜按分钟分桶，SQL 分桶与 JS 管线逐字段一致", () => {
    const store = openStore();
    const now = new Date(2026, 10, 8, 15, 30, 0);
    const custom = {
      start: new Date(2026, 10, 7, 22, 0).getTime(),
      end: new Date(2026, 10, 8, 1, 0).getTime(),
    };
    const records = [
      ...generateRecords(1, 11).map((record, index) => ({
        ...record,
        id: `minute-a-${index}`,
        timestamp: new Date(2026, 10, 7, 23, 58, 20).getTime(),
      })),
      ...generateRecords(1, 12).map((record, index) => ({
        ...record,
        id: `minute-b-${index}`,
        timestamp: new Date(2026, 10, 8, 0, 2, 40).getTime(),
      })),
      // 窗口外：22:00 前与 01:00 后各一条，不应计入。
      ...generateRecords(1, 13).map((record, index) => ({
        ...record,
        id: `minute-out-early-${index}`,
        timestamp: new Date(2026, 10, 7, 21, 59, 0).getTime(),
      })),
      ...generateRecords(1, 14).map((record, index) => ({
        ...record,
        id: `minute-out-late-${index}`,
        timestamp: new Date(2026, 10, 8, 1, 0, 1).getTime(),
      })),
    ];
    commitRecords(store, records);
    const filters: UsageQueryFilters = {
      range: "custom",
      start: custom.start,
      end: custom.end,
      harness: "all",
      project: "all",
      provider: "all",
      model: "all",
      billing: "all",
    };
    const view = store.queryView(filters, now);

    expect(view.filteredCount).toBe(2);
    // 22:00 ～ 01:00 共 181 个分钟桶；边界记录落在 23:58 与 00:02 桶。
    const byKey = new Map(view.trend.map((point) => [point.key, point.requests]));
    expect(view.trend.length).toBe(181);
    expect(view.trend[0]).toMatchObject({ key: "2026-11-07 22:00", label: "22:00" });
    expect(view.trend[0].fullLabel).toBe("2026-11-07 22:00–22:01");
    // 23:59 桶跨天：右侧带完整日期。
    expect(byKey.has("2026-11-07 23:59")).toBe(true);
    expect(view.trend.find((point) => point.key === "2026-11-07 23:59")?.fullLabel).toBe(
      "2026-11-07 23:59–2026-11-08 00:00",
    );
    expect(byKey.get("2026-11-07 23:58")).toBe(1);
    expect(byKey.get("2026-11-08 00:02")).toBe(1);
    expect(Array.from(byKey.values()).reduce((sum, count) => sum + count, 0)).toBe(2);

    // 与 JS 管线对拍。
    const expectedRecords = filterUsageRecords(
      records,
      "custom",
      "all",
      "all",
      "all",
      now,
      "all",
      "all",
      custom,
    );
    const expectedTrend = buildTrend(expectedRecords, "custom", now, custom);
    expect(view.trend.length).toBe(expectedTrend.length);
    for (let index = 0; index < expectedTrend.length; index += 1) {
      expect(view.trend[index]).toMatchObject({
        key: expectedTrend[index].key,
        label: expectedTrend[index].label,
        fullLabel: expectedTrend[index].fullLabel,
        requests: expectedTrend[index].requests,
        tokens: expectedTrend[index].tokens,
      });
    }
  });

  it("分页覆盖全部筛选记录且无重复，越界页码与页大小被钳制", () => {
    const store = openStore();
    const records = generateRecords(53, 77);
    commitRecords(store, records);
    const filters: UsageQueryFilters = {
      range: "all",
      harness: "all",
      project: "all",
      provider: "all",
      model: "all",
      billing: "all",
    };
    const now = new Date(2026, 10, 8, 15, 30, 0);
    const expected = filterUsageRecords(records, "all", "all", "all", "all", now, "all", "all");

    const seen: string[] = [];
    let page = 0;
    for (;;) {
      const result = store.queryRecordsPage(filters, page, 10, now);
      expect(result.pageSize).toBe(10);
      expect(result.page).toBe(page);
      // 时间戳按降序排列。
      const timestamps = result.records.map((record) => record.timestamp);
      expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);
      seen.push(...result.records.map((record) => `${record.harness}:${record.id}`));
      if ((page + 1) * 10 >= result.total) break;
      page += 1;
    }
    expect(seen.length).toBe(expected.length);
    expect(new Set(seen).size).toBe(expected.length);
    expect(new Set(seen)).toEqual(new Set(expected.map((record) => `${record.harness}:${record.id}`)));

    const beyond = store.queryRecordsPage(filters, 999, 10, now);
    expect(beyond.page).toBe(Math.max(0, Math.ceil(expected.length / 10) - 1));
    const huge = store.queryRecordsPage(filters, 0, 100_000, now);
    expect(huge.records.length).toBe(expected.length);
  });

  it("单条详情按 harness 与 record ID 查询", () => {
    const store = openStore();
    const records = generateRecords(5, 9);
    // 造一个跨 harness 同 ID 的记录，验证复合键。
    const target = { ...records[0], harness: "claude" as HarnessId, id: "claude:shared-id" };
    records[0] = target;
    records.push({ ...target, harness: "codebuddy", id: "claude:shared-id" });
    commitRecords(store, records);
    const found = store.queryRecordDetail(target.harness, target.id);
    expect(stripCostFields(found as unknown as Record<string, unknown>)).toEqual(target);
    expect(stripCostFields(store.queryRecordDetail("codebuddy", target.id) as unknown as Record<string, unknown>)).toEqual({
      ...target,
      harness: "codebuddy",
    });
    expect(store.queryRecordDetail("claude", "missing")).toBeNull();
  });

  it("空库视图不伪造零用量，分页与详情安全返回", () => {
    const store = openStore();
    const filters: UsageQueryFilters = {
      range: "today",
      harness: "all",
      project: "all",
      provider: "all",
      model: "all",
      billing: "all",
    };
    const view = store.queryView(filters);
    expect(view.snapshotAvailable).toBe(false);
    expect(view.summary.requests).toBe(0);
    expect(view.syncedAt).toBe(0);
    expect(store.queryRecordsPage(filters, 0, 10)).toMatchObject({
      total: 0,
      page: 0,
      records: [],
    });
  });
});

describe("parseUsageQueryParams", () => {
  it("缺省参数回落默认筛选与分页", () => {
    const parsed = parseUsageQueryParams(new URLSearchParams());
    expect(parsed).toEqual({
      ok: true,
      value: {
        filters: {
          range: "today",
          harness: "all",
          project: "all",
          provider: "all",
          model: "all",
          billing: "all",
        },
        page: 0,
        pageSize: DEFAULT_RECORDS_PAGE_SIZE,
      },
    });
  });

  it("合法参数完整解析，pageSize 超上限被钳制", () => {
    const parsed = parseUsageQueryParams(
      new URLSearchParams(
        "range=7d&harness=claude&project=p%20one&provider=Anthropic&model=claude-sonnet&billing=unbilled&page=3&pageSize=5000",
      ),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.filters).toEqual({
      range: "7d",
      harness: "claude",
      project: "p one",
      provider: "Anthropic",
      model: "claude-sonnet",
      billing: "unbilled",
    });
    expect(parsed.value.page).toBe(3);
    expect(parsed.value.pageSize).toBe(MAX_RECORDS_PAGE_SIZE);
  });

  it("非法枚举、非数字页码与超长文本返回错误", () => {
    expect(parseUsageQueryParams(new URLSearchParams("range=90d"))).toMatchObject({
      ok: false,
      error: "range 参数非法",
    });
    expect(parseUsageQueryParams(new URLSearchParams("harness=nope"))).toMatchObject({
      ok: false,
      error: "harness 参数非法",
    });
    expect(parseUsageQueryParams(new URLSearchParams("billing=free"))).toMatchObject({
      ok: false,
      error: "billing 参数非法",
    });
    expect(parseUsageQueryParams(new URLSearchParams("page=-1"))).toMatchObject({
      ok: false,
      error: "page 参数非法",
    });
    expect(parseUsageQueryParams(new URLSearchParams("page=1.5"))).toMatchObject({
      ok: false,
      error: "page 参数非法",
    });
    expect(parseUsageQueryParams(new URLSearchParams("pageSize=abc"))).toMatchObject({
      ok: false,
      error: "pageSize 参数非法",
    });
    expect(
      parseUsageQueryParams(new URLSearchParams(`project=${"x".repeat(301)}`)),
    ).toMatchObject({ ok: false, error: "project 参数非法" });
  });

  it("custom 时间段解析：合法毫秒区间通过，非法参数返回 400 文案", () => {
    const ok = parseUsageQueryParams(
      new URLSearchParams("range=custom&start=1000&end=2000&harness=claude"),
    );
    expect(ok).toEqual({
      ok: true,
      value: {
        filters: {
          range: "custom",
          start: 1000,
          end: 2000,
          harness: "claude",
          project: "all",
          provider: "all",
          model: "all",
          billing: "all",
        },
        page: 0,
        pageSize: DEFAULT_RECORDS_PAGE_SIZE,
      },
    });

    // 缺参 / 非数字 / 超长数字 / start ≥ end。
    expect(parseUsageQueryParams(new URLSearchParams("range=custom"))).toMatchObject({
      ok: false,
      error: "start/end 参数非法",
    });
    expect(
      parseUsageQueryParams(new URLSearchParams("range=custom&start=1000")),
    ).toMatchObject({ ok: false, error: "start/end 参数非法" });
    expect(
      parseUsageQueryParams(new URLSearchParams("range=custom&start=abc&end=2000")),
    ).toMatchObject({ ok: false, error: "start/end 参数非法" });
    expect(
      parseUsageQueryParams(
        new URLSearchParams(`range=custom&start=${"1".repeat(17)}&end=2000`),
      ),
    ).toMatchObject({ ok: false, error: "start/end 参数非法" });
    expect(
      parseUsageQueryParams(new URLSearchParams("range=custom&start=2000&end=2000")),
    ).toMatchObject({ ok: false, error: "自定义时间段 start 需早于 end" });

    // 预设范围携带多余 start/end：忽略，不进筛选。
    const ignored = parseUsageQueryParams(
      new URLSearchParams("range=7d&start=1000&end=2000"),
    );
    expect(ignored.ok).toBe(true);
    if (ignored.ok) {
      expect(ignored.value.filters.start).toBeUndefined();
      expect(ignored.value.filters.end).toBeUndefined();
    }
  });
});

describe("UsageStore 统计面板聚合", () => {
  const pad2 = (value: number) => String(value).padStart(2, "0");
  const dayKeyOf = (timestamp: number): string => {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  };
  const monthKeyOf = (timestamp: number): string => dayKeyOf(timestamp).slice(0, 7);

  function bucketOf(records: UsageRecord[], keyOf: (timestamp: number) => string) {
    const map = new Map<string, UsageRecord[]>();
    for (const record of records) {
      const key = keyOf(record.timestamp);
      map.set(key, [...(map.get(key) ?? []), record]);
    }
    return map;
  }

  /** UsageBucketStat 与 summarizeRecords 逐字段对比（无首字/速度字段）。 */
  function expectBucket(
    actual: UsageBucketStat,
    expected: ReturnType<typeof summarizeRecords>,
  ): void {
    expect(actual.requests).toBe(expected.requests);
    expect(actual.tokens).toBe(expected.tokens);
    expect(actual.inputTokens).toBe(expected.inputTokens);
    expect(actual.outputTokens).toBe(expected.outputTokens);
    expect(actual.cacheReadTokens).toBe(expected.cacheReadTokens);
    expect(actual.cacheableInputTokens).toBe(expected.cacheableInputTokens);
    expect(actual.hasTokens).toBe(expected.hasTokens);
    expect(actual.hasCredit).toBe(expected.hasCredit);
    expect(actual.mixedCreditUnits).toBe(expected.mixedCreditUnits);
    expect(actual.unbilledCredits).toBeCloseTo(expected.unbilledCredits, 8);
    expect(actual.credits).toBeCloseTo(expected.credits, 8);
    expect(actual.cacheRate).toBeCloseTo(expected.cacheRate, 12);
    expect(actual.successRate).toBeCloseTo(expected.successRate, 12);
    expect(actual.creditsByHarness.map((item) => item.harness)).toEqual(
      expected.creditsByHarness.map((item) => item.harness),
    );
    for (let index = 0; index < expected.creditsByHarness.length; index += 1) {
      expect(actual.creditsByHarness[index].credits).toBeCloseTo(
        expected.creditsByHarness[index].credits,
        8,
      );
    }
  }

  it.each(FILTER_CASES.map((filters) => [JSON.stringify(filters), filters] as const))(
    "筛选 %s 的日/月与日×模型聚合与 JS 全量管线一致",
    (_name, filters) => {
      const store = openStore();
      const records = generateRecords(400, 20261108);
      commitRecords(store, records);
      const now = new Date(2026, 10, 8, 15, 30, 0);
      const stats = store.queryStats(filters, now);

      expect(stats.snapshotAvailable).toBe(true);
      const custom = { start: filters.start, end: filters.end };
      const expectedRecords = filterUsageRecords(
        records,
        filters.range,
        filters.project,
        filters.provider,
        filters.model,
        now,
        filters.harness,
        filters.billing,
        custom,
      );

      // 日/月桶：只含有记录的桶，降序，逐桶与 JS 汇总一致。
      const byDay = bucketOf(expectedRecords, dayKeyOf);
      expect(stats.daily.map((bucket) => bucket.key)).toEqual(
        Array.from(byDay.keys()).sort().reverse(),
      );
      for (const bucket of stats.daily) {
        expectBucket(bucket, summarizeRecords(byDay.get(bucket.key)!));
      }
      const byMonth = bucketOf(expectedRecords, monthKeyOf);
      expect(stats.monthly.map((bucket) => bucket.key)).toEqual(
        Array.from(byMonth.keys()).sort().reverse(),
      );
      for (const bucket of stats.monthly) {
        expectBucket(bucket, summarizeRecords(byMonth.get(bucket.key)!));
      }

      // 日×模型：行集合与逐组合计一致；日降序、同日 Tokens 降序。
      const pairs = new Map<string, UsageRecord[]>();
      for (const record of expectedRecords) {
        const key = `${dayKeyOf(record.timestamp)}|${record.model}`;
        pairs.set(key, [...(pairs.get(key) ?? []), record]);
      }
      expect(stats.dailyModelsTruncated).toBe(false);
      expect(stats.dailyModels.length).toBe(pairs.size);
      const dayOrder = stats.dailyModels.map((row) => row.day);
      expect(dayOrder).toEqual([...dayOrder].sort().reverse());
      for (const row of stats.dailyModels) {
        const rows = pairs.get(`${row.day}|${row.model}`)!;
        expect(rows).toBeDefined();
        expect(row.requests).toBe(rows.length);
        expect(row.tokens).toBe(rows.reduce((sum, record) => sum + record.totalTokens, 0));
        expect(row.inputTokens).toBe(rows.reduce((sum, record) => sum + record.inputTokens, 0));
        expect(row.outputTokens).toBe(rows.reduce((sum, record) => sum + record.outputTokens, 0));
        expect(row.cacheReadTokens).toBe(
          rows.reduce((sum, record) => sum + record.cacheReadTokens, 0),
        );
        expect(row.credits).toBeCloseTo(
          rows.reduce((sum, record) => sum + record.credits, 0),
          8,
        );
        expect(row.hasTokens).toBe(rows.some((record) => record.hasTokenUsage));
        expect(row.hasCredit).toBe(rows.some((record) => record.hasCredit));
        // provider 取组内字典序最小值。
        expect(row.provider).toBe(
          Array.from(new Set(rows.map((record) => record.provider))).sort()[0],
        );
      }

      // 月×模型：同口径不截断；月降序、同月 Tokens 降序。
      const monthPairs = new Map<string, UsageRecord[]>();
      for (const record of expectedRecords) {
        const key = `${monthKeyOf(record.timestamp)}|${record.model}`;
        monthPairs.set(key, [...(monthPairs.get(key) ?? []), record]);
      }
      expect(stats.monthlyModels.length).toBe(monthPairs.size);
      const monthOrder = stats.monthlyModels.map((row) => row.month);
      expect(monthOrder).toEqual([...monthOrder].sort().reverse());
      for (const row of stats.monthlyModels) {
        const rows = monthPairs.get(`${row.month}|${row.model}`)!;
        expect(rows).toBeDefined();
        expect(row.requests).toBe(rows.length);
        expect(row.tokens).toBe(rows.reduce((sum, record) => sum + record.totalTokens, 0));
        expect(row.credits).toBeCloseTo(
          rows.reduce((sum, record) => sum + record.credits, 0),
          8,
        );
        expect(row.provider).toBe(
          Array.from(new Set(rows.map((record) => record.provider))).sort()[0],
        );
      }
    },
  );

  it("日×模型天数超上限时截断到最近 370 天，单日不切断", () => {
    const store = openStore();
    const day = 24 * 60 * 60 * 1000;
    const base = new Date(2026, 10, 8, 15, 30, 0).getTime();
    // 380 个不同日期的记录（每天 1 条，同一模型）。
    const records: UsageRecord[] = Array.from({ length: 380 }, (_, index) => ({
      id: `claude:day-${index}`,
      requestId: `request-day-${index}`,
      sessionId: "session-1",
      harness: "claude" as const,
      project: "project-alpha",
      model: "claude-sonnet",
      provider: "Anthropic",
      timestamp: base - index * day,
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 110,
      inputTokenSemantics: "fresh" as const,
      hasTokenUsage: true,
      credits: 0,
      hasCredit: false,
      status: "success" as const,
    }));
    commitRecords(store, records);
    const stats = store.queryStats(
      { range: "all", harness: "all", project: "all", provider: "all", model: "all", billing: "all" },
      new Date(2026, 10, 8, 15, 30, 0),
    );
    expect(stats.dailyModelsTruncated).toBe(true);
    expect(stats.dailyModels.length).toBe(370);
    const days = stats.dailyModels.map((row) => row.day);
    expect(days[0]).toBe(dayKeyOf(base));
    expect(days[days.length - 1]).toBe(dayKeyOf(base - 369 * day));
    // 日桶与月×模型不受截断影响。
    expect(stats.daily.length).toBe(380);
    expect(stats.monthlyModels.length).toBeGreaterThan(0);
  });

  it("空库统计视图不伪造零用量", () => {
    const store = openStore();
    const stats = store.queryStats({
      range: "all",
      harness: "all",
      project: "all",
      provider: "all",
      model: "all",
      billing: "all",
    });
    expect(stats.snapshotAvailable).toBe(false);
    expect(stats.daily).toEqual([]);
    expect(stats.monthly).toEqual([]);
    expect(stats.dailyModels).toEqual([]);
    expect(stats.dailyModelsTruncated).toBe(false);
    expect(stats.monthlyModels).toEqual([]);
  });
});
