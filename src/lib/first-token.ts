import type { HarnessId, UsageRecord } from "@/lib/usage";

/**
 * 首 token（TTFT，首字时间）的口径，对齐 cc-switch 的 first_token_ms 语义
 * （src-tauri/src/services/session_usage.rs 的 estimated_first_token_ms 与
 * usage_stats.rs 的 first_token_medians），字段含义全部依据本机 harness 实际
 * 代码反查确认（详见各 reader 的文件头）：
 *
 * - ZCode：model_usage.time_to_first_token_ms，写入方 zcode.cjs 的 HC
 *   （firstTokenAt 由 JJo 取首个非空 text/reasoning delta 的流事件时刻，
 *   timeToFirstTokenMs = firstTokenAt − startedAt）——精确值。
 * - KCode：step.end 的 llmFirstTokenLatencyMs（KYe 计时器：首分片到达 −
 *   请求开始）——精确值。
 * - Antigravity：原生会话库 gen_metadata 字段 11（首字等待 Duration）——精确值。
 * - DSH：assistant/message 的 stream 里最早的 time/time0（块到达时刻）减
 *   step/start（请求起点）——两个时间戳都是真实事件时刻，按精确值处理。
 * - Claude Code：thinkingDurationMs（claude.exe Nlt：content_block_stop 的
 *   monotonicNow − content_block_start，只有回复以思考块开头时才有）推出
 *   首字时刻，再减沿父链回溯出的请求起点——起点是上一条日志写盘时刻，
 *   系统性偏高，估算值。
 * - Codex：item_completed.started_at_ms（本项开始生成时刻，只有 Reasoning /
 *   AgentMessage 项有）减起点行时刻——同 Claude，估算值。
 *
 * CodeBuddy / WorkBuddy / Qoder / Pi Desktop 的本地会话没有首字计时
 * （已按各自本机数据与官方 bundle 核实），不提供该字段。
 */

/**
 * 首 token 为 harness 原生计时（精确）的来源；其余来源（Claude / Codex）按
 * 时间戳推算，展示时带 ≈。与速度列的精确/估算分界保持一致。
 */
export const PRECISE_FIRST_TOKEN_HARNESSES: ReadonlySet<HarnessId> = new Set([
  "zcode",
  "kcode",
  "antigravity",
  "dsh",
]);

/**
 * 估算首 token 的公共有效性规则（cc-switch estimated_first_token_ms 同款）：
 * 必须落在 (0, 耗时] 之间，否则说明起点或首字取错了；推不出返回 undefined。
 */
export function estimatedFirstTokenMs(
  startMs: number,
  firstOutputMs: number,
  latencyMs: number,
): number | undefined {
  const firstToken = firstOutputMs - startMs;
  return firstToken > 0 && firstToken <= latencyMs ? firstToken : undefined;
}

/** 已排序数值数组的中位数；空数组返回 null。 */
export function medianOfSorted(values: number[]): number | null {
  if (values.length === 0) return null;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 0
    ? (values[mid - 1]! + values[mid]!) / 2
    : values[mid]!;
}

/** 一组记录的首 token 双口径中位数（毫秒）；没有可统计请求时为 null。 */
export interface FirstTokenMedians {
  /** 精确口径：原生计时来源的成功请求的首字中位数。 */
  firstTokenMedianMs: number | null;
  /** 估算口径：Claude / Codex 按时间戳推出首字的请求的中位数，展示时带 ≈。 */
  estFirstTokenMedianMs: number | null;
}

/**
 * 首字时间长尾明显（偶尔一次排队就是十几秒），平均值会被拉高，取中位数
 * （cc-switch first_token_medians 同款取舍）。精确与估算分开统计：估算起点
 * 系统性偏高，混在一起会互相污染；展示时精确优先、没有才回落估算。
 */
export function collectFirstTokenMedians(
  records: Pick<UsageRecord, "firstTokenMs" | "harness" | "status">[],
): FirstTokenMedians {
  const precise: number[] = [];
  const estimated: number[] = [];
  for (const record of records) {
    if (record.firstTokenMs === undefined || record.status !== "success") continue;
    (PRECISE_FIRST_TOKEN_HARNESSES.has(record.harness) ? precise : estimated).push(
      record.firstTokenMs,
    );
  }
  precise.sort((a, b) => a - b);
  estimated.sort((a, b) => a - b);
  return {
    firstTokenMedianMs: medianOfSorted(precise),
    estFirstTokenMedianMs: medianOfSorted(estimated),
  };
}

/** 首 token 的显示：毫秒换秒、一位小数；没有值返回 null（界面显示「—」）。 */
export function formatFirstTokenSeconds(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  return `${(ms / 1000).toFixed(1)}s`;
}
