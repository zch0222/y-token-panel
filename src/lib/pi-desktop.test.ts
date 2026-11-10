import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  applyPiDesktopProjectLabels,
  readPiDesktopProjectLabels,
} from "@/lib/pi-desktop";
import type { UsageRecord } from "@/lib/usage";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "pi-desktop-projects-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 最小 pi.sqlite：只含项目映射查询用到的表与列（实库 schema 见 pi-desktop.ts 头注）。 */
function writeProjectDatabase(
  projects: Array<{ id: number; name: string }>,
  sessions: Array<{ id: string; projectId: number | null }>,
): void {
  const db = new DatabaseSync(path.join(root, "pi.sqlite"));
  try {
    db.exec("CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id INTEGER)");
    for (const project of projects) {
      db.prepare("INSERT INTO projects (id, name) VALUES (?, ?)").run(project.id, project.name);
    }
    for (const session of sessions) {
      db.prepare("INSERT INTO sessions (id, project_id) VALUES (?, ?)").run(
        session.id,
        session.projectId,
      );
    }
  } finally {
    db.close();
  }
}

function record(sessionId: string, project: string): UsageRecord {
  return {
    id: `pidesktop:${sessionId}:op`,
    requestId: "op",
    sessionId,
    harness: "pidesktop",
    project,
    model: "kimi-k3-1-pro-261024",
    provider: "Moonshot AI",
    timestamp: 1_794_000_000_000,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 2,
    inputTokenSemantics: "fresh",
    hasTokenUsage: true,
    credits: 0,
    hasCredit: false,
    status: "success",
  };
}

describe("readPiDesktopProjectLabels（pi.sqlite 只读映射）", () => {
  it("JOIN projects 取 sessionId → 项目名；无项目 / 空名的会话不入映射", async () => {
    writeProjectDatabase(
      [
        { id: 1, name: "y-token-panel" },
        { id: 2, name: "" },
      ],
      [
        { id: "session-a", projectId: 1 },
        { id: "session-b", projectId: null },
        { id: "session-c", projectId: 2 },
        { id: "session-d", projectId: 999 },
      ],
    );
    const labels = await readPiDesktopProjectLabels(root);
    expect(Array.from(labels.entries())).toEqual([["session-a", "y-token-panel"]]);
  });

  it("库缺失或损坏时返回空映射（保留调用方原标签）", async () => {
    expect(await readPiDesktopProjectLabels(root)).toEqual(new Map());
    await writeFile(path.join(root, "pi.sqlite"), "not a sqlite file");
    expect(await readPiDesktopProjectLabels(root)).toEqual(new Map());
  });
});

describe("applyPiDesktopProjectLabels", () => {
  it("命中映射覆盖未知项目与后续改名；未命中保留原值；空映射原样返回", () => {
    const records = [record("session-a", "未知项目"), record("session-b", "旧名")];
    expect(applyPiDesktopProjectLabels(records, new Map())).toBe(records);

    const relabeled = applyPiDesktopProjectLabels(
      records,
      new Map([
        ["session-a", "y-token-panel"],
        ["session-b", "renamed"],
      ]),
    );
    expect(relabeled.map((item) => item.project)).toEqual(["y-token-panel", "renamed"]);
    // 原数组不被就地修改。
    expect(records[0]!.project).toBe("未知项目");

    const partial = applyPiDesktopProjectLabels(
      records,
      new Map([["session-a", "y-token-panel"]]),
    );
    expect(partial.map((item) => item.project)).toEqual(["y-token-panel", "旧名"]);
  });
});
