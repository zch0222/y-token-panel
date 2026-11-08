import { connection, NextResponse } from "next/server";
import { removeBalanceProvider, updateBalanceProvider } from "@/lib/balance-store";

export async function PATCH(request: Request, ctx: RouteContext<"/api/balance/providers/[id]">) {
  await connection();
  const { id } = await ctx.params;
  try {
    const body = (await request.json()) as {
      name?: string;
      baseUrl?: string;
      apiKey?: string;
      kind?: string;
      accessToken?: string;
      userId?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      organizationId?: string;
      projectId?: string;
    };
    const provider = await updateBalanceProvider(id, {
      name: body.name,
      baseUrl: body.baseUrl,
      // apiKey / accessToken / secretAccessKey 留空字符串 = 不修改。
      apiKey: body.apiKey,
      kind: body.kind as never,
      accessToken: body.accessToken,
      userId: body.userId,
      accessKeyId: body.accessKeyId,
      secretAccessKey: body.secretAccessKey,
      organizationId: body.organizationId,
      projectId: body.projectId,
    });
    if (!provider) {
      return NextResponse.json({ error: "供应商不存在" }, { status: 404 });
    }
    return NextResponse.json({ provider }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法更新供应商";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/balance/providers/[id]">) {
  await connection();
  const { id } = await ctx.params;
  try {
    const removed = await removeBalanceProvider(id);
    if (!removed) {
      return NextResponse.json({ error: "供应商不存在" }, { status: 404 });
    }
    return NextResponse.json({ removed: true }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Failed to remove balance provider", error);
    return NextResponse.json({ error: "无法删除供应商" }, { status: 500 });
  }
}
