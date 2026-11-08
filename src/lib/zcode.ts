import "server-only";
import { access, readFile } from "node:fs/promises";
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
interface ZcodePathOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 与本机 ZCode CLI（resources/glm/zcode.cjs）中的 resolvePath（ag）一致：
 * `~/` 前缀拼到 homeDir 下，其余路径（含相对路径）走 path.resolve。
 */
function resolveZcodePath(value: string, homeDir: string): string {
  return value.startsWith("~/")
    ? path.join(homeDir, value.slice(2))
    : path.resolve(value);
}

/**
 * 读取并校验 ~/.zcode/cli/config.json 中的 storage.sessionDbPath，对齐
 * zcode.cjs 的 loadFileConfig（Zve）与 Sna schema：文件缺失、JSON 损坏或字段
 * 类型不合法时均静默回退默认配置，不向外抛错。
 */
async function readUserConfigSessionDbPath(homeDir: string): Promise<string | undefined> {
  const configPath = path.join(homeDir, ".zcode", "cli", "config.json");
  let content: string;
  try {
    content = await readFile(configPath, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isPlainRecord(parsed)) return undefined;
  if (parsed.storage === undefined) return undefined;
  if (!isPlainRecord(parsed.storage)) return undefined;
  const { dir, sessionDbPath } = parsed.storage;
  if (dir !== undefined && (typeof dir !== "string" || dir.length === 0)) {
    return undefined;
  }
  if (
    sessionDbPath !== undefined &&
    (typeof sessionDbPath !== "string" || sessionDbPath.length === 0)
  ) {
    return undefined;
  }
  return sessionDbPath;
}

export async function resolveZcodeDatabasePath({
  env = process.env,
  homeDir = homedir(),
}: ZcodePathOptions = {}): Promise<string> {
  // 面板专用 DATA_DIR 只替换 ~/.zcode 根，不与官方配置文件混用。
  const dataDir = env.ZCODE_DATA_DIR?.trim();
  if (dataDir) {
    return path.join(path.resolve(dataDir), "cli", "db", "db.sqlite");
  }

  // 对齐 zcode.cjs 的 parseEnvConfig（J4e）与 ConfigStore：按对象枚举顺序让后出现的
  // ZCODE_SESSION_DB_PATH / ZCODE_SESSION_DB 覆盖前一个；仅非空字符串写入 Env 层。
  let environmentPath: string | undefined;
  for (const [key, value] of Object.entries(env)) {
    if ((key === "ZCODE_SESSION_DB_PATH" || key === "ZCODE_SESSION_DB") && value !== undefined) {
      environmentPath = value;
    }
  }
  if (environmentPath) {
    return resolveZcodePath(environmentPath, homeDir);
  }

  const configuredPath = await readUserConfigSessionDbPath(homeDir);
  if (configuredPath) {
    return resolveZcodePath(configuredPath, homeDir);
  }

  return path.join(homeDir, ".zcode", "cli", "db", "db.sqlite");
}

export async function readZcodeUsage(): Promise<HarnessUsage> {
  const source = await resolveZcodeDatabasePath();

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
