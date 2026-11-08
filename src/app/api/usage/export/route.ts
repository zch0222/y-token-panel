import { connection } from "next/server";
import { buildUsageCsv } from "@/lib/usage-csv";
import { parseUsageQueryParams } from "@/lib/usage-query";
import { getUsageStore } from "@/lib/usage-store";

/** 请求日志 CSV 导出；与汇总/分页共用同一筛选参数。 */
export async function GET(request: Request) {
  await connection();
  try {
    const parsed = parseUsageQueryParams(new URL(request.url).searchParams);
    if (!parsed.ok) {
      return Response.json({ error: parsed.error }, { status: 400 });
    }
    const records = getUsageStore().queryRecordsForExport(parsed.value.filters);
    const csv = buildUsageCsv(records);
    const date = new Date().toISOString().slice(0, 10);
    return new Response(`\ufeff${csv}`, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="ai-harness-usage-${date}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error("Failed to export usage records", error);
    return Response.json({ error: "无法导出请求日志，请检查数据库状态" }, { status: 500 });
  }
}
