# Headless 核心流程调试清单

> 这是一张操作清单，不是原理详解。原理看 `phase-3-headless-agent-tool-flow.md`。

## 1. 启动命令

最短链：

```bash
bun run dev:headless-core
```

附加断点：

```bash
bun run dev:headless-core:inspect
```

想看更完整的多工具链：

```bash
bun run dev:headless-core --bare --print --output-format stream-json --verbose \
  --permission-mode default --max-turns 5 \
  --tools Glob,Grep,Read,Bash \
  --allowedTools Glob Grep Read Bash \
  -- \
  "请先用 Glob 和 Grep 找出仓库里调用 runHeadless 的地方，再读取关键源码，最后用 Bash 执行 pwd。"
```

想看写入闭环：

```bash
bun run dev:headless-core --print --output-format stream-json --verbose \
  --permission-mode default --max-turns 6 \
  --tools Read,Edit,Bash \
  --allowedTools Read Edit Bash \
  -- \
  "请先阅读一个小文件，做一个极小改动，再用 Bash 运行对应检查命令。"
```

这些命令里的 `--` 用来终止 variadic 选项解析，避免 prompt 被 `--tools` / `--allowedTools` 吞掉。

## 2. VS Code 调试步骤

1. 运行 `bun run dev:headless-core:inspect`
2. 在以下位置下断点
3. F5 选择 `Attach to Bun (Headless Core)`
4. 让流程自己跑，不要一开始从入口一路 step into 到底

## 3. 建议断点

| 位置 | 目的 | 第一眼看什么 |
|------|------|-------------|
| `src/cli/print.ts:2145` | 看本轮是否真正进入 `ask()` | `input`、`allTools`、`mutableMessages.length` |
| `src/QueryEngine.ts:413` | 看 `processUserInput()` 改了什么 | `messagesFromUserInput`、`shouldQuery`、`allowedTools` |
| `src/QueryEngine.ts:679` | 看 `query()` 入参 | `messages.length`、`systemPrompt`、`userContext` |
| `src/query.ts:659` | 看模型请求前的状态 | `messagesForQuery`、`fullSystemPrompt`、`toolUseContext.options.tools` |
| `src/query.ts:832` | 看 `tool_use` 第一次出现 | `msgToolUseBlocks`、`toolUseBlocks`、`needsFollowUp` |
| `src/query.ts:1387` | 看工具执行更新如何回流 | `update.message`、`toolResults.length` |
| `src/services/tools/toolExecution.ts:916` | 看权限决策 | `tool.name`、`processedInput`、`permissionMode` |
| `src/services/tools/toolExecution.ts:1207` | 看真正进入工具实现 | `callInput`、`permissionDecision` |
| `src/services/tools/toolExecution.ts:1456` | 看 `tool_result` 生成 | `contentBlocks`、`toolUseResult` |
| `src/query.ts:1719` | 看下一轮 state | `assistantMessages.length`、`toolResults.length`、`next.messages.length` |

## 4. 必看变量

每次只盯这几个，别展开整个对象海：

- `msgToolUseBlocks`
- `toolUseBlocks`
- `needsFollowUp`
- `permissionDecision.behavior`
- `callInput`
- `result.data`
- `contentBlocks`
- `toolResults`
- `next.messages`

## 5. 正常链路应该看到什么

### 场景 A：`Bash(pwd)`

你应该看到：

1. `query.ts:832` 首次出现 `tool_use`
2. `toolExecution.ts:916` 里 `tool.name === "Bash"`
3. `toolExecution.ts:1207` 进入 `tool.call()`
4. `toolExecution.ts:1456` 生成一个带 `tool_result` 的 user message
5. `query.ts:1719` 下一轮 `next.messages` 包含 assistant + tool_result

### 如果没有出现 `tool_use`

优先检查：

1. prompt 是否明确要求“必须调用工具”
2. 是否把工具池收窄到了 `Bash`
3. 模型/provider 是否已正确配置
4. `query.ts:659` 的 `toolUseContext.options.tools` 里是否真的有 `Bash`

### 如果出现 `tool_use` 但没有执行

优先检查：

1. `toolExecution.ts:916` 的 `permissionDecision`
2. `toolExecution.ts:995` 是否走进 deny/ask 分支
3. `toolExecution.ts:1207` 是否根本没被命中

### 如果工具执行了但没进入下一轮

优先检查：

1. `toolExecution.ts:1456` 是否生成了 `createUserMessage(...)`
2. `query.ts:1387` 是否收到了 `update.message`
3. `query.ts:1719` 的 `next.messages` 是否包含该 `tool_result`

## 6. 调试顺序

建议按这个顺序，不要跳：

1. 先只看场景 A，把 `Bash` 最短链跑顺
2. 再看场景 B，理解多工具与多轮
3. 最后看场景 C，理解写文件和验证闭环

如果场景 A 还没跑顺，不要急着看具体工具实现。
