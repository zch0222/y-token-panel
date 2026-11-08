import { connection } from "next/server";
import { createUsageSnapshotResponse } from "@/lib/usage-http";
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

export async function POST() {
  await connection();
  try {
    await requestUsageSync();
    return createUsageSnapshotResponse();
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
