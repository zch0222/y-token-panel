import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readCodexUsage } from "@/lib/codex";

const THREAD_ID = "01a090ff-afe1-7e23-8bf6-d531d4c1c3ce";
const PARENT_ID = "01a0a06c-adbe-73b3-860e-e15bc017f538";
const CHILD_ID = "01a0a072-8428-7d51-b146-f1e3abc1ae26";
const PAGE_ROLL_ID = "01a0a081-fe8e-7ea2-bd20-f58da96e106b";

let homeDir: string;

async function createCodexHome(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-test-"));
  await mkdir(path.join(dir, "sessions"), { recursive: true });
  return dir;
}

async function writeRollout(
  home: string,
  relative: string,
  lines: string[],
  options: { compress?: boolean } = {},
): Promise<string> {
  const filePath = path.join(home, relative);
  await mkdir(path.dirname(filePath), { recursive: true });
  const content = `${lines.join("\n")}\n`;
  if (options.compress) {
    await writeFile(`${filePath}.zst`, zlib.zstdCompressSync(Buffer.from(content, "utf8")));
    return `${filePath}.zst`;
  }
  await writeFile(filePath, content, "utf8");
  return filePath;
}

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

/** 一个普通会话：两个请求，均带精确 last_token_usage。 */
function plainSessionLines(threadId: string): string[] {
  return [
    line(0, "2026-11-01T10:00:00.000Z", "session_meta", {
      id: threadId,
      cwd: "D:\\code\\demo",
      originator: "codex_cli",
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
      model_context_window: 258400,
    }),
    line(5, "2026-11-01T10:00:20.000Z", "response_item", {
      type: "function_call_output",
    }),
    tokenCountLine(6, "2026-11-01T10:00:31.000Z", {
      total_token_usage: tokenUsageFields({ input: 2500, cached: 2000, output: 180 }),
      last_token_usage: tokenUsageFields({ input: 1500, cached: 1400, output: 80 }),
      model_context_window: 258400,
    }),
  ];
}

beforeEach(async () => {
  homeDir = await createCodexHome();
  process.env.CODEX_HOME = homeDir;
});

afterAll(async () => {
  delete process.env.CODEX_HOME;
  if (homeDir) await rm(homeDir, { recursive: true, force: true });
});

describe("readCodexUsage 数据源", () => {
  it("sessions 目录不存在时来源不可用", async () => {
    await rm(path.join(homeDir, "sessions"), { recursive: true });
    const usage = await readCodexUsage();
    expect(usage.sourceAvailable).toBe(false);
    expect(usage.records).toHaveLength(0);
    expect(usage.source).toBe(homeDir);
  });

  it("读取日期分区目录下的普通会话并给出正确记录形状", async () => {
    await writeRollout(
      homeDir,
      path.join("sessions", "2026", "11", "01", `rollout-2026-11-01T10-00-00-${THREAD_ID}.jsonl`),
      plainSessionLines(THREAD_ID),
    );
    const usage = await readCodexUsage();
    expect(usage.sourceAvailable).toBe(true);
    expect(usage.scannedFiles).toBe(1);
    expect(usage.skippedFiles).toBe(0);
    expect(usage.records).toHaveLength(2);

    const [second, first] = usage.records;
    expect(first).toMatchObject({
      harness: "codex",
      sessionId: THREAD_ID,
      project: "demo",
      model: "gpt-6-astra",
      provider: "OpenAI",
      inputTokens: 400,
      cacheReadTokens: 600,
      cacheCreationTokens: 0,
      outputTokens: 100,
      totalTokens: 1100,
      inputTokenSemantics: "fresh",
      hasTokenUsage: true,
      hasCredit: false,
      status: "success",
      timestamp: Date.parse("2026-11-01T10:00:12.500Z"),
    });
    expect(second).toMatchObject({
      inputTokens: 100,
      cacheReadTokens: 1400,
      outputTokens: 80,
      totalTokens: 1580,
    });
    // 记录按时间倒序
    expect(second.timestamp).toBeGreaterThan(first.timestamp);
  });

  it("压缩形态 .jsonl.zst 解压读取；与普通形态并存时只读普通形态", async () => {
    const lines = plainSessionLines(THREAD_ID);
    const base = path.join("sessions", "2026", "11", "01");
    // 只有压缩形态的另一个会话
    await writeRollout(
      homeDir,
      path.join(base, `rollout-2026-11-01T09-00-00-${PARENT_ID}.jsonl`),
      lines.map((l) => l.replace(THREAD_ID, PARENT_ID)),
      { compress: true },
    );
    // 同一逻辑文件名的两种形态并存：只读 .jsonl
    await writeRollout(
      homeDir,
      path.join(base, `rollout-2026-11-01T10-00-00-${THREAD_ID}.jsonl`),
      lines,
    );
    await writeRollout(
      homeDir,
      path.join(base, `rollout-2026-11-01T10-00-00-${THREAD_ID}.jsonl`),
      lines,
      { compress: true },
    );

    const usage = await readCodexUsage();
    expect(usage.scannedFiles).toBe(2);
    expect(usage.skippedFiles).toBe(0);
    expect(usage.records).toHaveLength(4);
    expect(new Set(usage.records.map((record) => record.sessionId))).toEqual(
      new Set([THREAD_ID, PARENT_ID]),
    );
  });

  it("非 rollout 命名的 jsonl 不产出记录（无有效尾部 UUID）", async () => {
    await writeRollout(homeDir, path.join("sessions", "notes.jsonl"), [
      ...plainSessionLines(THREAD_ID),
    ]);
    const usage = await readCodexUsage();
    expect(usage.records).toHaveLength(0);
    expect(usage.skippedFiles).toBe(1);
  });

  it("同一文件复制到 archived_sessions 不双计（按记录 id 去重）", async () => {
    const name = `rollout-2026-11-01T10-00-00-${THREAD_ID}.jsonl`;
    await writeRollout(homeDir, path.join("sessions", "2026", "11", "01", name), plainSessionLines(THREAD_ID));
    await writeRollout(homeDir, path.join("archived_sessions", name), plainSessionLines(THREAD_ID));
    const usage = await readCodexUsage();
    expect(usage.scannedFiles).toBe(2);
    expect(usage.records).toHaveLength(2);
  });

  it("两次读取的记录 id 稳定（重扫不产生新记录）", async () => {
    await writeRollout(
      homeDir,
      path.join("sessions", "2026", "11", "01", `rollout-2026-11-01T10-00-00-${THREAD_ID}.jsonl`),
      plainSessionLines(THREAD_ID),
    );
    const first = await readCodexUsage();
    const second = await readCodexUsage();
    expect(second.records.map((record) => record.id)).toEqual(
      first.records.map((record) => record.id),
    );
    expect(first.records.map((record) => record.id)).toEqual([
      `codex:${THREAD_ID}:6:2`,
      `codex:${THREAD_ID}:4:1`,
    ]);
  });
});

describe("readCodexUsage fork 重放剔除", () => {
  /** 父线程：fork 时刻之前两次请求，fork 之后父回合结束（时间戳晚于 fork）。 */
  function parentLines(): string[] {
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
      // fork 发生在 10:00:00；父回合 10:05:00 才结束（父必须写到 fork 时刻之后）
      line(3, "2026-11-01T10:05:00.000Z", "event_msg", { type: "task_complete" }),
    ];
  }

  it("子文件开头复制来的父事件被跳过，只计自己的请求", async () => {
    const replayed = parentLines().slice(1, 3); // 两条 token_count 原样复制
    const childLines = [
      line(0, "2026-11-01T10:00:00.000Z", "session_meta", {
        id: CHILD_ID,
        cwd: "D:\\code\\demo",
        forked_from_id: PARENT_ID,
        source: {
          subagent: { thread_spawn: { parent_thread_id: PARENT_ID, depth: 1 } },
        },
      }),
      ...replayed,
      tokenCountLine(3, "2026-11-01T10:01:00.000Z", {
        total_token_usage: tokenUsageFields({ input: 900, cached: 800, output: 60 }),
        last_token_usage: tokenUsageFields({ input: 900, cached: 800, output: 60 }),
      }),
    ];
    await writeRollout(
      homeDir,
      path.join("sessions", "2026", "11", "01", `rollout-2026-11-01T09-00-00-${PARENT_ID}.jsonl`),
      parentLines(),
    );
    await writeRollout(
      homeDir,
      path.join("sessions", "2026", "11", "01", `rollout-2026-11-01T10-00-00-${CHILD_ID}.jsonl`),
      childLines,
    );

    const usage = await readCodexUsage();
    expect(usage.records).toHaveLength(3);
    const childRecords = usage.records.filter((record) => record.sessionId === CHILD_ID);
    expect(childRecords).toHaveLength(1);
    expect(childRecords[0]).toMatchObject({
      inputTokens: 100,
      cacheReadTokens: 800,
      outputTokens: 60,
      timestamp: Date.parse("2026-11-01T10:01:00.000Z"),
    });
    const parentRecords = usage.records.filter((record) => record.sessionId === PARENT_ID);
    expect(parentRecords).toHaveLength(2);
  });

  it("父文件缺失时子文件整体不计入（宁可少算不双算）", async () => {
    const childLines = [
      line(0, "2026-11-01T10:00:00.000Z", "session_meta", {
        id: CHILD_ID,
        cwd: "D:\\code\\demo",
        forked_from_id: PARENT_ID,
      }),
      tokenCountLine(1, "2026-11-01T10:01:00.000Z", {
        last_token_usage: tokenUsageFields({ input: 900, cached: 800, output: 60 }),
      }),
    ];
    await writeRollout(
      homeDir,
      path.join("sessions", "2026", "11", "01", `rollout-2026-11-01T10-00-00-${CHILD_ID}.jsonl`),
      childLines,
    );
    const usage = await readCodexUsage();
    expect(usage.records).toHaveLength(0);
    expect(usage.skippedFiles).toBe(1);
    expect(usage.scannedFiles).toBe(1);
  });

  it("父文件还没写到 fork 时刻时子文件不计入", async () => {
    // 父的最后一行时间戳早于 fork 时刻
    const staleParent = parentLines().slice(0, 3);
    const childLines = [
      line(0, "2026-11-01T10:00:00.000Z", "session_meta", {
        id: CHILD_ID,
        cwd: "D:\\code\\demo",
        forked_from_id: PARENT_ID,
      }),
      tokenCountLine(1, "2026-11-01T10:01:00.000Z", {
        last_token_usage: tokenUsageFields({ input: 900, cached: 800, output: 60 }),
      }),
    ];
    await writeRollout(
      homeDir,
      path.join("sessions", "2026", "11", "01", `rollout-2026-11-01T09-00-00-${PARENT_ID}.jsonl`),
      staleParent,
    );
    await writeRollout(
      homeDir,
      path.join("sessions", "2026", "11", "01", `rollout-2026-11-01T10-00-00-${CHILD_ID}.jsonl`),
      childLines,
    );
    const usage = await readCodexUsage();
    // 父自身 2 条照常，子 0 条
    expect(usage.records).toHaveLength(2);
    expect(usage.records.every((record) => record.sessionId === PARENT_ID)).toBe(true);
  });

  it("文件名线程 ID 与 root meta ID 不一致的文件弃用", async () => {
    // meta 是 PARENT_ID，文件名却是 THREAD_ID：像是被改名的副本
    const renamed = [
      line(0, "2026-11-01T10:00:00.000Z", "session_meta", {
        id: PARENT_ID,
        cwd: "D:\\code\\demo",
      }),
      tokenCountLine(1, "2026-11-01T10:00:10.000Z", {
        last_token_usage: tokenUsageFields({ input: 10, cached: 0, output: 1 }),
      }),
    ];
    await writeRollout(
      homeDir,
      path.join("sessions", "2026", "11", "01", `rollout-2026-11-01T10-00-00-${THREAD_ID}.jsonl`),
      renamed,
    );
    const usage = await readCodexUsage();
    expect(usage.records).toHaveLength(0);
    expect(usage.skippedFiles).toBe(1);
  });
});

describe("readCodexUsage 翻页续写", () => {
  it("续写页只有累计快照时从前序分段恢复基线，只计自身增量", async () => {
    // 首页：total-only 计数到 input=5000
    const firstPage = [
      line(0, "2026-11-01T09:00:00.000Z", "session_meta", {
        id: PARENT_ID,
        cwd: "D:\\code\\demo",
      }),
      tokenCountLine(1, "2026-11-01T09:00:10.000Z", {
        total_token_usage: tokenUsageFields({ input: 5000, cached: 4000, output: 300 }),
      }),
    ];
    // 续写页（双段文件名 <threadId>_<rolloutId>）：meta 仍是线程本体，history_base 指向自身线程
    const secondPage = [
      line(0, "2026-11-01T10:00:00.000Z", "session_meta", {
        id: PARENT_ID,
        cwd: "D:\\code\\demo",
        history_mode: "paginated",
        history_base: { thread_id: PARENT_ID },
      }),
      tokenCountLine(1, "2026-11-01T10:00:10.000Z", {
        // 继承首页累计 5000 + 自身首请求 800
        total_token_usage: tokenUsageFields({ input: 5800, cached: 4600, output: 340 }),
      }),
    ];
    await writeRollout(
      homeDir,
      path.join("sessions", "2026", "11", "01", `rollout-2026-11-01T09-00-00-${PARENT_ID}.jsonl`),
      firstPage,
    );
    await writeRollout(
      homeDir,
      path.join(
        "sessions",
        "2026",
        "11",
        "01",
        `rollout-2026-11-01T10-00-00-${PARENT_ID}_${PAGE_ROLL_ID}.jsonl`,
      ),
      secondPage,
    );

    const usage = await readCodexUsage();
    expect(usage.records).toHaveLength(2);
    const continuation = usage.records.find(
      (record) => record.timestamp === Date.parse("2026-11-01T10:00:10.000Z"),
    );
    expect(continuation).toMatchObject({
      sessionId: PARENT_ID,
      inputTokens: 200,
      cacheReadTokens: 600,
      outputTokens: 40,
      totalTokens: 840,
    });
  });
});

describe("readCodexUsage bounded 引用 fork", () => {
  /** 父 rollout：两个请求后线程结束（最后一行时间戳早于 fork 时刻，永不推进）。 */
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
      // 继承父累计 2500/2000/180，自身首请求 800/500/40
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

  async function writeBoundedPair(endOverride?: { bytes: number; ordinal: number }) {
    const parentLines = boundedParentLines();
    const parentContent = `${parentLines.join("\n")}\n`;
    await writeRollout(
      homeDir,
      path.join("sessions", "2026", "11", "01", `rollout-2026-11-01T09-00-00-${PARENT_ID}.jsonl`),
      parentLines,
    );
    const end = endOverride ?? {
      bytes: Buffer.byteLength(parentContent, "utf8"),
      ordinal: parentLines.length,
    };
    await writeRollout(
      homeDir,
      path.join("sessions", "2026", "11", "01", `rollout-2026-11-01T10-00-00-${THREAD_ID}.jsonl`),
      boundedChildLines(end.bytes, end.ordinal),
    );
  }

  it("基线吻合时子文件全量导入（父线程已结束也能导入）", async () => {
    await writeBoundedPair();
    const usage = await readCodexUsage();
    expect(usage.skippedFiles).toBe(0);
    expect(usage.records).toHaveLength(4);
    const child = usage.records.filter((record) => record.sessionId === THREAD_ID);
    expect(child).toHaveLength(2);
    expect(child[1]).toMatchObject({ inputTokens: 300, cacheReadTokens: 500, outputTokens: 40 });
  });

  it("基线对不上时退回父时间线路径，父未推进则整份弃用", async () => {
    // end_byte_offset 只包含父文件前两条记录（计数器停在 1000/600/100），
    // 与子文件声明的继承基线（2500/2000/180）不符
    const parentLines = boundedParentLines();
    const partial = `${parentLines.slice(0, 2).join("\n")}\n`;
    await writeBoundedPair({
      bytes: Buffer.byteLength(partial, "utf8"),
      ordinal: 2,
    });
    const usage = await readCodexUsage();
    // 父自身 2 条照常；子文件退回重放路径，父没写到 fork 时刻 → 弃用
    expect(usage.records).toHaveLength(2);
    expect(usage.records.every((record) => record.sessionId === PARENT_ID)).toBe(true);
    expect(usage.skippedFiles).toBe(1);
  });
});
