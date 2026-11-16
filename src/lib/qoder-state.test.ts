import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildQoderStateRecord,
  decryptQoderStateSegment,
  encryptQoderStateSegment,
  parseQoderStateContent,
  readQoderStateUsage,
  type QoderStateUsage,
} from "@/lib/qoder-state";
import type { UsageRecord } from "@/lib/usage";

/** 本机 Qoder 1.1.86-hotfix.5 真实 state.json 的 s0 段（workspace /Users/zch/code/ai-test/test-qwen4-p）。 */
const REAL_SESSION_ID = "31af4ec2-1913-4d1e-afa7-38c99c9359a0";
const REAL_WORKSPACE = "/Users/zch/code/ai-test/test-qwen4-p";
const REAL_SEGMENT_ITEM = {
  c: "2026-11-16T02:30:17.430Z",
  u: "2026-11-16T02:50:24.750Z",
  n: "/SVCFsme/w/yDP0B",
  p: "Np8Lr6PIJ/CvsGzkq4y4CMeTumTPm5rOKg1+tPAYdXmI5Gcwn3DAHTcLpZ6Wzw5j587B+ST3HjxL0a2fdu0eNiPAXzi3w7SKf4A0lciQ8TybOA+1Hk4OGxE3rjJqCreN/uHLDxy8WsIX/tNZFR+/HhucizqsOCvO/gwQsMWHmQBsn4HGbrg2+rNjk6X8RMhZcPcHsuGFA/5RQI3XZNg4XSPCc/yyhD0SuAU9vttg414kBc0rBGV7tF3fr0nR/j+Eot3ulRavUMbAJeGA2p59SZqExTsRsEklK4+onaXbgoOqsqhvqWrb1lAz4sGLS6dG5J+qosLZXBIhn9SClUGjkMgmOS1Wdt4jK78waJK3gxF0bkF3cz12/KsUAF4Fk8rhimw6TIK84Ely6K0ncsfK29bkTY7nkY2kHlqZm+VsF34T2CPpgFySmkRRQ0Jxh34eDm+D9DtS/f06qffqgtn6K4OrYcK1jzcssd7wjRyThrbeZu45nKSL18H+qBXI1IBb0eG/ZLTrr0NDt6XKRm824wknWiC7BAGysth1GKHCvPhxeyMTuQ==",
  t: "97Jpg1R+abkpskRtUAd89w==",
} as const;

/** darwin 数据落盘时路径已折小写；非 darwin 平台直接用小写形态保证哈希一致。 */
function pinnedWorkspaceRoot(): string {
  return process.platform === "darwin" ? REAL_WORKSPACE : REAL_WORKSPACE.toLowerCase();
}

function stateFileContent(
  payload: unknown,
  sessionId: string,
  projectRoot: string,
): string {
  return `${JSON.stringify(
    {
      sessionId,
      revision: 1,
      createdAt: "2026-11-16T02:30:17.430Z",
      updatedAt: "2026-11-16T02:50:24.750Z",
      data: {},
      items: { s0: encryptQoderStateSegment(JSON.stringify(payload), sessionId, projectRoot) },
    },
    null,
    2,
  )}\n`;
}

const AGGREGATE_PAYLOAD = {
  updatedAt: "2026-11-16T02:50:24.749Z",
  latest: {
    input_tokens: 99549,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 94850,
    output_tokens: 1211,
  },
  latestRequestId: "cd21c8a8-0c02-4b1c-969c-5ff068a3f82d",
  total: {
    input_tokens: 2074163,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 1866135,
    output_tokens: 25077,
  },
  credits: {
    total: 109.59382841,
    byModel: { qmodel_latest: { credits: 109.59382841 } },
  },
};

function record(overrides: Partial<UsageRecord>): UsageRecord {
  return {
    id: "qoder:req-1",
    requestId: "req-1",
    sessionId: "session-a",
    harness: "qoder",
    project: "p1",
    model: "qmodel_latest",
    provider: "Qoder",
    timestamp: 1_794_000_000_000,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    inputTokenSemantics: "fresh",
    hasTokenUsage: false,
    credits: 0,
    hasCredit: false,
    status: "success",
    ...overrides,
  };
}

describe("Qoder state.json 聚合解析", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "qoder-state-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("真实 1.1.86 固定样本按 cwd 候选解出会话聚合", () => {
    const payload = decryptQoderStateSegment(
      REAL_SEGMENT_ITEM,
      REAL_SESSION_ID,
      [pinnedWorkspaceRoot()],
    );
    expect(payload).toMatchObject({
      updatedAt: "2026-11-16T02:50:24.749Z",
      total: {
        input_tokens: 2_074_163,
        cache_read_input_tokens: 1_866_135,
        output_tokens: 25_077,
      },
      credits: { total: 109.59382841 },
    });
  });

  it("workspace 候选不匹配时解密失败返回 null，不影响其他会话", () => {
    expect(
      decryptQoderStateSegment(REAL_SEGMENT_ITEM, REAL_SESSION_ID, [
        "/Users/zch/code/other-project",
      ]),
    ).toBeNull();
  });

  it("读取并解析加密 state 文件；损坏 / 缺段返回 null", async () => {
    const sessionDir = path.join(root, "session-a");
    await mkdir(sessionDir, { recursive: true });
    const filePath = path.join(sessionDir, "state.json");
    await writeFile(filePath, stateFileContent(AGGREGATE_PAYLOAD, "session-a", "/tmp/wk_dir"));

    const usage = await readQoderStateUsage(filePath, "session-a", ["/tmp/wk_dir"]);
    expect(usage).toEqual({
      total: {
        inputTokens: 2_074_163,
        outputTokens: 25_077,
        cacheReadTokens: 1_866_135,
        cacheCreationTokens: 0,
      },
      credits: 109.59382841,
      models: [{ model: "qmodel_latest", credits: 109.59382841 }],
      updatedAt: Date.parse("2026-11-16T02:50:24.749Z"),
    } satisfies QoderStateUsage);

    await writeFile(filePath, "{ not json");
    expect(await readQoderStateUsage(filePath, "session-a", ["/tmp/wk_dir"])).toBeNull();
    await writeFile(filePath, JSON.stringify({ sessionId: "session-a", items: {} }));
    expect(parseQoderStateContent("{}", "session-a", [])).toBeNull();
  });

  it("BYOK 会话无 credits 快照：credits undefined、models 为空", () => {
    const usage = parseQoderStateContent(
      stateFileContent(
        { updatedAt: "2026-11-16T02:50:24.749Z", total: { input_tokens: 10, output_tokens: 2 } },
        "session-a",
        "/tmp/wk_dir",
      ),
      "session-a",
      ["/tmp/wk_dir"],
    );
    expect(usage).toMatchObject({ credits: undefined, models: [] });
  });

  it("total 与 credits 全缺时不产出补差记录", () => {
    const usage = parseQoderStateContent(
      stateFileContent({ updatedAt: "2026-11-16T02:50:24.749Z" }, "session-a", "/tmp/wk_dir"),
      "session-a",
      ["/tmp/wk_dir"],
    );
    expect(usage).toBeNull();
    expect(buildQoderStateRecord("session-a", "p1", usage, [])).toBeNull();
  });
});

describe("Qoder state 补差记录", () => {
  const baseUsage: QoderStateUsage = {
    total: {
      inputTokens: 2_074_163,
      outputTokens: 25_077,
      cacheReadTokens: 1_866_135,
      cacheCreationTokens: 0,
    },
    credits: 109.59382841,
    models: [{ model: "qmodel_latest", credits: 109.59382841 }],
    updatedAt: Date.parse("2026-11-16T02:50:24.749Z"),
  };

  it("新格式会话（jsonl 无 usage）补差记录等于会话聚合全集", () => {
    const created = buildQoderStateRecord("session-a", "p1", baseUsage, [
      record({ id: "qoder:jsonl-only", inputTokens: 0, outputTokens: 0, hasTokenUsage: false }),
    ]);
    expect(created).toMatchObject({
      id: "qoder:state:session-a",
      sessionId: "session-a",
      model: "qmodel_latest",
      inputTokens: 2_074_163,
      outputTokens: 25_077,
      cacheReadTokens: 1_866_135,
      totalTokens: 3_965_375,
      credits: 109.59382841,
      hasCredit: true,
      billable: true,
      hasTokenUsage: true,
      timestamp: Date.parse("2026-11-16T02:50:24.749Z"),
      status: "success",
    });
  });

  it("老格式会话 jsonl 已计满：差值为零不产出（BYOK 场景）", () => {
    expect(
      buildQoderStateRecord("session-a", "p1", baseUsage, [
        record({
          id: "qoder:req-1",
          inputTokens: 2_074_163,
          outputTokens: 25_077,
          cacheReadTokens: 1_866_135,
          totalTokens: 3_965_375,
          credits: 109.59382841,
          hasCredit: true,
        }),
      ]),
    ).toBeNull();
  });

  it("老格式会话 tokens 全零但 credits 已计：只补 tokens、不重复计 credits", () => {
    const created = buildQoderStateRecord("session-a", "p1", baseUsage, [
      record({
        id: "qoder:req-1",
        inputTokens: 0,
        credits: 109.59382841,
        hasCredit: true,
      }),
    ]);
    expect(created).toMatchObject({
      inputTokens: 2_074_163,
      credits: 0,
      hasCredit: false,
      hasTokenUsage: true,
    });
    expect(created).not.toHaveProperty("billable");
  });

  it("jsonl credits 少计：credits 差值单独补齐；时间戳回退到 jsonl 最新记录", () => {
    const usage: QoderStateUsage = {
      total: null,
      credits: 88.93,
      models: [{ model: "kmodel_latest", credits: 88.93 }],
      updatedAt: undefined,
    };
    const created = buildQoderStateRecord("session-a", "p1", usage, [
      record({
        id: "qoder:req-1",
        timestamp: 1_794_000_000_000,
        credits: 63.77,
        hasCredit: true,
      }),
      // 补差记录自身不参与会话求和
      record({
        id: "qoder:state:session-a",
        timestamp: 1_794_000_500_000,
        credits: 999,
        hasCredit: true,
      }),
    ]);
    expect(created).toMatchObject({
      credits: 88.93 - 63.77,
      hasCredit: true,
      totalTokens: 0,
      hasTokenUsage: false,
      timestamp: 1_794_000_000_000,
    });
  });

  it("credits 未观测（BYOK）且 tokens 已计满：不产出", () => {
    const usage: QoderStateUsage = {
      total: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
      credits: undefined,
      models: [],
      updatedAt: 1_794_000_000_000,
    };
    expect(
      buildQoderStateRecord("session-a", "p1", usage, [
        record({ id: "qoder:req-1", inputTokens: 100, outputTokens: 5, totalTokens: 105 }),
      ]),
    ).toBeNull();
  });
});
