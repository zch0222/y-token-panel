import { connection, NextResponse } from "next/server";
import { queryBalance } from "@/lib/balance-store";

/**
 * 查询单个供应商余额。只允许查询已配置的供应商（不提供任意 URL 代理），
 * 服务端强制最小间隔与失败冷却：throttled / cooldown 时直接返回缓存结果。
 */
export async function POST(request: Request) {
  await connection();
  try {
    const body = (await request.json()) as { providerId?: string };
    if (!body.providerId) {
      return NextResponse.json({ error: "缺少 providerId" }, { status: 400 });
    }
    const outcome = await queryBalance(body.providerId);
    return NextResponse.json(outcome, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Failed to query balance", error);
    return NextResponse.json(
      { error: "余额查询失败" },
      { status: 500 },
    );
  }
}
