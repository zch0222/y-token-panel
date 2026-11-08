import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readAntigravityUsage } from "@/lib/antigravity";
import { readAntigravityUsageIncremental } from "@/lib/antigravity-incremental";
import type { IncrementalUsageResult } from "@/lib/incremental-core";
import type { UsageResponse } from "@/lib/usage";
import { UsageStore } from "@/lib/usage-store";

let root: string;
let store: UsageStore;
let now = Date.parse("2026-11-09T00:00:00Z");

function transcriptLine(stepIndex: number, outputTokens = 40): string {
  return JSON.stringify({
    step_index: stepIndex,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: new Date(now + stepIndex * 1000).toISOString(),
    input_tokens: 1000,
    cache_read_tokens: 200,
    output_tokens: outputTokens,
  });
}

function conversationDir(conversationId: string): string {
  return path.join(
    root,
    "brain",
    conversationId,
    ".system_generated",
    "logs",
  );
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "y-token-antigravity-inc-"));
  process.env.ANTIGRAVITY_DATA_DIR = root;
  store = new UsageStore(":memory:");
});

afterEach(async () => {
  store.close();
  delete process.env.ANTIGRAVITY_DATA_DIR;
  await rm(root, { recursive: true, force: true });
});

async function sync(): Promise<IncrementalUsageResult> {
  const result = await readAntigravityUsageIncremental(store);
  const { records, ...source } = result.usage;
  const usage: UsageResponse = {
    records,
    sources: [{ ...source, recordCount: records.length }],
    scannedFiles: result.usage.scannedFiles,
    skippedFiles: result.usage.skippedFiles,
    syncedAt: now,
  };
  store.markSyncStarted(now);
  store.commitSnapshot(usage, now + 10, [result.transaction]);
  now += 1000;
  return result;
}

describe("Antigravity 增量导入", () => {
  it("冷导入与全量 reader 一致；未变化零读取；追加后整读并保持一致", async () => {
    const logs = conversationDir("conv-a");
    await mkdir(logs, { recursive: true });
    const filePath = path.join(logs, "transcript.jsonl");
    await writeFile(filePath, transcriptLine(1) + "\n" + transcriptLine(2) + "\n");

    const baseline = await readAntigravityUsage();
    const imported = await sync();
    expect(imported.usage).toEqual(baseline);
    expect(imported.stats.rebuilds).toBe(1);
    expect(store.getSessionLogStates("antigravity")).toHaveLength(1);

    const unchanged = await sync();
    expect(unchanged.stats).toMatchObject({
      bodyBytesRead: 0,
      verificationBytesRead: 0,
      unchangedFiles: 1,
      incrementalFilesRead: 0,
    });

    await appendFile(filePath, transcriptLine(3) + "\n");
    const incremental = await sync();
    expect(incremental.stats).toMatchObject({ incrementalFilesRead: 1, rebuilds: 0 });
    expect(incremental.usage.records).toHaveLength(3);
    expect(incremental.usage.records).toEqual((await readAntigravityUsage()).records);
  });

  it("转录被截断重写时来源级重建，不保留已消失的记录", async () => {
    const logs = conversationDir("conv-a");
    await mkdir(logs, { recursive: true });
    const filePath = path.join(logs, "transcript.jsonl");
    await writeFile(filePath, transcriptLine(1) + "\n" + transcriptLine(2) + "\n");
    await sync();
    expect(store.readNormalizedRecords("antigravity")).toHaveLength(2);

    await writeFile(filePath, transcriptLine(1, 77) + "\n");
    const rebuilt = await sync();
    expect(rebuilt.stats.rebuilds).toBe(1);
    expect(rebuilt.usage.records).toHaveLength(1);
    expect(rebuilt.usage.records[0]?.outputTokens).toBe(77);
    expect(store.readNormalizedRecords("antigravity")).toHaveLength(1);
  });

  it("新增与删除会话目录触发来源级重建", async () => {
    const logsA = conversationDir("conv-a");
    await mkdir(logsA, { recursive: true });
    await writeFile(path.join(logsA, "transcript.jsonl"), transcriptLine(1) + "\n");
    await sync();

    const logsB = conversationDir("conv-b");
    await mkdir(logsB, { recursive: true });
    await writeFile(path.join(logsB, "transcript.jsonl"), transcriptLine(2) + "\n");
    const grown = await sync();
    expect(grown.stats.rebuilds).toBe(1);
    expect(grown.usage.records).toHaveLength(2);

    await rm(path.join(root, "brain", "conv-b"), { recursive: true, force: true });
    const shrunk = await sync();
    expect(shrunk.stats.rebuilds).toBe(1);
    expect(shrunk.usage.records).toHaveLength(1);
    expect(store.getDedupKeys("antigravity")).toHaveLength(1);
  });
});
