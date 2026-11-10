import { describe, expect, it } from "vitest";
import { parsePiDesktopSession, type PiDesktopRecord } from "@/lib/pi-desktop-session";

/**
 * 工厂按本机 PI-Desktop 0.22.0 真实转录形态构造（字段语义见
 * pi-desktop-session.ts 文件头，全部反查自 app.asar usageFromPi 与
 * host-core transcripts 写入口径，样例取自 ~/.pi-desktop/sessions 实测）。
 */

const SESSION_ID = "82f94c45-6278-4c5b-a786-a7598cb78c3e";
const FILE = `${SESSION_ID}.jsonl`;

function sessionHeader(sessionId = SESSION_ID): PiDesktopRecord {
  return {
    type: "session",
    createdAt: "2026-11-10T15:25:59.094Z",
    schema: 2,
    sessionId,
  };
}

interface UsageOverrides {
  operationId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  aggregation?: string;
  costStatus?: string;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  operations?: Array<Record<string, unknown>>;
}

function assistantLine(overrides: {
  id?: string;
  createdAt?: string;
  status?: string;
  modelId?: string;
  responseModelId?: string;
  responseDurationMs?: number;
  withUsage?: boolean;
  usage?: UsageOverrides;
}): PiDesktopRecord {
  const withUsage = overrides.withUsage ?? true;
  const usage = withUsage
      ? {
        aggregation: overrides.usage?.aggregation ?? "operation",
        cacheReadTokens: overrides.usage?.cacheReadTokens ?? 512,
        costStatus: overrides.usage?.costStatus ?? "unknown",
        inputTokens: overrides.usage?.inputTokens ?? 8529,
        modelId: overrides.modelId ?? "kimi-k3-1-pro-261024",
        operationId:
          overrides.usage?.operationId ?? "621883be-576f-404d-a4cb-bfcb128d62e6",
        outputTokens: overrides.usage?.outputTokens ?? 353,
        providerId: "f39b8d71-e8ae-494c-b635-1088342678d4",
        reasoningTokens: overrides.usage?.reasoningTokens ?? 195,
        totalTokens: overrides.usage?.totalTokens ?? 9394,
        usageOrigin: "pi",
        // 应用仅在 >0 时写入 cacheWriteTokens / cost / operations。
        ...(overrides.usage?.cacheWriteTokens ? { cacheWriteTokens: overrides.usage.cacheWriteTokens } : {}),
        ...(overrides.usage?.cost ? { cost: overrides.usage.cost } : {}),
        ...(overrides.usage?.operations ? { operations: overrides.usage.operations } : {}),
      }
    : undefined;
  return {
    type: "message",
    id: overrides.id ?? "5ee2853a-dee1-4b56-b53f-68b83a7da415",
    role: "assistant",
    createdAt: overrides.createdAt ?? "2026-11-10T15:26:09.248Z",
    blocks: [{ type: "text", text: "ok" }],
    meta: {
      modelId: overrides.modelId ?? "kimi-k3-1-pro-261024",
      providerId: "f39b8d71-e8ae-494c-b635-1088342678d4",
      responseDurationMs: overrides.responseDurationMs ?? 2908,
      responseModelId: overrides.responseModelId ?? overrides.modelId ?? "kimi-k3-1-pro-261024",
      status: overrides.status ?? "complete",
      ...(usage ? { usage } : {}),
    },
  };
}

function jsonl(...items: unknown[]): string {
  return items.map((item) => JSON.stringify(item)).join("\n") + "\n";
}

describe("parsePiDesktopSession 字段映射（依据 PI-Desktop 自身代码确认）", () => {
  it("真实形态的 assistant usage 记录完整映射；operationId 是去重键", () => {
    const records = parsePiDesktopSession(
      jsonl(sessionHeader(), assistantLine({})),
      FILE,
    );
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record).toMatchObject({
      id: `pidesktop:${SESSION_ID}:621883be-576f-404d-a4cb-bfcb128d62e6`,
      requestId: "621883be-576f-404d-a4cb-bfcb128d62e6",
      sessionId: SESSION_ID,
      harness: "pidesktop",
      project: "未知项目",
      model: "kimi-k3-1-pro-261024",
      provider: "Moonshot AI",
      timestamp: Date.parse("2026-11-10T15:26:09.248Z"),
      inputTokens: 8529,
      outputTokens: 353,
      cacheReadTokens: 512,
      cacheCreationTokens: 0,
      totalTokens: 9394,
      inputTokenSemantics: "fresh",
      hasTokenUsage: true,
      credits: 0,
      hasCredit: false,
      estimatedDurationMs: 2908,
      status: "success",
    });
    expect(record.reportedCredits).toBeUndefined();
  });

  it("reasoningTokens 是 output 子集不另行累计；cacheWrite 单列；小数 token 四舍五入", () => {
    const records = parsePiDesktopSession(
      jsonl(
        sessionHeader(),
        assistantLine({
          usage: {
            inputTokens: 100.4,
            outputTokens: 20,
            cacheReadTokens: 30,
            cacheWriteTokens: 5,
            reasoningTokens: 18,
            // totalTokens 未上报（0 视为缺省，与 usageFromPi 的 || 回退一致）。
            totalTokens: 0,
          },
        }),
      ),
      FILE,
    );
    expect(records[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 5,
      // totalTokens 缺失时回退四项求和（镜像 usageFromPi）。
      totalTokens: 155,
      inputTokenSemantics: "fresh",
    });
  });

  it("totalTokens 为上游报告值，权威于组件和", () => {
    const records = parsePiDesktopSession(
      jsonl(
        sessionHeader(),
        assistantLine({
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 999 },
        }),
      ),
      FILE,
    );
    expect(records[0]!.totalTokens).toBe(999);
  });

  it("aggregation:aggregate 带 operations[] 时只对明细求和、忽略顶层值", () => {
    const records = parsePiDesktopSession(
      jsonl(
        sessionHeader(),
        assistantLine({
          usage: {
            aggregation: "aggregate",
            // 顶层是诱饵值：存在 operations[] 时必须忽略
            inputTokens: 999_999,
            outputTokens: 999_999,
            totalTokens: 999_999,
            operations: [
              { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1, totalTokens: 16 },
              { inputTokens: 5, outputTokens: 1 },
            ],
          },
        }),
      ),
      FILE,
    );
    expect(records[0]).toMatchObject({
      inputTokens: 15,
      outputTokens: 3,
      cacheReadTokens: 3,
      cacheCreationTokens: 1,
      // 明细报告 total 之和（16 + 0）> 0，权威于组件和 20。
      totalTokens: 16,
    });
  });

  it("costStatus=reported 的 cost（绝对美元）计入 Credits；组件和兜底", () => {
    const records = parsePiDesktopSession(
      jsonl(
        sessionHeader(),
        assistantLine({
          usage: { costStatus: "reported", cost: { input: 0.1, output: 0.2, total: 0.3 } },
        }),
        assistantLine({
          id: "a2b2c2d2-0000-0000-0000-000000000002",
          usage: {
            operationId: "op-with-components-only",
            costStatus: "reported",
            cost: { input: 0.5, cacheRead: 0.25 },
          },
        }),
      ),
      FILE,
    );
    expect(records[0]).toMatchObject({ credits: 0.3, hasCredit: true, reportedCredits: 0.3 });
    expect(records[1]).toMatchObject({ credits: 0.75, hasCredit: true, reportedCredits: 0.75 });
  });

  it("costStatus=estimated 的本地估算不计费，只保留报告值", () => {
    const records = parsePiDesktopSession(
      jsonl(
        sessionHeader(),
        assistantLine({
          usage: { costStatus: "estimated", cost: { input: 0.1, output: 0.2, total: 0.3 } },
        }),
      ),
      FILE,
    );
    expect(records[0]).toMatchObject({ credits: 0, hasCredit: false, reportedCredits: 0.3 });
  });

  it("status=error/aborted 的请求按零 token 失败计数（无 usage 也导入）", () => {
    const records = parsePiDesktopSession(
      jsonl(
        sessionHeader(),
        assistantLine({ status: "error", withUsage: false, responseDurationMs: 367 }),
        assistantLine({
          id: "aborted-1",
          status: "aborted",
          withUsage: false,
          responseDurationMs: 2082,
        }),
        assistantLine({
          id: "aborted-with-usage",
          status: "aborted",
          usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        }),
      ),
      FILE,
    );
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      id: `pidesktop:${SESSION_ID}:5ee2853a-dee1-4b56-b53f-68b83a7da415`,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      hasTokenUsage: false,
      status: "error",
      estimatedDurationMs: 367,
    });
    expect(records[1]!.status).toBe("error");
    expect(records[2]).toMatchObject({ status: "error", totalTokens: 14, hasTokenUsage: true });
  });

  it("status=in_progress 视为成功；modelId 缺失回退 responseModelId，再缺记未知模型", () => {
    const records = parsePiDesktopSession(
      jsonl(
        sessionHeader(),
        assistantLine({
          status: "in_progress",
          modelId: "",
          responseModelId: "deepseek-v4.1-flash",
        }),
        assistantLine({
          id: "no-model",
          modelId: "",
          responseModelId: "",
          usage: { operationId: "op-no-model" },
        }),
      ),
      FILE,
    );
    expect(records[0]).toMatchObject({ status: "success", model: "deepseek-v4.1-flash", provider: "DeepSeek" });
    expect(records[1]).toMatchObject({ model: "未知模型", provider: "Pi Desktop" });
  });

  it("无 operationId 时回退消息 id；两者皆无时回退 file:lineIndex", () => {
    const records = parsePiDesktopSession(
      jsonl(
        sessionHeader(),
        assistantLine({ usage: { operationId: "" } }),
        assistantLine({
          id: "",
          usage: { operationId: "", inputTokens: 1 },
        }),
      ),
      FILE,
    );
    expect(records[0]!.id).toBe(`pidesktop:${SESSION_ID}:5ee2853a-dee1-4b56-b53f-68b83a7da415`);
    expect(records[1]!.id).toBe(`pidesktop:${SESSION_ID}:${FILE}:2`);
    expect(records[1]!.requestId).toBe(`${FILE}:2`);
  });

  it("跳过 session 头之外的无关记录：user/tool/system、无 usage 的 assistant、未知 type、坏行", () => {
    const content = [
      JSON.stringify(sessionHeader()),
      JSON.stringify({ type: "message", role: "user", meta: { status: "complete" } }),
      JSON.stringify({ type: "message", role: "tool", toolName: "bash", isError: false }),
      JSON.stringify({ type: "message", role: "system" }),
      JSON.stringify(assistantLine({ withUsage: false })),
      JSON.stringify({ type: "compaction", summary: "..." }),
      JSON.stringify({ type: "tool_review_state", state: {} }),
      "{ not json",
      "",
      JSON.stringify(assistantLine({ usage: { operationId: "op-last" } })),
    ].join("\n");
    const records = parsePiDesktopSession(content, FILE);
    expect(records).toHaveLength(1);
    expect(records[0]!.requestId).toBe("op-last");
  });

  it("首个有效 JSON 行不是 session 头则整文件不产出（host 阅读器同口径）", () => {
    const records = parsePiDesktopSession(
      jsonl(assistantLine({}), sessionHeader()),
      FILE,
    );
    expect(records).toEqual([]);
  });

  it("坏行在前不阻断 session 头识别；头内 sessionId 优先于文件名", () => {
    const otherId = "00000000-1111-2222-3333-444444444444";
    const content = [
      "{ torn line without newline",
      JSON.stringify(sessionHeader(otherId)),
      JSON.stringify(assistantLine({})),
    ].join("\n");
    const records = parsePiDesktopSession(content, "filename-session.jsonl");
    expect(records).toHaveLength(1);
    expect(records[0]!.sessionId).toBe(otherId);
    expect(records[0]!.id).toBe(`pidesktop:${otherId}:621883be-576f-404d-a4cb-bfcb128d62e6`);
  });

  it("createdAt 缺失或非法的记录跳过；responseDurationMs 非正数不记耗时", () => {
    const records = parsePiDesktopSession(
      jsonl(
        sessionHeader(),
        assistantLine({ createdAt: "" }),
        assistantLine({ createdAt: "not-a-date" }),
        assistantLine({ responseDurationMs: 0, usage: { operationId: "op-dur" } }),
      ),
      FILE,
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.requestId).toBe("op-dur");
    expect(records[0]!.estimatedDurationMs).toBeUndefined();
  });
});
