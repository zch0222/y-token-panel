import { connection } from "next/server";
import { getUsageStore } from "@/lib/usage-store";
import { requestUsageSync } from "@/lib/usage-sync";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function GET() {
  await connection();
  try {
    return Response.json(getUsageStore().getStatus(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Failed to read usage sync status", error);
    return Response.json({ error: "无法读取用量同步状态" }, { status: 500 });
  }
}

/**
 * 同步只返回提交结果（revision 等），不再回传全部历史记录；
 * 客户端按 revision 变化决定是否重查聚合视图（M6）。
 */
export async function POST() {
  await connection();
  try {
    const result = await requestUsageSync();
    const sync = getUsageStore().getStatus();
    return Response.json({ ...result, sync }, {
      headers: {
        "Cache-Control": "no-store",
        "X-Usage-Revision": String(result.revision),
      },
    });
  } catch (error) {
    console.error("Failed to synchronize local harness usage", error);
    let sync;
    try {
      sync = getUsageStore().getStatus();
    } catch {
      sync = undefined;
    }
    return Response.json(
      {
        error: "本地用量同步失败；最后成功快照已保留",
        detail: errorMessage(error),
        sync,
      },
      { status: 500 },
    );
  }
}
