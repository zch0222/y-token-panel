import { describe, expect, it } from "vitest";
import {
  modelFromSettingsChange,
  parseAntigravityTranscript,
  projectLabelFromWorkspaceUris,
} from "@/lib/antigravity-session";

/** 真实 transcript 行的最小投影：字段名与 Antigravity 写入的完全一致。 */
function step(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    step_index: 1,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    created_at: "2026-11-08T17:52:13Z",
    input_tokens: 10587,
    cache_read_tokens: 0,
    output_tokens: 414,
    ...overrides,
  });
}

function userInput(content: string, stepIndex = 0): string {
  return step({
    step_index: stepIndex,
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    input_tokens: undefined,
    cache_read_tokens: undefined,
    output_tokens: undefined,
    content,
  });
}

const SETTINGS_CHANGE = (to: string) =>
  "The user changed setting `Model Selection` from None to " +
  to +
  ". No need to comment on this change if the user doesn't ask about it.";

describe("parseAntigravityTranscript", () => {
  it("按真实字段产出记录：输入不含缓存、输出已含思考、无 Credits", () => {
    const [record] = parseAntigravityTranscript(
      step({}) + "\n",
      "2d7b6c61-fc85-416b-b43b-01930298feb1",
      "y-token-panel",
    );
    expect(record).toMatchObject({
      id: "antigravity:2d7b6c61-fc85-416b-b43b-01930298feb1:1",
      requestId: "2d7b6c61-fc85-416b-b43b-01930298feb1:1",
      sessionId: "2d7b6c61-fc85-416b-b43b-01930298feb1",
      harness: "antigravity",
      project: "y-token-panel",
      model: "未知模型",
      provider: "Antigravity",
      timestamp: Date.parse("2026-11-08T17:52:13Z"),
      inputTokens: 10587,
      outputTokens: 414,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 11001,
      inputTokenSemantics: "fresh",
      hasTokenUsage: true,
      credits: 0,
      hasCredit: false,
      status: "success",
    });
    expect(record).not.toHaveProperty("estimatedDurationMs");
  });

  it("把 CHECKPOINT（上下文压缩请求）也计入，不当作前序累计值", () => {
    const content = [
      step({ step_index: 87, type: "GENERIC", content: "tool output", input_tokens: undefined, output_tokens: undefined, cache_read_tokens: undefined }),
      step({
        step_index: 88,
        source: "SYSTEM",
        type: "CHECKPOINT",
        input_tokens: 14736,
        cache_read_tokens: 243879,
        output_tokens: 7507,
        content: "# Resuming from a compaction",
      }),
    ].join("\n");
    const records = parseAntigravityTranscript(content, "conv", "demo");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      inputTokens: 14736,
      cacheReadTokens: 243879,
      outputTokens: 7507,
      totalTokens: 266122,
    });
  });

  it("只导入 DONE 且用量非零的响应", () => {
    const content = [
      step({ step_index: 1, status: "RUNNING" }),
      step({ step_index: 2, status: "ERROR" }),
      step({ step_index: 3, input_tokens: 0, cache_read_tokens: 0, output_tokens: 0 }),
      step({ step_index: 4, type: "GENERIC", input_tokens: undefined, output_tokens: undefined, cache_read_tokens: undefined }),
    ].join("\n");
    expect(parseAntigravityTranscript(content, "conv", "demo")).toEqual([]);
  });

  it("模型按 step 顺序继承 Model Selection 切换事件，切换前的响应不受影响", () => {
    const content = [
      userInput(SETTINGS_CHANGE("Gemini 4 Argon (High)"), 0),
      step({ step_index: 1, input_tokens: 100, output_tokens: 10 }),
      userInput(SETTINGS_CHANGE("Claude Opus 5.5 (Medium)"), 9),
      step({ step_index: 10, input_tokens: 200, output_tokens: 20 }),
    ].join("\n");
    const records = parseAntigravityTranscript(content, "conv", "demo");
    expect(records.map((record) => record.model)).toEqual([
      "Gemini 4 Argon (High)",
      "Claude Opus 5.5 (Medium)",
    ]);
    expect(records.map((record) => record.provider)).toEqual(["Google", "Anthropic"]);
  });

  it("正文里提到 Model Selection 不算切换，只有 USER_INPUT 的设置变更才生效", () => {
    const content = [
      step({
        step_index: 1,
        type: "GENERIC",
        input_tokens: undefined,
        cache_read_tokens: undefined,
        output_tokens: undefined,
        content: "- **Model Selection**: Choose the active Gemini model " + SETTINGS_CHANGE("Fake Model"),
      }),
      step({ step_index: 2, input_tokens: 100, output_tokens: 10 }),
    ].join("\n");
    expect(parseAntigravityTranscript(content, "conv", "demo")[0]?.model).toBe("未知模型");
  });

  it("模型名里的点号不会被当成句末", () => {
    expect(modelFromSettingsChange(SETTINGS_CHANGE("Gemini 3.8 Flash (High)"))).toBe(
      "Gemini 3.8 Flash (High)",
    );
    expect(modelFromSettingsChange("The user changed setting `Model Selection` from None to None.")).toBe(
      undefined,
    );
  });

  it("耗时只用于 PLANNER_RESPONSE：CHECKPOINT 即使有映射也不带 estimatedDurationMs", () => {
    const content = [
      step({ step_index: 1 }),
      step({ step_index: 88, type: "CHECKPOINT", source: "SYSTEM" }),
    ].join("\n");
    const timings = new Map([
      [1, 8013],
      [88, 11000],
    ]);
    const records = parseAntigravityTranscript(content, "conv", "demo", { timings });
    expect(records.map((record) => [record.id, record.estimatedDurationMs])).toEqual([
      ["antigravity:conv:1", 8013],
      ["antigravity:conv:88", undefined],
    ]);
  });

  it("同一 step_index 重复写入时取最后一条", () => {
    const content = [
      step({ step_index: 5, status: "RUNNING" }),
      step({ step_index: 5, status: "DONE", output_tokens: 900 }),
    ].join("\n");
    const records = parseAntigravityTranscript(content, "conv", "demo");
    expect(records).toHaveLength(1);
    expect(records[0]?.outputTokens).toBe(900);
  });

  it("容错：损坏行、尾部半行、非法时间戳与非数值字段", () => {
    const content = [
      "{ not json",
      step({ step_index: 1 }),
      '{"step_index":2,"type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-11-09T01:00:00Z","input_tokens":"12","cache_read_tokens":"3","output_tokens":4}',
      step({ step_index: 3, created_at: "not-a-date" }),
      '{"step_index":4,"type":"PLANNER',
    ].join("\n");
    const records = parseAntigravityTranscript(content, "conv", "demo");
    expect(records.map((record) => record.totalTokens)).toEqual([11001, 19]);
  });
});

describe("projectLabelFromWorkspaceUris", () => {
  it("解析 Windows percent-encoded 工作区 URI", () => {
    expect(projectLabelFromWorkspaceUris('["file:///d%3A/code/y-token-panel"]')).toBe(
      "y-token-panel",
    );
  });

  it("解析 POSIX 工作区 URI 与尾部斜杠", () => {
    expect(projectLabelFromWorkspaceUris('["file:///home/me/repo/"]')).toBe("repo");
  });

  it("损坏 JSON、非数组、空数组与非 file URI 返回 undefined", () => {
    expect(projectLabelFromWorkspaceUris("{")).toBeUndefined();
    expect(projectLabelFromWorkspaceUris('{"a":1}')).toBeUndefined();
    expect(projectLabelFromWorkspaceUris("[]")).toBeUndefined();
    expect(projectLabelFromWorkspaceUris('["https://example.com/x"]')).toBeUndefined();
  });
});
