import "server-only";
import path from "node:path";
import { Worker } from "node:worker_threads";
import {
  getUsageDatabasePath,
  getUsageStore,
  type UsageCommitResult,
} from "@/lib/usage-store";

interface WorkerResultMessage {
  type: "complete";
  result: UsageCommitResult;
}

interface WorkerErrorMessage {
  type: "error";
  error: { message: string; stack?: string };
}

type WorkerMessage = WorkerResultMessage | WorkerErrorMessage;

interface UsageSyncGlobal {
  inFlight?: Promise<UsageCommitResult>;
}

const SYNC_KEY = Symbol.for("y-token-panel.usage-sync");
const DEFAULT_SYNC_TIMEOUT_MS = 10 * 60_000;
const globalSync = globalThis as typeof globalThis & {
  [SYNC_KEY]?: UsageSyncGlobal;
};

function sharedState(): UsageSyncGlobal {
  const existing = globalSync[SYNC_KEY];
  if (existing) return existing;
  const created: UsageSyncGlobal = {};
  globalSync[SYNC_KEY] = created;
  return created;
}

function workerError(message: string, stack?: string): Error {
  const error = new Error(`用量同步 worker 失败: ${message}`);
  if (stack) error.stack = `${error.stack}\n${stack}`;
  return error;
}

function syncTimeoutMs(): number {
  const configured = Number(process.env.USAGE_SYNC_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_SYNC_TIMEOUT_MS;
}

function runWorker(): Promise<UsageCommitResult> {
  const workerPath = path.resolve(process.cwd(), "src", "lib", "usage-scan-worker.cjs");
  return new Promise<UsageCommitResult>((resolve, reject) => {
    // 与 new Worker(...) 等价，但不让 Turbopack 把运行时绝对路径入口转换成
    // 自带 loader；worker 内的原生动态 import 必须绕开 Next 打包器。
    const worker = Reflect.construct(Worker, [
      workerPath,
      {
        workerData: {
          rootDir: process.cwd(),
          databasePath: getUsageDatabasePath(),
        },
        // 不继承 Next 调试参数；Node 22 原生 strip-types 足以执行 worker 入口。
        execArgv: [],
      },
    ]) as Worker;
    let settled = false;

    const succeed = (result: UsageCommitResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    };

    const timeout = setTimeout(() => {
      fail(new Error(`用量同步超过 ${syncTimeoutMs()}ms，已终止 worker；旧快照保持不变`));
      void worker.terminate().catch(() => undefined);
    }, syncTimeoutMs());
    timeout.unref();

    worker.once("message", (message: WorkerMessage) => {
      if (message.type === "complete") {
        succeed(message.result);
      } else {
        fail(workerError(message.error.message, message.error.stack));
      }
    });
    worker.once("error", fail);
    worker.once("exit", (code) => {
      if (!settled) {
        fail(new Error(`用量同步 worker 在提交结果前退出（exit code ${code}）`));
      }
    });
    worker.unref();
  });
}

/** 同一 Next 进程中的所有手动、自动和可见性同步共享同一个 worker。 */
export function requestUsageSync(): Promise<UsageCommitResult> {
  const state = sharedState();
  if (state.inFlight) return state.inFlight;

  const promise = runWorker();
  state.inFlight = promise;
  const clear = () => {
    if (state.inFlight === promise) state.inFlight = undefined;
  };
  void promise.then(clear, clear);

  // worker 自身会记录普通扫描/写库失败；这里兜底记录启动失败和异常退出。
  promise.catch((error) => {
    try {
      getUsageStore().markSyncFailed(error);
    } catch (statusError) {
      console.error("Failed to record worker failure", statusError);
    }
  });
  return promise;
}
