import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncrementalUsageResult } from "@/lib/incremental-core";
import { readQoderUsage } from "@/lib/qoder";
import { readQoderUsageIncremental } from "@/lib/qoder-incremental";
import { encryptQoderStateSegment } from "@/lib/qoder-state";
import type { UsageResponse } from "@/lib/usage";
import { UsageStore } from "@/lib/usage-store";

const BASE_MS = 1_794_000_000_000;

interface UsageOptions {
  requestId?: string;
  credits?: number;
  billable?: boolean;
  contextUsageRatio?: number;
}

/** 一条带 usage 的 Qoder 会话行（真实形态：message.usage + request_id）。 */
function usageLine(
  timestamp: number,
  outputTokens: number,
  options: UsageOptions = {},
  extras: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: "assistant",
    uuid: `uuid-${timestamp}-${outputTokens}`,
    timestamp,
    sessionId: "session-a",
    message: {
      id: `fallback-${timestamp}-${outputTokens}`,
      model: "qoder-model",
      usage: {
        ...(options.requestId === undefined ? {} : { request_id: options.requestId }),
        input_tokens: 50,
        output_tokens: outputTokens,
        total_tokens: 50 + outputTokens,
        credits: options.credits,
        ...(options.billable === undefined ? {} : { billable: options.billable }),
        ...(options.contextUsageRatio === undefined
          ? {}
          : { context_usage_ratio: options.contextUsageRatio }),
      },
    },
    ...extras,
  });
}

function jsonl(...lines: string[]): string {
  return lines.join("\n") + "\n";
}

describe("Qoder 持久化字节游标增量导入", () => {
  let root: string;
  let databasePath: string;
  let store: UsageStore;
  let previousDir: string | undefined;
  let now = 1_794_000_100_000;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "qoder-incremental-"));
    databasePath = path.join(root, "usage.sqlite");
    previousDir = process.env.QODER_DATA_DIR;
    process.env.QODER_DATA_DIR = path.join(root, "projects");
    store = new UsageStore(databasePath);
  });

  afterEach(async () => {
    store.close();
    if (previousDir === undefined) delete process.env.QODER_DATA_DIR;
    else process.env.QODER_DATA_DIR = previousDir;
    await rm(root, { recursive: true, force: true });
  });

  function restartStore(): void {
    store.close();
    store = new UsageStore(databasePath);
  }

  async function sync(): Promise<IncrementalUsageResult> {
    const result = await readQoderUsageIncremental(store);
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

  async function projectDir(name = "p1"): Promise<string> {
    const directory = path.join(process.env.QODER_DATA_DIR!, name);
    await mkdir(directory, { recursive: true });
    return directory;
  }

  it("首次全量导入与旧 reader 一致，Credits/billable 口径不变", async () => {
    const directory = await projectDir();
    await writeFile(
      path.join(directory, "session.jsonl"),
      jsonl(
        usageLine(BASE_MS, 10, { requestId: "req-1", credits: 0.5, billable: true }),
        usageLine(BASE_MS + 1000, 20, { requestId: "req-2", credits: 0.25, billable: false }),
        usageLine(BASE_MS + 2000, 30, { requestId: "req-3", credits: 0.75 }),
      ),
    );

    const baseline = await readQoderUsage();
    const imported = await sync();
    expect(imported.usage).toEqual(baseline);
    expect(imported.usage.records).toHaveLength(3);
    expect(imported.usage.records.find((r) => r.id === "qoder:req-1")).toMatchObject({
      credits: 0.5,
      hasCredit: true,
      billable: true,
    });
    expect(imported.usage.records.find((r) => r.id === "qoder:req-2")).toMatchObject({
      credits: 0,
      hasCredit: true,
      billable: false,
    });
    expect(imported.usage.records.find((r) => r.id === "qoder:req-3")).toMatchObject({
      credits: 0,
      hasCredit: false,
    });
    expect(store.readNormalizedRecords("qoder")).toEqual(baseline.records);
    expect(store.getDedupKeys("qoder").sort()).toEqual(["qoder:req-1", "qoder:req-2", "qoder:req-3"]);
  });

  it("未变化零读取；追加只读新增字节且不重复导入", async () => {
    const directory = await projectDir();
    const filePath = path.join(directory, "session.jsonl");
    const first = jsonl(usageLine(BASE_MS, 10, { requestId: "req-1" }));
    await writeFile(filePath, first);
    await sync();

    const unchanged = await sync();
    expect(unchanged.stats).toMatchObject({
      bodyBytesRead: 0,
      verificationBytesRead: 0,
      fullFilesRead: 0,
      incrementalFilesRead: 0,
      unchangedFiles: 1,
    });
    expect(store.getSnapshot()?.revision).toBe(1);

    const appended = usageLine(BASE_MS + 5000, 40, { requestId: "req-2", contextUsageRatio: 0.3 }) + "\n";
    await appendFile(filePath, appended);
    const incremental = await sync();
    expect(incremental.stats).toMatchObject({
      bodyBytesRead: Buffer.byteLength(appended),
      fullFilesRead: 0,
      incrementalFilesRead: 1,
    });
    expect(incremental.usage.records).toHaveLength(2);
    const baseline = await readQoderUsage();
    expect(incremental.usage.records).toEqual(baseline.records);

    await sync();
    expect(store.readNormalizedRecords("qoder")).toHaveLength(2);
    expect(store.getSnapshot()?.revision).toBe(2);
  });

  it("半行补全后不丢记录；无 request_id 行的 file:line 兜底 ID 跨轮稳定", async () => {
    const directory = await projectDir();
    const filePath = path.join(directory, "session.jsonl");
    // 无 request_id、无 message.id 回退 uuid；再去掉 uuid 走 file:lineIndex 兜底。
    const firstLine = usageLine(BASE_MS, 10, { requestId: "req-1" });
    const secondRaw = usageLine(BASE_MS + 1000, 20);
    const secondLine = JSON.stringify({
      timestamp: BASE_MS + 1000,
      sessionId: "session-a",
      message: {
        model: "qoder-model",
        usage: {
          input_tokens: 5,
          output_tokens: 9,
          total_tokens: 14,
        },
      },
    });
    expect(secondRaw).not.toBe(secondLine);
    const splitAt = Buffer.byteLength(secondLine) - 15;
    await writeFile(
      filePath,
      Buffer.concat([Buffer.from(firstLine + "\n"), Buffer.from(secondLine).subarray(0, splitAt)]),
    );
    const first = await sync();
    expect(first.usage.records.map((r) => r.id)).toEqual(["qoder:req-1"]);
    expect(store.getSessionLogStates("qoder")[0]).toMatchObject({
      cursorOffset: Buffer.byteLength(firstLine) + 1,
    });

    await appendFile(filePath, Buffer.from(secondLine).subarray(splitAt) + "\n");
    const second = await sync();
    // 半行 + 兜底 ID 行号续接：与全量 reader 的 file:lineIndex 编号一致。
    expect(second.usage.records.map((r) => r.id).sort()).toEqual([
      "qoder:req-1",
      "qoder:session.jsonl:1",
    ]);
    const baseline = await readQoderUsage();
    expect(second.usage.records).toEqual(baseline.records);

    await appendFile(filePath, usageLine(BASE_MS + 2000, 30, { requestId: "req-9" }) + "\n");
    const third = await sync();
    expect(third.usage.records).toHaveLength(3);
    expect(await readQoderUsage()).toMatchObject({ records: expect.arrayContaining([third.usage.records[2]]) });
  });

  it("跨文件与跨目录重复 request_id 保持 first-wins", async () => {
    const first = await projectDir("z-old");
    await writeFile(
      path.join(first, "a.jsonl"),
      jsonl(usageLine(BASE_MS, 10, { requestId: "req-dup", credits: 1 })),
    );
    await sync();

    const second = await projectDir("a-new");
    await mkdir(path.join(second, "nested"), { recursive: true });
    await writeFile(
      path.join(second, "nested", "b.jsonl"),
      jsonl(usageLine(BASE_MS, 20, { requestId: "req-dup", credits: 2 })),
    );
    const rebuild = await sync();
    expect(rebuild.stats.rebuilds).toBe(1); // 文件集变化 → 重建重算 winner
    expect(rebuild.usage.records).toHaveLength(1);

    // 重建后追加同 ID 新行不再重复计数。
    await appendFile(
      path.join(second, "nested", "b.jsonl"),
      usageLine(BASE_MS + 100, 30, { requestId: "req-dup", credits: 3 }) + "\n",
    );
    const appended = await sync();
    expect(appended.stats.rebuilds).toBe(0);
    expect(appended.usage.records).toHaveLength(1);
    const baseline = await readQoderUsage();
    expect(appended.usage.records).toEqual(baseline.records);
  });

  it("重启后恢复游标，追加不重复导入", async () => {
    const directory = await projectDir();
    const filePath = path.join(directory, "session.jsonl");
    await writeFile(filePath, jsonl(usageLine(BASE_MS, 10, { requestId: "req-old" })));
    await sync();

    restartStore();
    await appendFile(filePath, usageLine(BASE_MS + 1000, 20, { requestId: "req-new" }) + "\n");
    const afterRestart = await sync();
    expect(afterRestart.stats.rebuilds).toBe(0);
    expect(afterRestart.usage.records).toHaveLength(2);
    const baseline = await readQoderUsage();
    expect(afterRestart.usage.records).toEqual(baseline.records);
  });

  it("同尺寸重写与截断触发来源级重建", async () => {
    const directory = await projectDir();
    const filePath = path.join(directory, "session.jsonl");
    const before = jsonl(usageLine(BASE_MS, 10, { requestId: "req-old" }));
    await writeFile(filePath, before);
    await sync();

    // req-old 与 req-aaa 等长：等尺寸重写无法靠 size 发现，明确回退重建。
    const rewritten = jsonl(usageLine(BASE_MS, 10, { requestId: "req-aaa" }));
    expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(before));
    await writeFile(filePath, rewritten);
    const future = new Date(Date.now() + 2000);
    await utimes(filePath, future, future);
    const recovered = await sync();
    expect(recovered.stats.rebuilds).toBe(1);
    expect(recovered.transaction.resetCursors).toBe(true);
    expect(recovered.usage.records.map((r) => r.id)).toEqual(["qoder:req-aaa"]);
    expect(store.getDedupKeys("qoder")).toEqual(["qoder:req-aaa"]);

    await writeFile(filePath, "");
    const truncated = await sync();
    expect(truncated.stats.rebuilds).toBe(1);
    expect(truncated.usage.records).toHaveLength(0);
    expect(store.getDedupKeys("qoder")).toHaveLength(0);
  });
});

describe("Qoder state.json 加密聚合增量", () => {
  let root: string;
  let databasePath: string;
  let store: UsageStore;
  let previousDir: string | undefined;
  let now = 1_794_000_100_000;
  let clock = 1_794_000_200_000;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "qoder-state-inc-"));
    databasePath = path.join(root, "usage.sqlite");
    previousDir = process.env.QODER_DATA_DIR;
    process.env.QODER_DATA_DIR = path.join(root, "projects");
    store = new UsageStore(databasePath);
  });

  afterEach(async () => {
    store.close();
    if (previousDir === undefined) delete process.env.QODER_DATA_DIR;
    else process.env.QODER_DATA_DIR = previousDir;
    await rm(root, { recursive: true, force: true });
  });

  async function sync(): Promise<IncrementalUsageResult> {
    const result = await readQoderUsageIncremental(store);
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

  function statePayload(options: {
    input: number;
    output: number;
    cacheRead?: number;
    credits?: number;
    model?: string;
    updatedAt?: string;
  }) {
    return {
      updatedAt: options.updatedAt ?? "2026-11-16T02:50:24.749Z",
      total: {
        input_tokens: options.input,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: options.cacheRead ?? 0,
        output_tokens: options.output,
      },
      ...(options.credits === undefined
        ? {}
        : {
            credits: {
              total: options.credits,
              byModel: { [options.model ?? "qmodel_latest"]: { credits: options.credits } },
            },
          }),
    };
  }

  async function writeStateFile(
    sessionId: string,
    payload: unknown,
    workspace: string,
  ): Promise<string> {
    const filePath = path.join(process.env.QODER_DATA_DIR!, "p1", sessionId, "state.json");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      `${JSON.stringify(
        {
          sessionId,
          revision: 1,
          createdAt: "2026-11-16T02:30:17.430Z",
          updatedAt: "2026-11-16T02:50:24.750Z",
          data: {},
          items: { s0: encryptQoderStateSegment(JSON.stringify(payload), sessionId, workspace) },
        },
        null,
        2,
      )}\n`,
    );
    clock += 2000;
    const future = new Date(clock);
    await utimes(filePath, future, future);
    return filePath;
  }

  /** 新格式 jsonl 行：只有 cwd / sessionId，没有 message.usage（1.1.86+ 形态）。 */
  function plainLine(timestamp: number, cwd: string): string {
    return JSON.stringify({
      type: "assistant",
      uuid: `uuid-${timestamp}`,
      timestamp,
      sessionId: "session-a",
      cwd,
      message: { id: `msg-${timestamp}`, model: "qmodel_latest", content: [] },
    });
  }

  it("新格式会话（jsonl 无 usage）：补差记录恢复整会话用量，随 state 更新原地替换", async () => {
    const workspace = path.join(root, "wk_dir");
    const directory = path.join(process.env.QODER_DATA_DIR!, "p1");
    await mkdir(path.join(directory, "session-a"), { recursive: true });
    await writeFile(
      path.join(directory, "session-a.jsonl"),
      jsonl(plainLine(BASE_MS, workspace), plainLine(BASE_MS + 1000, workspace)),
    );
    await writeStateFile(
      "session-a",
      statePayload({ input: 1000, output: 200, cacheRead: 300, credits: 5.5 }),
      workspace,
    );

    const first = await sync();
    const stateRecord = first.usage.records.find((r) => r.id === "qoder:state:session-a");
    expect(stateRecord).toMatchObject({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 300,
      totalTokens: 1500,
      credits: 5.5,
      hasCredit: true,
      model: "qmodel_latest",
      // workspace 带 "_"，目录名反推候选解不开 → cwd 候选生效
    });
    expect(first.usage.scannedFiles).toBe(2);
    const baseline = await readQoderUsage();
    expect(first.usage.records).toEqual(baseline.records);

    // 未变化轮：state.json 零读取，补差记录沿用已入库值。
    const unchanged = await sync();
    expect(unchanged.stats).toMatchObject({
      bodyBytesRead: 0,
      unchangedFiles: 2,
    });
    expect(
      unchanged.usage.records.find((r) => r.id === "qoder:state:session-a"),
    ).toMatchObject({ inputTokens: 1000 });

    // 会话推进：jsonl 追加无 usage 行、state 聚合更新 → 同 ID 记录被替换为新聚合。
    await appendFile(
      path.join(directory, "session-a.jsonl"),
      plainLine(BASE_MS + 2000, workspace) + "\n",
    );
    await writeStateFile(
      "session-a",
      statePayload({
        input: 1800,
        output: 350,
        cacheRead: 520,
        credits: 9.25,
        updatedAt: "2026-11-16T02:55:00.000Z",
      }),
      workspace,
    );
    const updated = await sync();
    const records = updated.usage.records.filter((r) => r.id.startsWith("qoder:"));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "qoder:state:session-a",
      inputTokens: 1800,
      outputTokens: 350,
      cacheReadTokens: 520,
      credits: 9.25,
      timestamp: Date.parse("2026-11-16T02:55:00.000Z"),
    });
    expect(store.readNormalizedRecords("qoder")).toHaveLength(1);
  });

  it("老格式会话 jsonl 已计 usage：state 聚合只补差值，计满不产出", async () => {
    const workspace = path.join(root, "wk_dir");
    const directory = path.join(process.env.QODER_DATA_DIR!, "p1");
    await mkdir(path.join(directory, "session-a"), { recursive: true });
    await writeFile(
      path.join(directory, "session-a.jsonl"),
      jsonl(
        usageLine(
          BASE_MS,
          10,
          {
            requestId: "req-1",
            credits: 1.5,
            billable: true,
          },
          { cwd: workspace },
        ),
      ),
    );
    // usageLine 的 input=50 / output=10 / cache=0；聚合只多 30 output + 0.5 credits。
    await writeStateFile(
      "session-a",
      statePayload({ input: 50, output: 40, credits: 2.0 }),
      workspace,
    );

    const first = await sync();
    expect(first.usage.records.map((r) => r.id).sort()).toEqual([
      "qoder:req-1",
      "qoder:state:session-a",
    ]);
    expect(first.usage.records.find((r) => r.id === "qoder:state:session-a")).toMatchObject({
      inputTokens: 0,
      outputTokens: 30,
      totalTokens: 30,
      credits: 0.5,
      hasCredit: true,
      hasTokenUsage: true,
    });

    // 聚合追平 jsonl 已计量：补差记录消失（下一轮 rebuild 由文件集不变、
    // state 变化触发的整文件重算移除）。
    await writeStateFile(
      "session-a",
      statePayload({ input: 50, output: 10, credits: 1.5 }),
      workspace,
    );
    const second = await sync();
    expect(second.usage.records.map((r) => r.id)).toEqual(["qoder:req-1"]);
    expect(store.readNormalizedRecords("qoder").map((r) => r.id)).toEqual(["qoder:req-1"]);
  });

  it("state.json 损坏 / 解不开：计入 skipped，不影响 jsonl 记录", async () => {
    const directory = path.join(process.env.QODER_DATA_DIR!, "p1");
    await mkdir(path.join(directory, "session-a"), { recursive: true });
    await writeFile(
      path.join(directory, "session-a.jsonl"),
      jsonl(usageLine(BASE_MS, 10, { requestId: "req-1" })),
    );
    const statePath = path.join(directory, "session-a", "state.json");
    await writeFile(statePath, "{ corrupted");
    clock += 2000;
    const future = new Date(clock);
    await utimes(statePath, future, future);

    const first = await sync();
    expect(first.usage.records.map((r) => r.id)).toEqual(["qoder:req-1"]);
    expect(first.usage.skippedFiles).toBe(1);
    expect(first.stats.rebuilds).toBe(1);
    // 与全量 reader 口径一致
    expect((await readQoderUsage()).skippedFiles).toBe(1);
  });
});
