import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { UsageRecord, UsageResponse } from "@/lib/usage";
import { getUsageStore } from "@/lib/usage-store";
import { GET as queryUsageView } from "@/app/api/usage/query/route";
import { GET as queryUsageRecords } from "@/app/api/usage/records/route";
import { GET as queryRecordDetail } from "@/app/api/usage/records/detail/route";
import { GET as exportUsageRecords } from "@/app/api/usage/export/route";

vi.mock("next/server", () => ({ connection: async () => undefined }));

const root = mkdtempSync(path.join(tmpdir(), "y-token-usage-query-route-"));
vi.stubEnv("USAGE_DB_PATH", path.join(root, "usage.sqlite"));

function record(id: string, timestamp: number, patch: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id,
    requestId: `request-${id}`,
    sessionId: "session-1",
    harness: "claude",
    project: "project-a",
    model: "claude-sonnet",
    provider: "Anthropic",
    timestamp,
    inputTokens: 100,
    outputTokens: 300,
    cacheReadTokens: 50,
    cacheCreationTokens: 20,
    totalTokens: 470,
    inputTokenSemantics: "fresh",
    hasTokenUsage: true,
    credits: 1.5,
    hasCredit: true,
    estimatedDurationMs: 2500,
    status: "success",
    ...patch,
  };
}

afterAll(() => {
  getUsageStore().close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("M6 查询 API", () => {
  it("聚合视图返回筛选汇总、趋势、分组与 facet，并带 revision 头", async () => {
    const store = getUsageStore();
    // 用真实当前时间锚定：路由按服务器当前时间计算范围边界。
    const now = Date.now();
    const usage: UsageResponse = {
      records: [
        record("m1", now - 60_000),
        record("m2", now - 120_000, { harness: "qoder" as UsageRecord["harness"], credits: 2 }),
        // 落在 7d 之外的记录不参与 today 查询。
        record("m3", now - 8 * 24 * 60 * 60 * 1000, { project: "project-old" }),
      ],
      sources: [
        { harness: "claude", recordCount: 2, scannedFiles: 2, skippedFiles: 0, source: "/a", sourceAvailable: true },
        { harness: "qoder", recordCount: 1, scannedFiles: 1, skippedFiles: 1, source: "/b", sourceAvailable: true },
      ],
      scannedFiles: 3,
      skippedFiles: 1,
      syncedAt: now,
    };
    store.markSyncStarted(now - 5_000);
    store.commitSnapshot(usage, now);

    const response = await queryUsageView(
      new Request("http://localhost/api/usage/query?range=today&harness=all"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Usage-Revision")).toBe("1");
    const view = (await response.json()) as Record<string, unknown> & {
      summary: { requests: number };
      todaySummary: { requests: number };
      filteredCount: number;
      facets: { projects: string[] };
      groups: { harness: unknown[] };
      trend: unknown[];
    };
    expect(view.snapshotAvailable).toBe(true);
    expect(view.summary.requests).toBe(2);
    expect(view.todaySummary.requests).toBe(2);
    expect(view.filteredCount).toBe(2);
    expect(view.facets.projects).toEqual(["project-a", "project-old"]);
    expect(view.groups.harness.length).toBe(2);
    expect(Array.isArray(view.trend)).toBe(true);
    expect(view.sources).toHaveLength(2);
  });

  it("非法 range 返回 400", async () => {
    const response = await queryUsageView(
      new Request("http://localhost/api/usage/query?range=someDay"),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "range 参数非法" });
  });

  it("日志分页受控且页大小钳制，非法页码返回 400", async () => {
    const ok = await queryUsageRecords(
      new Request("http://localhost/api/usage/records?page=1&pageSize=1"),
    );
    expect(ok.status).toBe(200);
    const page = (await ok.json()) as { page: number; pageSize: number; total: number; records: unknown[] };
    expect(page.pageSize).toBe(1);
    expect(page.page).toBe(1);
    expect(page.records).toHaveLength(1);

    const clamped = await queryUsageRecords(
      new Request("http://localhost/api/usage/records?pageSize=99999"),
    );
    expect(((await clamped.json()) as { pageSize: number }).pageSize).toBe(100);

    const invalid = await queryUsageRecords(
      new Request("http://localhost/api/usage/records?page=nope"),
    );
    expect(invalid.status).toBe(400);
  });

  it("单条详情按 ID 查询，缺失返回 404，非法参数返回 400", async () => {
    const store = getUsageStore();
    const target = store.readNormalizedRecords("claude")[0];

    const found = await queryRecordDetail(
      new Request(
        `http://localhost/api/usage/records/detail?harness=claude&recordId=${encodeURIComponent(target.id)}`,
      ),
    );
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual(target);

    const missing = await queryRecordDetail(
      new Request("http://localhost/api/usage/records/detail?harness=claude&recordId=missing"),
    );
    expect(missing.status).toBe(404);

    const invalid = await queryRecordDetail(
      new Request("http://localhost/api/usage/records/detail?harness=nope&recordId=x"),
    );
    expect(invalid.status).toBe(400);
  });

  it("CSV 导出与筛选共用参数并返回附件响应头", async () => {
    const response = await exportUsageRecords(
      new Request("http://localhost/api/usage/export?range=all"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="ai-harness-usage-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    // BOM 以原始字节校验：response.text() 解码时会按编码标准剥掉前导 BOM。
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder().decode(bytes.slice(3));
    expect(csv).toContain("时间");
    expect(csv).toContain("session-1");
    // 3 条记录 + 表头。
    expect(csv.trimEnd().split("\r\n")).toHaveLength(4);

    const invalid = await exportUsageRecords(
      new Request("http://localhost/api/usage/export?billing=xyz"),
    );
    expect(invalid.status).toBe(400);
  });
});
