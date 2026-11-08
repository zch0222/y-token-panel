/* eslint-disable @typescript-eslint/no-require-imports -- 独立 Node worker 以 CJS 启动，再动态加载原生 TypeScript。 */
const { existsSync, statSync } = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { registerHooks } = require("node:module");
const { parentPort, workerData } = require("node:worker_threads");

function resolveFile(base) {
  const candidates = [base, `${base}.ts`, `${base}.js`, path.join(base, "index.ts")];
  return candidates.find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
}

// Next 在编译时提供这两个解析行为。独立 Node worker 需要显式复刻，且只影响
// 本 worker；不会修改 Next 主线程或项目的模块解析配置。
registerHooks({
  resolve(specifier, context, nextResolve) {
    let base;
    if (specifier.startsWith("@/")) {
      base = path.join(workerData.rootDir, "src", specifier.slice(2));
    } else if (specifier === "server-only") {
      return { url: "data:text/javascript,export%20%7B%7D", shortCircuit: true };
    }

    if (base) {
      const file = resolveFile(base);
      if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

async function main() {
  const entryUrl = pathToFileURL(
    path.join(workerData.rootDir, "src", "lib", "usage-worker-entry.ts"),
  ).href;
  const { runUsageScanInWorker } = await import(entryUrl);
  const result = await runUsageScanInWorker(workerData.databasePath);
  parentPort.postMessage({ type: "complete", result });
}

main().catch((error) => {
  parentPort.postMessage({
    type: "error",
    error: {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    },
  });
  process.exitCode = 1;
});
