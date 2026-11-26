import { scanUsageForStorage } from "@/lib/usage-scanner";
import { UsageStore, type UsageCommitResult } from "@/lib/usage-store";
import { HARNESS_OPTIONS, type HarnessId } from "@/lib/usage";

function parseHarnessScope(value: unknown): HarnessId | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && HARNESS_OPTIONS.some((option) => option.id === value)) {
    return value as HarnessId;
  }
  throw new Error(`非法用量同步范围: ${String(value)}`);
}

/** 独立 worker 的唯一业务入口：扫描、持久化和状态更新都不占用 Next 主线程。 */
export async function runUsageScanInWorker(
  databasePath: string,
  harnessScope?: unknown,
): Promise<UsageCommitResult> {
  const harness = parseHarnessScope(harnessScope);
  const store = new UsageStore(databasePath, { recoverInterruptedSync: false });
  let syncStarted = false;
  try {
    store.markSyncStarted();
    syncStarted = true;
    const { usage, incrementals } = await scanUsageForStorage(store, harness);
    return store.commitSnapshot(usage, Date.now(), incrementals);
  } catch (error) {
    if (syncStarted) {
      try {
        store.markSyncFailed(error);
      } catch (statusError) {
        console.error("Failed to persist usage sync error", statusError);
      }
    }
    throw error;
  } finally {
    store.close();
  }
}
