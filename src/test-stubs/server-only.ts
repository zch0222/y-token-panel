// vitest 空桩：Next.js 的 server-only 包只在应用构建里存在，单测直接替换为空模块，
// 让 fs 读取器（src/lib/codex.ts 等）可以在 node 环境下被直接测试。
export {};
