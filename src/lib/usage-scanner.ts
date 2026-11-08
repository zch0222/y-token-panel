import { performance } from "node:perf_hooks";
import { readClaudeUsage } from "@/lib/claude";
import { readCodeBuddyUsage } from "@/lib/codebuddy";
import { readCodexUsage } from "@/lib/codex";
import { readDshUsage } from "@/lib/dsh";
import { readDshUsageIncremental, type DshIncrementalResult } from "@/lib/dsh-incremental";
import { readKcodeUsage } from "@/lib/kcode";
import { readQoderUsage } from "@/lib/qoder";
import { readWorkBuddyUsage } from "@/lib/workbuddy";
import { readZcodeUsage } from "@/lib/zcode";
import type { HarnessUsage, UsageResponse } from "@/lib/usage";
import type { UsageStore } from "@/lib/usage-store";

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

const usageScanner = createUsageScanner(usageReaders);

export function scanUsage(): Promise<UsageResponse> {
  return usageScanner.scan();
}

/** worker 专用：其他 reader 保持原实现，仅 DSH 使用持久游标增量路径。 */
export async function scanUsageForStorage(store: UsageStore): Promise<{
  usage: UsageResponse;
  dsh: DshIncrementalResult;
}> {
  let incremental: DshIncrementalResult | undefined;
  const readers = usageReaders.map((read) =>
    read === readDshUsage
      ? async () => {
          incremental = await readDshUsageIncremental(store);
          return incremental.usage;
        }
      : read,
  );
  const usage = combineUsageResults(await Promise.all(readers.map((read) => read())));
  if (!incremental) throw new Error("DSH 增量 reader 未返回事务状态");
  return { usage, dsh: incremental };
}
