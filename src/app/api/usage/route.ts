import { connection, NextResponse } from "next/server";
import { readCodeBuddyUsage } from "@/lib/codebuddy";
import { readQoderUsage } from "@/lib/qoder";
import type { UsageResponse } from "@/lib/usage";

export async function GET() {
  await connection();
  try {
    const results = await Promise.all([readCodeBuddyUsage(), readQoderUsage()]);
    const usage: UsageResponse = {
      records: results.flatMap((result) => result.records),
      sources: results.map(({ records, ...source }) => ({
        ...source,
        recordCount: records.length,
      })),
      scannedFiles: results.reduce((sum, result) => sum + result.scannedFiles, 0),
      skippedFiles: results.reduce((sum, result) => sum + result.skippedFiles, 0),
      syncedAt: Date.now(),
    };
    usage.records.sort((a, b) => b.timestamp - a.timestamp);
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
