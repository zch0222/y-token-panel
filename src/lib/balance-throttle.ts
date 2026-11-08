/**
 * 余额查询限流与冷却决策（纯逻辑，便于用假时钟单测）。
 *
 * 防风控口径对齐 cc-switch：
 * - cc-switch 手动点击即真查（只有并发合并），没有服务端最小间隔；这里只保留
 *   5 秒防连点间隔（同时覆盖自动刷新最快档），间隔内的请求直接回缓存；
 * - 429 / 5xx / 网络错误视为瞬时失败（cc-switch isTransientUsageError），保留上次
 *   成功值并进入冷却，绝不连续重打；
 * - 401/403 等 4xx 是确定性失败，立即透出、不冷却（但最小间隔仍然生效）。
 */

import type { BalanceCacheEntry, BalanceResult } from "@/lib/balance";

/** 同一供应商两次真实外呼的最小间隔（含手动刷新）——防连点抖动，取自动刷新最快档。 */
export const MIN_QUERY_INTERVAL_MS = 5_000;

/** 单次余额请求超时，对齐 cc-switch balance.rs 的 15s。 */
export const QUERY_TIMEOUT_MS = 15_000;

/** 瞬时失败（网络 / 5xx）的重试次数与间隔，对齐 cc-switch react-query retry:1 / 1.5s。 */
export const TRANSIENT_RETRY_COUNT = 1;
export const TRANSIENT_RETRY_DELAY_MS = 1_500;

/** 瞬时失败后的冷却时长。 */
export const TRANSIENT_COOLDOWN_MS = 60_000;

/** HTTP 429（供应商限流）专属冷却，避免加剧风控。 */
export const RATE_LIMIT_COOLDOWN_MS = 300_000;

export type QueryDecision =
  | { action: "fetch" }
  | { action: "skip-throttled"; waitMs: number }
  | { action: "skip-cooldown"; waitMs: number; reason: string | null };

/** 决定此刻是否允许对某供应商发起真实外呼。 */
export function decideQuery(
  entry: Pick<BalanceCacheEntry, "nextEligibleAt" | "cooldownUntil" | "cooldownReason">,
  now: number,
): QueryDecision {
  if (entry.cooldownUntil > now) {
    return {
      action: "skip-cooldown",
      waitMs: entry.cooldownUntil - now,
      reason: entry.cooldownReason,
    };
  }
  if (entry.nextEligibleAt > now) {
    return { action: "skip-throttled", waitMs: entry.nextEligibleAt - now };
  }
  return { action: "fetch" };
}

/** 从错误信息中提取 HTTP 状态码（错误信息统一含「HTTP 429」这类片段）。 */
export function extractHttpStatus(error: string | null | undefined): number | null {
  if (!error) return null;
  const match = /HTTP\s+(\d{3})/.exec(error);
  return match ? Number(match[1]) : null;
}

/** 瞬时失败（网络 / 5xx / 429）才值得立即重试；429 除外（直接进冷却）。 */
export function shouldRetryTransient(result: BalanceResult): boolean {
  if (result.success || result.errorKind !== "transient") return false;
  return extractHttpStatus(result.error) !== 429;
}

/**
 * 一次真实外呼结束后应写入的冷却状态：
 * - 429 → 冷却 5 分钟；
 * - 其他瞬时失败（网络 / 5xx）→ 冷却 60s；
 * - 成功与确定性失败 → 不冷却（确定性失败可立即手动重试，最小间隔仍由 nextEligibleAt 管）。
 */
export function cooldownFor(
  result: BalanceResult,
  now: number,
): { until: number; reason: string | null } | null {
  if (result.success || result.errorKind !== "transient") return null;
  if (extractHttpStatus(result.error) === 429) {
    return { until: now + RATE_LIMIT_COOLDOWN_MS, reason: "供应商限流（HTTP 429），已暂停查询" };
  }
  return { until: now + TRANSIENT_COOLDOWN_MS, reason: result.error ?? "瞬时网络错误" };
}
