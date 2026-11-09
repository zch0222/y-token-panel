"use client";

import { useEffect } from "react";

/** 仅在生产环境接管离线导航，避免缓存 Next.js 开发资源或干扰 HMR。 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (
      process.env.NODE_ENV !== "production" ||
      !window.isSecureContext ||
      !("serviceWorker" in navigator)
    ) {
      return;
    }

    void navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch((error: unknown) => {
        console.warn("Y Token 离线服务注册失败", error);
      });
  }, []);

  return null;
}
