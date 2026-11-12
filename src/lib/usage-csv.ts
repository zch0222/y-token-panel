import { getEstimatedTokensPerSecond } from "@/lib/speed";
import { getHarnessLabel, type UsageRecord } from "@/lib/usage";

const CSV_HEADERS = [
  "时间",
  "Harness",
  "项目",
  "供应商",
  "模型",
  "输入 Tokens",
  "输出 Tokens",
  "缓存读取 Tokens",
  "总 Tokens",
  "估算耗时(ms)",
  "估算速度(tok/s)",
  "首字时间(ms)",
  "计费 Credits",
  "服务端报告 Credits",
  "是否计费",
  "状态",
  "会话 ID",
];

function escapeCsv(value: string | number): string {
  return `"${String(value).replace(/"/g, '""')}"`;
}

/**
 * 请求日志 CSV 导出（M6 起在服务端生成，列与口径沿用原前端 exportCsv）。
 * 调用方负责 \ufeff BOM 与下载响应头。
 */
export function buildUsageCsv(records: UsageRecord[]): string {
  const rows = records.map((record) => [
    new Date(record.timestamp).toISOString(),
    getHarnessLabel(record.harness),
    record.project,
    record.provider,
    record.model,
    record.hasTokenUsage ? record.inputTokens : "",
    record.hasTokenUsage ? record.outputTokens : "",
    record.hasTokenUsage ? record.cacheReadTokens : "",
    record.hasTokenUsage ? record.totalTokens : "",
    record.estimatedDurationMs ?? "",
    getEstimatedTokensPerSecond(record)?.toFixed(1) ?? "",
    record.firstTokenMs ?? "",
    record.hasCredit ? record.credits : "",
    record.reportedCredits ?? "",
    record.billable === undefined ? "" : record.billable ? "是" : "否",
    record.status,
    record.sessionId,
  ]);
  return [CSV_HEADERS, ...rows].map((row) => row.map(escapeCsv).join(",")).join("\r\n");
}
