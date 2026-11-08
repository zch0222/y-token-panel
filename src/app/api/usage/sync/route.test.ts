import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { UsageCommitResult } from "@/lib/usage-store";
import { getUsageStore } from "@/lib/usage-store";
import { GET as getSyncStatus, POST as postSync } from "@/app/api/usage/sync/route";

vi.mock("next/server", () => ({ connection: async () => undefined }));

const commitResult = vi.hoisted(() => ({ commit: vi.fn() }));
vi.mock("@/lib/usage-sync", () => ({ requestUsageSync: commitResult.commit }));

const root = mkdtempSync(path.join(tmpdir(), "y-token-usage-sync-route-"));
vi.stubEnv("USAGE_DB_PATH", path.join(root, "usage.sqlite"));

function result(patch: Partial<UsageCommitResult> = {}): UsageCommitResult {
  return { revision: 7, changed: false, recordCount: 42, syncedAt: 123_456, ...patch };
}

afterAll(() => {
  getUsageStore().close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("POST /api/usage/sync", () => {
  it("返回小提交结果（不再携带全部记录），并带 revision 头与状态", async () => {
    commitResult.commit.mockResolvedValueOnce(result());
    const response = await postSync();
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Usage-Revision")).toBe("7");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload).toMatchObject({
      revision: 7,
      changed: false,
      recordCount: 42,
      syncedAt: 123_456,
    });
    // sync 是数据库当前状态；mock 提交未写库，保持空库状态。
    expect(payload.sync).toMatchObject({ phase: "empty", revision: 0 });
    // 关键：不包含 records 数组。
    expect("records" in payload).toBe(false);
    expect(JSON.stringify(payload).length).toBeLessThan(1024);
  });

  it("同步失败保留 500 结构与最后成功状态", async () => {
    commitResult.commit.mockRejectedValueOnce(new Error("worker boom"));
    const response = await postSync();
    expect(response.status).toBe(500);
    const payload = (await response.json()) as { error: string; detail: string };
    expect(payload.error).toContain("同步失败");
    expect(payload.detail).toContain("worker boom");
  });

  it("GET 返回同步状态", async () => {
    const response = await getSyncStatus();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ phase: "empty", revision: 0 });
  });
});
