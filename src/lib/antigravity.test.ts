import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  antigravityRoots,
  discoverAntigravityTranscripts,
  readAntigravityUsage,
} from "@/lib/antigravity";

const roots: string[] = [];
const originalDataDir = process.env.ANTIGRAVITY_DATA_DIR;

beforeEach(() => {
  delete process.env.ANTIGRAVITY_DATA_DIR;
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.ANTIGRAVITY_DATA_DIR;
  else process.env.ANTIGRAVITY_DATA_DIR = originalDataDir;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "y-token-antigravity-"));
  roots.push(root);
  return root;
}

function transcriptLine(stepIndex: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    step_index: stepIndex,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: "2026-11-08T17:52:13Z",
    input_tokens: 1000,
    cache_read_tokens: 200,
    output_tokens: 40,
    ...overrides,
  });
}

async function writeTranscript(
  root: string,
  conversationId: string,
  name: "transcript.jsonl" | "transcript_full.jsonl",
  lines: string[],
): Promise<string> {
  const logs = path.join(
    root,
    "brain",
    conversationId,
    ".system_generated",
    "logs",
  );
  await mkdir(logs, { recursive: true });
  const filePath = path.join(logs, name);
  await writeFile(filePath, lines.join("\n") + "\n");
  return filePath;
}

function writeSummaries(root: string, rows: Array<[string, string]>): void {
  const db = new DatabaseSync(path.join(root, "conversation_summaries.db"));
  db.exec(
    "CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT NOT NULL)",
  );
  const insert = db.prepare(
    "INSERT INTO conversation_summaries (conversation_id, workspace_uris) VALUES (?, ?)",
  );
  for (const [id, uris] of rows) insert.run(id, uris);
  db.close();
}

describe("Antigravity 路径与数据源", () => {
  it("默认同时尝试 IDE 与 CLI 根，DATA_DIR 覆盖为单一根", () => {
    expect(antigravityRoots({ env: {}, homeDir: "C:\\Users\\demo" })).toEqual([
      path.join("C:\\Users\\demo", ".gemini", "antigravity"),
      path.join("C:\\Users\\demo", ".gemini", "antigravity-cli"),
    ]);
    expect(
      antigravityRoots({ env: { ANTIGRAVITY_DATA_DIR: "  D:\\agy  " }, homeDir: "C:\\Users\\demo" }),
    ).toEqual([path.resolve("D:\\agy")]);
    expect(
      antigravityRoots({ env: { ANTIGRAVITY_DATA_DIR: "   " }, homeDir: "C:\\Users\\demo" }),
    ).toEqual([
      path.join("C:\\Users\\demo", ".gemini", "antigravity"),
      path.join("C:\\Users\\demo", ".gemini", "antigravity-cli"),
    ]);
  });

  it("优先紧凑转录，缺失时回退 transcript_full.jsonl，并跳过非会话目录", async () => {
    const root = await temporaryRoot();
    await writeTranscript(root, "conv-compact", "transcript.jsonl", [transcriptLine(1)]);
    await writeTranscript(root, "conv-full", "transcript_full.jsonl", [transcriptLine(2)]);
    await mkdir(path.join(root, "brain", "tempmediaStorage"), { recursive: true });

    const discovery = await discoverAntigravityTranscripts({
      env: { ANTIGRAVITY_DATA_DIR: root },
    });
    expect(discovery.source).toBe(path.join(root, "brain"));
    expect(discovery.scannedFiles).toBe(2);
    expect(discovery.skippedFiles).toBe(0);
    expect(discovery.files.map((file) => file.conversationId).sort()).toEqual([
      "conv-compact",
      "conv-full",
    ]);
    expect(discovery.files.map((file) => path.basename(file.filePath)).sort()).toEqual([
      "transcript.jsonl",
      "transcript_full.jsonl",
    ]);
    expect(discovery.files.every((file) => file.project === "未知项目")).toBe(true);
  });

  it("从 conversation_summaries 读取项目归属；库缺失时退回未知项目", async () => {
    const root = await temporaryRoot();
    writeSummaries(root, [
      ["conv-a", '["file:///d%3A/code/y-token-panel"]'],
      ["conv-b", "[]"],
    ]);
    await writeTranscript(root, "conv-a", "transcript.jsonl", [transcriptLine(1)]);
    await writeTranscript(root, "conv-b", "transcript.jsonl", [transcriptLine(2)]);
    await writeTranscript(root, "conv-c", "transcript.jsonl", [transcriptLine(3)]);

    const usage = await readAntigravityUsage({ env: { ANTIGRAVITY_DATA_DIR: root } });
    const bySession = new Map(usage.records.map((record) => [record.sessionId, record.project]));
    expect(bySession.get("conv-a")).toBe("y-token-panel");
    expect(bySession.get("conv-b")).toBe("未知项目");
    expect(bySession.get("conv-c")).toBe("未知项目");
    expect(usage.harness).toBe("antigravity");
    expect(usage.sourceAvailable).toBe(true);
  });

  it("合并 IDE 与 CLI 两个根，同一会话 ID 只保留一条", async () => {
    const home = await temporaryRoot();
    const ide = path.join(home, ".gemini", "antigravity");
    const cli = path.join(home, ".gemini", "antigravity-cli");
    await writeTranscript(ide, "shared", "transcript.jsonl", [transcriptLine(1)]);
    await writeTranscript(ide, "ide-only", "transcript.jsonl", [transcriptLine(2)]);
    await writeTranscript(cli, "shared", "transcript.jsonl", [
      transcriptLine(1, { output_tokens: 99 }),
    ]);
    await writeTranscript(cli, "cli-only", "transcript.jsonl", [transcriptLine(3)]);

    const usage = await readAntigravityUsage({ env: {}, homeDir: home });
    // 两个根下同名会话的路径不同，但记录 ID 相同：后读的 CLI 覆盖 IDE。
    expect(usage.records.map((record) => record.sessionId).sort()).toEqual([
      "cli-only",
      "ide-only",
      "shared",
    ]);
    expect(
      usage.records.find((record) => record.sessionId === "shared")?.outputTokens,
    ).toBe(99);
  });

  it("数据目录不存在时 sourceAvailable 为 false 且不抛错", async () => {
    const home = await temporaryRoot();
    const usage = await readAntigravityUsage({ env: {}, homeDir: home });
    expect(usage).toMatchObject({
      harness: "antigravity",
      records: [],
      scannedFiles: 0,
      sourceAvailable: false,
    });
  });

  it("单个会话文件读取失败只增加 skippedFiles，不影响其他会话", async () => {
    const root = await temporaryRoot();
    await writeTranscript(root, "conv-ok", "transcript.jsonl", [transcriptLine(1)]);
    const broken = await writeTranscript(root, "conv-broken", "transcript.jsonl", [
      transcriptLine(2),
    ]);
    // 先 discovery 再让文件消失：模拟读取阶段的失败。
    await rm(broken);

    const usage = await readAntigravityUsage({ env: { ANTIGRAVITY_DATA_DIR: root } });
    expect(usage.records).toHaveLength(1);
    expect(usage.skippedFiles).toBe(1);
  });
});
