import "server-only";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { HarnessUsage } from "@/lib/usage";
import { collectDevinUsage, DEVIN_USAGE_SQL } from "@/lib/devin-usage";

/**
 * 读取 Devin 的本地会话库（数据根下 cli/sessions.db；数据源与字段语义见
 * src/lib/devin-usage.ts 文件头）。
 *
 * 路径解析对齐本地实际应用代码（Windows devin.exe 与 macOS Devin.app 内
 * extensions/windsurf/devin/bin/devin 的二进制字符串表 + 应用内官方文档）：
 *
 * - macOS 实测（Devin.app 1.12，本机库 ~/.local/share/devin/cli/sessions.db
 *   运行中持续更新）：CLI 二进制含 XDG_DATA_HOME / XDG_CONFIG_HOME 与
 *   ".local"+"share" 路径段、不含 DEVIN_CONFIG_HOME；内置文档
 *   docs/troubleshooting.mdx 写明 macOS/Linux 日志在 ~/.local/share/devin/cli/
 *   （即数据根），docs/extensibility/configuration.mdx 写明用户配置 Unix 在
 *   ~/.config/devin/config.json、Windows 在 %APPDATA%\devin\config.json，
 *   changelog 确认 config（~/.config/devin）/ data（~/.local/share/devin）/
 *   cache（~/.cache/devin）三层目录。即 macOS/Linux 与 Rust dirs 的
 *   ~/Library/Application Support 惯例无关，config 与 data 是两个独立的
 *   XDG 根。
 * - Desktop 扩展（extensions/windsurf/dist/extension.js）airgap 模式同时
 *   设置 XDG_CONFIG_HOME=DEVIN_CONFIG_HOME=airgap 目录；DEVIN_CONFIG_HOME
 *   只出现在 Windows devin.exe 字符表中，且 Windows 实测 config.json 与
 *   cli/sessions.db 同在 %APPDATA%\devin（config 根 = 数据根）。
 *
 * 解析顺序：
 *
 * 1. DEVIN_DATA_DIR 是面板专用覆盖：替换整个数据根（对齐 ZCODE_DATA_DIR
 *    约定，不与官方变量混用），其下仍按 cli/sessions.db 布局；
 * 2. DEVIN_SESSIONS_DIR（官方，changelog：把会话库迁到其他目录，如 NFS
 *    主目录时指到本地盘）：直接指向含 sessions.db 的目录；
 * 3. 平台默认数据根：Windows %APPDATA%\devin（可被 DEVIN_CONFIG_HOME
 *    覆盖，见上）；macOS/Linux $XDG_DATA_HOME/devin 或
 *    ~/.local/share/devin。
 *
 * DEVIN_SESSION_STORE=files（或 config.json 的 session_store:"files"）时 CLI
 * 改用逐会话 log.jsonl/meta.json 文件、不再更新 SQLite（本机未使用该模式），
 * 此时库里只剩陈旧数据，按来源不可用处理，避免展示过期用量。config.json 从
 * 配置根读取（macOS/Linux $XDG_CONFIG_HOME/devin 或 ~/.config/devin、
 * Windows %APPDATA%\devin）；面板 DEVIN_DATA_DIR 替换数据根时优先读其下
 * 的 config.json（库与配置一并沙箱化），缺失或损坏时回退平台配置根。
 */

/** 依赖注入点（测试用）；默认取 process.env、homedir() 与当前平台。 */
export interface DevinPathOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  /** Windows %APPDATA% 等价基目录（测试注入）；仅 win32 分支使用。 */
  appDataDir?: string;
  /** 平台（测试注入，跨平台跑分支用）；默认 process.platform。 */
  platform?: NodeJS.Platform;
}

/** Windows 配置与数据共用的基目录（%APPDATA%，缺省回退 home 下标准路径）。 */
function windowsAppDataDir(
  env: Record<string, string | undefined>,
  home: string,
  appDataDir?: string,
): string {
  return appDataDir ?? env.APPDATA ?? path.join(home, "AppData", "Roaming");
}

/**
 * 数据根（cli/sessions.db 的父目录的父目录）。Windows：config 根与数据根
 * 同为 %APPDATA%\devin（实测布局），可被 DEVIN_CONFIG_HOME 覆盖（该变量
 * 仅见于 devin.exe 字符表）；macOS/Linux：XDG 数据目录 + devin（官方
 * troubleshooting 文档与 macOS 实测，非 ~/Library/Application Support）。
 */
function devinDataRoot({
  env = process.env,
  homeDir = homedir(),
  appDataDir,
  platform = process.platform,
}: DevinPathOptions = {}): string {
  if (platform === "win32") {
    const override = env.DEVIN_CONFIG_HOME?.trim();
    if (override) return path.resolve(override);
    return path.join(windowsAppDataDir(env, homeDir, appDataDir), "devin");
  }
  const xdgData = env.XDG_DATA_HOME?.trim();
  return path.join(
    xdgData ? path.resolve(xdgData) : path.join(homeDir, ".local", "share"),
    "devin",
  );
}

/**
 * 配置根（config.json 所在目录）。Windows：%APPDATA%\devin（可被
 * DEVIN_CONFIG_HOME 覆盖）；macOS/Linux：XDG 配置目录 + devin（官方
 * configuration 文档；CLI 二进制含 XDG_CONFIG_HOME，Desktop airgap 模式
 * 即经它重定向，无 DEVIN_CONFIG_HOME）。
 */
export function devinConfigRoot({
  env = process.env,
  homeDir = homedir(),
  appDataDir,
  platform = process.platform,
}: DevinPathOptions = {}): string {
  if (platform === "win32") {
    const override = env.DEVIN_CONFIG_HOME?.trim();
    if (override) return path.resolve(override);
    return path.join(windowsAppDataDir(env, homeDir, appDataDir), "devin");
  }
  const xdgConfig = env.XDG_CONFIG_HOME?.trim();
  return path.join(
    xdgConfig ? path.resolve(xdgConfig) : path.join(homeDir, ".config"),
    "devin",
  );
}

export function resolveDevinDatabasePath(options: DevinPathOptions = {}): string {
  const env = options.env ?? process.env;

  // 面板专用 DATA_DIR 只替换数据根，不与官方变量混用（对齐 ZCODE_DATA_DIR）。
  const dataDir = env.DEVIN_DATA_DIR?.trim();
  if (dataDir) {
    return path.join(path.resolve(dataDir), "cli", "sessions.db");
  }

  const sessionsDir = env.DEVIN_SESSIONS_DIR?.trim();
  if (sessionsDir) {
    return path.join(path.resolve(sessionsDir), "sessions.db");
  }

  return path.join(devinDataRoot(options), "cli", "sessions.db");
}

/**
 * 判断文件存储模式是否生效（此时 SQLite 库不再更新）。env DEVIN_SESSION_STORE
 * 优先于 config.json 的 session_store 键（设置面板文案："session history store
 * (sqlite/files); DEVIN_SESSION_STORE overrides"；二进制字符串表：
 * "config.json session_store" / "ignoring =: expected `files` or `sqlite`"），
 * 非法值忽略后回落 config.json；config.json 缺失、损坏或字段类型不对时按
 * sqlite，不向外抛错。configRoots 依优先级排列，首个能解析出有效 JSON 的生效。
 */
async function devinFileStoreActive(
  env: Record<string, string | undefined>,
  configRoots: string[],
): Promise<boolean> {
  const override = env.DEVIN_SESSION_STORE?.trim();
  if (override === "files") return true;
  if (override === "sqlite") return false;

  for (const configRoot of configRoots) {
    let content: string;
    try {
      content = await readFile(path.join(configRoot, "config.json"), "utf8");
    } catch {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(content);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        continue;
      }
      return (parsed as { session_store?: unknown }).session_store === "files";
    } catch {
      continue;
    }
  }
  return false;
}

export async function readDevinUsage(
  options: DevinPathOptions = {},
): Promise<HarnessUsage> {
  const env = options.env ?? process.env;
  const source = resolveDevinDatabasePath(options);
  // session_store 配置读配置根下的 config.json；面板专用 DEVIN_DATA_DIR
  // 替换数据根时其下的 config.json 优先（库与配置一并沙箱化），能解析出
  // 有效 JSON 即止，否则回退平台配置根。
  const dataDir = env.DEVIN_DATA_DIR?.trim();
  const configRoots = dataDir
    ? [path.resolve(dataDir), devinConfigRoot(options)]
    : [devinConfigRoot(options)];

  const unavailable = (skippedFiles = 0): HarnessUsage => ({
    harness: "devin",
    records: [],
    scannedFiles: 0,
    skippedFiles,
    source,
    sourceAvailable: false,
  });

  // 文件存储模式下 SQLite 库只剩陈旧数据，不作为可用来源。
  if (await devinFileStoreActive(env, configRoots)) {
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
