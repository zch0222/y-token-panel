import type { Page } from "@playwright/test";

export const records = Array.from({ length: 25 }, (_, index) => {
  const second = index === 1;
  return {
    id: `record-${index + 1}`,
    requestId: `request-${index + 1}`,
    sessionId: `session-${index + 1}`,
    harness: index % 2 === 0 ? "dsh" : "claude",
    project: index % 2 === 0 ? "Alpha" : "Beta",
    model: second ? "claude-sonnet-e2e" : "kimi-k3.1-pro",
    provider: index % 2 === 0 ? "DeepSeek" : "Anthropic",
    timestamp: Date.UTC(2026, 10, 10, 1, index),
    inputTokens: 1_000 + index,
    outputTokens: 300 + index,
    cacheReadTokens: 200,
    cacheCreationTokens: 50,
    totalTokens: 1_550 + index,
    inputTokenSemantics: "fresh",
    hasTokenUsage: true,
    credits: 0.25,
    hasCredit: true,
    billable: true,
    estimatedDurationMs: 5_000,
    status: "success",
  };
});

const summary = {
  requests: 25,
  credits: 6.25,
  hasCredit: true,
  creditsByHarness: [{ harness: "dsh", label: "DeepSeek Harness", credits: 6.25 }],
  mixedCreditUnits: false,
  unbilledCredits: 0,
  tokens: 38_750,
  hasTokens: true,
  inputTokens: 25_000,
  outputTokens: 7_500,
  cacheReadTokens: 5_000,
  cacheableInputTokens: 30_000,
  cacheRate: 5_000 / 30_000,
  successRate: 1,
  speedOutputTokens: 7_500,
  speedDurationMs: 125_000,
};

const group = (key: string) => ({ ...summary, key, lastUsed: records[0].timestamp });

/** 排名断言需要 Tokens 与请求数排序不一致：kimi 请求多、claude Tokens 多。 */
const modelGroups = [
  { ...summary, key: "kimi-k3.1-pro", requests: 13, tokens: 20_150, lastUsed: records[0].timestamp },
  { ...summary, key: "claude-sonnet-e2e", requests: 12, tokens: 38_750, lastUsed: records[0].timestamp },
];

export const usageView = {
  revision: 1,
  snapshotAvailable: true,
  syncedAt: records[0].timestamp,
  sync: {
    phase: "ready",
    revision: 1,
    hasSnapshot: true,
    startedAt: records[0].timestamp,
    syncedAt: records[0].timestamp,
    durationMs: 20,
    error: null,
    recordCount: 25,
  },
  sources: [
    {
      harness: "dsh",
      scannedFiles: 2,
      skippedFiles: 0,
      source: "~/.dsh/sessions",
      sourceAvailable: true,
      recordCount: 13,
    },
    {
      harness: "claude",
      scannedFiles: 2,
      skippedFiles: 0,
      source: "~/.claude/projects",
      sourceAvailable: true,
      recordCount: 12,
    },
  ],
  scannedFiles: 4,
  skippedFiles: 0,
  summary,
  todaySummary: summary,
  trend: [
    {
      key: "00",
      label: "00:00",
      fullLabel: "2026/11/10 00:00",
      tokens: 15_000,
      requests: 10,
      credits: 2.5,
      unbilledCredits: 0,
      cacheRate: 0.2,
      inputTokens: 10_000,
      cacheReadTokens: 2_000,
      cacheableInputTokens: 10_000,
    },
    {
      key: "01",
      label: "01:00",
      fullLabel: "2026/11/10 01:00",
      tokens: 23_750,
      requests: 15,
      credits: 3.75,
      unbilledCredits: 0,
      cacheRate: 0.15,
      inputTokens: 15_000,
      cacheReadTokens: 3_000,
      cacheableInputTokens: 20_000,
    },
  ],
  groups: {
    harness: [group("dsh"), group("claude")],
    provider: [group("DeepSeek"), group("Anthropic")],
    model: modelGroups,
    project: [group("Alpha"), group("Beta")],
  },
  facets: {
    projects: ["Alpha", "Beta"],
    providers: ["DeepSeek", "Anthropic"],
    models: ["kimi-k3.1-pro", "claude-sonnet-e2e"],
  },
  filteredCount: 25,
};

/**
 * /api/usage/stats 的统计面板负载：3 天 + 2 月 + 日×模型 + 月×模型。
 * 排序区分度刻意设计：claude Tokens 更高（25,000 / 31,000），kimi 请求数更多（13 / 23）。
 */
export const usageStats = {
  revision: 1,
  snapshotAvailable: true,
  daily: [
    {
      key: "2026-11-10",
      requests: 25,
      credits: 6.25,
      hasCredit: true,
      creditsByHarness: [{ harness: "dsh", label: "DeepSeek Harness", credits: 6.25 }],
      mixedCreditUnits: false,
      unbilledCredits: 0,
      tokens: 43_600,
      hasTokens: true,
      inputTokens: 27_000,
      outputTokens: 8_600,
      cacheReadTokens: 5_400,
      cacheableInputTokens: 32_000,
      cacheRate: 5_400 / 32_000,
      successRate: 1,
    },
    {
      key: "2026-11-09",
      requests: 10,
      credits: 1.5,
      hasCredit: true,
      creditsByHarness: [{ harness: "dsh", label: "DeepSeek Harness", credits: 1.5 }],
      mixedCreditUnits: false,
      unbilledCredits: 0,
      tokens: 5_000,
      hasTokens: true,
      inputTokens: 3_400,
      outputTokens: 1_000,
      cacheReadTokens: 600,
      cacheableInputTokens: 4_000,
      cacheRate: 600 / 4_000,
      successRate: 1,
    },
    {
      key: "2026-10-20",
      requests: 5,
      credits: 1,
      hasCredit: true,
      creditsByHarness: [{ harness: "dsh", label: "DeepSeek Harness", credits: 1 }],
      mixedCreditUnits: false,
      unbilledCredits: 0,
      tokens: 6_000,
      hasTokens: true,
      inputTokens: 4_000,
      outputTokens: 1_200,
      cacheReadTokens: 800,
      cacheableInputTokens: 5_000,
      cacheRate: 800 / 5_000,
      successRate: 1,
    },
  ],
  monthly: [
    {
      key: "2026-11",
      requests: 35,
      credits: 7.75,
      hasCredit: true,
      creditsByHarness: [{ harness: "dsh", label: "DeepSeek Harness", credits: 7.75 }],
      mixedCreditUnits: false,
      unbilledCredits: 0,
      tokens: 48_600,
      hasTokens: true,
      inputTokens: 30_400,
      outputTokens: 9_600,
      cacheReadTokens: 6_000,
      cacheableInputTokens: 36_000,
      cacheRate: 6_000 / 36_000,
      successRate: 1,
    },
    {
      key: "2026-10",
      requests: 5,
      credits: 1,
      hasCredit: true,
      creditsByHarness: [{ harness: "dsh", label: "DeepSeek Harness", credits: 1 }],
      mixedCreditUnits: false,
      unbilledCredits: 0,
      tokens: 6_000,
      hasTokens: true,
      inputTokens: 4_000,
      outputTokens: 1_200,
      cacheReadTokens: 800,
      cacheableInputTokens: 5_000,
      cacheRate: 800 / 5_000,
      successRate: 1,
    },
  ],
  dailyModels: [
    {
      day: "2026-11-10",
      model: "kimi-k3.1-pro",
      provider: "DeepSeek",
      requests: 13,
      tokens: 18_600,
      hasTokens: true,
      inputTokens: 12_000,
      outputTokens: 3_600,
      cacheReadTokens: 2_400,
      credits: 3,
      hasCredit: true,
    },
    {
      day: "2026-11-10",
      model: "claude-sonnet-e2e",
      provider: "Anthropic",
      requests: 12,
      tokens: 25_000,
      hasTokens: true,
      inputTokens: 15_000,
      outputTokens: 5_000,
      cacheReadTokens: 3_000,
      credits: 3.25,
      hasCredit: true,
    },
    {
      day: "2026-11-09",
      model: "kimi-k3.1-pro",
      provider: "DeepSeek",
      requests: 10,
      tokens: 5_000,
      hasTokens: true,
      inputTokens: 3_400,
      outputTokens: 1_000,
      cacheReadTokens: 600,
      credits: 1.5,
      hasCredit: true,
    },
    {
      day: "2026-10-20",
      model: "claude-sonnet-e2e",
      provider: "Anthropic",
      requests: 5,
      tokens: 6_000,
      hasTokens: true,
      inputTokens: 4_000,
      outputTokens: 1_200,
      cacheReadTokens: 800,
      credits: 1,
      hasCredit: true,
    },
  ],
  dailyModelsTruncated: false,
  monthlyModels: [
    {
      month: "2026-11",
      model: "kimi-k3.1-pro",
      provider: "DeepSeek",
      requests: 23,
      tokens: 23_600,
      hasTokens: true,
      inputTokens: 15_400,
      outputTokens: 4_600,
      cacheReadTokens: 3_000,
      credits: 4.5,
      hasCredit: true,
    },
    {
      month: "2026-11",
      model: "claude-sonnet-e2e",
      provider: "Anthropic",
      requests: 12,
      tokens: 25_000,
      hasTokens: true,
      inputTokens: 15_000,
      outputTokens: 5_000,
      cacheReadTokens: 3_000,
      credits: 3.25,
      hasCredit: true,
    },
    {
      month: "2026-10",
      model: "claude-sonnet-e2e",
      provider: "Anthropic",
      requests: 5,
      tokens: 6_000,
      hasTokens: true,
      inputTokens: 4_000,
      outputTokens: 1_200,
      cacheReadTokens: 800,
      credits: 1,
      hasCredit: true,
    },
  ],
};

export interface UsageMockOptions {
  failRecords?: () => boolean;
  detailDelay?: (recordId: string) => number;
  onRecordsRequest?: (url: URL) => void;
}

export async function mockUsageApi(page: Page, options: UsageMockOptions = {}) {
  const requests: URL[] = [];
  await page.route("**/api/usage/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push(url);
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (url.pathname === "/api/usage/sync") {
      return json({
        revision: 1,
        changed: false,
        recordCount: 25,
        syncedAt: Date.now(),
        sync: usageView.sync,
      });
    }
    if (url.pathname === "/api/usage/query") return json(usageView);
    if (url.pathname === "/api/usage/stats") return json(usageStats);
    if (url.pathname === "/api/usage/records") {
      options.onRecordsRequest?.(url);
      if (options.failRecords?.()) return json({ error: "读取请求日志失败" }, 500);
      const pageNumber = Number(url.searchParams.get("page") ?? "0");
      const pageSize = Number(url.searchParams.get("pageSize") ?? "10");
      return json({
        revision: 1,
        total: records.length,
        page: pageNumber,
        pageSize,
        records: records.slice(pageNumber * pageSize, (pageNumber + 1) * pageSize),
      });
    }
    if (url.pathname === "/api/usage/records/detail") {
      const recordId = url.searchParams.get("recordId") ?? "";
      const delay = options.detailDelay?.(recordId) ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      const record = records.find((item) => item.id === recordId);
      return record ? json(record) : json({ error: "Not found" }, 404);
    }
    if (url.pathname === "/api/usage/export") {
      return route.fulfill({
        status: 200,
        contentType: "text/csv; charset=utf-8",
        headers: { "Content-Disposition": 'attachment; filename="usage-e2e.csv"' },
        body: "id,model\nrecord-1,kimi-k3.1-pro\n",
      });
    }
    return json({ error: `Unhandled usage endpoint: ${url.pathname}` }, 404);
  });
  return requests;
}
