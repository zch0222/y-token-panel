import { connection, NextResponse } from "next/server";
import { addBalanceProvider, listBalanceState } from "@/lib/balance-store";

/** 供应商列表（Key 只回脱敏视图）与缓存 / 限流状态；不触发任何外呼。 */
export async function GET() {
  await connection();
  try {
    const state = await listBalanceState();
    return NextResponse.json(state, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Failed to list balance providers", error);
    return NextResponse.json(
      { error: "无法读取余额供应商配置" },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  await connection();
  try {
    const body = (await request.json()) as {
      name?: string;
      baseUrl?: string;
      apiKey?: string;
      kind?: string;
      accessToken?: string;
      userId?: string;
    };
    if (!body.name || !body.baseUrl) {
      return NextResponse.json(
        { error: "请填写供应商名称与 Base URL" },
        { status: 400 },
      );
    }
    const provider = await addBalanceProvider({
      name: body.name,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey ?? "",
      kind: (body.kind as never) ?? "auto",
      accessToken: body.accessToken,
      userId: body.userId,
    });
    return NextResponse.json({ provider }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法保存供应商";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
