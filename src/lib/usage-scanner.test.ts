import { describe, expect, it, vi } from "vitest";
import type { HarnessUsage, UsageResponse } from "@/lib/usage";
import { createUsageScanner, type UsageReader } from "@/lib/usage-scanner";

vi.mock("@/lib/claude", () => ({ readClaudeUsage: vi.fn() }));
vi.mock("@/lib/codebuddy", () => ({ readCodeBuddyUsage: vi.fn() }));
vi.mock("@/lib/codex", () => ({ readCodexUsage: vi.fn() }));
vi.mock("@/lib/dsh", () => ({ readDshUsage: vi.fn() }));
vi.mock("@/lib/kcode", () => ({ readKcodeUsage: vi.fn() }));
vi.mock("@/lib/qoder", () => ({ readQoderUsage: vi.fn() }));
vi.mock("@/lib/workbuddy", () => ({ readWorkBuddyUsage: vi.fn() }));
vi.mock("@/lib/zcode", () => ({ readZcodeUsage: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function emptyHarnessUsage(): HarnessUsage {
  return {
    harness: "claude",
    records: [],
    scannedFiles: 0,
    skippedFiles: 0,
    source: "/tmp/claude",
    sourceAvailable: true,
  };
}

describe("createUsageScanner", () => {
  it("20 个并发调用共享同一个 Promise 和同一轮扫描结果", async () => {
    const pending = deferred<HarnessUsage>();
    const reader = vi.fn<UsageReader>(() => pending.promise);
    const info = vi.fn();
    const now = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(250);
    const scanner = createUsageScanner([reader], {
      logger: { info },
      now,
    });

    const requests = Array.from({ length: 20 }, () => scanner.scan());

    expect(new Set(requests).size).toBe(1);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(scanner.getStats()).toEqual({
      requests: 20,
      scans: 1,
      pendingScans: 1,
      maxPendingScans: 1,
    });

    pending.resolve(emptyHarnessUsage());
    const results = await Promise.all(requests);

    expect(results.every((result) => result === results[0])).toBe(true);
    expect(scanner.getStats()).toEqual({
      requests: 20,
      scans: 1,
      pendingScans: 0,
      maxPendingScans: 1,
    });
    expect(info).toHaveBeenNthCalledWith(1, "[usage] scan #1 started; totalScans=1");
    expect(info).toHaveBeenLastCalledWith(
      "[usage] scan #1 completed in 150ms; requests=20; totalScans=1; records=0",
    );
  });

  it("当前轮完成后才允许下一轮，失败也会释放 in-flight", async () => {
    const pending = deferred<HarnessUsage>();
    const reader = vi.fn<UsageReader>().mockReturnValueOnce(pending.promise);
    const scanner = createUsageScanner([reader], { logger: { info: vi.fn() } });

    const failedRequests = Array.from({ length: 5 }, () => scanner.scan());
    pending.reject(new Error("scan failed"));
    await Promise.all(
      failedRequests.map((request) => expect(request).rejects.toThrow("scan failed")),
    );
    expect(scanner.getStats().pendingScans).toBe(0);

    reader.mockResolvedValueOnce(emptyHarnessUsage());
    const nextResult = await scanner.scan();
    expect(nextResult.sources[0].recordCount).toBe(0);
    expect(reader).toHaveBeenCalledTimes(2);
    expect(scanner.getStats()).toMatchObject({ requests: 6, scans: 2 });
  });

  it("保持原有合并、排序与来源计数口径", async () => {
    const first = emptyHarnessUsage();
    const second = { ...emptyHarnessUsage(), harness: "qoder" as const };
    first.records = [
      { id: "old", timestamp: 10 },
      { id: "new", timestamp: 30 },
    ] as HarnessUsage["records"];
    second.records = [{ id: "middle", timestamp: 20 }] as HarnessUsage["records"];
    first.scannedFiles = 2;
    second.scannedFiles = 3;
    second.skippedFiles = 1;

    const scanner = createUsageScanner(
      [() => Promise.resolve(first), () => Promise.resolve(second)],
      { logger: { info: vi.fn() } },
    );
    const result: UsageResponse = await scanner.scan();

    expect(result.records.map((record) => record.id)).toEqual(["new", "middle", "old"]);
    expect(result.sources.map((source) => source.recordCount)).toEqual([2, 1]);
    expect(result.scannedFiles).toBe(5);
    expect(result.skippedFiles).toBe(1);
  });
});
