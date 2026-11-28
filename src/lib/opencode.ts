import "server-only";
// OpenCode 本地 SQLite 数据库读取器。
//
// 路径规则以 @opencode/cli@2.4.2 内嵌源码（module-0029 的 Global.Path 与 module-0087 的
// 数据库文件名解析）为准，并用本机真实库位置复核：
// - 数据目录是 `XDG_DATA_HOME/opencode`；XDG_DATA_HOME 为空/未设置时使用
//   `~/.local/share/opencode`。OpenCode 在 Windows 上也使用这套 xdg-basedir 规则。
// - `OPENCODE_DB` 是 OpenCode 官方数据库路径覆盖项：绝对路径直接使用；相对路径基于上述
//   数据目录 resolve；未设置时默认 `opencode.db`。本地 2.4.2 release channel 是 latest，
//   所以默认文件名就是 `opencode.db`（非 latest/dev/beta/next/prod 的罕见 channel 会改名，
//   本面板不猜测 channel，必要时可用 OPENCODE_DB 显式指定）。
// - `OPENCODE_DB=:memory:` 是 OpenCode 的内存测试模式；内存库不在进程外可见，因此面板只能
//   将其视为不可扫描来源。
// - `OPENCODE_DATA_DIR` 不是 OpenCode 官方变量，而是 y-token-panel 与其他 harness 保持一致的
//   本地覆盖项，优先级高于 XDG 数据目录；它表示 OpenCode 数据目录本身，不是数据库文件路径。

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  collectOpenCodeUsage,
  OPENCODE_V1_USAGE_SQL,
  OPENCODE_V2_USAGE_SQL,
  type OpenCodeUsageRow,
  type OpenCodeSchemaVersion,
} from "@/lib/opencode-usage";
import type { HarnessUsage } from "@/lib/usage";

export function resolveOpenCodeDataDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (env.OPENCODE_DATA_DIR?.trim()) return path.resolve(env.OPENCODE_DATA_DIR.trim());
  const xdgDataHome = env.XDG_DATA_HOME || path.join(home, ".local", "share");
  return path.join(xdgDataHome, "opencode");
}

export function resolveOpenCodeDatabasePath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const dataDir = resolveOpenCodeDataDir(env, home);
  if (env.OPENCODE_DB !== undefined) return path.resolve(dataDir, env.OPENCODE_DB);
  return path.join(dataDir, "opencode.db");
}

function tableNames(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function detectSchema(tables: Set<string>): OpenCodeSchemaVersion | undefined {
  if (tables.has("session_v2") && tables.has("session_message")) return "v2";
  if (tables.has("session") && tables.has("message")) return "v1";
  return undefined;
}

function countSessions(db: DatabaseSync, schema: OpenCodeSchemaVersion): number {
  const table = schema === "v2" ? "session_v2" : "session";
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return Number(row.count) || 0;
}

export async function readOpenCodeUsage(): Promise<HarnessUsage> {
  const databasePath = resolveOpenCodeDatabasePath();
  const unavailable = {
    harness: "opencode" as const,
    records: [],
    scannedFiles: 0,
    skippedFiles: 0,
    source: databasePath,
    sourceAvailable: false,
  };
  if (databasePath.endsWith(":memory:") || !existsSync(databasePath)) return unavailable;

  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const schema = detectSchema(tableNames(db));
    if (!schema) return { ...unavailable, sourceAvailable: true };
    const sql = schema === "v2" ? OPENCODE_V2_USAGE_SQL : OPENCODE_V1_USAGE_SQL;
    const rows = db.prepare(sql).all() as unknown as OpenCodeUsageRow[];
    return {
      harness: "opencode",
      records: collectOpenCodeUsage(rows, schema),
      scannedFiles: countSessions(db, schema),
      skippedFiles: 0,
      source: databasePath,
      sourceAvailable: true,
    };
  } finally {
    db.close();
  }
}
