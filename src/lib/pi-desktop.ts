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

export async function resolvePiDesktopSessionsDir(
  options: PiDesktopSourceOptions = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const development = env.PI_DESKTOP_DEV === "1";
  const override = env.PI_DESKTOP_DATA_DIR?.trim();
  if (override) return path.join(path.resolve(override), "sessions");
  const preferenceDir = await readStoragePreferenceDataDir(
    options.appDataDir ?? electronAppDataDir(env, home),
    development,
  );
  if (preferenceDir) return path.join(preferenceDir, "sessions");
  return path.join(home, development ? DEVELOPMENT_DATA_DIR_NAME : INSTALL_DATA_DIR_NAME, "sessions");
}

/** sessions/ 扁平目录里的转录文件；revisions / inflight 等伴随文件不是转录。 */
export function isPiDesktopTranscriptFile(name: string): boolean {
  return name.endsWith(".jsonl") && !name.endsWith(".revisions.jsonl");
}

export async function readPiDesktopUsage(): Promise<HarnessUsage> {
  const source = await resolvePiDesktopSessionsDir();
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
  return {
    harness: "pidesktop",
    records,
    scannedFiles,
    skippedFiles,
    source,
    sourceAvailable: true,
  };
}
