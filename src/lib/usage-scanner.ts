import { readAntigravityUsage } from "@/lib/antigravity";
import { readAntigravityUsageIncremental } from "@/lib/antigravity-incremental";
import { readClaudeUsage } from "@/lib/claude";
import { readClaudeUsageIncremental } from "@/lib/claude-incremental";
import { readCodeBuddyUsage } from "@/lib/codebuddy";
import { readCodexUsage } from "@/lib/codex";
import { readCodexUsageIncremental } from "@/lib/codex-incremental";
import { readDevinUsage } from "@/lib/devin";
import { readDshUsage } from "@/lib/dsh";
import { readDshUsageIncremental } from "@/lib/dsh-incremental";
import { readKcodeUsage } from "@/lib/kcode";
import { readOpenCodeUsage } from "@/lib/opencode";
import { readPiDesktopUsage } from "@/lib/pi-desktop";
import { readQoderUsage } from "@/lib/qoder";
import { readQoderUsageIncremental } from "@/lib/qoder-incremental";
import { readWorkBuddyUsage } from "@/lib/workbuddy";
import {
  readCodeBuddyUsageIncremental,
  readKcodeUsageIncremental,
  readPiDesktopUsageIncremental,
  readWorkBuddyUsageIncremental,
} from "@/lib/wholefile-incremental";
import { readZcodeUsage } from "@/lib/zcode";
import type { HarnessId, HarnessUsage, UsageResponse } from "@/lib/usage";
import type {
  UsageIncrementalCommit,
  UsageStore,
} from "@/lib/usage-store";
import { canonicalRecord, type IncrementalUsageResult } from "@/lib/incremental-core";

export type UsageReader = () => Promise<HarnessUsage>;

function combineUsageResults(results: HarnessUsage[]): UsageResponse {
  const usage: UsageResponse = {
    // 统一规范化键序：devin 等全量 reader 的记录键序与 DB 读回不一致
    // （firstTokenMs/estimatedDurationMs 颠倒），合并扫描的记录一半来自
    // parser、一半来自 DB；不规范化会让全量扫描与单来源合并扫描对同样数据
    // 产生不同内容哈希，两条流水线交替时 revision 来回抖动（假 changed）。
    records: results.flatMap((result) => result.records.map(canonicalRecord)),
    sources: results.map(({ records, ...source }) => ({
      ...source,
      recordCount: records.length,
    })),
    scannedFiles: results.reduce((sum, result) => sum + result.scannedFiles, 0),
    skippedFiles: results.reduce((sum, result) => sum + result.skippedFiles, 0),
    syncedAt: Date.now(),
  };
  // 全序排序（时间倒序 + id 兜底）：devin/zcode 全量 reader 的发射顺序与 DB
  // 读回的严格顺序不同，只有全序排序才能保证两条流水线对同样数据产生逐字节
  // 一致的数组顺序。
  usage.records.sort((a, b) => b.timestamp - a.timestamp || a.id.localeCompare(b.id));
  return usage;
}

const usageReaders: Array<{ harness: HarnessId; read: UsageReader }> = [
  { harness: "codebuddy", read: readCodeBuddyUsage },
  { harness: "workbuddy", read: readWorkBuddyUsage },
  { harness: "qoder", read: readQoderUsage },
  { harness: "zcode", read: readZcodeUsage },
  { harness: "opencode", read: readOpenCodeUsage },
  { harness: "kcode", read: readKcodeUsage },
  { harness: "claude", read: readClaudeUsage },
  { harness: "codex", read: readCodexUsage },
  { harness: "dsh", read: readDshUsage },
  { harness: "antigravity", read: readAntigravityUsage },
  { harness: "pidesktop", read: readPiDesktopUsage },
  { harness: "devin", read: readDevinUsage },
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
  {
    harness: "antigravity",
    read: readAntigravityUsage,
    incremental: readAntigravityUsageIncremental,
  },
  {
    harness: "pidesktop",
    read: readPiDesktopUsage,
    incremental: readPiDesktopUsageIncremental,
  },
];

/**
 * 单个来源失败时保留该来源的最后成功数据（M5 错误隔离）：失败来源的记录与
 * 来源摘要沿用上次成功提交的归一化库，其余来源照常更新；失败来源的增量游标
 * 因事务缺失而保持不动，下一轮自动重试。全部来源都失败时整体失败，由调用
 * 方保留旧快照。单来源同步也复用这份已提交数据合并其余未扫描来源。
 */
function storedUsageForSource(
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

/**
 * 单来源同步（手动按 Harness 刷新）：只扫描目标来源，其余来源原样沿用已提交
 * 的归一化记录与来源摘要，合并结果与全量扫描走同一提交流程。目标来源扫描
 * 失败即整体抛出——单来源同步没有其他来源需要隔离，错误应直接反馈给手动
 * 触发者，最后成功快照保持不变。
 */
async function scanSingleHarnessForStorage(
  store: UsageStore,
  harness: HarnessId,
): Promise<{
  usage: UsageResponse;
  incrementals: UsageIncrementalCommit[];
}> {
  const entry = usageReaders.find((candidate) => candidate.harness === harness);
  if (!entry) throw new Error(`未知用量来源: ${harness}`);
  const incremental = incrementalReaders.find((candidate) => candidate.harness === harness)?.incremental;

  const transactions: UsageIncrementalCommit[] = [];
  let scanned: HarnessUsage;
  if (incremental) {
    const result = await incremental(store);
    transactions.push(result.transaction);
    scanned = result.usage;
  } else {
    scanned = await entry.read();
  }

  const results: HarnessUsage[] = [];
  for (const { harness: candidate } of usageReaders) {
    if (candidate === harness) {
      results.push(scanned);
      continue;
    }
    const stored = storedUsageForSource(store, candidate);
    if (stored) results.push(stored);
  }
  return { usage: combineUsageResults(results), incrementals: transactions };
}

export async function scanUsageForStorage(
  store: UsageStore,
  onlyHarness?: HarnessId,
): Promise<{
  usage: UsageResponse;
  incrementals: UsageIncrementalCommit[];
}> {
  if (onlyHarness !== undefined) return scanSingleHarnessForStorage(store, onlyHarness);
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
    const stale = storedUsageForSource(store, harness);
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
