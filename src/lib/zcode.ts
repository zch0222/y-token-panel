import "server-only";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { HarnessUsage } from "@/lib/usage";
import { collectZcodeUsage, ZCODE_USAGE_SQL } from "@/lib/zcode-usage";

/**
 * 读取 ZCode 的本地用量库（默认 ~/.zcode/cli/db/db.sqlite，即 zcode 默认配置
 * storage.sessionDbPath；ZCODE_DATA_DIR 环境变量可替换 ~/.zcode 根目录，便于
 * 指定其他数据目录或测试注入）。
 *
 * 数据源与字段语义见 src/lib/zcode-usage.ts 文件头。注意 zcode 的 pruneUsage
 * 只保留最近 30 天的 model_usage 行。
 */
export async function readZcodeUsage(): Promise<HarnessUsage> {
  const root = process.env.ZCODE_DATA_DIR
    ? path.resolve(process.env.ZCODE_DATA_DIR)
    : path.join(homedir(), ".zcode");
  const source = path.join(root, "cli", "db", "db.sqlite");

  const unavailable = (skippedFiles = 0): HarnessUsage => ({
    harness: "zcode",
    records: [],
    scannedFiles: 0,
    skippedFiles,
    source,
    sourceAvailable: false,
  });

  try {
    await access(source);
  } catch {
    return unavailable();
  }

  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch (error) {
    // Node < 22.5 没有 node:sqlite；面板其他 Harness 不受影响。
    console.error("ZCode usage skipped: node:sqlite unavailable", error);
    return unavailable();
  }

  let db;
  try {
    db = new DatabaseSync(source, { readOnly: true });
  } catch (error) {
    // 库被独占锁住、文件损坏等：放弃该来源，不影响其他 Harness。
    console.error("ZCode usage skipped: cannot open sqlite db", error);
    return unavailable(1);
  }

  try {
    const rows = db.prepare(ZCODE_USAGE_SQL).all();
    const { records, sessionCount } = collectZcodeUsage(rows);
    return {
      harness: "zcode",
      records,
      scannedFiles: sessionCount,
      skippedFiles: 0,
      source,
      sourceAvailable: true,
    };
  } catch (error) {
    // schema 不含 model_usage / session 表（zcode 版本过旧）等。
    console.error("ZCode usage skipped: query failed", error);
    return unavailable(1);
  } finally {
    db.close();
  }
}
