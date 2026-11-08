import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IncrementalUsageResult } from "@/lib/incremental-core";
import type { UsageResponse } from "@/lib/usage";
import { UsageStore } from "@/lib/usage-store";
import { readCodexUsage } from "@/lib/codex";
import { readCodexUsageIncremental } from "@/lib/codex-incremental";

const THREAD_ID = "01a090ff-afe1-7e23-8bf6-d531d4c1c3ce";
const PARENT_ID = "01a0a06c-adbe-73b3-860e-e15bc017f538";
const CHILD_ID = "01a0a072-8428-7d51-b146-f1e3abc1ae26";
const PAGE_ROLL_ID = "01a0a081-fe8e-7ea2-bd20-f58da96e106b";

function line(
  ordinal: number,
  timestamp: string,
  type: string,
  payload: Record<string, unknown>,
): string {
  return JSON.stringify({ timestamp, ordinal, type, payload });
}

function tokenUsageFields(value: {
  input: number;
  cached: number;
  output: number;
}): Record<string, number> {
  return {
    input_tokens: value.input,
    cached_input_tokens: value.cached,
    cache_write_input_tokens: 0,
    output_tokens: value.output,
    reasoning_output_tokens: 0,
    total_tokens: value.input + value.output,
  };
}

function tokenCountLine(
  ordinal: number,
  timestamp: string,
  info: Record<string, unknown>,
): string {
  return line(ordinal, timestamp, "event_msg", {
    type: "token_count",
    info,
    rate_limits: { limit_id: "codex" },
  });
}

function plainSessionLines(threadId: string): string[] {
  return [
    line(0, "2026-11-01T10:00:00.000Z", "session_meta", {
      id: threadId,
      cwd: "D:\\code\\demo",
    }),
    line(1, "2026-11-01T10:00:01.000Z", "turn_context", {
      turn_id: "t1",
      cwd: "D:\\code\\demo",
      model: "gpt-6-astra",
    }),
    line(2, "2026-11-01T10:00:02.000Z", "response_item", {
      type: "message",
      role: "user",
    }),
    line(3, "2026-11-01T10:00:12.000Z", "response_item", {
      type: "message",
      role: "assistant",
    }),
    tokenCountLine(4, "2026-11-01T10:00:12.500Z", {
      total_token_usage: tokenUsageFields({ input: 1000, cached: 600, output: 100 }),
      last_token_usage: tokenUsageFields({ input: 1000, cached: 600, output: 100 }),
    }),
    line(5, "2026-11-01T10:00:20.000Z", "response_item", {
      type: "function_call_output",
    }),
    tokenCountLine(6, "2026-11-01T10:00:31.000Z", {
      total_token_usage: tokenUsageFields({ input: 2500, cached: 2000, output: 180 }),
      last_token_usage: tokenUsageFields({ input: 1500, cached: 1400, output: 80 }),
    }),
  ];
}

/** 父线程：fork 时刻（10:00）前两次请求；finalLine 控制父是否写到 fork 之后。 */
function parentLines(finalLine = true): string[] {
  const lines = [
    line(0, "2026-11-01T09:00:00.000Z", "session_meta", {
      id: PARENT_ID,
      cwd: "D:\\code\\demo",
    }),
    tokenCountLine(1, "2026-11-01T09:00:10.000Z", {
      total_token_usage: tokenUsageFields({ input: 1000, cached: 600, output: 100 }),
      last_token_usage: tokenUsageFields({ input: 1000, cached: 600, output: 100 }),
    }),
    tokenCountLine(2, "2026-11-01T09:00:30.000Z", {
      total_token_usage: tokenUsageFields({ input: 2500, cached: 2000, output: 180 }),
      last_token_usage: tokenUsageFields({ input: 1500, cached: 1400, output: 80 }),
    }),
  ];
  if (finalLine) {
    lines.push(line(3, "2026-11-01T10:05:00.000Z", "event_msg", { type: "task_complete" }));
  }
  return lines;
}

/** fork 子线程：开头复制父线程 fork 前事件，再记自己的请求。 */
function forkChildLines(): string[] {
  return [
    line(0, "2026-11-01T10:00:00.000Z", "session_meta", {
      id: CHILD_ID,
      cwd: "D:\\code\\demo",
      forked_from_id: PARENT_ID,
      source: { subagent: { thread_spawn: { parent_thread_id: PARENT_ID, depth: 1 } } },
    }),
    tokenCountLine(1, "2026-11-01T09:00:10.000Z", {
      total_token_usage: tokenUsageFields({ input: 1000, cached: 600, output: 100 }),
      last_token_usage: tokenUsageFields({ input: 1000, cached: 600, output: 100 }),
    }),
    tokenCountLine(2, "2026-11-01T09:00:30.000Z", {
      total_token_usage: tokenUsageFields({ input: 2500, cached: 2000, output: 180 }),
      last_token_usage: tokenUsageFields({ input: 1500, cached: 1400, output: 80 }),
    }),
    tokenCountLine(3, "2026-11-01T10:01:00.000Z", {
      total_token_usage: tokenUsageFields({ input: 900, cached: 800, output: 60 }),
      last_token_usage: tokenUsageFields({ input: 900, cached: 800, output: 60 }),
    }),
  ];
}

function boundedParentLines(): string[] {
  return [
    line(0, "2026-11-01T09:00:00.000Z", "session_meta", {
      id: PARENT_ID,
      cwd: "D:\\code\\demo",
    }),
    tokenCountLine(1, "2026-11-01T09:00:10.000Z", {
      total_token_usage: tokenUsageFields({ input: 1000, cached: 600, output: 100 }),
      last_token_usage: tokenUsageFields({ input: 1000, cached: 600, output: 100 }),
    }),
    tokenCountLine(2, "2026-11-01T09:00:30.000Z", {
      total_token_usage: tokenUsageFields({ input: 2500, cached: 2000, output: 180 }),
      last_token_usage: tokenUsageFields({ input: 1500, cached: 1400, output: 80 }),
    }),
  ];
}

function boundedChildLines(endByteOffset: number, endOrdinal: number): string[] {
  return [
    line(0, "2026-11-01T10:00:00.000Z", "session_meta", {
      id: THREAD_ID,
      cwd: "D:\\code\\demo",
      forked_from_id: PARENT_ID,
      history_mode: "paginated",
      history_base: {
        thread_id: PARENT_ID,
        end_byte_offset: endByteOffset,
        end_ordinal_exclusive: endOrdinal,
      },
    }),
    tokenCountLine(1, "2026-11-01T10:00:10.000Z", {
      total_token_usage: tokenUsageFields({ input: 3300, cached: 2500, output: 220 }),
      last_token_usage: tokenUsageFields({ input: 800, cached: 500, output: 40 }),
    }),
    tokenCountLine(2, "2026-11-01T10:00:30.000Z", {
      total_token_usage: tokenUsageFields({ input: 4000, cached: 3000, output: 260 }),
      last_token_usage: tokenUsageFields({ input: 700, cached: 500, output: 40 }),
    }),
  ];
}

describe("Codex 依赖缓存增量", () => {
  let homeDir: string;
  let root: string;
  let databasePath: string;
  let store: UsageStore;
  let now = 1_794_000_100_000;
  let mtimeStep = 0;
  const previousEnv = new Map<string, string | undefined>();

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "codex-incremental-"));
    homeDir = path.join(root, "codex-home");
    await mkdir(path.join(homeDir, "sessions"), { recursive: true });
    databasePath = path.join(root, "usage.sqlite");
    store = new UsageStore(databasePath);
    now = 1_794_000_100_000;
    mtimeStep = 0;
    previousEnv.set("CODEX_HOME", process.env.CODEX_HOME);
    process.env.CODEX_HOME = homeDir;
  });

  afterEach(async () => {
    store.close();
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    previousEnv.clear();
    await rm(root, { recursive: true, force: true });
  });

  function sessionPath(name: string): string {
    return path.join("sessions", "2026", "11", "01", name);
  }

  async function writeRollout(
    relative: string,
    lines: string[],
    options: { compress?: boolean } = {},
  ): Promise<string> {
    const filePath = path.join(homeDir, relative);
    await mkdir(path.dirname(filePath), { recursive: true });
    const content = `${lines.join("\n")}\n`;
    const target = options.compress ? `${filePath}.zst` : filePath;
    const data = options.compress
      ? zlib.zstdCompressSync(Buffer.from(content, "utf8"))
      : Buffer.from(content, "utf8");
    await writeFile(target, data);
    // 显式推进 mtime，避免 Windows 上写入时间戳精度不足导致的“未变化”误判。
    mtimeStep += 1;
    await utimes(target, new Date(now + mtimeStep * 1000), new Date(now + mtimeStep * 1000));
    return target;
  }

  async function appendRollout(
    filePath: string,
    lines: string[],
    options: { compress?: boolean } = {},
  ): Promise<void> {
    const content = `${lines.join("\n")}\n`;
    if (options.compress || filePath.endsWith(".zst")) {
      throw new Error("压缩形态追加请整文件重写");
    }
    await appendFile(filePath, content, "utf8");
    mtimeStep += 1;
    await utimes(filePath, new Date(now + mtimeStep * 1000), new Date(now + mtimeStep * 1000));
  }

  function restartStore(): void {
    store.close();
    store = new UsageStore(databasePath);
  }

  async function sync(): Promise<IncrementalUsageResult> {
    const result = await readCodexUsageIncremental(store);
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

  async function expectConsistentWithFullReader(result: IncrementalUsageResult): Promise<void> {
    const full = await readCodexUsage();
    expect(result.usage.records).toEqual(full.records);
    expect(result.usage.skippedFiles).toBe(full.skippedFiles);
    expect(result.usage.scannedFiles).toBe(full.scannedFiles);
  }

  it("冷导入（含 fork / 压缩 / archived 副本 / 无计费文件）与全量 reader 一致", async () => {
    await writeRollout(
      sessionPath(`rollout-2026-11-01T09-00-00-${PARENT_ID}.jsonl`),
      parentLines(),
    );
    await writeRollout(
      sessionPath(`rollout-2026-11-01T10-00-00-${CHILD_ID}.jsonl`),
      forkChildLines(),
    );
    await writeRollout(
      sessionPath(`rollout-2026-11-01T08-00-00-${THREAD_ID}.jsonl`),
      plainSessionLines(THREAD_ID),
      { compress: true },
    );
    await writeRollout(
      path.join("archived_sessions", `rollout-2026-11-01T08-00-00-${THREAD_ID}.jsonl`),
      plainSessionLines(THREAD_ID),
    );
    // 无计费 token 的会话（只有 meta）：合法文件，不计 skipped、不产记录。
    await writeRollout(
      sessionPath(`rollout-2026-11-01T07-00-00-${PAGE_ROLL_ID}.jsonl`),
      [
        line(0, "2026-11-01T07:00:00.000Z", "session_meta", {
          id: PAGE_ROLL_ID,
          cwd: "D:\\code\\demo",
        }),
        line(1, "2026-11-01T07:00:01.000Z", "turn_context", { model: "gpt-6-astra" }),
      ],
    );

    const imported = await sync();
    expect(imported.stats.rebuilds).toBe(1);
    expect(imported.usage.records.length).toBeGreaterThan(0);
    await expectConsistentWithFullReader(imported);
    expect(store.getSessionLogStates("codex")).toHaveLength(5);

    // 未变化轮的 skipped 口径同样与全量 reader 一致（no-billable 不计 skipped）。
    const unchanged = await sync();
    expect(unchanged.stats.bodyBytesRead).toBe(0);
    await expectConsistentWithFullReader(unchanged);
  });

  it("未变化同步零读取；记录与 no-op revision 保持", async () => {
    await writeRollout(
      sessionPath(`rollout-2026-11-01T10-00-00-${THREAD_ID}.jsonl`),
      plainSessionLines(THREAD_ID),
    );
    await writeRollout(
      sessionPath(`rollout-2026-11-01T09-00-00-${PARENT_ID}.jsonl`),
      parentLines(),
    );
    await writeRollout(
      sessionPath(`rollout-2026-11-01T10-00-00-${CHILD_ID}.jsonl`),
      forkChildLines(),
    );
    await sync();
    const revision = store.getSnapshot()?.revision;
    expect(revision).toBe(1);

    const unchanged = await sync();
    expect(unchanged.stats).toMatchObject({
      bodyBytesRead: 0,
      verificationBytesRead: 0,
      unchangedFiles: 3,
      incrementalFilesRead: 0,
      dependencyFilesRead: 0,
      rebuilds: 0,
    });
    expect(store.getSnapshot()?.revision).toBe(1);
    await expectConsistentWithFullReader(unchanged);

    // 重启后缓存仍可复用（游标持久化在 session_log_sync）。
    restartStore();
    const afterRestart = await sync();
    expect(afterRestart.stats).toMatchObject({ bodyBytesRead: 0, rebuilds: 0 });
  });

  it("子文件追加时整文件重读，父时间线缓存命中零依赖读取", async () => {
    await writeRollout(
      sessionPath(`rollout-2026-11-01T09-00-00-${PARENT_ID}.jsonl`),
      parentLines(),
    );
    const childPath = await writeRollout(
      sessionPath(`rollout-2026-11-01T10-00-00-${CHILD_ID}.jsonl`),
      forkChildLines(),
    );
    await sync();

    await appendRollout(childPath, [
      line(4, "2026-11-01T10:02:00.000Z", "response_item", { type: "function_call_output" }),
      tokenCountLine(5, "2026-11-01T10:02:30.000Z", {
        total_token_usage: tokenUsageFields({ input: 1400, cached: 1100, output: 90 }),
        last_token_usage: tokenUsageFields({ input: 500, cached: 300, output: 30 }),
      }),
    ]);
    const fs = await import("node:fs/promises");
    const childSize = (await fs.stat(childPath)).size;
    const appended = await sync();
    expect(appended.stats.rebuilds).toBe(0);
    expect(appended.stats.incrementalFilesRead).toBe(1);
    // 父时间线来自持久缓存：不读父正文，也不做依赖补载；正文读取只有子文件本身。
    expect(appended.stats.dependencyFilesRead).toBe(0);
    expect(appended.stats.bodyBytesRead).toBe(childSize);
    await expectConsistentWithFullReader(appended);

    // 追加后的记录包含子文件新请求。
    const childRecords = appended.usage.records.filter(
      (record) => record.sessionId === CHILD_ID,
    );
    expect(childRecords).toHaveLength(2);
  });

  it("未变化 deferred 文件不重复读取正文", async () => {
    // 父没写到 fork 时刻：子文件 deferred。
    await writeRollout(
      sessionPath(`rollout-2026-11-01T09-00-00-${PARENT_ID}.jsonl`),
      parentLines(false),
    );
    const childPath = await writeRollout(
      sessionPath(`rollout-2026-11-01T10-00-00-${CHILD_ID}.jsonl`),
      forkChildLines(),
    );
    const childSize = (await (await import("node:fs/promises")).stat(childPath)).size;
    const imported = await sync();
    expect(imported.usage.skippedFiles).toBe(1);

    const untouched = await sync();
    expect(untouched.stats.bodyBytesRead).toBe(0);
    expect(untouched.stats.dependencyFilesRead).toBe(0);
    expect(untouched.usage.skippedFiles).toBe(1);
    expect(untouched.stats.bodyBytesRead).toBeLessThan(childSize + 1);
    await expectConsistentWithFullReader(untouched);
  });

  it("父文件追加后，未变化的 deferred 子文件恢复导入", async () => {
    const parentPath = await writeRollout(
      sessionPath(`rollout-2026-11-01T09-00-00-${PARENT_ID}.jsonl`),
      parentLines(false),
    );
    await writeRollout(
      sessionPath(`rollout-2026-11-01T10-00-00-${CHILD_ID}.jsonl`),
      forkChildLines(),
    );
    const imported = await sync();
    expect(imported.usage.skippedFiles).toBe(1);
    expect(imported.usage.records.every((record) => record.sessionId === PARENT_ID)).toBe(true);

    // 父线程补写到 fork 时刻之后；子文件自身未变化。
    await appendRollout(parentPath, [
      line(3, "2026-11-01T10:05:00.000Z", "event_msg", { type: "task_complete" }),
    ]);
    const recovered = await sync();
    expect(recovered.usage.skippedFiles).toBe(0);
    // 子文件被重新尝试：读取子正文（父自身变化也会重读）。
    expect(recovered.stats.incrementalFilesRead).toBe(2);
    await expectConsistentWithFullReader(recovered);
    const childRecords = recovered.usage.records.filter(
      (record) => record.sessionId === CHILD_ID,
    );
    expect(childRecords).toHaveLength(1);
    // 恢复后的记录被持久化；下一轮未变化零读取。
    const settled = await sync();
    expect(settled.stats.bodyBytesRead).toBe(0);
    expect(settled.usage.records.length).toBe(recovered.usage.records.length);
  });

  it("父文件替换（增长重写）后旧时间线失效，结果与全量一致", async () => {
    const parentPath = await writeRollout(
      sessionPath(`rollout-2026-11-01T09-00-00-${PARENT_ID}.jsonl`),
      parentLines(),
    );
    await writeRollout(
      sessionPath(`rollout-2026-11-01T10-00-00-${CHILD_ID}.jsonl`),
      forkChildLines(),
    );
    await sync();

    // 父重写：前缀保留、追加新请求（fork 后），尺寸增长。
    const lines = parentLines();
    lines.push(
      tokenCountLine(4, "2026-11-01T10:06:00.000Z", {
        total_token_usage: tokenUsageFields({ input: 3000, cached: 2200, output: 200 }),
        last_token_usage: tokenUsageFields({ input: 500, cached: 200, output: 20 }),
      }),
    );
    await writeRollout(
      sessionPath(`rollout-2026-11-01T09-00-00-${PARENT_ID}.jsonl`),
      lines,
    );
    const rewritten = await sync();
    expect(rewritten.stats.rebuilds).toBe(0);
    // 父变化 → 父整读；子文件未变化 deferred 逻辑不触发（已导入），
    // 子记录沿用库内（fork 前签名不变，前缀结论不变）。
    expect(rewritten.stats.incrementalFilesRead).toBe(1);
    await expectConsistentWithFullReader(rewritten);
    // 父 3 条（追加一次请求）+ 子 1 条。
    expect(rewritten.usage.records.length).toBe(4);

    // 同尺寸重写 → 来源级重建。
    const sameSize = await import("node:fs/promises").then((fs) => fs.stat(parentPath));
    await utimes(parentPath, new Date(now + 60_000), new Date(now + 60_000));
    const statAfter = await import("node:fs/promises").then((fs) => fs.stat(parentPath));
    expect(statAfter.size).toBe(sameSize.size);
    const rebuilt = await sync();
    expect(rebuilt.stats.rebuilds).toBe(1);
    await expectConsistentWithFullReader(rebuilt);
  });

  it("bounded 引用 fork 子文件追加时读取父正文完成区间验证", async () => {
    const parentLinesContent = boundedParentLines();
    const parentContent = `${parentLinesContent.join("\n")}\n`;
    const end = {
      bytes: Buffer.byteLength(parentContent, "utf8"),
      ordinal: parentLinesContent.length,
    };
    await writeRollout(
      sessionPath(`rollout-2026-11-01T09-00-00-${PARENT_ID}.jsonl`),
      parentLinesContent,
    );
    const childPath = await writeRollout(
      sessionPath(`rollout-2026-11-01T10-00-00-${THREAD_ID}.jsonl`),
      boundedChildLines(end.bytes, end.ordinal),
    );
    const imported = await sync();
    expect(imported.usage.skippedFiles).toBe(0);
    expect(imported.usage.records).toHaveLength(4);

    // 子文件追加一次请求：bounded 验证需要父正文（依赖补载）。
    await appendRollout(childPath, [
      line(3, "2026-11-01T10:01:00.000Z", "response_item", { type: "function_call_output" }),
      tokenCountLine(4, "2026-11-01T10:01:30.000Z", {
        total_token_usage: tokenUsageFields({ input: 4600, cached: 3500, output: 300 }),
        last_token_usage: tokenUsageFields({ input: 600, cached: 500, output: 40 }),
      }),
    ]);
    const appended = await sync();
    expect(appended.stats.rebuilds).toBe(0);
    expect(appended.stats.incrementalFilesRead).toBe(1);
    expect(appended.stats.dependencyFilesRead).toBe(1);
    expect(appended.usage.skippedFiles).toBe(0);
    await expectConsistentWithFullReader(appended);
  });

  it("续写页追加时前序分段高水位来自缓存", async () => {
    const firstPage = [
      line(0, "2026-11-01T09:00:00.000Z", "session_meta", {
        id: PARENT_ID,
        cwd: "D:\\code\\demo",
      }),
      tokenCountLine(1, "2026-11-01T09:00:10.000Z", {
        total_token_usage: tokenUsageFields({ input: 5000, cached: 4000, output: 300 }),
      }),
    ];
    const secondPage = [
      line(0, "2026-11-01T10:00:00.000Z", "session_meta", {
        id: PARENT_ID,
        cwd: "D:\\code\\demo",
        history_mode: "paginated",
        history_base: { thread_id: PARENT_ID },
      }),
      tokenCountLine(1, "2026-11-01T10:00:10.000Z", {
        total_token_usage: tokenUsageFields({ input: 5800, cached: 4600, output: 340 }),
      }),
    ];
    await writeRollout(
      sessionPath(`rollout-2026-11-01T09-00-00-${PARENT_ID}.jsonl`),
      firstPage,
    );
    const pagePath = await writeRollout(
      sessionPath(`rollout-2026-11-01T10-00-00-${PARENT_ID}_${PAGE_ROLL_ID}.jsonl`),
      secondPage,
    );
    const imported = await sync();
    expect(imported.usage.records).toHaveLength(2);

    await appendRollout(pagePath, [
      tokenCountLine(2, "2026-11-01T10:05:10.000Z", {
        total_token_usage: tokenUsageFields({ input: 6400, cached: 5000, output: 380 }),
      }),
    ]);
    const appended = await sync();
    expect(appended.stats.rebuilds).toBe(0);
    // 只重读续写页；前序分段未变化，高水位走缓存。
    expect(appended.stats.dependencyFilesRead).toBe(0);
    await expectConsistentWithFullReader(appended);
    // 追加事件以前序累计 5800/4600/340 为基线，只计自身增量。
    const latest = appended.usage.records[0]!;
    expect(latest).toMatchObject({ inputTokens: 200, cacheReadTokens: 400, outputTokens: 40 });
  });

  it("文件集变化（新增/删除）与截断触发来源级重建", async () => {
    const filePath = sessionPath(`rollout-2026-11-01T10-00-00-${THREAD_ID}.jsonl`);
    await writeRollout(filePath, plainSessionLines(THREAD_ID));
    await sync();

    await writeRollout(
      sessionPath(`rollout-2026-11-01T11-00-00-${CHILD_ID}.jsonl`),
      plainSessionLines(CHILD_ID),
    );
    const grown = await sync();
    expect(grown.stats.rebuilds).toBe(1);
    await expectConsistentWithFullReader(grown);

    await sync();
    await rm(path.join(homeDir, sessionPath(`rollout-2026-11-01T11-00-00-${CHILD_ID}.jsonl`)));
    const shrunk = await sync();
    expect(shrunk.stats.rebuilds).toBe(1);
    await expectConsistentWithFullReader(shrunk);

    // 截断：写回更短内容（同路径、更小尺寸）。
    const truncated = plainSessionLines(THREAD_ID).slice(0, 3);
    await writeRollout(filePath, truncated);
    const truncatedSync = await sync();
    expect(truncatedSync.stats.rebuilds).toBe(1);
    await expectConsistentWithFullReader(truncatedSync);
  });

  it("缓存版本失效：解析不了的 parser state 触发重建", async () => {
    await writeRollout(
      sessionPath(`rollout-2026-11-01T10-00-00-${THREAD_ID}.jsonl`),
      plainSessionLines(THREAD_ID),
    );
    await sync();
    const states = store.getSessionLogStates("codex");
    expect(states).toHaveLength(1);

    // 直接破坏持久化缓存（模拟版本升级后的旧格式）。
    const db = new (await import("node:sqlite")).DatabaseSync(databasePath);
    db.prepare("UPDATE session_log_sync SET parser_state_json = '{\"v\":999}'").run();
    db.close();

    const rebuilt = await sync();
    expect(rebuilt.stats.rebuilds).toBe(1);
    await expectConsistentWithFullReader(rebuilt);
  });

  it("父时间线缓存未命中时按需补载一次，后续轮次命中缓存", async () => {
    await writeRollout(
      sessionPath(`rollout-2026-11-01T09-00-00-${PARENT_ID}.jsonl`),
      parentLines(),
    );
    const childPath = await writeRollout(
      sessionPath(`rollout-2026-11-01T10-00-00-${CHILD_ID}.jsonl`),
      forkChildLines(),
    );
    await sync();

    // 清空父时间线缓存（保留游标与其他字段），模拟缓存缺失。
    const db = new (await import("node:sqlite")).DatabaseSync(databasePath);
    const rows = db
      .prepare("SELECT file_path, parser_state_json FROM session_log_sync WHERE harness = 'codex'")
      .all() as Array<{ file_path: string; parser_state_json: string | null }>;
    for (const row of rows) {
      if (!row.parser_state_json) continue;
      const state = JSON.parse(row.parser_state_json) as { timeline?: unknown };
      state.timeline = null;
      db.prepare("UPDATE session_log_sync SET parser_state_json = ? WHERE file_path = ?").run(
        JSON.stringify(state),
        row.file_path,
      );
    }
    db.close();

    await appendRollout(childPath, [
      tokenCountLine(4, "2026-11-01T10:03:30.000Z", {
        total_token_usage: tokenUsageFields({ input: 1200, cached: 900, output: 80 }),
        last_token_usage: tokenUsageFields({ input: 300, cached: 100, output: 20 }),
      }),
    ]);
    const warmup = await sync();
    expect(warmup.stats.rebuilds).toBe(0);
    expect(warmup.stats.dependencyFilesRead).toBe(1);
    await expectConsistentWithFullReader(warmup);

    // 缓存补载后：再次追加子文件，父零读取。
    await appendRollout(childPath, [
      tokenCountLine(5, "2026-11-01T10:04:30.000Z", {
        total_token_usage: tokenUsageFields({ input: 1500, cached: 1000, output: 90 }),
        last_token_usage: tokenUsageFields({ input: 300, cached: 100, output: 10 }),
      }),
    ]);
    const cached = await sync();
    expect(cached.stats.dependencyFilesRead).toBe(0);
    expect(cached.stats.incrementalFilesRead).toBe(1);
    await expectConsistentWithFullReader(cached);
  });

  it("同一 rollout 的副本（sessions + archived）同步去重一致", async () => {
    const name = `rollout-2026-11-01T10-00-00-${THREAD_ID}.jsonl`;
    const primary = await writeRollout(sessionPath(name), plainSessionLines(THREAD_ID));
    await writeRollout(path.join("archived_sessions", name), plainSessionLines(THREAD_ID));
    const imported = await sync();
    expect(imported.usage.records).toHaveLength(2);
    await expectConsistentWithFullReader(imported);

    // 修改 sessions 副本（追加请求）：两份副本都要重新解析，避免陈旧记录。
    await appendRollout(primary, [
      tokenCountLine(7, "2026-11-01T10:00:41.000Z", {
        total_token_usage: tokenUsageFields({ input: 3000, cached: 2200, output: 200 }),
        last_token_usage: tokenUsageFields({ input: 500, cached: 200, output: 20 }),
      }),
    ]);
    const appended = await sync();
    expect(appended.usage.records).toHaveLength(3);
    await expectConsistentWithFullReader(appended);
  });

  it("sessions 目录不存在时来源不可用", async () => {
    await rm(path.join(homeDir, "sessions"), { recursive: true });
    const result = await readCodexUsageIncremental(store);
    expect(result.usage.sourceAvailable).toBe(false);
    expect(result.transaction.resetCursors).toBe(true);
    expect(result.transaction.cursors).toHaveLength(0);
  });

  it("读取失败的文件保留可重试状态并不产生记录", async () => {
    const filePath = await writeRollout(
      sessionPath(`rollout-2026-11-01T10-00-00-${THREAD_ID}.jsonl`),
      plainSessionLines(THREAD_ID),
    );
    await sync();

    // 篡改游标指纹让增长校验失败，模拟前缀被改写 → 整体重建路径。
    const db = new (await import("node:sqlite")).DatabaseSync(databasePath);
    db.prepare("UPDATE session_log_sync SET tail_fingerprint = 'bad'").run();
    db.close();
    await appendRollout(filePath, [
      tokenCountLine(7, "2026-11-01T10:00:41.000Z", {
        total_token_usage: tokenUsageFields({ input: 3000, cached: 2200, output: 200 }),
        last_token_usage: tokenUsageFields({ input: 500, cached: 200, output: 20 }),
      }),
    ]);
    const rebuilt = await sync();
    expect(rebuilt.stats.rebuilds).toBe(1);
    await expectConsistentWithFullReader(rebuilt);
  });
});
