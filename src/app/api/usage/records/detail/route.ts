import { connection } from "next/server";
import { getUsageStore } from "@/lib/usage-store";
import { HARNESS_OPTIONS, type HarnessId } from "@/lib/usage";

/** 单条请求详情：/api/usage/records/detail?harness=<id>&recordId=<id>。 */
export async function GET(request: Request) {
  await connection();
  try {
    const searchParams = new URL(request.url).searchParams;
    const harness = searchParams.get("harness") ?? "";
    const recordId = searchParams.get("recordId") ?? "";
    if (!HARNESS_OPTIONS.some((option) => option.id === harness) || recordId === "") {
      return Response.json({ error: "harness 或 recordId 参数非法" }, { status: 400 });
    }
    const record = getUsageStore().queryRecordDetail(harness as HarnessId, recordId);
    if (record === null) {
      return Response.json({ error: "未找到该请求记录" }, { status: 404 });
    }
    return Response.json(record, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Failed to query usage record detail", error);
    return Response.json({ error: "无法查询请求详情，请检查数据库状态" }, { status: 500 });
  }
}
