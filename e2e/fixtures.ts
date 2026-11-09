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
    model: [group("kimi-k3.1-pro"), group("claude-sonnet-e2e")],
    project: [group("Alpha"), group("Beta")],
  },
  facets: {
    projects: ["Alpha", "Beta"],
    providers: ["DeepSeek", "Anthropic"],
    models: ["kimi-k3.1-pro", "claude-sonnet-e2e"],
  },
  filteredCount: 25,
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
