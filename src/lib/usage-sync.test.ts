import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createUsageSnapshotResponse } from "@/lib/usage-http";
import { getUsageStore } from "@/lib/usage-store";
import { requestUsageSync } from "@/lib/usage-sync";

const root = mkdtempSync(path.join(tmpdir(), "y-token-usage-worker-"));
const databasePath = path.join(root, "usage.sqlite");

function stubDataDirectories(): void {
  const variables = [
    "CODEBUDDY_DATA_DIR",
    "CODEBUDDY_CONFIG_DIR",
    "WORKBUDDY_DATA_DIR",
    "WORKBUDDY_CONFIG_DIR",
    "QODER_DATA_DIR",
    "QODERCN_CONFIG_DIR",
    "QODERCN_CLI_HOME",
    "ZCODE_DATA_DIR",
    "ZCODE_SESSION_DB_PATH",
    "ZCODE_SESSION_DB",
    "KIMI_CODE_HOME",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "DSH_HOME",
    "ANTIGRAVITY_DATA_DIR",
    "PI_DESKTOP_DATA_DIR",
    "DEVIN_DATA_DIR",
    "DEVIN_SESSIONS_DIR",
    "DEVIN_CONFIG_HOME",
  ];
  for (const variable of variables) {
    vi.stubEnv(variable, path.join(root, "missing", variable));
  }
  vi.stubEnv("QODERCN_CONFIG_DIR_NAME", "");
}

stubDataDirectories();
vi.stubEnv("USAGE_DB_PATH", databasePath);
vi.stubEnv("USAGE_SYNC_TIMEOUT_MS", "30000");

afterAll(() => {
  getUsageStore().close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("独立用量 worker", () => {
  it("20 个并发同步共享一个 Promise，查询只读持久化快照", async () => {
    const emptyResponse = createUsageSnapshotResponse();
    expect(await emptyResponse.json()).toMatchObject({
      revision: 0,
      snapshotAvailable: false,
      sync: { phase: "empty" },
    });

    const requests = Array.from({ length: 20 }, () => requestUsageSync());
    expect(new Set(requests).size).toBe(1);
    const results = await Promise.all(requests);
    expect(results.every((result) => result === results[0])).toBe(true);
    expect(results[0]).toMatchObject({ revision: 1, changed: true, recordCount: 0 });

    const snapshotResponse = createUsageSnapshotResponse();
    expect(snapshotResponse.headers.get("X-Usage-Revision")).toBe("1");
    const snapshot = (await snapshotResponse.json()) as {
      revision: number;
      snapshotAvailable: boolean;
      records: unknown[];
      sync: { phase: string };
    };
    expect(snapshot).toMatchObject({
      revision: 1,
      snapshotAvailable: true,
      records: [],
      sync: { phase: "ready" },
    });

    const unchanged = await requestUsageSync();
    expect(unchanged).toMatchObject({ revision: 1, changed: false, recordCount: 0 });
    expect(getUsageStore().getStatus()).toMatchObject({ phase: "ready", revision: 1 });
  }, 60_000);

  it("worker 启动失败保留最后成功快照，失败后下一轮可重新执行", async () => {
    await requestUsageSync();
    const lastSuccess = getUsageStore().getSnapshotJson();
    expect(lastSuccess).not.toBeNull();

    // SQLite 不能以目录作为数据库文件，模拟 worker 在扫描前初始化失败。
    vi.stubEnv("USAGE_DB_PATH", root);
    await expect(requestUsageSync()).rejects.toThrow(/worker 失败/);
    vi.stubEnv("USAGE_DB_PATH", databasePath);

    expect(getUsageStore().getSnapshotJson()).toBe(lastSuccess);
    expect(getUsageStore().getStatus()).toMatchObject({
      phase: "error",
      hasSnapshot: true,
      revision: 1,
    });

    await expect(requestUsageSync()).resolves.toMatchObject({ revision: 1, changed: false });
    expect(getUsageStore().getSnapshotJson()).not.toBe(lastSuccess); // lastSync 更新，revision 不变。
    expect(getUsageStore().getStatus()).toMatchObject({ phase: "ready", revision: 1 });
  }, 60_000);

  it("同范围单来源同步共享一个 Promise，全量在途覆盖单来源请求", async () => {
    // 同范围搭车：同一个 worker，同一个 Promise。
    const first = requestUsageSync("claude");
    const second = requestUsageSync("claude");
    expect(second).toBe(first);
    await first;

    // 全量在途覆盖任意单来源请求：直接复用全量 Promise。
    const full = requestUsageSync();
    const joiner = requestUsageSync("codex");
    expect(joiner).toBe(full);
    await full;

    // 反向不成立：单来源在途时全量请求必须排队独立执行。
    const scoped = requestUsageSync("dsh");
    const independentFull = requestUsageSync();
    expect(independentFull).not.toBe(scoped);
    await Promise.all([scoped, independentFull]);
    expect(getUsageStore().getStatus()).toMatchObject({ phase: "ready" });
  }, 60_000);

  it("不同范围的单来源同步串行执行，均能完成", async () => {
    const [claudeResult, codexResult] = await Promise.all([
      requestUsageSync("claude"),
      requestUsageSync("codex"),
    ]);
    expect(claudeResult).toMatchObject({ recordCount: 0 });
    expect(codexResult).toMatchObject({ recordCount: 0 });
    expect(getUsageStore().getStatus()).toMatchObject({ phase: "ready" });
  }, 60_000);

  it("非法 harness 范围worker 失败但不破坏已有快照", async () => {
    await requestUsageSync();
    const lastSuccess = getUsageStore().getSnapshotJson();
    // 绕过类型系统直接传入非法范围：worker 入口校验拒绝。
    await expect(
      (requestUsageSync as (harness?: string) => Promise<unknown>)("not-a-harness"),
    ).rejects.toThrow();
    expect(getUsageStore().getSnapshotJson()).toBe(lastSuccess);
    // 失败后正常同步仍可恢复。
    await expect(requestUsageSync()).resolves.toMatchObject({ changed: false });
  }, 60_000);
});
