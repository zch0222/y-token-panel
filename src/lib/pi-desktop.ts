import "server-only";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parsePiDesktopSession } from "@/lib/pi-desktop-session";
import type { HarnessUsage, UsageRecord } from "@/lib/usage";

/**
 * 数据根定位对齐 PI-Desktop 主进程（app.asar 的 resolveDataDir / prepareStorage）：
 * 1. env PI_DESKTOP_DATA_DIR（trim 后非空）直接作为数据根，此时应用内迁移被拒，
 *    面板同样忽略迁移偏好；
 * 2. 否则读 Electron userData 下的 storage-location.json
 *    （{ version: 1, roots: { data, browser } }），roots.data 是应用内迁移后的
 *    绝对数据根，损坏 / 缺失 / 非法则静默回退默认（对齐 zcode 对 config.json 的处理）；
 * 3. 默认 ~/.pi-desktop（PI_DESKTOP_DEV=1 的开发安装为 ~/.pi-desktop-dev）。
 * 会话转录在其下的 sessions/ 扁平目录里。
 */

const INSTALL_DATA_DIR_NAME = ".pi-desktop";
const DEVELOPMENT_DATA_DIR_NAME = ".pi-desktop-dev";
const APP_NAME = "PI-Desktop";
const DEVELOPMENT_APP_NAME = "PI-Desktop Dev";
const STORAGE_PREFERENCE_FILE = "storage-location.json";

/** Electron userData 的 appData 根（app.getPath("appData") 的平台默认值）。 */
function electronAppDataDir(env: Record<string, string | undefined>, home: string): string {
  if (process.platform === "win32") {
    return env.APPDATA ?? path.join(home, "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support");
  }
  return env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(home, ".config");
}

/** 读应用内存储迁移偏好；只在 version 为 1 且 roots.data 是绝对路径时生效。 */
async function readStoragePreferenceDataDir(appDataDir: string, development: boolean): Promise<string | null> {
  const preferencePath = path.join(
    appDataDir,
    development ? DEVELOPMENT_APP_NAME : APP_NAME,
    STORAGE_PREFERENCE_FILE,
  );
  let content: string;
  try {
    content = await readFile(preferencePath, "utf8");
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(content) as {
      version?: unknown;
      roots?: { data?: unknown };
    };
    const data = value.roots?.data;
    if (
      typeof value.version === "number" &&
      value.version === 1 &&
      typeof data === "string" &&
      data.trim() !== "" &&
      path.isAbsolute(data)
    ) {
      return path.resolve(data);
    }
  } catch {
    // 损坏的偏好文件按未迁移处理。
  }
  return null;
}

/** 依赖注入点（测试用）；默认取 process.env、homedir() 与 Electron appData。 */
export interface PiDesktopSourceOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  appDataDir?: string;
}

export async function resolvePiDesktopDataDir(
  options: PiDesktopSourceOptions = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const development = env.PI_DESKTOP_DEV === "1";
  const override = env.PI_DESKTOP_DATA_DIR?.trim();
  if (override) return path.resolve(override);
  const preferenceDir = await readStoragePreferenceDataDir(
    options.appDataDir ?? electronAppDataDir(env, home),
    development,
  );
  if (preferenceDir) return preferenceDir;
  return path.join(home, development ? DEVELOPMENT_DATA_DIR_NAME : INSTALL_DATA_DIR_NAME);
}

export async function resolvePiDesktopSessionsDir(
  options: PiDesktopSourceOptions = {},
): Promise<string> {
  return path.join(await resolvePiDesktopDataDir(options), "sessions");
}

/** sessions/ 扁平目录里的转录文件；revisions / inflight 等伴随文件不是转录。 */
export function isPiDesktopTranscriptFile(name: string): boolean {
  return name.endsWith(".jsonl") && !name.endsWith(".revisions.jsonl");
}

/**
 * 会话转录里没有项目信息，归属只在 pi.sqlite（sessions.project_id →
 * projects.name，schema 已按本机 0.22.0 实库确认）。这里只读打开、单查询取
 * sessionId → 项目名映射；应用运行中（WAL）并发只读安全，打不开 / 损坏 /
 * 缺表时返回空映射，由调用方保留原标签。
 */
export async function readPiDesktopProjectLabels(dataDir: string): Promise<Map<string, string>> {
  let DatabaseSync: typeof import("node:sqlite").DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    return new Map();
  }
  let db;
  try {
    db = new DatabaseSync(path.join(dataDir, "pi.sqlite"), { readOnly: true });
    const rows = db
      .prepare(
        "SELECT s.id AS session_id, p.name AS project_name FROM sessions s JOIN projects p ON p.id = s.project_id",
      )
      .all() as Array<{ session_id?: unknown; project_name?: unknown }>;
    const labels = new Map<string, string>();
    for (const row of rows) {
      if (
        typeof row.session_id === "string" &&
        typeof row.project_name === "string" &&
        row.project_name !== ""
      ) {
        labels.set(row.session_id, row.project_name);
      }
    }
    return labels;
  } catch {
    return new Map();
  } finally {
    try {
      db?.close();
    } catch {
      // 打开失败时无需关闭。
    }
  }
}

/**
 * 重贴项目标签：映射命中则覆盖（含「未知项目」→ 实名与后续改名），未命中
 * 保留原值——库暂时不可读不让已入库的标签回退。
 */
export function applyPiDesktopProjectLabels(
  records: UsageRecord[],
  labels: Map<string, string>,
): UsageRecord[] {
  if (labels.size === 0) return records;
  return records.map((record) => {
    const label = labels.get(record.sessionId);
    return label && label !== record.project ? { ...record, project: label } : record;
  });
}

export async function readPiDesktopUsage(): Promise<HarnessUsage> {
  const dataDir = await resolvePiDesktopDataDir();
  const source = path.join(dataDir, "sessions");
  const records: UsageRecord[] = [];
  const seen = new Set<string>();
  let scannedFiles = 0;
  let skippedFiles = 0;

  let entries;
  try {
    entries = await readdir(source, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        harness: "pidesktop",
        records: [],
        scannedFiles: 0,
        skippedFiles: 0,
        source,
        sourceAvailable: false,
      };
    }
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !isPiDesktopTranscriptFile(entry.name)) continue;
    scannedFiles += 1;
    try {
      const content = await readFile(path.join(source, entry.name), "utf8");
      for (const record of parsePiDesktopSession(content, entry.name)) {
        if (seen.has(record.id)) continue;
        seen.add(record.id);
        records.push(record);
      }
    } catch {
      skippedFiles += 1;
    }
  }

  records.sort((a, b) => b.timestamp - a.timestamp);
  const labels = await readPiDesktopProjectLabels(dataDir);
  return {
    harness: "pidesktop",
    records: applyPiDesktopProjectLabels(records, labels),
    scannedFiles,
    skippedFiles,
    source,
    sourceAvailable: true,
  };
}
