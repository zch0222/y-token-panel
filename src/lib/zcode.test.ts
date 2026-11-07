import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { summarizeRecords, type UsageRecord } from "@/lib/usage";
import {
  clampInteger,
  collectZcodeUsage,
  parseZcodeUsageRow,
  zcodeInputSideTokens,
  zcodeProjectLabel,
  ZCODE_USAGE_SQL,
  type ZcodeModelUsageRow,
} from "@/lib/zcode-usage";

/** 便于覆盖字段的行工厂：数值取自本机 model_usage 实测行。 */
function row(overrides: Partial<ZcodeModelUsageRow> = {}): ZcodeModelUsageRow {
  return {
    id: "usage_model_main_turn_msg-abc-123_0",
    logical_request_id: "msg-abc-123",
    attempt_index: 0,
    session_id: "sess_85190ce4-3055-421f-b87a-50d2fc12ddac",
    query_source: "main_turn",
    provider_id: "account:bigmodel-individual-coding-plan",
    model_id: "GLM-5.3",
    status: "completed",
    started_at: 1_794_065_393_518,
    duration_ms: 28_780,
    input_tokens: 81_380,
    output_tokens: 1_431,
    reasoning_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 80_192,
    provider_total_tokens: 82_811,
    computed_total_tokens: 82_811,
    session_directory: "D:\\code\\y-token-panel",
    ...overrides,
  };
}

describe("clampInteger", () => {
  it("非数值与负数截为 0，小数截断取整", () => {
    expect(clampInteger(null)).toBe(0);
    expect(clampInteger(Number.NaN)).toBe(0);
    expect(clampInteger(-5)).toBe(0);
    expect(clampInteger(3.9)).toBe(3);
    expect(clampInteger(1000)).toBe(1000);
  });
});

describe("zcodeInputSideTokens（对齐 zcode 读侧 inputSideTokensFromStoredUsage）", () => {
  it("现行格式：input 已含缓存，总量与 input+output 对齐时直接取 input", () => {
    // 实测行：81380 + 1431 = 82811 = provider_total
    expect(
      zcodeInputSideTokens(
        row({
          input_tokens: 81_380,
          cache_read_input_tokens: 80_192,
          output_tokens: 1_431,
          provider_total_tokens: 82_811,
        }),
      ),
    ).toBe(81_380);
  });

  it("旧格式：input 不含缓存，总量与 input+缓存+output 对齐时取 input+缓存", () => {
    // 31136 + 22528 + 234 = 53898，比 31136+234 更接近 provider_total
    expect(
      zcodeInputSideTokens(
        row({
          input_tokens: 31_136,
          cache_read_input_tokens: 22_528,
          output_tokens: 234,
          provider_total_tokens: 53_898,
        }),
      ),
    ).toBe(53_664);
  });

  it("input 为 0 时输入侧只剩缓存分量之和", () => {
    expect(
      zcodeInputSideTokens(
        row({
          input_tokens: 0,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 900,
        }),
      ),
    ).toBe(1000);
  });

  it("没有缓存分量时输入侧就是 input", () => {
    expect(
      zcodeInputSideTokens(
        row({ input_tokens: 5_000, cache_read_input_tokens: 0 }),
      ),
    ).toBe(5_000);
  });

  it("总量缺失（0）时默认 input 已含缓存", () => {
    expect(
      zcodeInputSideTokens(
        row({
          input_tokens: 1_000,
          cache_read_input_tokens: 800,
          provider_total_tokens: null,
          computed_total_tokens: 0,
        }),
      ),
    ).toBe(1_000);
  });

  it("provider_total_tokens 为 0 时不落入 ?? 之后的 computed_total_tokens", () => {
    // 0 ?? computed → 0（?? 只跳过 null/undefined），与 zcode 原实现一致
    expect(
      zcodeInputSideTokens(
        row({
          input_tokens: 1_000,
          cache_read_input_tokens: 800,
          provider_total_tokens: 0,
          computed_total_tokens: 1_800,
        }),
      ),
    ).toBe(1_000);
  });
});

describe("zcodeProjectLabel", () => {
  it("Windows 与 POSIX 路径都取最后一段", () => {
    expect(zcodeProjectLabel("D:\\code\\y-token-panel")).toBe("y-token-panel");
    expect(zcodeProjectLabel("/home/yxlm/cli2api")).toBe("cli2api");
  });

  it("容忍结尾分隔符", () => {
    expect(zcodeProjectLabel("D:\\code\\vgrep\\")).toBe("vgrep");
  });

  it("缺失或空白目录返回未知项目", () => {
    expect(zcodeProjectLabel(null)).toBe("未知项目");
    expect(zcodeProjectLabel(undefined)).toBe("未知项目");
    expect(zcodeProjectLabel("   ")).toBe("未知项目");
    expect(zcodeProjectLabel("")).toBe("未知项目");
  });
});

describe("parseZcodeUsageRow", () => {
  it("实测行映射出完整 UsageRecord", () => {
    const record = parseZcodeUsageRow(row());
    expect(record).toEqual({
      id: "zcode:usage_model_main_turn_msg-abc-123_0",
      requestId: "usage_model_main_turn_msg-abc-123_0",
      sessionId: "sess_85190ce4-3055-421f-b87a-50d2fc12ddac",
      harness: "zcode",
      project: "y-token-panel",
      model: "GLM-5.3",
      provider: "account:bigmodel-individual-coding-plan",
      timestamp: 1_794_065_393_518,
      inputTokens: 81_380,
      outputTokens: 1_431,
      cacheReadTokens: 80_192,
      cacheCreationTokens: 0,
      totalTokens: 82_811,
      inputTokenSemantics: "total",
      hasTokenUsage: true,
      credits: 0,
      hasCredit: false,
      estimatedDurationMs: 28_780,
      status: "success",
    });
  });

  it("provider_total 缺失时使用 computed_total", () => {
    const record = parseZcodeUsageRow(
      row({ provider_total_tokens: null, computed_total_tokens: 82_811 }),
    );
    expect(record?.totalTokens).toBe(82_811);
  });

  it("两个总量都缺失且为 0 时退回输入+输出", () => {
    const record = parseZcodeUsageRow(
      row({
        provider_total_tokens: null,
        computed_total_tokens: 0,
        input_tokens: 1_000,
        cache_read_input_tokens: 0,
        output_tokens: 200,
      }),
    );
    expect(record?.totalTokens).toBe(1_200);
  });

  it("全零 token 行 hasTokenUsage 为 false", () => {
    const record = parseZcodeUsageRow(
      row({
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        provider_total_tokens: null,
        computed_total_tokens: 0,
      }),
    );
    expect(record?.hasTokenUsage).toBe(false);
    expect(record?.totalTokens).toBe(0);
  });

  it("error / cancelled / running 一律按未成功记 error", () => {
    for (const status of ["error", "cancelled", "running"]) {
      expect(parseZcodeUsageRow(row({ status }))?.status).toBe("error");
    }
    expect(parseZcodeUsageRow(row({ status: "completed" }))?.status).toBe(
      "success",
    );
  });

  it("duration_ms 缺失、0、负数时不给耗时，小数被截断", () => {
    expect(parseZcodeUsageRow(row({ duration_ms: null }))?.estimatedDurationMs).toBeUndefined();
    expect(parseZcodeUsageRow(row({ duration_ms: 0 }))?.estimatedDurationMs).toBeUndefined();
    expect(parseZcodeUsageRow(row({ duration_ms: -3 }))?.estimatedDurationMs).toBeUndefined();
    expect(parseZcodeUsageRow(row({ duration_ms: 1500.7 }))?.estimatedDurationMs).toBe(1500);
  });

  it("session 目录缺失时项目为未知项目，session_id 缺失兜底为空串", () => {
    const record = parseZcodeUsageRow(
      row({ session_directory: null, session_id: null }),
    );
    expect(record?.project).toBe("未知项目");
    expect(record?.sessionId).toBe("");
  });

  it("id 缺失或 started_at 非法（null/0/负数）的行丢弃", () => {
    expect(parseZcodeUsageRow(row({ id: null }))).toBeNull();
    expect(parseZcodeUsageRow(row({ id: "" }))).toBeNull();
    expect(parseZcodeUsageRow(row({ started_at: null }))).toBeNull();
    expect(parseZcodeUsageRow(row({ started_at: 0 }))).toBeNull();
    expect(parseZcodeUsageRow(row({ started_at: -1 }))).toBeNull();
  });

  it("model / provider 缺失时有兜底，不丢行", () => {
    const record = parseZcodeUsageRow(row({ model_id: null, provider_id: null }));
    expect(record?.model).toBe("未知模型");
    expect(record?.provider).toBe("ZCode");
  });
});

describe("collectZcodeUsage", () => {
  it("按时间倒序输出并统计有记录的会话数", () => {
    const { records, sessionCount } = collectZcodeUsage([
      row({ id: "a", started_at: 1_000 }),
      row({ id: "b", started_at: 3_000 }),
      row({
        id: "c",
        started_at: 2_000,
        session_id: "sess_other",
        session_directory: "/home/yxlm/cli2api",
      }),
    ]);
    expect(records.map((record) => record.id)).toEqual([
      "zcode:b",
      "zcode:c",
      "zcode:a",
    ]);
    expect(sessionCount).toBe(2);
  });

  it("时间戳非法的行被丢弃，其余保留", () => {
    const { records } = collectZcodeUsage([
      row({ id: "bad", started_at: null }),
      row({ id: "good" }),
    ]);
    expect(records.map((record) => record.id)).toEqual(["zcode:good"]);
  });
});

describe("summarizeRecords 与 ZCode 记录", () => {
  it("无 Credits 字段：hasCredit 为 false，速度按精确耗时聚合", () => {
    const record = parseZcodeUsageRow(row()) as UsageRecord;
    const summary = summarizeRecords([record]);
    expect(summary.hasCredit).toBe(false);
    expect(summary.credits).toBe(0);
    expect(summary.tokens).toBe(82_811);
    // 输出 1431 ≥ 200 且耗时 28780ms ≥ 1s，计入速度
    expect(summary.speedOutputTokens).toBe(1_431);
    expect(summary.speedDurationMs).toBe(28_780);
  });
});

// ---------------------------------------------------------------------------
// 集成验证：用 zcode 真实建表 DDL 搭一个临时库，跑 ZCODE_USAGE_SQL，
// 防止 SQL 列名 / join 与真实 schema 脱节。
// ---------------------------------------------------------------------------

let sqlite: typeof import("node:sqlite") | null = null;
try {
  sqlite = await import("node:sqlite");
} catch {
  sqlite = null;
}

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe.skipIf(!sqlite)("ZCODE_USAGE_SQL 对真实 schema", () => {
  async function createFixtureDb() {
    const dir = await mkdtemp(path.join(tmpdir(), "zcode-usage-test-"));
    tempDirs.push(dir);
    const db = new sqlite!.DatabaseSync(path.join(dir, "db.sqlite"));
    // 与 zcode migration 的真实 DDL 保持一致（仅建本查询涉及的表）。
    db.exec(`
      CREATE TABLE session (
        id text primary key,
        project_id text not null,
        workspace_id text,
        parent_id text,
        slug text not null,
        directory text not null,
        path text,
        title text not null,
        version text not null,
        share_url text,
        permission text,
        time_created integer not null,
        time_updated integer not null,
        task_type text not null default 'interactive'
      );
      CREATE TABLE model_usage (
        id text primary key,
        logical_request_id text not null,
        attempt_index integer not null default 0,
        session_id text not null references session(id) on delete cascade,
        turn_id text,
        trace_id text,
        span_id text,
        assistant_message_id text,
        parent_user_message_id text,
        query_source text not null,
        provider_id text not null,
        model_id text not null,
        variant text,
        agent text,
        mode text,
        task_type text,
        status text not null check(status in ('running', 'completed', 'error', 'cancelled')),
        started_at integer not null,
        first_token_at integer,
        completed_at integer,
        duration_ms integer,
        time_to_first_token_ms integer,
        finish_reason text,
        tool_call_count integer not null default 0,
        input_tokens integer not null default 0,
        output_tokens integer not null default 0,
        reasoning_tokens integer not null default 0,
        cache_creation_input_tokens integer not null default 0,
        cache_read_input_tokens integer not null default 0,
        provider_total_tokens integer,
        computed_total_tokens integer not null default 0,
        retry_count integer not null default 0,
        retryable integer not null default 0 check(retryable in (0, 1)),
        cancelled_by_user integer not null default 0,
        context_exceeded integer not null default 0,
        error_type text,
        error_code text,
        error_message text,
        raw_usage_json text,
        provider_metadata_json text
      );
    `);
    const insertSession = db.prepare(
      "insert into session (id, project_id, slug, directory, title, version, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insertSession.run(
      "sess_85190ce4-3055-421f-b87a-50d2fc12ddac",
      "p1",
      "slug-1",
      "D:\\code\\y-token-panel",
      "会话标题",
      "1",
      1_794_000_000_000,
      1_794_000_000_000,
    );
    const insertUsage = db.prepare(
      `insert into model_usage (
         id, logical_request_id, attempt_index, session_id, query_source,
         provider_id, model_id, status, started_at, duration_ms,
         input_tokens, output_tokens, cache_creation_input_tokens,
         cache_read_input_tokens, provider_total_tokens, computed_total_tokens
       ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertUsage.run(
      "usage_model_main_turn_msg-a_0",
      "msg-a",
      0,
      "sess_85190ce4-3055-421f-b87a-50d2fc12ddac",
      "main_turn",
      "account:bigmodel-individual-coding-plan",
      "GLM-5.3",
      "completed",
      1_794_065_393_518,
      28_780,
      81_380,
      1_431,
      0,
      80_192,
      82_811,
      82_811,
    );
    insertUsage.run(
      "usage_model_session_title_t1_0",
      "t1",
      0,
      "sess_85190ce4-3055-421f-b87a-50d2fc12ddac",
      "session_title",
      "account:bigmodel-start-plan",
      "GLM-5.3-Flash",
      "completed",
      1_794_065_000_000,
      4_210,
      2_050,
      18,
      32,
      1_400,
      2_068,
      2_068,
    );
    db.close();
    return path.join(dir, "db.sqlite");
  }

  it("join session 取到项目目录并完成端到端映射", async () => {
    const dbPath = await createFixtureDb();
    const db = new sqlite!.DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare(ZCODE_USAGE_SQL).all();
      const { records, sessionCount } = collectZcodeUsage(rows);
      expect(records).toHaveLength(2);
      expect(sessionCount).toBe(1);
      const [newer, older] = records;
      expect(newer.id).toBe("zcode:usage_model_main_turn_msg-a_0");
      expect(newer.project).toBe("y-token-panel");
      expect(newer.inputTokenSemantics).toBe("total");
      expect(newer.totalTokens).toBe(82_811);
      expect(older.id).toBe("zcode:usage_model_session_title_t1_0");
      expect(older.provider).toBe("account:bigmodel-start-plan");
      expect(older.totalTokens).toBe(2_068);
    } finally {
      db.close();
    }
  });

  it("session 行缺失（孤儿 usage 行）时项目回退未知项目", async () => {
    const dbPath = await createFixtureDb();
    const db = new sqlite!.DatabaseSync(dbPath);
    // 关闭外键约束模拟孤儿 usage 行（真实库有级联删除，这里只验证防御路径）。
    db.exec("PRAGMA foreign_keys = OFF");
    try {
      db.prepare(
        "insert into model_usage (id, logical_request_id, session_id, query_source, provider_id, model_id, status, started_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "usage_model_main_turn_orphan_0",
        "orphan",
        "sess_missing",
        "main_turn",
        "bigmodel-api",
        "GLM-5.3",
        "error",
        1_794_066_000_000,
      );
    } finally {
      db.close();
    }
    const ro = new sqlite!.DatabaseSync(dbPath, { readOnly: true });
    try {
      const { records } = collectZcodeUsage(ro.prepare(ZCODE_USAGE_SQL).all());
      const orphan = records.find(
        (record) => record.id === "zcode:usage_model_main_turn_orphan_0",
      );
      expect(orphan).toMatchObject({
        project: "未知项目",
        status: "error",
        hasTokenUsage: false,
      });
    } finally {
      ro.close();
    }
  });
});
