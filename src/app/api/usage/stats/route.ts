import { connection } from "next/server";
import { parseUsageQueryParams } from "@/lib/usage-query";
import { getUsageStore } from "@/lib/usage-store";

export async function GET(request: Request) {
  await connection();
  try {
    const parsed = parseUsageQueryParams(new URL(request.url).searchParams);
    if (!parsed.ok) {
      return Response.json({ error: parsed.error }, { status: 400 });
    }
    const stats = getUsageStore().queryStats(parsed.value.filters);
    return Response.json(stats, {
      headers: {
        "Cache-Control": "no-store",
        "X-Usage-Revision": String(stats.revision),
      },
    });
  } catch (error) {
    console.error("Failed to query usage statistics", error);
    return Response.json({ error: "无法聚合统计本地用量，请检查数据库状态" }, { status: 500 });
  }
}
