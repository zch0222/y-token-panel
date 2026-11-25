import { connection, NextResponse } from "next/server";
import {
  getModelPricingFilePath,
  loadOrCreateModelPricingFile,
  recordModelsDevSyncResult,
  saveModelsDevSyncConfig,
} from "@/lib/model-pricing-file";
import { syncModelsDevPricingWithStore } from "@/lib/models-dev";
import { getUsageStore } from "@/lib/usage-store";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function GET() {
  await connection();
  try {
    return NextResponse.json({
      config: loadOrCreateModelPricingFile().modelsDevSync,
      configPath: getModelPricingFilePath(),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  await connection();
  try {
    const body = (await request.json()) as {
      autoSyncEnabled?: boolean;
      includeCommonModels?: boolean;
      selectedModelKeys?: string[];
      excludedCommonModelKeys?: string[];
    };
    const config = saveModelsDevSyncConfig(body);
    return NextResponse.json({ config }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
  }
}

export async function POST(request: Request) {
  await connection();
  try {
    let force = new URL(request.url).searchParams.get("force") === "1";
    try {
      const body = (await request.json()) as { force?: boolean };
      force = force || body.force === true;
    } catch {
      // 空 body 是合法的自动同步触发。
    }
    const result = await syncModelsDevPricingWithStore(
      getUsageStore(),
      {
        load: loadOrCreateModelPricingFile,
        recordResult: recordModelsDevSyncResult,
      },
      force,
    );
    return NextResponse.json({
      ...result,
      config: loadOrCreateModelPricingFile().modelsDevSync,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 502 });
  }
}
