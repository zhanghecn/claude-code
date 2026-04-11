#!/usr/bin/env bun
/**
 * Headless learning entrypoint.
 *
 * Uses the same Bun feature/default-define setup as scripts/dev.ts, but with a
 * focused default invocation for studying the core agent -> tool loop.
 *
 * If extra CLI args are provided, they fully replace the defaults.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getMacroDefines } from "./defines.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");
const cliPath = join(projectRoot, "src/entrypoints/cli.tsx");

const defines = getMacroDefines();
const defineArgs = Object.entries(defines).flatMap(([k, v]) => [
  "-d",
  `${k}:${v}`,
]);

const DEFAULT_FEATURES = [
  "BUDDY",
  "TRANSCRIPT_CLASSIFIER",
  "BRIDGE_MODE",
  "AGENT_TRIGGERS_REMOTE",
  "CHICAGO_MCP",
  "VOICE_MODE",
  "SHOT_STATS",
  "PROMPT_CACHE_BREAK_DETECTION",
  "TOKEN_BUDGET",
  "AGENT_TRIGGERS",
  "ULTRATHINK",
  "BUILTIN_EXPLORE_PLAN_AGENTS",
  "LODESTONE",
  "EXTRACT_MEMORIES",
  "VERIFICATION_AGENT",
  "KAIROS_BRIEF",
  "AWAY_SUMMARY",
  "ULTRAPLAN",
  "DAEMON",
];

const envFeatures = Object.entries(process.env)
  .filter(([k]) => k.startsWith("FEATURE_"))
  .map(([k]) => k.replace("FEATURE_", ""));

const allFeatures = [...new Set([...DEFAULT_FEATURES, ...envFeatures])];
const featureArgs = allFeatures.flatMap((name) => ["--feature", name]);

const inspectArgs = process.env.BUN_INSPECT
  ? [`--inspect-wait=${process.env.BUN_INSPECT}`]
  : [];

const defaultArgs = [
  "--bare",
  "--print",
  "--output-format",
  "stream-json",
  "--verbose",
  "--permission-mode",
  "default",
  "--max-turns",
  "3",
  "--tools",
  "Bash",
  "--allowedTools",
  "Bash",
  "--",
  "你必须调用 Bash 工具执行 `pwd`。如果没有真正调用 Bash，不要回答。执行后只输出目录路径。",
];

const forwardedArgs = process.argv.slice(2);
const cliArgs = forwardedArgs.length > 0 ? forwardedArgs : defaultArgs;

const result = Bun.spawnSync(
  [
    "bun",
    ...inspectArgs,
    "run",
    ...defineArgs,
    ...featureArgs,
    cliPath,
    ...cliArgs,
  ],
  { stdio: ["inherit", "inherit", "inherit"], cwd: projectRoot },
);

process.exit(result.exitCode ?? 0);
