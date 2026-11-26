import { connection, NextResponse } from "next/server";
import {
  getModelPricingFilePath,
  loadOrCreateModelPricingFile,
} from "@/lib/model-pricing-file";
import { normalizePricingEntry, validatePricingEntry, type ModelPricingInfo } from "@/lib/model-pricing";
import { getUsageStore } from "@/lib/usage-store";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function GET() {
  await connection();
  try {
    const store = getUsageStore();
    return NextResponse.json({
      models: store.listModelPricing(),
      sync: loadOrCreateModelPricingFile().modelsDevSync,
      configPath: getModelPricingFilePath(),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Failed to list model pricing", error);
    return NextResponse.json({ error: "无法读取模型价格", detail: errorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  await connection();
  try {
    const body = (await request.json()) as Partial<ModelPricingInfo>;
    const entry = normalizePricingEntry({
      modelId: body.modelId ?? "",
      displayName: body.displayName ?? "",
      inputCostPerMillion: body.inputCostPerMillion ?? "",
      outputCostPerMillion: body.outputCostPerMillion ?? "",
      cacheReadCostPerMillion: body.cacheReadCostPerMillion ?? "0",
      cacheCreationCostPerMillion: body.cacheCreationCostPerMillion ?? "0",
    });
    const validation = validatePricingEntry(entry);
    if (validation) return NextResponse.json({ error: validation }, { status: 400 });
    const changed = getUsageStore().updateModelPricing(entry);
    return NextResponse.json({ entry, changed }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  await connection();
  try {
    const modelId = new URL(request.url).searchParams.get("modelId")?.trim();
    if (!modelId) return NextResponse.json({ error: "modelId 参数不能为空" }, { status: 400 });
    getUsageStore().deleteModelPricing(modelId);
    return NextResponse.json({ deleted: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 400 });
  }
}
