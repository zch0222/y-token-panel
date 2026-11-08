import "server-only";
import { getUsageStore } from "@/lib/usage-store";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
} as const;

/** 直接发送 worker 预序列化的快照，避免在 Next 主线程 parse/stringify 大响应。 */
export function createUsageSnapshotResponse(): Response {
  const store = getUsageStore();
  const snapshot = store.getSnapshotDocument();
  if (snapshot === null) {
    return Response.json(store.getEmptySnapshot(), { headers: NO_STORE_HEADERS });
  }

  return new Response(snapshot.json, {
    headers: {
      ...NO_STORE_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "X-Usage-Revision": String(snapshot.revision),
    },
  });
}
