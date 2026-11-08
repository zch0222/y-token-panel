import { readClaudeUsage } from "@/lib/claude";
import { readClaudeUsageIncremental } from "@/lib/claude-incremental";
import { readCodeBuddyUsage } from "@/lib/codebuddy";
import { readCodexUsage } from "@/lib/codex";
import { readCodexUsageIncremental } from "@/lib/codex-incremental";
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
import type { HarnessId, HarnessUsage, UsageResponse } from "@/lib/usage";
import type {
  UsageIncrementalCommit,
  UsageStore,
} from "@/lib/usage-store";
import type { IncrementalUsageResult } from "@/lib/incremental-core";

export type UsageReader = () => Promise<HarnessUsage>;

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

const usageReaders: Array<{ harness: HarnessId; read: UsageReader }> = [
  { harness: "codebuddy", read: readCodeBuddyUsage },
  { harness: "workbuddy", read: readWorkBuddyUsage },
  { harness: "qoder", read: readQoderUsage },
  { harness: "zcode", read: readZcodeUsage },
  { harness: "kcode", read: readKcodeUsage },
  { harness: "claude", read: readClaudeUsage },
  { harness: "codex", read: readCodexUsage },
  { harness: "dsh", read: readDshUsage },
];

/** worker 专用：全量 reader 之外的持久游标增量路径（与全量 reader 同一解析体）。 */
const incrementalReaders: Array<{
  harness: HarnessId;
  read: UsageReader;
  incremental: (store: UsageStore) => Promise<IncrementalUsageResult>;
}> = [
  { harness: "codebuddy", read: readCodeBuddyUsage, incremental: readCodeBuddyUsageIncremental },
  { harness: "workbuddy", read: readWorkBuddyUsage, incremental: readWorkBuddyUsageIncremental },
  { harness: "qoder", read: readQoderUsage, incremental: readQoderUsageIncremental },
  { harness: "kcode", read: readKcodeUsage, incremental: readKcodeUsageIncremental },
  { harness: "claude", read: readClaudeUsage, incremental: readClaudeUsageIncremental },
  { harness: "codex", read: readCodexUsage, incremental: readCodexUsageIncremental },
  { harness: "dsh", read: readDshUsage, incremental: readDshUsageIncremental },
];

/**
 * 单个来源失败时保留该来源的最后成功数据（M5 错误隔离）：失败来源的记录与
 * 来源摘要沿用上次成功提交的归一化库，其余来源照常更新；失败来源的增量游标
 * 因事务缺失而保持不动，下一轮自动重试。全部来源都失败时整体失败，由调用
 * 方保留旧快照。
 */
function staleUsageForFailedSource(
  store: UsageStore,
  harness: HarnessId,
): HarnessUsage | undefined {
  const row = store.getSourceRows().get(harness);
  if (!row) return undefined;
  return {
    harness,
    records: store.readNormalizedRecords(harness),
    scannedFiles: row.scannedFiles,
    skippedFiles: row.skippedFiles,
    source: row.source,
    sourceAvailable: row.sourceAvailable,
  };
}

export async function scanUsageForStorage(store: UsageStore): Promise<{
  usage: UsageResponse;
  incrementals: UsageIncrementalCommit[];
}> {
  const incrementalByHarness = new Map(
    incrementalReaders.map(({ harness, incremental }) => [harness, incremental]),
  );
  const transactions: UsageIncrementalCommit[] = [];
  const expectedTransactions = new Set<HarnessId>();
  const readers = usageReaders.map(({ harness, read }) => {
    const incremental = incrementalByHarness.get(harness);
    if (!incremental) return read;
    expectedTransactions.add(harness);
    return async () => {
      const result = await incremental(store);
      transactions.push(result.transaction);
      return result.usage;
    };
  });

  const settled = await Promise.allSettled(readers.map((read) => read()));
  const results: HarnessUsage[] = [];
  let succeededIncrementals = 0;
  let firstError: unknown;
  for (const [index, outcome] of settled.entries()) {
    const { harness } = usageReaders[index]!;
    if (outcome.status === "fulfilled") {
      results.push(outcome.value);
      if (expectedTransactions.has(harness)) succeededIncrementals += 1;
      continue;
    }
    firstError ??= outcome.reason;
    // 失败来源回退到最后成功数据；从未成功过的来源按不可用略过。
    const stale = staleUsageForFailedSource(store, harness);
    if (stale) results.push(stale);
    console.error(
      `[usage] 来源 ${harness} 本轮同步失败，已保留最后成功数据`,
      outcome.reason,
    );
  }
  if (results.length === 0) {
    throw firstError instanceof Error ? firstError : new Error(String(firstError));
  }
  if (transactions.length !== succeededIncrementals) {
    throw new Error("增量 reader 事务与成功来源数不一致");
  }
  return { usage: combineUsageResults(results), incrementals: transactions };
}
