import { describe, expect, it } from "vitest";
import { summarizeRecords } from "@/lib/usage";
import {
  KcodeRequestIndex,
  kcodeTimestampMs,
  kcodeWorkspaceLabel,
  parseKcodeConfigFile,
  parseKcodeProjectsFile,
  parseKcodeWireFile,
  resolveKcodeModelAndProvider,
  resolveKcodeProjectName,
  type KcodeWireRecord,
} from "@/lib/kcode-session";

/** 数值取自本机 ~/.kimi-code 真实 wire.jsonl（k3.1-pro-highspeed 的一步）。 */
const REAL_STEP_USAGE = {
  inputOther: 972,
  output: 522,
  inputCacheRead: 12800,
  inputCacheCreation: 0,
};

function wireLines(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

function loopEvent(
  time: number,
  event: Record<string, unknown>,
  agentId = "main",
): KcodeWireRecord {
  return { type: "context.append_loop_event", agentId, time, event };
}

function stepBegin(uuid: string, turnId = "0", step = 1) {
  return loopEvent(1, { type: "step.begin", uuid, turnId, step });
}

function messageAppended(options: {
  messageId: string;
  time: number;
  usage?: Record<string, unknown>;
  model?: { provider?: string; model?: string };
  role?: string;
}): KcodeWireRecord {
  return {
    type: "agent.message.appended",
    agentId: "main",
    time: options.time,
    message: {
      message: { role: options.role ?? "assistant", content: [] },
      meta: {
        messageId: options.messageId,
        source: "llm",
        model: options.model ?? { provider: "agent-loop", model: "agent-loop" },
        usage: options.usage ?? REAL_STEP_USAGE,
      },
    },
  };
}

const MAIN_CONTEXT = {
  project: "y-note",
  sessionId: "session_e8e068ab-d59b-4afa-97d3-2be7ca63c282",
  agent: "main",
  file: "wire.jsonl",
} as const;

describe("kcodeTimestampMs", () => {
  it("秒级时间戳放大到毫秒，毫秒级原样保留", () => {
    expect(kcodeTimestampMs(1_793_449_152)).toBe(1_793_449_152_000);
    expect(kcodeTimestampMs(1_793_449_152_579)).toBe(1_793_449_152_579);
  });

  it("非数值、0、负数、Infinity 一律丢弃", () => {
    expect(kcodeTimestampMs(undefined)).toBeUndefined();
    expect(kcodeTimestampMs("1793449152579")).toBeUndefined();
    expect(kcodeTimestampMs(0)).toBeUndefined();
    expect(kcodeTimestampMs(-5)).toBeUndefined();
    expect(kcodeTimestampMs(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe("KcodeRequestIndex（对齐 cc-switch kimi_session.rs）", () => {
  function observed(records: KcodeWireRecord[]): KcodeRequestIndex {
    const index = new KcodeRequestIndex();
    for (const record of records) index.observe(record);
    return index;
  }

  it("最终一次 llm.request 胜出；他人 agentId、非 loop kind、过期 turnStep 都不采纳", () => {
    const index = observed([
      stepBegin("step", "1", 2),
      {
        type: "llm.request",
        time: 1_700_000_000_010,
        kind: "loop",
        turnStep: "1.2",
        model: "first-model",
      },
      {
        type: "llm.request",
        time: 1_700_000_010_000,
        kind: "loop",
        turnStep: "1.2",
        model: "retry-model",
      },
      { type: "llm.request", kind: "compaction", model: "summary-model" },
      { type: "llm.request", agentId: "child", kind: "loop", model: "child-model" },
      { type: "llm.request", kind: "loop", turnStep: "1.1", model: "stale-model" },
      loopEvent(1_700_000_012_000, {
        type: "step.end",
        uuid: "step",
        messageId: "message",
        llmFirstTokenLatencyMs: 300,
        llmStreamDurationMs: 1_700,
      }),
    ]);
    const meta = { messageId: "message", model: { model: "agent-loop" } };
    expect(index.model(meta)).toBe("retry-model");
    expect(index.get("message")).toMatchObject({
      latencyMs: 2_000,
      firstTokenMs: 300,
      requestMs: 1_700_000_010_000,
    });
    expect(index.model({ messageId: "unrelated", model: { model: "agent-loop" } })).toBeUndefined();
    // 旧 wire：meta.model.model 是真实模型名时作为兜底。
    expect(index.model({ model: { model: "legacy-real-model" } })).toBe("legacy-real-model");
    expect(index.model({ model: { model: "unknown" } })).toBeUndefined();
  });

  it("优先用原生计时；缺失时用已完成分片收口，且工具执行不进入耗时窗口", () => {
    const index = observed([
      stepBegin("step"),
      { type: "llm.request", time: 1_700_000_000_010, kind: "loop", turnStep: "0.1", model: "m" },
      loopEvent(1_700_000_002_000, {
        type: "content.part",
        stepUuid: "step",
        part: { type: "think", think: "reasoning" },
      }),
      loopEvent(1_700_000_003_010, {
        type: "content.part",
        stepUuid: "step",
        part: { type: "text", text: "result" },
      }),
      // 别的 step 的分片与其后的工具调用、工具结果不延长模型窗口。
      loopEvent(1_700_000_010_000, { type: "content.part", stepUuid: "other" }),
      loopEvent(1_700_000_020_000, { type: "tool.call", stepUuid: "step" }),
      loopEvent(1_700_000_040_000, {
        type: "step.end",
        uuid: "step",
        messageId: "message",
      }),
    ]);
    expect(index.get("message")).toMatchObject({ latencyMs: 3_000, requestMs: 1_700_000_000_010 });
  });

  it("有工具却无完成分片时不用 step.end 时间兜底；原生计时范围外丢弃", () => {
    const index = observed([
      stepBegin("step"),
      { type: "llm.request", time: 1_700_000_000_000, kind: "loop", turnStep: "0.1", model: "m" },
      loopEvent(1_700_000_020_000, { type: "tool.call", stepUuid: "step" }),
      loopEvent(1_700_000_040_000, {
        type: "step.end",
        uuid: "step",
        messageId: "tool-only",
      }),
      stepBegin("step2"),
      { type: "llm.request", time: 1_700_000_000_000, kind: "loop", turnStep: "0.1", model: "m" },
      loopEvent(1_700_000_000_095, {
        type: "step.end",
        uuid: "step2",
        messageId: "too-fast",
        llmFirstTokenLatencyMs: 5,
        llmStreamDurationMs: 90,
      }),
      stepBegin("step3"),
      { type: "llm.request", time: 1_700_000_000_000, kind: "loop", turnStep: "0.1", model: "m" },
      loopEvent(1_700_000_000_050, {
        type: "step.end",
        uuid: "step3",
        messageId: "invalid-clock",
        llmFirstTokenLatencyMs: -1,
      }),
    ]);
    expect(index.get("tool-only")?.latencyMs).toBe(0);
    expect(index.get("too-fast")?.latencyMs).toBe(0);
    expect(index.get("invalid-clock")).toMatchObject({ latencyMs: 0 });
  });

  it("agent.switched / agent.turn.started 重置当前 step，fork 重放的 step 不串模型", () => {
    const index = observed([
      stepBegin("step"),
      { type: "llm.request", time: 1_700_000_000_010, kind: "loop", turnStep: "0.1", model: "m" },
      { type: "agent.switched", branch: "fork" },
      loopEvent(1_700_000_002_000, { type: "step.end", uuid: "step", messageId: "message" }),
    ]);
    const meta = { messageId: "message", model: { model: "agent-loop" } };
    expect(index.model(meta)).toBeUndefined();
    expect(index.get("message")).toMatchObject({ latencyMs: 0 });
  });
});

describe("parseKcodeWireFile（主 agent：已提交 assistant 消息）", () => {
  it("实测形态：模型取 llm.request，时间取 请求起点+耗时 与 commit 的较小值", () => {
    const content = wireLines([
      { type: "turn.prompt", agentId: "main", input: [], time: 1_793_449_152_400 },
      loopEvent(1_793_449_152_564, {
        type: "step.begin",
        uuid: "1a387126",
        turnId: "0",
        step: 1,
      }),
      {
        type: "llm.request",
        agentId: "main",
        kind: "loop",
        provider: "openai",
        model: "k3.1-pro-highspeed",
        modelAlias: "kimi-code/k3.1-pro-highspeed",
        turnStep: "0.1",
        time: 1_793_449_152_579,
      },
      {
        type: "usage.record",
        agentId: "main",
        model: "kimi-code/k3.1-pro-highspeed",
        usage: REAL_STEP_USAGE,
        usageScope: "turn",
        time: 1_793_449_160_068,
      },
      loopEvent(1_793_449_160_118, {
        type: "step.end",
        uuid: "1a387126",
        turnId: "0",
        step: 1,
        finishReason: "tool_use",
        usage: REAL_STEP_USAGE,
        llmFirstTokenLatencyMs: 1_358,
        llmStreamDurationMs: 6_130,
        messageId: "chatcmpl-Lj90DRANxpUrR3FBwp1xQDbq",
      }),
      messageAppended({
        messageId: "chatcmpl-Lj90DRANxpUrR3FBwp1xQDbq",
        time: 1_793_449_690_176,
      }),
    ]);
    const records = parseKcodeWireFile(content, MAIN_CONTEXT);
    expect(records).toHaveLength(1);
    // usage.record 与 step.end 都带同一份 usage，但主 agent 只认已提交消息，不双计。
    const record = records[0];
    expect(record).toMatchObject({
      id: "kcode:agent-loop:chatcmpl-Lj90DRANxpUrR3FBwp1xQDbq",
      requestId: "chatcmpl-Lj90DRANxpUrR3FBwp1xQDbq",
      sessionId: MAIN_CONTEXT.sessionId,
      harness: "kcode",
      project: "y-note",
      model: "k3.1-pro-highspeed",
      provider: "Moonshot AI",
      timestamp: 1_793_449_152_579 + 1_358 + 6_130,
      inputTokens: 972,
      outputTokens: 522,
      cacheReadTokens: 12_800,
      cacheCreationTokens: 0,
      totalTokens: 972 + 522 + 12_800,
      inputTokenSemantics: "fresh",
      hasTokenUsage: true,
      credits: 0,
      hasCredit: false,
      estimatedDurationMs: 7_488,
      status: "success",
    });
  });

  it("人类投影先于 step.end 出现也能按 messageId 连接", () => {
    const content = wireLines([
      stepBegin("s1"),
      {
        type: "llm.request",
        agentId: "main",
        kind: "loop",
        model: "k3",
        turnStep: "0.1",
        time: 1_700_000_000_000,
      },
      messageAppended({ messageId: "m1", time: 1_700_000_008_000 }),
      loopEvent(1_700_000_009_000, {
        type: "step.end",
        uuid: "s1",
        messageId: "m1",
        llmFirstTokenLatencyMs: 1_000,
        llmStreamDurationMs: 3_000,
      }),
    ]);
    const records = parseKcodeWireFile(content, MAIN_CONTEXT);
    expect(records).toHaveLength(1);
    expect(records[0].model).toBe("k3");
    expect(records[0].timestamp).toBe(1_700_000_004_000);
    expect(records[0].estimatedDurationMs).toBe(4_000);
  });

  it("没有请求事件时模型与耗时兜底，时间退回 commit 时刻", () => {
    const content = wireLines([
      messageAppended({ messageId: "m2", time: 1_700_000_100_000 }),
    ]);
    const records = parseKcodeWireFile(content, MAIN_CONTEXT);
    expect(records).toHaveLength(1);
    expect(records[0].model).toBe("未知模型");
    expect(records[0].timestamp).toBe(1_700_000_100_000);
    expect(records[0].estimatedDurationMs).toBeUndefined();
    // 旧 wire：meta.model.model 是真实模型名。
    const legacy = parseKcodeWireFile(
      wireLines([
        messageAppended({
          messageId: "m3",
          time: 1_700_000_100_000,
          model: { provider: "custom", model: "vendor/model" },
        }),
      ]),
      MAIN_CONTEXT,
    );
    expect(legacy[0].model).toBe("vendor/model");
    expect(legacy[0].id).toBe("kcode:custom:m3");
  });

  it("用量四项全零、user/tool 消息、缺 time、坏行都不产出记录", () => {
    const content = wireLines([
      messageAppended({
        messageId: "zero",
        time: 1_700_000_000_000,
        usage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
      }),
      messageAppended({ messageId: "u1", time: 1_700_000_000_000, role: "user" }),
      messageAppended({ messageId: "t1", time: 1_700_000_000_000, role: "tool" }),
      { type: "agent.message.appended", agentId: "main", message: { message: { role: "assistant" }, meta: { messageId: "nt", usage: REAL_STEP_USAGE } } },
      "{ 这不是 JSON",
      messageAppended({ messageId: "ok", time: 1_700_000_000_001 }),
    ]);
    const records = parseKcodeWireFile(content, MAIN_CONTEXT);
    expect(records.map((record) => record.requestId)).toEqual(["ok"]);
  });

  it("usage 数值按 u64 语义归一：负数/小数截断，字符串按 0，超大值封顶", () => {
    const content = wireLines([
      messageAppended({
        messageId: "dirty",
        time: 1_700_000_000_000,
        usage: { inputOther: -5, output: 2.9, inputCacheCreation: "40" },
      }),
    ]);
    const [record] = parseKcodeWireFile(content, MAIN_CONTEXT);
    expect(record.inputTokens).toBe(0);
    expect(record.outputTokens).toBe(2);
    expect(record.cacheReadTokens).toBe(0);
    expect(record.cacheCreationTokens).toBe(0);
    expect(record.totalTokens).toBe(2);

    const capped = parseKcodeWireFile(
      wireLines([
        messageAppended({
          messageId: "cap",
          time: 1_700_000_000_000,
          usage: { inputOther: 1e12, output: 1 },
        }),
      ]),
      MAIN_CONTEXT,
    );
    expect(capped[0].inputTokens).toBe(0xffffffff);
  });

  it("messageId 缺失时用 文件:行号 兜底身份", () => {
    const content = wireLines([
      {
        type: "human.agent.message.appended",
        agentId: "main",
        time: 1_700_000_000_000,
        message: {
          message: { role: "assistant", content: [] },
          meta: { source: "llm", usage: REAL_STEP_USAGE },
        },
      },
    ]);
    const [record] = parseKcodeWireFile(content, { ...MAIN_CONTEXT, file: "w.jsonl" });
    expect(record.id).toBe("kcode:unknown:w.jsonl:0");
    expect(record.requestId).toBe("w.jsonl:0");
  });

  it("原生计时范围外时回退 content.part 收口估算，仍含首字等待", () => {
    const content = wireLines([
      stepBegin("s9"),
      {
        type: "llm.request",
        agentId: "main",
        kind: "loop",
        model: "k3",
        turnStep: "0.1",
        time: 1_700_000_000_000,
      },
      loopEvent(1_700_000_003_000, {
        type: "content.part",
        stepUuid: "s9",
        part: { type: "text", text: "done" },
      }),
      loopEvent(1_700_000_003_100, {
        type: "step.end",
        uuid: "s9",
        messageId: "m9",
        llmFirstTokenLatencyMs: 5,
        llmStreamDurationMs: 90,
      }),
      messageAppended({ messageId: "m9", time: 1_700_000_004_000 }),
    ]);
    const [record] = parseKcodeWireFile(content, MAIN_CONTEXT);
    expect(record.estimatedDurationMs).toBe(3_000);
    expect(record.timestamp).toBe(1_700_000_003_000);
  });
});

describe("parseKcodeWireFile（子 agent：step.end 用量）", () => {
  const SUB_CONTEXT = { ...MAIN_CONTEXT, agent: "agent-0" };

  function subStep(options: {
    uuid: string;
    messageId?: string;
    model?: string;
    start: number;
    usage?: Record<string, unknown>;
    first?: number;
    stream?: number;
    agentId?: string;
  }) {
    const agentId = options.agentId ?? "agent-0";
    const lines: KcodeWireRecord[] = [
      loopEvent(
        options.start - 10,
        { type: "step.begin", uuid: options.uuid, turnId: "0", step: 1 },
        agentId,
      ),
      {
        type: "llm.request",
        agentId,
        kind: "loop",
        model: options.model,
        turnStep: "0.1",
        time: options.start,
      },
      {
        type: "usage.record",
        agentId: "agent-0",
        model: `kimi-code/${options.model ?? "m"}`,
        usage: options.usage ?? REAL_STEP_USAGE,
        usageScope: "turn",
        time: options.start + 900,
      },
      loopEvent(
        options.start + 1_000,
        {
          type: "step.end",
          uuid: options.uuid,
          turnId: "0",
          step: 1,
          usage: options.usage ?? REAL_STEP_USAGE,
          messageId: options.messageId,
          llmFirstTokenLatencyMs: options.first,
          llmStreamDurationMs: options.stream,
        },
        agentId,
      ),
    ];
    return lines;
  }

  it("带用量的 step.end 产出记录；模型经本 wire 的 llm.request 解析", () => {
    const content = wireLines([
      ...subStep({ uuid: "c1", messageId: "child-1", model: "child-model", start: 1_700_000_002_000, first: 200, stream: 800 }),
      // 他人 agentId 的请求不串扰。
      ...subStep({ uuid: "c2", messageId: "child-2", model: "wrong-model", start: 1_700_000_004_000, agentId: "agent-1" }),
    ]);
    const records = parseKcodeWireFile(content, SUB_CONTEXT);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      id: "kcode:subagent:child-1",
      model: "child-model",
      timestamp: 1_700_000_003_000,
      estimatedDurationMs: 1_000,
      harness: "kcode",
    });
    expect(records[1].model).toBe("未知模型");
  });

  it("无用量（interrupted）或无 messageId 的 step.end 不产出记录", () => {
    const content = wireLines([
      loopEvent(1_700_000_000_000, {
        type: "step.end",
        uuid: "x1",
        turnId: "0",
        step: 12,
        finishReason: "interrupted",
      }),
      ...subStep({ uuid: "x2", start: 1_700_000_010_000, usage: { inputOther: 0, output: 0, inputCacheCreation: 0 } }),
    ]);
    expect(parseKcodeWireFile(content, SUB_CONTEXT)).toHaveLength(0);
  });

  it("请求起点未知时时间退回 step.end 事件时刻", () => {
    const content = wireLines([
      loopEvent(1_700_000_005_000, {
        type: "step.end",
        uuid: "orphan",
        turnId: "0",
        step: 1,
        usage: REAL_STEP_USAGE,
        messageId: "orphan-1",
      }),
    ]);
    const [record] = parseKcodeWireFile(content, SUB_CONTEXT);
    expect(record.timestamp).toBe(1_700_000_005_000);
    expect(record.estimatedDurationMs).toBeUndefined();
  });
});

describe("项目名解析", () => {
  it("projects.json 的 name 优先，缺失时用 root 叶子（实测样本）", () => {
    const names = parseKcodeProjectsFile(
      JSON.stringify({
        schema_version: 2,
        projects: {
          "wd_y-note_180b664743fa": { root: "D:\\code\\y-note", name: "y-note" },
          wd_legacy_00783f8d0732: { root: "D:\\code\\y-sub" },
        },
      }),
    );
    expect(resolveKcodeProjectName("wd_y-note_180b664743fa", names)).toBe("y-note");
    expect(resolveKcodeProjectName("wd_legacy_00783f8d0732", names)).toBe("y-sub");
  });

  it("注册表缺失时退回 wd_<slug>_<hash12> 目录名解析；wm_/无 hash 解析不出", () => {
    expect(kcodeWorkspaceLabel("wd_y-note_180b664743fa")).toBe("y-note");
    expect(kcodeWorkspaceLabel("wm_3f2b1c9a-1234-5678-90ab-cdef01234567")).toBeUndefined();
    expect(kcodeWorkspaceLabel("wd_y-note")).toBeUndefined();
    const empty = parseKcodeProjectsFile("not json");
    expect(resolveKcodeProjectName("wd_y-note_180b664743fa", empty)).toBe("y-note");
    expect(resolveKcodeProjectName("wm_3f2b1c9a-1234-5678-90ab-cdef01234567", empty)).toBe("未知项目");
  });

  it("root 目录叶子的结尾分隔符被容忍", () => {
    const names = parseKcodeProjectsFile(
      JSON.stringify({ projects: { wd_a_000000000000: { root: "D:\\code\\a\\" } } }),
    );
    expect(resolveKcodeProjectName("wd_a_000000000000", names)).toBe("a");
  });
});

describe("summarizeRecords 与 kcode 记录", () => {
  it("无 Credits：不计入 creditsByHarness；速度按原生请求窗口聚合", () => {
    const records = parseKcodeWireFile(
      wireLines([
        messageAppended({ messageId: "m1", time: 1_700_000_100_000 }),
      ]),
      MAIN_CONTEXT,
    );
    const summary = summarizeRecords(records);
    expect(summary.hasCredit).toBe(false);
    expect(summary.creditsByHarness).toHaveLength(0);
    expect(summary.requests).toBe(1);
    // 无请求事件 → 无耗时，速度不满足门槛。
    expect(summary.speedOutputTokens).toBe(0);

    const timed = parseKcodeWireFile(
      wireLines([
        stepBegin("s1"),
        {
          type: "llm.request",
          agentId: "main",
          kind: "loop",
          model: "k3",
          turnStep: "0.1",
          time: 1_700_000_000_000,
        },
        loopEvent(1_700_000_004_000, {
          type: "step.end",
          uuid: "s1",
          messageId: "big",
          llmFirstTokenLatencyMs: 1_000,
          llmStreamDurationMs: 3_000,
        }),
        messageAppended({
          messageId: "big",
          time: 1_700_000_005_000,
          usage: { inputOther: 100, output: 500, inputCacheRead: 0, inputCacheCreation: 0 },
        }),
      ]),
      MAIN_CONTEXT,
    );
    const speedSummary = summarizeRecords(timed);
    expect(speedSummary.speedOutputTokens).toBe(500);
    expect(speedSummary.speedDurationMs).toBe(4_000);
    // 缓存命中率 = cacheRead ÷（fresh 输入 + 缓存读写）。
    expect(speedSummary.cacheRate).toBe(0);
  });
});

describe("parseKcodeConfigFile 与第三方供应商解析", () => {
  it("解析双引号/单引号/裸键 [models.*]，忽略 [providers.*] 等其他区块与注释", () => {
    const config = parseKcodeConfigFile(
      [
        'default_model = "Kimi For Coding/k3.1-pro"',
        "",
        '[providers."Kimi For Coding"]',
        'type = "kimi"',
        'api_key = "sk-secret-do-not-store"',
        "",
        '[models."Kimi For Coding/k3.1-pro"] # 行尾注释',
        'provider = "Kimi For Coding" # 自定义名称',
        'model = "k3.1-pro"',
        "max_context_size = 262144",
        "",
        "[models.'openrouter/anthropic/claude-sonnet-4']",
        "provider = 'openrouter'",
        "model = 'anthropic/claude-sonnet-4'",
        "",
        "[models.work_proxy]",
        'provider = "Relay #1"',
        'model = "gpt-4.1"',
        "",
        '[models."kimi-code/k3.1-pro"]',
        'provider = "managed:kimi-code"',
        'model = "k3.1-pro"',
      ].join("\r\n"),
    );

    expect(config.size).toBe(4);
    expect(config.get("Kimi For Coding/k3.1-pro")).toEqual({
      alias: "Kimi For Coding/k3.1-pro",
      provider: "Kimi For Coding",
      model: "k3.1-pro",
    });
    expect(config.get("openrouter/anthropic/claude-sonnet-4")).toEqual({
      alias: "openrouter/anthropic/claude-sonnet-4",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
    });
    expect(config.get("work_proxy")).toEqual({
      alias: "work_proxy",
      provider: "Relay #1",
      model: "gpt-4.1",
    });
    expect(config.get("kimi-code/k3.1-pro")).toEqual({
      alias: "kimi-code/k3.1-pro",
      provider: "managed:kimi-code",
      model: "k3.1-pro",
    });
  });

  it("官方渠道回落 deriveProvider，第三方供应商直接保留配置名或 alias 前缀", () => {
    const config = parseKcodeConfigFile(
      [
        '[models."kimi-code/k3.1-pro"]',
        'provider = "managed:kimi-code"',
        'model = "k3.1-pro"',
        '[models."Kimi For Coding/k3.1-pro"]',
        'provider = "Kimi For Coding"',
        'model = "k3.1-pro"',
      ].join("\n"),
    );

    expect(
      resolveKcodeModelAndProvider({
        modelAlias: "kimi-code/k3.1-pro",
        configuredModels: config,
      }),
    ).toEqual({ model: "k3.1-pro", provider: "Moonshot AI" });

    expect(
      resolveKcodeModelAndProvider({
        modelAlias: "Kimi For Coding/k3.1-pro",
        configuredModels: config,
      }),
    ).toEqual({ model: "k3.1-pro", provider: "Kimi For Coding" });

    // config.toml 条目被删后，仍能从 alias 前缀拆出供应商与模型。
    expect(
      resolveKcodeModelAndProvider({
        modelAlias: "openrouter/anthropic/claude-sonnet-4",
      }),
    ).toEqual({ model: "anthropic/claude-sonnet-4", provider: "openrouter" });
  });
});

describe("Kimi Code 1.3.5 wire（无 llm.request / agent.message.appended）与边界场景", () => {
  it("1.3.5 主 agent 读取 step.end + profile.bind / usage.record，区分官方与第三方供应商", () => {
    const config = parseKcodeConfigFile(
      [
        '[models."kimi-code/k3.1-pro"]',
        'provider = "managed:kimi-code"',
        'model = "k3.1-pro"',
        '[models."Kimi For Coding/k3.1-pro"]',
        'provider = "Kimi For Coding"',
        'model = "k3.1-pro"',
      ].join("\n"),
    );
    const content = wireLines([
      {
        type: "profile.bind",
        agentId: "main",
        profileName: "default",
        modelAlias: "kimi-code/k3.1-pro",
        time: 1_794_500_000_000,
      },
      loopEvent(1_794_500_000_100, { type: "step.begin", uuid: "u1", turnId: "0", step: 1 }),
      {
        type: "usage.record",
        agentId: "main",
        model: "kimi-code/k3.1-pro",
        usage: REAL_STEP_USAGE,
        usageScope: "turn",
        time: 1_794_500_002_000,
      },
      loopEvent(1_794_500_002_100, {
        type: "step.end",
        uuid: "u1",
        turnId: "0",
        step: 1,
        usage: REAL_STEP_USAGE,
        messageId: "chatcmpl-official-1",
        llmFirstTokenLatencyMs: 400,
        llmStreamDurationMs: 1_500,
      }),
      // thinkingEffort 变更时不带 modelAlias，不能清掉当前模型绑定。
      { type: "config.update", agentId: "main", thinkingEffort: "high", time: 1_794_500_005_000 },
      // 中途切换为第三方供应商。
      {
        type: "config.update",
        agentId: "main",
        modelAlias: "Kimi For Coding/k3.1-pro",
        time: 1_794_500_006_000,
      },
      loopEvent(1_794_500_007_000, { type: "step.begin", uuid: "u2", turnId: "1", step: 1 }),
      {
        type: "usage.record",
        agentId: "main",
        model: "Kimi For Coding/k3.1-pro",
        usage: { inputOther: 500, output: 120, inputCacheRead: 2_000, inputCacheCreation: 0 },
        usageScope: "turn",
        time: 1_794_500_008_400,
      },
      loopEvent(1_794_500_008_500, {
        type: "step.end",
        uuid: "u2",
        turnId: "1",
        step: 1,
        usage: { inputOther: 500, output: 120, inputCacheRead: 2_000, inputCacheCreation: 0 },
        messageId: "msg-custom-1",
        llmFirstTokenLatencyMs: 300,
        llmStreamDurationMs: 1_100,
      }),
    ]);

    const records = parseKcodeWireFile(content, { ...MAIN_CONTEXT, models: config });
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      id: "kcode:main:chatcmpl-official-1",
      model: "k3.1-pro",
      provider: "Moonshot AI",
      timestamp: 1_794_500_000_100 + 1_900,
      estimatedDurationMs: 1_900,
      firstTokenMs: 400,
    });
    expect(records[1]).toMatchObject({
      id: "kcode:main:msg-custom-1",
      model: "k3.1-pro",
      provider: "Kimi For Coding",
      timestamp: 1_794_500_007_000 + 1_400,
      estimatedDurationMs: 1_400,
      firstTokenMs: 300,
      totalTokens: 2_620,
    });
  });

  it("第三方代理省略 messageId 时主 agent step.end 回退 event.uuid 并保留耗时", () => {
    const config = parseKcodeConfigFile(
      '[models."MyRelay/gpt-4.1"]\nprovider = "MyRelay"\nmodel = "gpt-4.1"\n',
    );
    const content = wireLines([
      {
        type: "profile.bind",
        agentId: "main",
        modelAlias: "MyRelay/gpt-4.1",
        time: 1_794_500_010_000,
      },
      loopEvent(1_794_500_010_100, { type: "step.begin", uuid: "step-uuid-only", turnId: "0", step: 1 }),
      loopEvent(1_794_500_012_000, {
        type: "content.part",
        stepUuid: "step-uuid-only",
        part: { type: "text", text: "ok" },
      }),
      loopEvent(1_794_500_012_050, {
        type: "step.end",
        uuid: "step-uuid-only",
        turnId: "0",
        step: 1,
        usage: REAL_STEP_USAGE,
      }),
    ]);

    const records = parseKcodeWireFile(content, { ...MAIN_CONTEXT, models: config });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "kcode:main:step-uuid-only",
      requestId: "step-uuid-only",
      model: "gpt-4.1",
      provider: "MyRelay",
      timestamp: 1_794_500_012_000,
      estimatedDurationMs: 1_900,
    });
  });

  it("混合会话（旧版 agent.message.appended + 1.3.5 step.end）去重不双计，session 级压缩独立计数", () => {
    const content = wireLines([
      // 旧版：同一 messageId 同时出现在 step.end 与 agent.message.appended。
      loopEvent(1_794_500_020_000, { type: "step.begin", uuid: "old-1", turnId: "0", step: 1 }),
      {
        type: "llm.request",
        agentId: "main",
        kind: "loop",
        model: "k3.1-pro-highspeed",
        turnStep: "0.1",
        time: 1_794_500_020_010,
      },
      loopEvent(1_794_500_021_010, {
        type: "step.end",
        uuid: "old-1",
        messageId: "legacy-msg-1",
        usage: REAL_STEP_USAGE,
        llmFirstTokenLatencyMs: 200,
        llmStreamDurationMs: 800,
      }),
      messageAppended({ messageId: "legacy-msg-1", time: 1_794_500_022_000 }),
      // 升级 1.3.5 后新回合：只有 usage.record(turn) + step.end。
      { type: "profile.bind", agentId: "main", modelAlias: "Kimi For Coding/k3.1-pro", time: 1_794_500_030_000 },
      loopEvent(1_794_500_030_100, { type: "step.begin", uuid: "new-1", turnId: "1", step: 1 }),
      {
        type: "usage.record",
        agentId: "main",
        model: "Kimi For Coding/k3.1-pro",
        usage: REAL_STEP_USAGE,
        usageScope: "turn",
        time: 1_794_500_031_000,
      },
      loopEvent(1_794_500_031_100, {
        type: "step.end",
        uuid: "new-1",
        messageId: "new-msg-1",
        usage: REAL_STEP_USAGE,
      }),
      // full_compaction 等 session 级操作独立产出。
      {
        type: "usage.record",
        agentId: "main",
        model: "Kimi For Coding/k3.1-pro",
        usage: { inputOther: 300, output: 80, inputCacheRead: 0, inputCacheCreation: 0 },
        usageScope: "session",
        time: 1_794_500_040_000,
      },
    ]);

    const records = parseKcodeWireFile(content, MAIN_CONTEXT);
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      id: "kcode:agent-loop:legacy-msg-1",
      model: "k3.1-pro-highspeed",
      provider: "Moonshot AI",
    });
    expect(records[1]).toMatchObject({
      id: "kcode:main:new-msg-1",
      model: "k3.1-pro",
      provider: "Kimi For Coding",
    });
    expect(records[2]).toMatchObject({
      model: "k3.1-pro",
      provider: "Kimi For Coding",
      totalTokens: 380,
      timestamp: 1_794_500_040_000,
    });
  });
});
