import { connection, NextResponse } from "next/server";
import { scanUsage } from "@/lib/usage-scanner";

export async function GET() {
  await connection();
  try {
    const usage = await scanUsage();
    return NextResponse.json(usage, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Failed to read local harness usage", error);
    return NextResponse.json(
      { error: "无法读取本地 Harness 用量记录" },
      { status: 500 },
    );
  }
}
