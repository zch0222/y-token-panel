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

function postRequest(body?: unknown): Request {
  if (body === undefined) return new Request("http://localhost/api/usage/sync", { method: "POST" });
  return new Request("http://localhost/api/usage/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterAll(() => {
  getUsageStore().close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("POST /api/usage/sync", () => {
  it("返回小提交结果（不再携带全部记录），并带 revision 头与状态", async () => {
    commitResult.commit.mockResolvedValueOnce(result());
    const response = await postSync(postRequest());
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
    const response = await postSync(postRequest());
    expect(response.status).toBe(500);
    const payload = (await response.json()) as { error: string; detail: string };
    expect(payload.error).toContain("同步失败");
    expect(payload.detail).toContain("worker boom");
  });

  it("body 带合法 harness 时按单来源同步并透传", async () => {
    commitResult.commit.mockResolvedValueOnce(result());
    const response = await postSync(postRequest({ harness: "claude" }));
    expect(response.status).toBe(200);
    expect(commitResult.commit).toHaveBeenCalledWith("claude");
  });

  it("空 body 或非对象 payload 按全量同步处理", async () => {
    commitResult.commit.mockResolvedValue(result());
    const empty = await postSync(postRequest());
    expect(empty.status).toBe(200);
    expect(commitResult.commit).toHaveBeenLastCalledWith(undefined);
    commitResult.commit.mockClear();
    commitResult.commit.mockResolvedValue(result());
    const noKey = await postSync(postRequest({ other: 1 }));
    expect(noKey.status).toBe(200);
    expect(commitResult.commit).toHaveBeenLastCalledWith(undefined);
  });

  it("未知 harness 返回 400，不触发同步", async () => {
    commitResult.commit.mockClear();
    const response = await postSync(postRequest({ harness: "not-a-harness" }));
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string; detail: string };
    expect(payload.detail).toContain("not-a-harness");
    expect(commitResult.commit).not.toHaveBeenCalled();
  });

  it("非法 JSON body 返回 400，不触发同步", async () => {
    commitResult.commit.mockClear();
    const request = new Request("http://localhost/api/usage/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const response = await postSync(request);
    expect(response.status).toBe(400);
    expect(commitResult.commit).not.toHaveBeenCalled();
  });

  it("GET 返回同步状态", async () => {
    const response = await getSyncStatus();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ phase: "empty", revision: 0 });
  });
});
