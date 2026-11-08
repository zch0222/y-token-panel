import { connection } from "next/server";
import { createUsageSnapshotResponse } from "@/lib/usage-http";

export async function GET() {
  await connection();
  try {
    return createUsageSnapshotResponse();
  } catch (error) {
    console.error("Failed to read persisted usage snapshot", error);
    return Response.json(
      { error: "无法读取本地用量快照，请检查数据库与迁移状态" },
      { status: 500 },
    );
  }
}
