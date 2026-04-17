/**
 * Headless Core 调试入口。
 *
 * 作用只有一件事：
 * 先把 Bun Inspector（调试 WebSocket）固定到一个已知地址，
 * 再加载真正的 headless 启动脚本 `dev-headless-core.ts`。
 *
 * 这样 `.vscode/launch.json` 就可以稳定用同一个地址 attach（附加调试）：
 * - ws://localhost:8888/2dc3gzl5xot
 *
 * 常用方式：
 * - bun run dev:headless-core:inspect
 * - bun run scripts/dev-headless-core-debug.ts --preset core_loop
 * - bun run scripts/dev-headless-core-debug.ts --prompt "你的提示词"
 *
 * 然后在 VS Code 里启动：
 * - Attach to Bun (Headless Core)
 */
process.env.BUN_INSPECT = "localhost:8888/2dc3gzl5xot";
await import("./dev-headless-core.ts");
