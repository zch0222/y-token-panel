import { performance } from "node:perf_hooks";
import { readClaudeUsage } from "@/lib/claude";
import { readClaudeUsageIncremental } from "@/lib/claude-incremental";
import { readCodeBuddyUsage } from "@/lib/codebuddy";
import { readCodexUsage } from "@/lib/codex";
import { readDshUsage } from "@/lib/dsh";
import { readDshUsageIncremental } from "@/lib/dsh-incremental";
import { readKcodeUsage } from "@/lib/kcode";
import { readQoderUsage } from "@/lib/qoder";
import { readQoderUsageIncremental } from "@/lib/qoder-incremental";
import { readWorkBuddyUsage } from "@/lib/workbuddy";
import {
  readCodeBuddyUsageIncremental,
  readKcodeUsageIncremental,
  readWorkBuddyUsageIncremental,
} from "@/lib/wholefile-incremental";
import { readZcodeUsage } from "@/lib/zcode";
import type { HarnessUsage, UsageResponse } from "@/lib/usage";
import type {
  UsageIncrementalCommit,
  UsageStore,
} from "@/lib/usage-store";
import type { IncrementalUsageResult } from "@/lib/incremental-core";

export type UsageReader = () => Promise<HarnessUsage>;

interface UsageScannerOptions {
  logger?: Pick<Console, "info">;
  now?: () => number;
}

export interface UsageScannerStats {
  requests: number;
  scans: number;
  pendingScans: number;
  maxPendingScans: number;
}

function combineUsageResults(results: HarnessUsage[]): UsageResponse {
  const usage: UsageResponse = {
    records: results.flatMap((result) => result.records),
    sources: results.map(({ records, ...source }) => ({
      ...source,
      recordCount: records.length,
    })),
    scannedFiles: results.reduce((sum, result) => sum + result.scannedFiles, 0),
    skippedFiles: results.reduce((sum, result) => sum + result.skippedFiles, 0),
    syncedAt: Date.now(),
  };
  usage.records.sort((a, b) => b.timestamp - a.timestamp);
  return usage;
}

/**
 * 在同一 Next.js 进程内合并重叠的用量扫描。
 *
 * 这里共享的是同一个 Promise，而不是互斥锁后的排队任务：等待中的 GET
 * 会获得同一轮结果，不会在前一轮完成后各自再扫描一次。
 */
export function createUsageScanner(
  readers: UsageReader[],
  { logger = console, now = () => performance.now() }: UsageScannerOptions = {},
) {
  let inFlight: Promise<UsageResponse> | null = null;
  let requestCount = 0;
  let scanCount = 0;
  let currentScanRequests = 0;
  let maxPendingScans = 0;

  const scan = (): Promise<UsageResponse> => {
    requestCount += 1;

    if (inFlight) {
      currentScanRequests += 1;
      return inFlight;
    }

    const scanId = ++scanCount;
    currentScanRequests = 1;
    maxPendingScans = Math.max(maxPendingScans, 1);
    const startedAt = now();
    logger.info(`[usage] scan #${scanId} started; totalScans=${scanCount}`);

    const promise = (async () => {
      let outcome = "completed";
      let recordCount = 0;

      try {
        const results = await Promise.all(readers.map((read) => read()));
        const usage = combineUsageResults(results);
        recordCount = usage.records.length;
        return usage;
      } catch (error) {
        outcome = "failed";
        throw error;
      } finally {
        if (scanId === scanCount) inFlight = null;
        const durationMs = Math.round((now() - startedAt) * 100) / 100;
        logger.info(
          `[usage] scan #${scanId} ${outcome} in ${durationMs}ms; ` +
            `requests=${currentScanRequests}; totalScans=${scanCount}; records=${recordCount}`,
        );
      }
    })();

    inFlight = promise;
    return promise;
  };

  return {
    scan,
    getStats: (): UsageScannerStats => ({
      requests: requestCount,
      scans: scanCount,
      pendingScans: inFlight ? 1 : 0,
      maxPendingScans,
    }),
  };
}

const usageReaders: UsageReader[] = [
  readCodeBuddyUsage,
  readWorkBuddyUsage,
  readQoderUsage,
  readZcodeUsage,
  readKcodeUsage,
  readClaudeUsage,
  readCodexUsage,
  readDshUsage,
];

/** worker 专用：全量 reader 之外的持久游标增量路径（与全量 reader 同一解析体）。 */
const incrementalReaders: Array<{
  read: UsageReader;
  incremental: (store: UsageStore) => Promise<IncrementalUsageResult>;
}> = [
  { read: readCodeBuddyUsage, incremental: readCodeBuddyUsageIncremental },
  { read: readWorkBuddyUsage, incremental: readWorkBuddyUsageIncremental },
  { read: readQoderUsage, incremental: readQoderUsageIncremental },
  { read: readKcodeUsage, incremental: readKcodeUsageIncremental },
  { read: readClaudeUsage, incremental: readClaudeUsageIncremental },
  { read: readDshUsage, incremental: readDshUsageIncremental },
];

const usageScanner = createUsageScanner(usageReaders);

export function scanUsage(): Promise<UsageResponse> {
  return usageScanner.scan();
}

export async function scanUsageForStorage(store: UsageStore): Promise<{
  usage: UsageResponse;
  incrementals: UsageIncrementalCommit[];
}> {
  const incrementalByRead = new Map(
    incrementalReaders.map(({ read, incremental }) => [read, incremental]),
  );
  const transactions: UsageIncrementalCommit[] = [];
  const readers = usageReaders.map((read) => {
    const incremental = incrementalByRead.get(read);
    if (!incremental) return read;
    return async () => {
      const result = await incremental(store);
      transactions.push(result.transaction);
      return result.usage;
    };
  });
  const usage = combineUsageResults(await Promise.all(readers.map((read) => read())));
  if (transactions.length !== incrementalReaders.length) {
    throw new Error("增量 reader 未全部返回事务状态");
  }
  return { usage, incrementals: transactions };
}
