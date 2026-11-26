import { connection } from "next/server";
import { getUsageStore } from "@/lib/usage-store";
import { requestUsageSync } from "@/lib/usage-sync";
import { HARNESS_OPTIONS, type HarnessId } from "@/lib/usage";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 可选 JSON body { harness } 限定只同步一个来源；空 body 或缺省为全量。
 * harness 非法时抛出带 status 的 Error，由 POST 统一映射为 400。
 */
async function parseHarnessScope(request: Request): Promise<HarnessId | undefined> {
  const body = await request.text();
  if (body.trim() === "") return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw Object.assign(new Error("同步请求体不是合法 JSON"), { status: 400 });
  }
  if (payload === null || typeof payload !== "object" || !("harness" in payload)) {
    return undefined;
  }
  const harness = (payload as { harness: unknown }).harness;
  if (typeof harness === "string" && HARNESS_OPTIONS.some((option) => option.id === harness)) {
    return harness as HarnessId;
  }
  throw Object.assign(new Error(`未知 Harness: ${String(harness)}`), { status: 400 });
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
export async function POST(request: Request) {
  await connection();
  try {
    const harness = await parseHarnessScope(request);
    const result = await requestUsageSync(harness);
    const sync = getUsageStore().getStatus();
    return Response.json({ ...result, sync }, {
      headers: {
        "Cache-Control": "no-store",
        "X-Usage-Revision": String(result.revision),
      },
    });
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (status === 400) {
      return Response.json(
        { error: "非法的用量同步请求", detail: errorMessage(error) },
        { status: 400 },
      );
    }
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
