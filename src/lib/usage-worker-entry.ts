import { scanUsageForStorage } from "@/lib/usage-scanner";
import { UsageStore, type UsageCommitResult } from "@/lib/usage-store";

/** 独立 worker 的唯一业务入口：扫描、持久化和状态更新都不占用 Next 主线程。 */
export async function runUsageScanInWorker(databasePath: string): Promise<UsageCommitResult> {
  const store = new UsageStore(databasePath, { recoverInterruptedSync: false });
  let syncStarted = false;
  try {
    store.markSyncStarted();
    syncStarted = true;
    const { usage, incrementals } = await scanUsageForStorage(store);
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
