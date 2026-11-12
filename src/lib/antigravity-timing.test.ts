import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { readAntigravityUsage } from "@/lib/antigravity";
import { readAntigravityUsageIncremental } from "@/lib/antigravity-incremental";
import { parseAntigravityTranscript } from "@/lib/antigravity-session";
import { readGenerationTimings } from "@/lib/antigravity-timing";
import {
  formatEstimatedTokensPerSecond,
  sumSpeedTotals,
} from "@/lib/speed";
import { UsageStore } from "@/lib/usage-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "y-token-antigravity-timing-"));
  roots.push(root);
  return root;
}

// --- 最小 protobuf 编码器：只构造测试需要的字段 -----------------------------

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

function tag(field: number, wireType: number): Buffer {
  return varint((field << 3) | wireType);
}

function bytesField(field: number, value: Buffer): Buffer {
  return Buffer.concat([tag(field, 2), varint(value.length), value]);
}

function varintField(field: number, value: number): Buffer {
  return Buffer.concat([tag(field, 0), varint(value)]);
}

function duration(seconds: number, nanos: number): Buffer {
  return Buffer.concat([varintField(1, seconds), varintField(2, nanos)]);
}

function millisDuration(millis: number): Buffer {
  return duration(Math.floor(millis / 1000), (millis % 1000) * 1_000_000);
}

/** steps.metadata：field 20 GenerationReference { field 3 index }。 */
function stepMetadata(generationIndex: number): Buffer {
  const reference = varintField(3, generationIndex);
  return bytesField(20, reference);
}

/** gen_metadata.data：field 1 { field 11 首字 + field 12 流式 }。 */
function generationMetadata(firstTokenMs: number, streamingMs: number): Buffer {
  return bytesField(
    1,
    Buffer.concat([
      bytesField(11, millisDuration(firstTokenMs)),
      bytesField(12, millisDuration(streamingMs)),
    ]),
  );
}

function writeDatabase(
  dbPath: string,
  steps: Array<{ idx: number; stepType: number; metadata: Buffer }>,
  generations: Array<{ idx: number; data: Buffer }>,
): void {
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, metadata BLOB);" +
      "CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB NOT NULL);",
  );
  const insertStep = db.prepare("INSERT INTO steps VALUES (?, ?, ?)");
  for (const step of steps) insertStep.run(step.idx, step.stepType, step.metadata);
  const insertGeneration = db.prepare("INSERT INTO gen_metadata VALUES (?, ?)");
  for (const generation of generations) insertGeneration.run(generation.idx, generation.data);
  db.close();
}

describe("readGenerationTimings", () => {
  it("按 steps.metadata 的 generation 索引读取首字 + 流式耗时；默认为 0", async () => {
    const root = await temporaryRoot();
    const dbPath = path.join(root, "conv.db");
    writeDatabase(
      dbPath,
      [
        { idx: 1, stepType: 15, metadata: stepMetadata(0) },
        { idx: 5, stepType: 15, metadata: stepMetadata(1) },
        { idx: 9, stepType: 132, metadata: stepMetadata(2) },
      ],
      [
        { idx: 0, data: generationMetadata(7355, 658) },
        { idx: 1, data: generationMetadata(6145, 589) },
        { idx: 2, data: generationMetadata(1000, 0) },
      ],
    );
    expect(readGenerationTimings(dbPath)).toEqual(
      new Map([
        [1, { durationMs: 8013, firstTokenMs: 7355 }],
        [5, { durationMs: 6734, firstTokenMs: 6145 }],
      ]),
    );
  });

  it("忽略非 PLANNER_RESPONSE、缺失耗时与损坏数据", async () => {
    const root = await temporaryRoot();
    const dbPath = path.join(root, "conv.db");
    writeDatabase(
      dbPath,
      [
        { idx: 1, stepType: 15, metadata: stepMetadata(0) },
        { idx: 2, stepType: 15, metadata: stepMetadata(1) },
        { idx: 3, stepType: 15, metadata: Buffer.from([0xff, 0xff, 0xff]) },
        { idx: 4, stepType: 23, metadata: stepMetadata(2) },
        { idx: 5, stepType: 15, metadata: Buffer.from([]) },
      ],
      [{ idx: 0, data: generationMetadata(1000, 500) }],
    );
    expect(readGenerationTimings(dbPath)).toEqual(
      new Map([[1, { durationMs: 1500, firstTokenMs: 1000 }]]),
    );
  });

  it("库不存在或不是 SQLite 时返回空表而不抛错", async () => {
    const root = await temporaryRoot();
    expect(readGenerationTimings(path.join(root, "missing.db"))).toEqual(new Map());
    const invalid = path.join(root, "invalid.db");
    await writeFile(invalid, "not a database");
    expect(readGenerationTimings(invalid)).toEqual(new Map());
  });
});

describe("Antigravity 耗时接入", () => {
  it("PLANNER_RESPONSE 使用原生库耗时，CHECKPOINT 不含耗时", async () => {
    const root = await temporaryRoot();
    const logs = path.join(root, "brain", "conv-a", ".system_generated", "logs");
    await mkdir(logs, { recursive: true });
    const planner = JSON.stringify({
      step_index: 1,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-11-08T17:52:13Z",
      input_tokens: 10587,
      cache_read_tokens: 0,
      output_tokens: 414,
    });
    const checkpoint = JSON.stringify({
      step_index: 88,
      type: "CHECKPOINT",
      status: "DONE",
      created_at: "2026-11-08T18:02:30Z",
      input_tokens: 14736,
      cache_read_tokens: 243879,
      output_tokens: 7507,
    });
    await writeFile(path.join(logs, "transcript.jsonl"), planner + "\n" + checkpoint + "\n");

    const conversations = path.join(root, "conversations");
    await mkdir(conversations, { recursive: true });
    writeDatabase(
      path.join(conversations, "conv-a.db"),
      [
        { idx: 1, stepType: 15, metadata: stepMetadata(0) },
        { idx: 88, stepType: 23, metadata: stepMetadata(1) },
      ],
      [
        { idx: 0, data: generationMetadata(7000, 1013) },
        { idx: 1, data: generationMetadata(9000, 2000) },
      ],
    );

    const usage = await readAntigravityUsage({ env: { ANTIGRAVITY_DATA_DIR: root } });
    const byId = new Map(usage.records.map((record) => [record.id, record]));
    expect(byId.get("antigravity:conv-a:1")?.estimatedDurationMs).toBe(8013);
    expect(byId.get("antigravity:conv-a:88")?.estimatedDurationMs).toBeUndefined();

    // 增量 reader 走同一个 parseFile，耗时口径必须一致。
    process.env.ANTIGRAVITY_DATA_DIR = root;
    const store = new UsageStore(":memory:");
    try {
      const incremental = await readAntigravityUsageIncremental(store);
      const record = incremental.usage.records.find(
        (candidate) => candidate.id === "antigravity:conv-a:1",
      );
      expect(record?.estimatedDurationMs).toBe(8013);
    } finally {
      store.close();
      delete process.env.ANTIGRAVITY_DATA_DIR;
    }
  });
});
describe("Antigravity 速度口径（对齐 cc-switch agy_session）", () => {
  function line(stepIndex: number, outputTokens: number): string {
    return JSON.stringify({
      step_index: stepIndex,
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: "2026-11-08T17:52:13Z",
      input_tokens: 100,
      cache_read_tokens: 0,
      output_tokens: outputTokens,
    });
  }

  it("整段耗时含首字；输出 ≥200 且耗时 ≥1s 才算速度；首字时间随计时透传", () => {
    const content = [line(1, 400), line(2, 150), line(3, 400)].join("\n");
    const timings = new Map<number, { durationMs: number; firstTokenMs: number }>([
      [1, { durationMs: 2000, firstTokenMs: 800 }],
      [2, { durationMs: 2000, firstTokenMs: 1200 }],
      [3, { durationMs: 900, firstTokenMs: 400 }],
    ]);
    const records = parseAntigravityTranscript(content, "conv", "demo", { timings });
    const byId = new Map(records.map((record) => [record.id, record]));

    expect(formatEstimatedTokensPerSecond(byId.get("antigravity:conv:1")!)).toBe("200");
    expect(formatEstimatedTokensPerSecond(byId.get("antigravity:conv:2")!)).toBeNull();
    expect(formatEstimatedTokensPerSecond(byId.get("antigravity:conv:3")!)).toBeNull();
    expect(sumSpeedTotals(records)).toEqual({
      speedOutputTokens: 400,
      speedDurationMs: 2000,
    });
    expect(byId.get("antigravity:conv:1")?.firstTokenMs).toBe(800);
    expect(byId.get("antigravity:conv:3")?.firstTokenMs).toBe(400);
  });
});
