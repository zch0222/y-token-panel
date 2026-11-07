import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  completeLines,
  decodeZstdFrames,
  dshProjectLabel,
  parseDshSessionLog,
  scanZstdFrames,
} from "@/lib/dsh-session";
import { readDshUsage } from "@/lib/dsh";
import { HARNESS_OPTIONS } from "@/lib/usage";

const decompress = (buffer: Buffer) => zlib.zstdDecompressSync(buffer);

/** 一帧 = 一个事件批次（真实写入器每批追加一帧，载荷以换行收尾）。 */
function frame(text: string): Buffer {
  return zlib.zstdCompressSync(Buffer.from(text.endsWith("\n") ? text : `${text}\n`));
}

function jsonl(...events: unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}

/** 真实毫秒级基准时间（2026-11 前后）；合成时间戳必须用这一量级。 */
const BASE_MS = 1_794_000_000_000;

function header(overrides: Record<string, unknown> = {}) {
  return {
    type: "session",
    version: 4,
    id: "session-test",
    createdAt: BASE_MS,
    cwd: "D:\\proj",
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: "standard",
    ...overrides,
  };
}

function stepStart(turn: number, step: number, time: number, extra: Record<string, unknown> = {}) {
  return { type: "step/start", seq: 1, time, data: { turn, step, ...extra } };
}

function assistantMessage(options: {
  turn?: number;
  step?: number;
  id?: string;
  time?: number;
  model?: string;
  provider?: string;
  usage?: Record<string, unknown>;
  omitUsage?: boolean;
}) {
  const {
    turn = 1,
    step = 1,
    id = "msg-1",
    time = BASE_MS + 5000,
    model = "deepseek-v4.1-flash",
    provider = "deepseek-account",
    usage = {
      inputTokens: 1895,
      outputTokens: 561,
      cacheReadTokens: 8704,
      cacheWriteTokens: 0,
      totalTokens: 11160,
    },
    omitUsage = false,
  } = options;
  const data: Record<string, unknown> = {
    turn,
    step,
    message: {
      role: "assistant",
      id,
      content: [{ type: "text", text: "ok" }],
      source: { kind: "model", provider, model },
    },
  };
  if (!omitUsage) data.usage = usage;
  return { type: "assistant/message", seq: 2, time, data };
}

describe("scanZstdFrames / decodeZstdFrames", () => {
  it("逐帧解压拼接的多帧文件（zstdDecompressSync 只解第一帧）", () => {
    const file = Buffer.concat([
      frame(jsonl(header())),
      frame(jsonl(stepStart(1, 1, BASE_MS))),
      frame(jsonl(assistantMessage({}))),
    ]);
    expect(zlib.zstdDecompressSync(file).toString("utf8")).not.toContain("assistant/message");

    const text = decodeZstdFrames(file, decompress).toString("utf8");
    expect(text).toContain('"type":"session"');
    expect(text).toContain('"type":"step/start"');
    expect(text).toContain('"type":"assistant/message"');
  });

  it("末尾写了一半的帧被忽略，不炸整个文件", () => {
    const torn = frame(jsonl(assistantMessage({}))).subarray(0, 12);
    const file = Buffer.concat([frame(jsonl(header())), torn]);
    const { frames, tornAt } = scanZstdFrames(file);
    expect(frames).toHaveLength(1);
    expect(tornAt).toBe(file.length - torn.length);

    const text = decodeZstdFrames(file, decompress).toString("utf8");
    expect(text).toContain('"type":"session"');
    expect(text).not.toContain("assistant/message");
  });

  it("空文件返回空结果", () => {
    const { frames, tornAt } = scanZstdFrames(Buffer.alloc(0));
    expect(frames).toHaveLength(0);
    expect(tornAt).toBeNull();
    expect(decodeZstdFrames(Buffer.alloc(0), decompress)).toEqual(Buffer.alloc(0));
  });

  it("中间出现非法字节（魔数丢失）按残缺处理，不再向后扫", () => {
    const garbage = Buffer.from("not zstd at all");
    const { frames, tornAt } = scanZstdFrames(Buffer.concat([frame("x"), garbage]));
    expect(frames).toHaveLength(1);
    expect(tornAt).toBe(0 + frame("x").length);
  });

  it("结构完整但解压失败的帧抛错（由读取器按坏文件跳过）", () => {
    // 1601 字节输入压成 26 字节小帧：魔数4 + descriptor1 + FCS2 + 窗口1 + 块头3，
    // 从第 11 字节起换成同长度垃圾——结构扫描通过，解压报 Data corruption。
    const good = frame("payload-".repeat(200));
    expect(good.length).toBeGreaterThan(14);
    const corrupt = Buffer.from(good);
    for (let i = 11; i < corrupt.length - 4; i += 1) corrupt[i] = 0x5a;
    expect(() => decodeZstdFrames(corrupt, decompress)).toThrow();
  });
});

describe("completeLines", () => {
  it("丢弃没有换行收尾的最后一行", () => {
    expect(completeLines('{"a":1}\n{"a":2}\n{"a":3}')).toBe('{"a":1}\n{"a":2}\n');
  });

  it("全部行都不完整时返回空串", () => {
    expect(completeLines('{"a":1}')).toBe("");
    expect(completeLines("")).toBe("");
  });
});

describe("dshProjectLabel", () => {
  it("去掉 D--code- 盘符前缀（projectKey 的 --…-- 包装 + 分隔符折叠）", () => {
    expect(dshProjectLabel("--D-code-y-auto-harness--")).toBe("y-auto-harness");
  });

  it("没有 code 段的路径保持可读形式", () => {
    expect(dshProjectLabel("--wsl.localhost-Ubuntu-22.04-home-yxlm-VideoLingo--")).toBe(
      "wsl.localhost-Ubuntu-22.04-home-yxlm-VideoLingo",
    );
  });

  it("~XXXX 转义（非安全字符）还原为原字符", () => {
    // projectKey("D:\\code\\my proj") => "--D-code-my~0020proj--"
    expect(dshProjectLabel("--D-code-my~0020proj--")).toBe("my proj");
  });

  it("无 cwd 会话目录与纯分隔符 cwd 的特例", () => {
    expect(dshProjectLabel("_no-cwd")).toBe("未知项目");
    expect(dshProjectLabel("--root--")).toBe("root");
  });

  it("不符合包装形状的目录名按原文返回", () => {
    expect(dshProjectLabel("plain-name")).toBe("plain-name");
  });
});

describe("parseDshSessionLog（字段映射回归）", () => {
  it("真实事件形态 → UsageRecord 各字段（fresh 语义 / cacheWrite→cacheCreation / 路由名）", () => {
    const [record] = parseDshSessionLog(
      jsonl(
        header(),
        stepStart(1, 1, BASE_MS),
        assistantMessage({ time: BASE_MS + 4200 }),
      ),
      "y-auto-harness",
      "session-abc",
    );
    expect(record).toBeDefined();
    expect(record!.harness).toBe("dsh");
    expect(record!.id).toBe("dsh:msg-1");
    expect(record!.requestId).toBe("msg-1");
    expect(record!.sessionId).toBe("session-abc");
    expect(record!.project).toBe("y-auto-harness");
    expect(record!.model).toBe("deepseek-v4.1-flash");
    expect(record!.provider).toBe("deepseek-account");
    expect(record!.timestamp).toBe(BASE_MS + 4200);
    expect(record!.inputTokens).toBe(1895);
    expect(record!.outputTokens).toBe(561);
    expect(record!.cacheReadTokens).toBe(8704);
    expect(record!.cacheCreationTokens).toBe(0);
    expect(record!.totalTokens).toBe(11160);
    expect(record!.inputTokenSemantics).toBe("fresh");
    expect(record!.hasTokenUsage).toBe(true);
    expect(record!.credits).toBe(0);
    expect(record!.hasCredit).toBe(false);
    expect(record!.estimatedDurationMs).toBe(4200);
    expect(record!.status).toBe("success");
  });

  it("totalTokens 缺失时按四项相加（TokenUsage 文档口径）", () => {
    const [record] = parseDshSessionLog(
      jsonl(
        assistantMessage({
          usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 50 },
        }),
      ),
      "p",
      "s",
    );
    expect(record!.totalTokens).toBe(200);
  });

  it("全零用量与没有 usage 的 assistant 消息都不计", () => {
    const records = parseDshSessionLog(
      jsonl(
        assistantMessage({
          id: "zero",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }),
        assistantMessage({ id: "none", omitUsage: true }),
      ),
      "p",
      "s",
    );
    expect(records).toHaveLength(0);
  });

  it("time 缺失的计量消息跳过（cc-switch created_at_ms 同款）", () => {
    const bad = assistantMessage({});
    delete (bad as { time?: number }).time;
    expect(parseDshSessionLog(jsonl(bad), "p", "s")).toHaveLength(0);
  });

  it("负数 / 非数字 token 字段按 0 处理，全零则跳过", () => {
    const records = parseDshSessionLog(
      jsonl(
        assistantMessage({
          id: "neg",
          usage: { inputTokens: -5, outputTokens: "x", cacheReadTokens: 1, cacheWriteTokens: 0 },
        }),
      ),
      "p",
      "s",
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.inputTokens).toBe(0);
    expect(records[0]!.outputTokens).toBe(0);
    expect(records[0]!.cacheReadTokens).toBe(1);
    expect(records[0]!.totalTokens).toBe(1);
  });

  it("同一步只有第一条消息能用 step 起点，起点用后即删", () => {
    const records = parseDshSessionLog(
      jsonl(
        stepStart(1, 1, BASE_MS),
        assistantMessage({ id: "a", time: BASE_MS + 1000 }),
        assistantMessage({ id: "b", time: BASE_MS + 2000 }),
      ),
      "p",
      "s",
    );
    expect(records).toHaveLength(2);
    expect(records[0]!.estimatedDurationMs).toBe(1000);
    expect(records[1]!.estimatedDurationMs).toBeUndefined();
  });

  it("新的 step/start 之后消息重新拿到耗时", () => {
    const records = parseDshSessionLog(
      jsonl(
        stepStart(1, 1, BASE_MS),
        assistantMessage({ id: "a", time: BASE_MS + 1000 }),
        stepStart(1, 2, BASE_MS + 5000),
        assistantMessage({ id: "b", turn: 1, step: 2, time: BASE_MS + 9000 }),
      ),
      "p",
      "s",
    );
    expect(records[1]!.estimatedDurationMs).toBe(4000);
  });

  it("耗时非正（消息时间早于 step 起点）时不估", () => {
    const records = parseDshSessionLog(
      jsonl(stepStart(1, 1, BASE_MS), assistantMessage({ id: "a", time: BASE_MS - 1 })),
      "p",
      "s",
    );
    expect(records[0]!.estimatedDurationMs).toBeUndefined();
  });

  it("缺 message.id 时按整行 sha256 稳定去重键", () => {
    const withoutId = assistantMessage({ id: "" }) as unknown as {
      data: { message: { id?: string } };
    };
    delete withoutId.data.message.id;
    const line = JSON.stringify(withoutId);
    const [a] = parseDshSessionLog(jsonl(withoutId), "p", "s");
    const [b] = parseDshSessionLog(`${line}\n`, "p", "s");
    expect(a!.id).toMatch(/^dsh:[0-9a-f]{64}$/);
    expect(a!.id).toBe(b!.id);
  });

  it("模型 / 路由缺失时的兜底", () => {
    const stripped = assistantMessage({ model: "", provider: "" });
    const [record] = parseDshSessionLog(jsonl(stripped), "p", "s");
    expect(record!.model).toBe("未知模型");
    expect(record!.provider).toBe("DeepSeek Harness");
  });

  it("供应商字段优先用 DSH 路由名，模型名可推断时兜底推断", () => {
    const [record] = parseDshSessionLog(
      jsonl(assistantMessage({ provider: "", model: "kimi-k3.1-pro" })),
      "p",
      "s",
    );
    expect(record!.provider).toBe("Moonshot AI");
  });

  it("非法 JSON 行与空白行忽略；v0 头无事件不产生记录", () => {
    const records = parseDshSessionLog(
      ["{broken", "", jsonl(header({ version: 0 })).trim()].join("\n") + "\n",
      "p",
      "s",
    );
    expect(records).toHaveLength(0);
  });
});

describe("readDshUsage（目录扫描与去重）", () => {
  let root: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "dsh-usage-"));
    previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = root;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });

  async function writeSessionLog(
    projectDir: string,
    sessionDir: string,
    fileName: string,
    events: unknown[],
  ) {
    const dir = path.join(root, "sessions", projectDir, sessionDir);
    await mkdir(dir, { recursive: true });
    const payload =
      fileName.endsWith(".zstd") ? frame(jsonl(...events)) : Buffer.from(jsonl(...events));
    await writeFile(path.join(dir, fileName), payload);
    return dir;
  }

  it("扫描 zstd 会话并产出记录（项目目录名 → 标签、目录名 → sessionId）", async () => {
    await writeSessionLog(
      "--D-code-y-auto-harness--",
      "session-02c5394f-78e1-42c4-9536-0072f7afded8",
      "session.v4.jsonl.zstd",
      [header(), stepStart(1, 1, BASE_MS), assistantMessage({ time: BASE_MS + 1500 })],
    );
    const usage = await readDshUsage();
    expect(usage.harness).toBe("dsh");
    expect(usage.sourceAvailable).toBe(true);
    expect(usage.scannedFiles).toBe(1);
    expect(usage.skippedFiles).toBe(0);
    expect(usage.records).toHaveLength(1);
    expect(usage.records[0]!.project).toBe("y-auto-harness");
    expect(usage.records[0]!.sessionId).toBe("session-02c5394f-78e1-42c4-9536-0072f7afded8");
    expect(usage.records[0]!.estimatedDurationMs).toBe(1500);
    expect(usage.source).toBe(path.join(root, "sessions"));
  });

  it("纯文本 .jsonl 也可读，末尾未写完的行丢弃", async () => {
    const dir = path.join(root, "sessions", "--D-code-p--", "session-plain");
    await mkdir(dir, { recursive: true });
    const complete = jsonl(header(), stepStart(1, 1, BASE_MS), assistantMessage({}));
    await writeFile(
      path.join(dir, "session.v3.jsonl"),
      Buffer.from(complete + '{"type":"assistant/message","time":1'),
    );
    const usage = await readDshUsage();
    expect(usage.records).toHaveLength(1);
    expect(usage.scannedFiles).toBe(1);
  });

  it("分叉会话复制的前缀只计一次；同目录多版本文件不双算", async () => {
    const shared = [header(), stepStart(1, 1, BASE_MS), assistantMessage({ id: "dup-1" })];
    await writeSessionLog("--D-code-p--", "session-parent", "session.v4.jsonl.zstd", shared);
    await writeSessionLog("--D-code-p--", "session-fork", "session.v4.jsonl.zstd", shared);
    // 同目录里迁移残留的旧代文件
    await writeSessionLog("--D-code-p--", "session-parent", "session.v3.jsonl.zstd", shared);
    const usage = await readDshUsage();
    expect(usage.scannedFiles).toBe(3);
    expect(usage.records).toHaveLength(1);
  });

  it("非会话日志文件名忽略", async () => {
    await writeSessionLog("--D-code-p--", "session-a", "session.v4.jsonl.zstd.tmp", [header()]);
    await writeSessionLog("--D-code-p--", "session-a", "notes.jsonl", [header()]);
    const usage = await readDshUsage();
    expect(usage.scannedFiles).toBe(0);
    expect(usage.records).toHaveLength(0);
  });

  it("目录不存在时 sourceAvailable=false", async () => {
    process.env.DSH_HOME = path.join(root, "missing");
    const usage = await readDshUsage();
    expect(usage.sourceAvailable).toBe(false);
    expect(usage.records).toHaveLength(0);
  });

  it("无魔数文件按无完整帧处理（cc-switch 同款），不产出记录也不计坏文件", async () => {
    const dir = path.join(root, "sessions", "--D-code-p--", "session-junk");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "session.v4.jsonl.zstd"), Buffer.from("garbage"));
    const usage = await readDshUsage();
    expect(usage.scannedFiles).toBe(1);
    expect(usage.skippedFiles).toBe(0);
    expect(usage.records).toHaveLength(0);
  });

  it("结构完整但解压失败的帧按 skipped 计，不影响其他文件", async () => {
    await writeSessionLog("--D-code-p--", "session-good", "session.v4.jsonl.zstd", [
      header(),
      assistantMessage({}),
    ]);
    const dir = path.join(root, "sessions", "--D-code-p--", "session-bad");
    await mkdir(dir, { recursive: true });
    const corrupt = Buffer.from(frame(jsonl(header())));
    for (let i = 9; i < corrupt.length - 4; i += 1) corrupt[i] = 0x5a;
    await writeFile(path.join(dir, "session.v4.jsonl.zstd"), corrupt);
    const usage = await readDshUsage();
    expect(usage.scannedFiles).toBe(2);
    expect(usage.skippedFiles).toBe(1);
    expect(usage.records).toHaveLength(1);
  });

  it("harness 已注册进 HARNESS_OPTIONS", () => {
    expect(HARNESS_OPTIONS.some((option) => option.id === "dsh")).toBe(true);
  });
});
