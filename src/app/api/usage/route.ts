import { connection, NextResponse } from "next/server";
import { readCodeBuddyUsage } from "@/lib/codebuddy";

export async function GET() {
  await connection();
  try {
    const usage = await readCodeBuddyUsage();
    return NextResponse.json(usage, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Failed to read CodeBuddy usage", error);
    return NextResponse.json(
      { error: "无法读取 CodeBuddy 本地用量记录" },
      { status: 500 },
    );
  }
}
