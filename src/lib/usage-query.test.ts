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
];

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
      const expectedRecords = filterUsageRecords(
        records,
        filters.range,
        filters.project,
        filters.provider,
        filters.model,
        now,
        filters.harness,
        filters.billing,
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

      const expectedTrend = buildTrend(expectedRecords, filters.range, now);
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
    expect(found).toEqual(target);
    expect(store.queryRecordDetail("codebuddy", target.id)).toEqual({
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
});
