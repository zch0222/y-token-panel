import "server-only";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { HarnessUsage } from "@/lib/usage";
import { collectDevinUsage, DEVIN_USAGE_SQL } from "@/lib/devin-usage";

/**
 * 读取 Devin 的本地会话库（默认 %APPDATA%\devin\cli\sessions.db，即 Devin CLI
 * 在配置根下的 cli/sessions.db；数据源与字段语义见 src/lib/devin-usage.ts 文件头）。
 *
 * 路径解析对齐本机 devin.exe 二进制字符串表（"devin"→"cli"→"sessions.db" 与
 * DEVIN_SESSIONS_DIR / DEVIN_SESSION_STORE / DEVIN_CONFIG_HOME）与官方文档
 * （docs/extensibility/configuration.mdx：Windows "%APPDATA%\devin\config.json"、
 * 其余 "~/.config/devin/config.json"；changelog：DEVIN_SESSIONS_DIR 迁移会话库、
 * DEVIN_SESSION_STORE=files 改用文件存储）：
 *
 * 1. DEVIN_DATA_DIR 是面板专用覆盖：替换整个配置根（对齐 ZCODE_DATA_DIR 约定，
 *    不与官方变量混用），其下仍按 cli/sessions.db 布局；
 * 2. DEVIN_SESSIONS_DIR（官方）：直接指向含 sessions.db 的目录；
 * 3. DEVIN_CONFIG_HOME（官方，Desktop airgap 模式使用）：配置根；
 * 4. 平台默认配置根（Rust dirs::config_dir 惯例）：Windows %APPDATA%\devin
 *    （NTFS 大小写不敏感，与 Roaming\Devin 同一目录）、macOS
 *    ~/Library/Application Support/devin、其余 ~/.config/devin。
 *
 * DEVIN_SESSION_STORE=files（或 config.json 的 session_store:"files"）时 CLI 改用
 * 逐会话 log.jsonl/meta.json 文件、不再更新 SQLite（本机未使用该模式），此时库
 * 里只剩陈旧数据，按来源不可用处理，避免展示过期用量。
 */

/** 依赖注入点（测试用）；默认取 process.env、homedir() 与平台配置根。 */
export interface DevinPathOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  appDataDir?: string;
}

/** 平台配置根（Rust dirs::config_dir 惯例，文档给出的默认路径为其常见值）。 */
function devinAppDataDir(
  env: Record<string, string | undefined>,
  home: string,
): string {
  if (process.platform === "win32") {
    return env.APPDATA ?? path.join(home, "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support");
  }
  return env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(home, ".config");
}

export function devinConfigRoot({
  env = process.env,
  homeDir = homedir(),
  appDataDir,
}: DevinPathOptions = {}): string {
  const override = env.DEVIN_CONFIG_HOME?.trim();
  if (override) return path.resolve(override);
  return path.join(appDataDir ?? devinAppDataDir(env, homeDir), "devin");
}

/**
 * 判断文件存储模式是否生效（此时 SQLite 库不再更新）。env DEVIN_SESSION_STORE
 * 优先于 config.json 的 session_store 键（二进制内 "=files =sqlite default
 * DEVIN_SESSION_STORE config.json session_store" 解析顺序），默认 sqlite；
 * config.json 缺失、损坏或字段类型不对时按 sqlite，不向外抛错。
 */
async function devinFileStoreActive(
  env: Record<string, string | undefined>,
  configRoot: string,
): Promise<boolean> {
  if (env.DEVIN_SESSION_STORE?.trim() === "files") return true;
  let content: string;
  try {
    content = await readFile(path.join(configRoot, "config.json"), "utf8");
  } catch {
    return false;
  }
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return false;
    }
    return (parsed as { session_store?: unknown }).session_store === "files";
  } catch {
    return false;
  }
}

export function resolveDevinDatabasePath(options: DevinPathOptions = {}): string {
  const env = options.env ?? process.env;

  // 面板专用 DATA_DIR 只替换配置根，不与官方变量混用（对齐 ZCODE_DATA_DIR）。
  const dataDir = env.DEVIN_DATA_DIR?.trim();
  if (dataDir) {
    return path.join(path.resolve(dataDir), "cli", "sessions.db");
  }

  const sessionsDir = env.DEVIN_SESSIONS_DIR?.trim();
  if (sessionsDir) {
    return path.join(path.resolve(sessionsDir), "sessions.db");
  }

  return path.join(devinConfigRoot(options), "cli", "sessions.db");
}

export async function readDevinUsage(
  options: DevinPathOptions = {},
): Promise<HarnessUsage> {
  const env = options.env ?? process.env;
  const source = resolveDevinDatabasePath(options);
  // session_store 配置始终读配置根下的 config.json；面板专用 DEVIN_DATA_DIR
  // 替换配置根时也随之替换（库与配置同根）。
  const configRoot = env.DEVIN_DATA_DIR?.trim()
    ? path.resolve(env.DEVIN_DATA_DIR.trim())
    : devinConfigRoot(options);

  const unavailable = (skippedFiles = 0): HarnessUsage => ({
    harness: "devin",
    records: [],
    scannedFiles: 0,
    skippedFiles,
    source,
    sourceAvailable: false,
  });

  // 文件存储模式下 SQLite 库只剩陈旧数据，不作为可用来源。
  if (await devinFileStoreActive(env, configRoot)) {
    return unavailable();
  }

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
    console.error("Devin usage skipped: node:sqlite unavailable", error);
    return unavailable();
  }

  let db;
  try {
    // Devin 运行中库为 WAL 模式，并发只读安全（与 pi.sqlite 同款口径）。
    db = new DatabaseSync(source, { readOnly: true });
  } catch (error) {
    // 库被独占锁住、文件损坏等：放弃该来源，不影响其他 Harness。
    console.error("Devin usage skipped: cannot open sqlite db", error);
    return unavailable(1);
  }

  try {
    const rows = db.prepare(DEVIN_USAGE_SQL).all();
    const { records, sessionCount } = collectDevinUsage(rows);
    return {
      harness: "devin",
      records,
      scannedFiles: sessionCount,
      skippedFiles: 0,
      source,
      sourceAvailable: true,
    };
  } catch (error) {
    // schema 不含 message_nodes / sessions 表（Devin 版本过旧）等。
    console.error("Devin usage skipped: query failed", error);
    return unavailable(1);
  } finally {
    db.close();
  }
}
