import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { getUsageStore } from "@/lib/usage-store";
import { GET } from "@/app/api/usage/route";

const readers = vi.hoisted(() => ({
  claude: vi.fn(),
  codebuddy: vi.fn(),
  codex: vi.fn(),
  dsh: vi.fn(),
  kcode: vi.fn(),
  qoder: vi.fn(),
  workbuddy: vi.fn(),
  zcode: vi.fn(),
}));

vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/lib/claude", () => ({ readClaudeUsage: readers.claude }));
vi.mock("@/lib/codebuddy", () => ({ readCodeBuddyUsage: readers.codebuddy }));
vi.mock("@/lib/codex", () => ({ readCodexUsage: readers.codex }));
vi.mock("@/lib/dsh", () => ({ readDshUsage: readers.dsh }));
vi.mock("@/lib/kcode", () => ({ readKcodeUsage: readers.kcode }));
vi.mock("@/lib/qoder", () => ({ readQoderUsage: readers.qoder }));
vi.mock("@/lib/workbuddy", () => ({ readWorkBuddyUsage: readers.workbuddy }));
vi.mock("@/lib/zcode", () => ({ readZcodeUsage: readers.zcode }));

const root = mkdtempSync(path.join(tmpdir(), "y-token-usage-route-"));
vi.stubEnv("USAGE_DB_PATH", path.join(root, "usage.sqlite"));

afterAll(() => {
  getUsageStore().close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("GET /api/usage", () => {
  it("空库和有快照都不调用任何原始会话 reader", async () => {
    const empty = await GET();
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ snapshotAvailable: false, revision: 0 });

    const store = getUsageStore();
    store.markSyncStarted(100);
    store.commitSnapshot(
      { records: [], sources: [], scannedFiles: 0, skippedFiles: 0, syncedAt: 12345 },
      150,
    );
    const persisted = store.getSnapshot();

    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Usage-Revision")).toBe("1");
    expect(await response.json()).toEqual(persisted);
    expect(persisted).toMatchObject({
      syncedAt: 12345,
      snapshotAvailable: true,
      revision: 1,
    });

    for (const read of Object.values(readers)) expect(read).not.toHaveBeenCalled();
  });
});
