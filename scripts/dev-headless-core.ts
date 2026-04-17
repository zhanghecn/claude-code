#!/usr/bin/env bun
/**
 * Headless 学习 / 调试入口脚本。
 *
 * 这个脚本和 scripts/dev.ts 一样，会先注入 Bun 的 define / feature，
 * 但默认参数更偏向 `--print` + `stream-json` 的 headless 调试场景，
 * 方便集中观察「agent -> tool -> result」这条主链。
 *
 * 约定：
 * 1. 如果你不传参数，就走脚本内置的默认调试参数。
 * 2. 如果你只想换提示词 / max-turns / permission-mode，优先用本脚本自己的包装参数：
 *    - --preset <name>
 *    - --prompt "<你的提示词>"
 *    - --max-turns <n>
 *    - --permission-mode <mode>
 *    - --allowed-tools <value>
 * 3. 如果你真的想完全自己拼底层 CLI 参数，再用 --raw 把后面的参数直接透传给 Claude CLI。
 *
 * 常用环境变量：
 * - HEADLESS_PROMPT_PRESET=core_loop|bash_pwd|agent_task|permission_probe|compact_probe
 * - HEADLESS_PROMPT="你的自定义提示词"
 * - HEADLESS_MAX_TURNS=6
 * - HEADLESS_PERMISSION_MODE=default|acceptEdits|bypassPermissions|plan
 * - HEADLESS_ALLOWED_TOOLS=*
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getMacroDefines } from "./defines.ts";

// 解析当前脚本所在目录，并定位到项目根目录和 CLI 入口。
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");
const cliPath = join(projectRoot, "src/entrypoints/cli.tsx");

// Bun 宏定义（macro define）。这部分和 dev.ts 保持一致，
// 目的是让 scripts 下直接启动入口时，也拿到和正式开发脚本一样的编译期开关。
const defines = getMacroDefines();
const defineArgs = Object.entries(defines).flatMap(([k, v]) => [
  "-d",
  `${k}:${v}`,
]);

// 默认开启的一批 feature（功能开关）。
// 这些 feature 主要覆盖 headless 核心链路里常见、且对调试有帮助的分支。
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

// 允许通过环境变量继续附加 feature：
// 例如 FEATURE_PROACTIVE=1 bun run dev:headless-core
const envFeatures = Object.entries(process.env)
  .filter(([k]) => k.startsWith("FEATURE_"))
  .map(([k]) => k.replace("FEATURE_", ""));

const allFeatures = [...new Set([...DEFAULT_FEATURES, ...envFeatures])];
const featureArgs = allFeatures.flatMap((name) => ["--feature", name]);

// 如果通过 scripts/dev-headless-core-debug.ts 注入了 BUN_INSPECT，
// 这里就转成 Bun 的 inspect 参数。
const inspectArgs = process.env.BUN_INSPECT
  ? [`--inspect-wait=${process.env.BUN_INSPECT}`]
  : [];

// 内置调试提示词预设（prompt preset）。
// 目标不是“一条 prompt 触发所有功能”——那在工程上并不现实，
// 因为有些分支依赖权限模式、MCP、后台 agent、磁盘状态或恢复路径。
// 这些预设的作用是：尽量用默认行为覆盖常见核心路径，
// 你可以通过切换 HEADLESS_PROMPT_PRESET 来快速打不同断点。
const PROMPT_PRESETS = {
  // 最小可用：只验证 headless -> ask -> Bash -> result 这条最短路径。
  bash_pwd:
    "你必须真实调用 Bash 工具执行 `pwd`。如果没有真正调用 Bash，不要回答。执行后只输出目录路径。",

  // 默认预设：尽量覆盖 Bash + Read + Write/Edit + 总结输出。
  // 写文件落在 /tmp，避免污染仓库。
  core_loop: [
    "你在 headless 调试模式下。",
    "必须按顺序真实调用工具，不要假装已经调用。",
    "1. 必须调用 Bash 工具执行 `pwd` 和 `ls scripts | head -n 5`。",
    "2. 不要用 Bash 读取文件，必须使用 Read 类工具读取 `scripts/dev-headless-core.ts`，总结默认参数做了什么。",
    "3. 不要用 Bash 写文件，必须使用 Write/Edit 类工具把 `headless-debug-ok` 写入 `/tmp/claude-code-headless-debug.txt`。",
    "4. 最后只输出 3 行：`cwd=...`、`script=...`、`tmp_file=...`。",
    "如果某一步做不到，要明确说明卡在哪个工具或权限上。",
  ].join(" "),

  // 用来观察 AgentTool / task-notification / 后台任务回流。
  agent_task: [
    "请先阅读 `scripts/dev-headless-core.ts`，再使用 Agent 工具把“总结默认行为”这个子任务交给一个子 agent。",
    "主线程等待子 agent 完成后，整合结果并只输出 5 行摘要。",
    "如果没有 Agent 工具，就明确说明缺失，不要伪造调用。",
  ].join(" "),

  // 用来观察权限链路。建议配合 HEADLESS_PERMISSION_MODE=default 或 plan 使用。
  permission_probe: [
    "你必须尝试修改 `/tmp/claude-code-permission-probe.txt`，并解释你是否遇到了权限确认。",
    "如果允许修改，就写入 `permission-probe-ok`；",
    "如果被阻止，就说明被哪个权限环节拦住。",
    "最后输出：`permission=...`、`write=...`。",
  ].join(" "),

  // 用来观察多轮、上下文增长、read/edit/tool_result 拼接。
  // 不保证一定触发 compact（压缩），但比 bash_pwd 更容易进入多轮回路。
  compact_probe: [
    "请分多步完成：",
    "1. 读取 `scripts/dev-headless-core.ts`、`scripts/dev-headless-core-debug.ts`。",
    "2. 比较两个脚本的差异。",
    "3. 把 8 条要点写入 `/tmp/claude-code-compact-probe.txt`。",
    "4. 最后输出一个带编号的摘要列表。",
    "要求：不要一次性结束，尽量显式使用多次工具调用。",
  ].join(" "),
} as const;

type PromptPresetName = keyof typeof PROMPT_PRESETS;

const requestedPreset = process.env.HEADLESS_PROMPT_PRESET as
  | PromptPresetName
  | undefined;

const presetName: PromptPresetName =
  requestedPreset && requestedPreset in PROMPT_PRESETS
    ? requestedPreset
    : "core_loop";

const selectedPrompt =
  process.env.HEADLESS_PROMPT?.trim() || PROMPT_PRESETS[presetName];

type WrapperOverrides = {
  preset?: PromptPresetName;
  prompt?: string;
  maxTurns?: string;
  permissionMode?: string;
  allowedTools?: string;
  rawArgs?: string[];
};

/**
 * 解析这个脚本自己的包装参数。
 *
 * 目的：
 * - 让你不用记 bash 环境变量写法；
 * - 也不用每次把 `--bare --print --output-format stream-json ...` 整串重打一遍。
 *
 * 支持的写法：
 * - bun run dev:headless-core --preset core_loop
 * - bun run dev:headless-core --prompt "你的提示词"
 * - bun run dev:headless-core --preset permission_probe --permission-mode default
 * - bun run dev:headless-core --raw --print --output-format stream-json -- ...
 */
function parseWrapperArgs(args: string[]): WrapperOverrides {
  const overrides: WrapperOverrides = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // 常见帮助参数直接透传到底层 CLI，保持符合直觉的行为。
    if (arg === "--help" || arg === "-h") {
      overrides.rawArgs = args.slice(i);
      return overrides;
    }

    if (arg === "--raw") {
      overrides.rawArgs = args.slice(i + 1);
      return overrides;
    }

    if (arg === "--preset") {
      const value = args[i + 1];
      if (!value) {
        throw new Error("`--preset` 后面必须跟一个预设名。");
      }
      if (!(value in PROMPT_PRESETS)) {
        throw new Error(
          `未知 preset: ${value}。可用值：${Object.keys(PROMPT_PRESETS).join(", ")}`,
        );
      }
      overrides.preset = value as PromptPresetName;
      i++;
      continue;
    }

    if (arg === "--prompt") {
      const value = args[i + 1];
      if (!value) {
        throw new Error("`--prompt` 后面必须跟一段提示词文本。");
      }
      overrides.prompt = value;
      i++;
      continue;
    }

    if (arg === "--max-turns") {
      const value = args[i + 1];
      if (!value) {
        throw new Error("`--max-turns` 后面必须跟一个数字。");
      }
      overrides.maxTurns = value;
      i++;
      continue;
    }

    if (arg === "--permission-mode") {
      const value = args[i + 1];
      if (!value) {
        throw new Error("`--permission-mode` 后面必须跟一个模式值。");
      }
      overrides.permissionMode = value;
      i++;
      continue;
    }

    if (arg === "--allowed-tools") {
      const value = args[i + 1];
      if (!value) {
        throw new Error("`--allowed-tools` 后面必须跟一个值。");
      }
      overrides.allowedTools = value;
      i++;
      continue;
    }

    throw new Error(
      `不支持的参数：${arg}\n` +
        "可用包装参数：--preset, --prompt, --max-turns, --permission-mode, --allowed-tools, --raw",
    );
  }

  return overrides;
}

// 默认 CLI 参数：
// - --bare：减少 UI 相关干扰
// - --print + stream-json：直接观察 headless 输出流
// - --verbose：保留更完整的事件
// - --allowedTools *：避免因为 deny-list 让核心工具链路触发不到
// - --max-turns：可以通过环境变量快速调高，方便看多轮 query / tool loop
const forwardedArgs = process.argv.slice(2);
const wrapperArgs = parseWrapperArgs(forwardedArgs);

const effectivePreset = wrapperArgs.preset ?? presetName;
const effectivePrompt =
  wrapperArgs.prompt ??
  process.env.HEADLESS_PROMPT?.trim() ??
  PROMPT_PRESETS[effectivePreset];

const defaultArgs = [
  "--bare",
  "--print",
  "--output-format",
  "stream-json",
  "--verbose",
  "--permission-mode",
  wrapperArgs.permissionMode ||
    process.env.HEADLESS_PERMISSION_MODE ||
    "default",
  "--max-turns",
  wrapperArgs.maxTurns || process.env.HEADLESS_MAX_TURNS || "5",
  "--allowedTools",
  wrapperArgs.allowedTools || process.env.HEADLESS_ALLOWED_TOOLS || "*",
  "--",
  effectivePrompt,
];

// 默认情况下走脚本封装后的友好参数。
// 只有在 --raw 模式下，才把后面的参数完全原样透传到底层 CLI。
const cliArgs = wrapperArgs.rawArgs ?? defaultArgs;

// 直接同步启动 Bun CLI。
// stdio 全部继承，方便你在终端里直接看 stream-json 输出和错误信息。
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
