# 第二阶段补充：Headless agent -> tool 主链详解

> 目标：只研究 `--print` 路径下，agent 如何产出 `tool_use`、如何执行工具、如何把 `tool_result` 回灌下一轮。

这篇不从 UI 开始，也不从每个工具实现开始，而是只盯住一条最短真实链。

## 推荐入口

最短真实命令：

```bash
bun run scripts/dev-headless-core-debug.ts --preset bash_pwd
```

默认等价于：

```bash
bun run dev --bare --print --output-format stream-json --verbose \
  --permission-mode default --max-turns 3 \
  --tools Bash --allowedTools Bash \
  -- \
  "你必须调用 Bash 工具执行 `pwd`。如果没有真正调用 Bash，不要回答。执行后只输出目录路径。"
```

调试版本：

```bash
bun run scripts/dev-headless-core-debug.ts --preset bash_pwd
```

VS Code 直接附着：

- 使用 `.vscode/launch.json` 里的 `Attach to Bun (Headless Core)`
- inspect 地址和现有 `dev:inspect` 共用：`ws://localhost:8888/2dc3gzl5xot`

默认带 `--bare`，目的是去掉插件同步、CLAUDE.md 自动发现、后台 housekeeping 等噪音，只保留真实的 headless + agent + tool 主链。  
如果你想看完整环境装配，把 `--bare` 去掉即可。

示例里的 `--` 不是多余的。它用来把最终 prompt 和 `--tools` / `--allowedTools` 这类 variadic 选项隔开，避免 prompt 被误当成工具名。

## 一条主链

```
scripts/dev-headless-core.ts
  -> src/entrypoints/cli.tsx
    -> src/main.tsx (--print 分支)
      -> runHeadless()
        -> runHeadlessStreaming()
          -> ask()
            -> QueryEngine.submitMessage()
              -> query()
                -> queryLoop()
                  -> deps.callModel()
                    -> 收集 tool_use
                      -> runTools()/StreamingToolExecutor
                        -> toolExecution.ts
                          -> resolveHookPermissionDecision()
                          -> tool.call()
                          -> createUserMessage(tool_result)
                  -> 下一轮 queryLoop()
```

要点：

- `main.tsx` 只是把 CLI 参数、状态、工具池组装好，再把控制权交给 `runHeadless()`
- `print.ts` 是 headless 会话编排层，不决定工具调用本身
- `QueryEngine.ts` 负责把输入处理、system init、transcript、`query()` 消费粘起来
- `query.ts` 才是核心单轮 agent loop
- `toolExecution.ts` 负责把 `tool_use` 变成真实的权限决策、工具调用、`tool_result`

## 五个关键层级

### 1. CLI 路由层：`src/main.tsx`

关键位置：

- `src/main.tsx:4154` 动态 import `runHeadless`
- `src/main.tsx:4156` 调用 `runHeadless(...)`

这层只解决两件事：

- 当前是不是 `--print` / headless 路径
- headless 路径需要哪些初始依赖：`headlessStore`、工具池、MCP、commands、systemPrompt、permission 相关配置

第一次看源码时，不要在这里单步太久。这里的信息密度不高，容易被初始化噪音淹没。

### 2. Headless 编排层：`src/cli/print.ts`

关键位置：

- `src/cli/print.ts:449` `runHeadless(...)`
- `src/cli/print.ts:857` 进入 `runHeadlessStreaming(...)`
- `src/cli/print.ts:2145` 真正调用 `ask(...)`

这一层的职责：

- 处理 `--print` 参数约束、structured IO、resume/rewind、stream-json 输出
- 维护 headless 下的 `mutableMessages` 和 `readFileState`
- 在每次队列取出 prompt 后，把输入送进 `ask(...)`

一个很重要的判断：

- 如果你想看“为什么这次 prompt 会发起一次 query”，看 `print.ts`
- 如果你想看“模型为什么调了这个工具”，别停在 `print.ts`，直接下钻到 `query.ts`

### 3. 高层会话编排：`src/QueryEngine.ts`

关键位置：

- `src/QueryEngine.ts:202` `new QueryEngine(config)`
- `src/QueryEngine.ts:211` `submitMessage(...)`
- `src/QueryEngine.ts:295` `fetchSystemPromptParts(...)`
- `src/QueryEngine.ts:413` `processUserInput(...)`
- `src/QueryEngine.ts:543` `yield buildSystemInitMessage(...)`
- `src/QueryEngine.ts:679` `for await (const message of query(...))`

这层的职责：

- 把 prompt 先过一遍 `processUserInput()`，让 slash command、附件、工具白名单等先落到消息数组和 app state
- 组装 system prompt / user context / system context
- 产出 headless 的 system init message
- 进入 `query()`，并消费它 yield 出来的 assistant/user/system/result 消息
- 维护 transcript、usage、permission denials、structured output

理解这层的关键不是“每个字段是什么”，而是这三个问题：

1. `this.mutableMessages` 何时增长
2. `processUserInput()` 在 query 之前改了什么
3. `query()` yield 回来的消息如何重新写回 transcript / SDK 输出

### 4. 核心 agent loop：`src/query.ts`

关键位置：

- `src/query.ts:219` `query(...)`
- `src/query.ts:241` `queryLoop(...)`
- `src/query.ts:659` `deps.callModel(...)`
- `src/query.ts:832` 提取 `tool_use`
- `src/query.ts:845` `streamingToolExecutor.addTool(...)`
- `src/query.ts:1366` `query_tool_execution_start`
- `src/query.ts:1383` 决定 `streamingToolExecutor.getRemainingResults()` 还是 `runTools(...)`
- `src/query.ts:1719` 把 `assistantMessages + toolResults` 拼回下一轮 state

这一层是你最该盯紧的地方。

一轮循环的核心结构：

1. 准备 `messagesForQuery`
2. 调 `deps.callModel()` 拿流式 assistant 消息
3. 扫 assistant content，把 `tool_use` 收集到 `toolUseBlocks`
4. 执行工具，得到 `toolResults`
5. 把 `messagesForQuery + assistantMessages + toolResults` 合并进下一轮 state
6. `while (true)` 继续

真正的 agentic loop，不是“模型一次性回答”，而是：

`assistant(tool_use) -> user(tool_result) -> assistant(继续推理) -> ...`

### 5. 工具执行层：`src/services/tools/toolExecution.ts`

关键位置：

- `src/services/tools/toolExecution.ts:916` 权限决策开始
- `src/services/tools/toolExecution.ts:930` `permissionDecision`
- `src/services/tools/toolExecution.ts:995` deny/ask 分支直接返回错误 `tool_result`
- `src/services/tools/toolExecution.ts:1207` 真正进入 `tool.call(...)`
- `src/services/tools/toolExecution.ts:1292` 把结果映射成 `ToolResultBlockParam`
- `src/services/tools/toolExecution.ts:1456` `createUserMessage(...)` 生成 `tool_result` 消息

这层负责：

- hook / permission / classifier 决策
- 把模型给的 tool input 转成最终 `callInput`
- 调具体工具实现的 `call()`
- 把原始结果映射成 API 需要的 `tool_result`
- 生成下一轮要喂回模型的 user message

你如果只想看“agent 如何调用工具”，最值钱的两个断点就是：

- `toolExecution.ts:916`
- `toolExecution.ts:1207`

## 最短断点路线

第一轮不要从入口一路 step into 到底，直接用下面这条路线。

### 断点 1：`src/cli/print.ts:2145`

目的：

- 确认 headless 这一轮真正开始了
- 看 `ask(...)` 被喂了什么输入

重点看：

- `input`
- `allTools`
- `mutableMessages`
- `activeUserSpecifiedModel`
- `abortController`

### 断点 2：`src/QueryEngine.ts:413`

目的：

- 看 `processUserInput()` 是否改写了用户输入
- 看 `allowedTools` / 本轮 message 数组如何更新

重点看：

- `messagesFromUserInput`
- `shouldQuery`
- `allowedTools`
- `this.mutableMessages`

### 断点 3：`src/QueryEngine.ts:679`

目的：

- 确认真正进入 `query(...)`

重点看：

- `messages`
- `systemPrompt`
- `userContext`
- `processUserInputContext.options.tools`

### 断点 4：`src/query.ts:659`

目的：

- 看本轮发给模型的完整输入长什么样

重点看：

- `messagesForQuery`
- `fullSystemPrompt`
- `toolUseContext.options.tools`
- `currentModel`

### 断点 5：`src/query.ts:832`

目的：

- 看 assistant 响应里什么时候真正出现 `tool_use`

重点看：

- `assistantMessage.message.content`
- `msgToolUseBlocks`
- `toolUseBlocks`
- `needsFollowUp`

如果你只想证明“模型确实决定调用工具了”，这一断点最关键。

### 断点 6：`src/query.ts:1387`

目的：

- 看 query loop 如何消费工具执行更新

重点看：

- `toolUpdates`
- `update.message`
- `toolResults`
- `updatedToolUseContext`

### 断点 7：`src/services/tools/toolExecution.ts:916`

目的：

- 看这次工具调用是否会被允许

重点看：

- `tool.name`
- `processedInput`
- `permissionMode`
- `hookPermissionResult`

### 断点 8：`src/services/tools/toolExecution.ts:1207`

目的：

- 看真正进入工具实现前，最终 `callInput` 是什么

重点看：

- `callInput`
- `permissionDecision`
- `toolUseID`
- `assistantMessage.uuid`

### 断点 9：`src/services/tools/toolExecution.ts:1456`

目的：

- 看成功执行后的 `tool_result` 是怎么回灌成 user message 的

重点看：

- `toolResultBlock`
- `contentBlocks`
- `toolUseResult`
- `resultingMessages`

### 断点 10：`src/query.ts:1719`

目的：

- 看下一轮 state 如何构造

重点看：

- `assistantMessages`
- `toolResults`
- `next.messages`
- `next.turnCount`

如果这里看懂了，你就已经抓住了完整闭环。

## 建议观察变量

调试时优先盯这些变量，不要一开始就看整个大对象：

- `msgToolUseBlocks`
- `toolUseBlocks`
- `needsFollowUp`
- `toolResults`
- `permissionDecision`
- `callInput`
- `result.data`
- `contentBlocks`
- `this.mutableMessages.at(-1)`
- `next.messages.at(-1)`

最常见的误区：

- 把 `assistantMessages` 当成最终历史。它只是本轮收集区，不是完整 transcript。
- 以为 `tool.call()` 返回后循环就结束。实际上真正重要的是它被包装成 `tool_result` 之后再进入下一轮。
- 在 `main.tsx` 花太久。它不是工具调用决策发生的地方。

## 从最短链扩到更完整的链

### 场景 A：只看最短 Bash 链

```bash
bun run scripts/dev-headless-core-debug.ts --preset bash_pwd
```

目标：

- 看懂一轮 `tool_use(Bash)` 到 `tool_result`

### 场景 B：看搜索 -> 读取 -> 决策 -> 执行

```bash
bun run scripts/dev-headless-core-debug.ts --prompt \
  "请先用 Glob 和 Grep 找出仓库里调用 runHeadless 的地方，再读取最关键的源码，并用 Bash 执行 pwd 验证当前目录。"
```

目标：

- 看多次 `tool_use`
- 看不同工具结果如何进入同一个下一轮 state

### 场景 C：看写入闭环

```bash
bun run scripts/dev-headless-core-debug.ts --prompt \
  "请阅读一个小文件，做一个极小改动，然后用 Bash 跑对应检查命令验证。"
```

目标：

- 看 `Edit` 之后的 `tool_result`
- 看模型如何依据 Bash 结果继续修正

## 第一批适合动手的小改动

等你把上面断点跑顺之后，再做这些小改动，学习价值最高：

1. 在 `query.ts` 里为 `tool_use` 被识别的时刻补一条更清晰的 debug 日志
2. 在 `toolExecution.ts` 里为 `permissionDecision` 增加更容易阅读的调试输出
3. 在 `print.ts` 里给 headless 模式增加一个更明确的状态提示，说明当前正在进入 `ask()`
4. 给 `tool_use -> tool_result -> next state` 这条链补一份轻量测试或录制说明

别先做这些：

- 新工具
- 新 agent 模式
- Bridge / Voice / Buddy / Chrome 这类外围能力
- 大重构

## 读源码时的判断标准

你真的看懂这条链时，应该能回答这四个问题：

1. `tool_use` 第一次进入内存时，落在哪个数组里
2. 权限决策是在 `tool.call()` 之前还是之后
3. `tool_result` 为什么是 user message，而不是 assistant message
4. 下一轮 query 为什么能“记住”刚才的工具结果

如果这四个问题还答不顺，就别急着扩到每个工具实现。
