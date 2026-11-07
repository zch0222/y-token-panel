import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Next.js 的 server-only 包只在应用构建里存在；单测换成空桩，
      // 让 fs 读取器可以在 node 环境下被直接测试。
      "server-only": fileURLToPath(
        new URL("./src/test-stubs/server-only.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
