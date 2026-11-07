import type { UsageRecord } from "@/lib/usage";

/**
 * Token 速度的估算口径，对齐 cc-switch 会话日志导入路径
 * （cc-switch src/components/usage/format.ts 的 SPEED_ESTIMATE_* 常量）。
 *
 * CodeBuddy 会话日志里没有首字计时，也没有单请求延迟，耗时只能按
 * 「assistant 消息完成时刻 − 请求窗口起点时刻」从时间戳推出来，天然包含
 * 首字等待，所以采用 cc-switch 的估算门槛：输出不少于 200 token、估算耗时
 * 不短于 1 秒（门槛比精确口径的 100 token / 100ms 高，因为首字等待占比
 * 越大算出的速度越偏低）。
 */
export const SPEED_ESTIMATE_MIN_OUTPUT_TOKENS = 200;

/** 估算耗时短于此值时不估速度：输出 200 token 以上却不到 1 秒，多半是起点取晚了。 */
export const SPEED_ESTIMATE_MIN_DURATION_MS = 1000;

/** 单条请求的输出 token 与估算耗时（毫秒）。 */
export interface SpeedEstimateInput {
  outputTokens: number;
  estimatedDurationMs?: number;
}

/**
 * 这条请求能不能估速度：输出不少于 200 token 且估算耗时不短于 1 秒，
 * 且耗时为有限正数。
 */
export function isSpeedEstimateEligible(record: SpeedEstimateInput): boolean {
  const duration = record.estimatedDurationMs;
  return (
    typeof duration === "number" &&
    Number.isFinite(duration) &&
    duration >= SPEED_ESTIMATE_MIN_DURATION_MS &&
    Number.isFinite(record.outputTokens) &&
    record.outputTokens >= SPEED_ESTIMATE_MIN_OUTPUT_TOKENS
  );
}

/**
 * 单条估算速度（tok/s）= 输出 token ÷ (估算耗时 / 1000)，含首字等待；
 * 不满足门槛或算不出有限正值时返回 null。
 */
export function getEstimatedTokensPerSecond(
  record: SpeedEstimateInput,
): number | null {
  if (!isSpeedEstimateEligible(record)) return null;
  const duration = record.estimatedDurationMs as number;
  const tps = record.outputTokens / (duration / 1000);
  return Number.isFinite(tps) && tps > 0 ? tps : null;
}

/**
 * 汇总速度 = Σ输出 ÷ Σ耗时（只算满足门槛的请求），不是逐条平均——
 * 逐条平均会被短请求带歪（cc-switch getAggregateTokensPerSecond 同款）。
 */
export function getAggregateTokensPerSecond(
  outputTokens: number,
  durationMs: number,
): number | null {
  if (
    !Number.isFinite(outputTokens) ||
    !Number.isFinite(durationMs) ||
    outputTokens <= 0 ||
    durationMs <= 0
  ) {
    return null;
  }
  const tps = outputTokens / (durationMs / 1000);
  return Number.isFinite(tps) && tps > 0 ? tps : null;
}

/** 前端已有明细时的汇总：只累加满足门槛的请求的输出与耗时。 */
export function sumSpeedTotals(records: SpeedEstimateInput[]): {
  speedOutputTokens: number;
  speedDurationMs: number;
} {
  let speedOutputTokens = 0;
  let speedDurationMs = 0;
  for (const record of records) {
    if (!isSpeedEstimateEligible(record)) continue;
    speedOutputTokens += record.outputTokens;
    speedDurationMs += record.estimatedDurationMs as number;
  }
  return { speedOutputTokens, speedDurationMs };
}

/** tok/s 的显示：≥ 1 取整，否则一位小数；null 原样返回（界面显示「—」）。 */
export function formatTokensPerSecond(tps: number | null): string | null {
  if (tps == null || !Number.isFinite(tps) || tps <= 0) return null;
  return tps >= 1 ? Math.round(tps).toString() : tps.toFixed(1);
}

/** 单条记录的估算速度显示；不满足门槛返回 null。 */
export function formatEstimatedTokensPerSecond(
  record: SpeedEstimateInput,
): string | null {
  return formatTokensPerSecond(getEstimatedTokensPerSecond(record));
}

/** 汇总速度分子分母的显示；没有可估算请求时返回 null。 */
export function formatAggregateTokensPerSecond(
  totals: Pick<SpeedTotals, "speedOutputTokens" | "speedDurationMs">,
): string | null {
  return formatTokensPerSecond(
    getAggregateTokensPerSecond(totals.speedOutputTokens, totals.speedDurationMs),
  );
}

/** 一组记录的速度分子分母（与 UsageSummary 的同名字段对应）。 */
export interface SpeedTotals {
  speedOutputTokens: number;
  speedDurationMs: number;
}

/** 从用量记录里提取速度输入（Qoder 等没有估算耗时的 Harness 自然不满足门槛）。 */
export function toSpeedInput(record: UsageRecord): SpeedEstimateInput {
  return {
    outputTokens: record.outputTokens,
    estimatedDurationMs: record.estimatedDurationMs,
  };
}
