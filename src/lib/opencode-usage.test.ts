import { describe, expect, it } from "vitest";
import {
  collectOpenCodeUsage,
  opencodeProjectLabel,
  parseOpenCodeUsageRow,
  type OpenCodeUsageRow,
} from "@/lib/opencode-usage";

function row(data: unknown, overrides: Partial<OpenCodeUsageRow> = {}): OpenCodeUsageRow {
  return {
    message_id: "msg-1",
    message_type: "assistant",
    row_time_created: 1_000,
    row_time_updated: 2_000,
    data: typeof data === "string" ? data : JSON.stringify(data),
    session_id: "ses-1",
    session_directory: "D:/work/demo-project",
    ...overrides,
  };
}

function assistantData(overrides: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    agent: "build",
    model: { providerID: "opencode-go", id: "kimi-k2.5", variant: "default" },
    cost: 0.0123,
    tokens: {
      input: 100,
      output: 20,
      reasoning: 7,
      cache: { read: 40, write: 5 },
    },
    finish: "stop",
    time: {
      created: 10_000,
      firstToken: 10_350,
      streamed: 11_200,
      completed: 11_500,
    },
    ...overrides,
  };
}

describe("parseOpenCodeUsageRow", () => {
  it("按 OpenCode TokenUsage 五项求和，output 合并 reasoning，并使用精确 firstToken/streamed 时间", () => {
    const record = parseOpenCodeUsageRow(row(assistantData()), "v2");
    expect(record).toMatchObject({
      id: "opencode:ses-1:msg-1",
      requestId: "msg-1",
      sessionId: "ses-1",
      harness: "opencode",
      project: "demo-project",
      model: "kimi-k2.5",
      provider: "opencode-go",
      timestamp: 10_000,
      inputTokens: 100,
      outputTokens: 27,
      cacheReadTokens: 40,
      cacheCreationTokens: 5,
      totalTokens: 172,
      inputTokenSemantics: "fresh",
      hasTokenUsage: true,
      credits: 0,
      hasCredit: false,
      status: "success",
      firstTokenMs: 350,
      estimatedDurationMs: 1_200,
    });
  });

  it("streamed 缺失或乱序时按 cc-switch 语义回退 completed", () => {
    const missingStreamed = parseOpenCodeUsageRow(
      row(assistantData({ time: { created: 1_000, completed: 2_500 } })),
      "v2",
    );
    expect(missingStreamed?.estimatedDurationMs).toBe(1_500);
    expect(missingStreamed?.firstTokenMs).toBeUndefined();

    const staleStreamed = parseOpenCodeUsageRow(
      row(
        assistantData({
          time: { created: 1_000, streamed: 900, firstToken: 1_100, completed: 2_000 },
        }),
      ),
      "v2",
    );
    expect(staleStreamed?.estimatedDurationMs).toBe(1_000);
    expect(staleStreamed?.firstTokenMs).toBe(100);
  });

  it("assistant 带 error/finish=error 记为失败，但仍保留已落库 token 用量", () => {
    const record = parseOpenCodeUsageRow(
      row(assistantData({ finish: "error", error: { name: "APIError", data: { message: "boom" } } })),
      "v2",
    );
    expect(record?.status).toBe("error");
    expect(record?.totalTokens).toBe(172);
  });

  it("compaction completed/failed 都是独立请求记录", () => {
    const compaction = {
      type: "compaction",
      status: "failed",
      reason: "auto",
      tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 4 } },
      cost: 0,
      time: { created: 5_000, completed: 5_800 },
    };
    const record = parseOpenCodeUsageRow(
      row(compaction, { message_id: "compact-1", message_type: "compaction" }),
      "v2",
    );
    expect(record).toMatchObject({
      status: "error",
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 3,
      cacheCreationTokens: 4,
      totalTokens: 20,
    });
  });

  it("跳过未完成、无 tokens、全零 tokens、非 assistant/compaction 与坏 JSON 行", () => {
    const rows = [
      row(assistantData({ time: { created: 1_000 } })),
      row(assistantData({ tokens: undefined })),
      row(assistantData({ tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })),
      row({ role: "user", tokens: assistantData().tokens, time: assistantData().time }, { message_type: "user" }),
      row("{bad json"),
    ];
    expect(collectOpenCodeUsage(rows, "v2")).toEqual([]);
  });

  it("v1 assistant 使用平铺 providerID/modelID，且只读取 assistant role", () => {
    const data = {
      role: "assistant",
      providerID: "deepseek",
      modelID: "deepseek-v4-pro",
      tokens: { input: 3, output: 4, reasoning: 2, cache: { read: 1, write: 0 } },
      cost: 0.001,
      time: { created: 20_000, completed: 21_000 },
    };
    const record = parseOpenCodeUsageRow(
      row(data, { message_type: null, session_directory: "C:/Users/me/project" }),
      "v1",
    );
    expect(record).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      outputTokens: 6,
      totalTokens: 10,
      estimatedDurationMs: 1_000,
    });
    expect(
      parseOpenCodeUsageRow(row({ ...data, role: "user" }, { message_type: null }), "v1"),
    ).toBeNull();
  });

  it("项目名取 directory 叶级；缺模型时用现有 provider 推断兜底", () => {
    expect(opencodeProjectLabel("D:/work/my-project/")).toBe("my-project");
    expect(opencodeProjectLabel("")).toBe("unknown");
    const record = parseOpenCodeUsageRow(
      row(
        assistantData({
          model: undefined,
          modelID: "claude-sonnet-4-5",
          providerID: undefined,
        }),
      ),
      "v2",
    );
    expect(record?.model).toBe("claude-sonnet-4-5");
    expect(record?.provider).toBe("Anthropic");
  });
});
