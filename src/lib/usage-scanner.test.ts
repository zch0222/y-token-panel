import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessId, HarnessUsage, UsageResponse, UsageRecord } from "@/lib/usage";
import { UsageStore, type UsageIncrementalCommit } from "@/lib/usage-store";
import type { IncrementalUsageResult } from "@/lib/incremental-core";
import { readClaudeUsageIncremental } from "@/lib/claude-incremental";
import { readCodexUsageIncremental } from "@/lib/codex-incremental";
import { readDshUsageIncremental } from "@/lib/dsh-incremental";
import { readQoderUsageIncremental } from "@/lib/qoder-incremental";
import {
  readCodeBuddyUsageIncremental,
  readKcodeUsageIncremental,
  readWorkBuddyUsageIncremental,
} from "@/lib/wholefile-incremental";
import { readZcodeUsage } from "@/lib/zcode";
import {
  createUsageScanner,
  scanUsageForStorage,
  type UsageReader,
} from "@/lib/usage-scanner";

vi.mock("@/lib/claude", () => ({ readClaudeUsage: vi.fn() }));
vi.mock("@/lib/codebuddy", () => ({ readCodeBuddyUsage: vi.fn() }));
vi.mock("@/lib/codex", () => ({ readCodexUsage: vi.fn() }));
vi.mock("@/lib/dsh", () => ({ readDshUsage: vi.fn() }));
vi.mock("@/lib/kcode", () => ({ readKcodeUsage: vi.fn() }));
vi.mock("@/lib/qoder", () => ({ readQoderUsage: vi.fn() }));
vi.mock("@/lib/workbuddy", () => ({ readWorkBuddyUsage: vi.fn() }));
vi.mock("@/lib/zcode", () => ({ readZcodeUsage: vi.fn() }));
vi.mock("@/lib/claude-incremental", () => ({ readClaudeUsageIncremental: vi.fn() }));
vi.mock("@/lib/codex-incremental", () => ({ readCodexUsageIncremental: vi.fn() }));
vi.mock("@/lib/dsh-incremental", () => ({ readDshUsageIncremental: vi.fn() }));
vi.mock("@/lib/qoder-incremental", () => ({ readQoderUsageIncremental: vi.fn() }));
vi.mock("@/lib/wholefile-incremental", () => ({
  readCodeBuddyUsageIncremental: vi.fn(),
  readKcodeUsageIncremental: vi.fn(),
  readWorkBuddyUsageIncremental: vi.fn(),
}));

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

describe("scanUsageForStorage 来源错误隔离", () => {
  let store: UsageStore;
  const incrementals = {
    codebuddy: vi.fn(),
    workbuddy: vi.fn(),
    qoder: vi.fn(),
    kcode: vi.fn(),
    claude: vi.fn(),
    codex: vi.fn(),
    dsh: vi.fn(),
  };
  const zcodeReader = vi.fn<UsageReader>();

  function record(id: string, harness: HarnessId, timestamp: number): UsageRecord {
    return {
      id,
      requestId: id,
      sessionId: "session-a",
      harness,
      project: "demo",
      model: "gpt-test",
      provider: "OpenAI",
      timestamp,
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 15,
      inputTokenSemantics: "fresh",
      hasTokenUsage: true,
      credits: 0,
      hasCredit: false,
      status: "success",
    };
  }

  function incrementalOf(
    harness: HarnessId,
    records: UsageRecord[],
  ): IncrementalUsageResult {
    return {
      usage: {
        harness,
        records,
        scannedFiles: 1,
        skippedFiles: 0,
        source: `/tmp/${harness}`,
        sourceAvailable: true,
      },
      transaction: { harness, resetCursors: false, resetDedup: false, cursors: [] },
      stats: {
        bodyBytesRead: 0,
        verificationBytesRead: 0,
        lookbackBytesRead: 0,
        dependencyFilesRead: 0,
        fullFilesRead: 0,
        incrementalFilesRead: 0,
        unchangedFiles: 0,
        rebuilds: 0,
      },
    };
  }

  async function commitRound(result: {
    usage: UsageResponse;
    incrementals: UsageIncrementalCommit[];
  }): Promise<void> {
    store.markSyncStarted();
    store.commitSnapshot(result.usage, Date.now(), result.incrementals);
  }

  beforeEach(() => {
    store = new UsageStore(":memory:");
    vi.mocked(readClaudeUsageIncremental).mockImplementation(incrementals.claude);
    vi.mocked(readCodexUsageIncremental).mockImplementation(incrementals.codex);
    vi.mocked(readDshUsageIncremental).mockImplementation(incrementals.dsh);
    vi.mocked(readQoderUsageIncremental).mockImplementation(incrementals.qoder);
    vi.mocked(readCodeBuddyUsageIncremental).mockImplementation(incrementals.codebuddy);
    vi.mocked(readKcodeUsageIncremental).mockImplementation(incrementals.kcode);
    vi.mocked(readWorkBuddyUsageIncremental).mockImplementation(incrementals.workbuddy);
    vi.mocked(readZcodeUsage).mockImplementation(zcodeReader);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    store.close();
    vi.restoreAllMocks();
    for (const mock of Object.values(incrementals)) mock.mockReset();
    zcodeReader.mockReset();
  });

  function stubAllSources(): void {
    for (const harness of Object.keys(incrementals) as Array<keyof typeof incrementals>) {
      incrementals[harness].mockImplementation(async () =>
        incrementalOf(harness, [record(`${harness}-1`, harness, 1000)]),
      );
    }
    zcodeReader.mockImplementation(async () =>
      Promise.resolve({
        harness: "zcode",
        records: [record("zcode-1", "zcode", 1000)],
        scannedFiles: 1,
        skippedFiles: 0,
        source: "/tmp/zcode",
        sourceAvailable: true,
      }),
    );
  }

  it("单个来源失败时保留其最后成功数据，其余来源正常更新", async () => {
    stubAllSources();
    const first = await scanUsageForStorage(store);
    await commitRound(first);
    expect(store.readNormalizedRecords("claude")).toHaveLength(1);

    // 第二轮：claude 失败，其余来源产生新记录。
    incrementals.claude.mockRejectedValue(new Error("claude source down"));
    incrementals.codex.mockImplementation(async () =>
      incrementalOf("codex", [record("codex-2", "codex", 2000)]),
    );
    const errorSpy = vi.mocked(console.error);

    const second = await scanUsageForStorage(store);
    await commitRound(second);

    // claude 保留第一轮数据；codex 更新为新记录。
    const sources = new Map(second.usage.sources.map((source) => [source.harness, source]));
    expect(sources.get("claude")?.recordCount).toBe(1);
    expect(sources.get("claude")?.source).toBe("/tmp/claude");
    expect(sources.get("codex")?.recordCount).toBe(1);
    const records = store.readNormalizedRecords();
    expect(records.filter((item) => item.harness === "claude").map((item) => item.id)).toEqual([
      "claude-1",
    ]);
    expect(records.filter((item) => item.harness === "codex").map((item) => item.id)).toEqual([
      "codex-2",
    ]);
    // 失败来源不提交增量事务（游标保持）。
    expect(second.incrementals).toHaveLength(6);
    expect(second.incrementals.map((item) => item.harness)).not.toContain("claude");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("claude"),
      expect.any(Error),
    );
  });

  it("从未成功过的来源失败时直接略过，不影响其余来源", async () => {
    stubAllSources();
    incrementals.dsh.mockRejectedValue(new Error("dsh never worked"));
    const result = await scanUsageForStorage(store);
    const harnesses = result.usage.sources.map((source) => source.harness);
    expect(harnesses).not.toContain("dsh");
    expect(harnesses).toHaveLength(7);
    await commitRound(result);
    expect(store.readNormalizedRecords("dsh")).toHaveLength(0);
  });

  it("全部来源失败时整体失败并抛出首个错误", async () => {
    for (const harness of Object.keys(incrementals) as Array<keyof typeof incrementals>) {
      incrementals[harness].mockRejectedValue(new Error(`${harness} down`));
    }
    zcodeReader.mockRejectedValue(new Error("zcode down"));
    await expect(scanUsageForStorage(store)).rejects.toThrow("down");
  });
});
