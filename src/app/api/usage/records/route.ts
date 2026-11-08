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
    const page = getUsageStore().queryRecordsPage(
      parsed.value.filters,
      parsed.value.page,
      parsed.value.pageSize,
    );
    return Response.json(page, {
      headers: {
        "Cache-Control": "no-store",
        "X-Usage-Revision": String(page.revision),
      },
    });
  } catch (error) {
    console.error("Failed to query paginated usage records", error);
    return Response.json({ error: "无法分页查询请求日志，请检查数据库状态" }, { status: 500 });
  }
}
