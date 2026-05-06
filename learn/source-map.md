# 源码地图

这份文档回答：

```text
我现在想看某个功能，应该从哪个文件、哪个函数开始？
```

它不是源码详解，只是导航。

## 主链路地图

```text
src/main.tsx
  -> src/cli/print.ts
  -> src/QueryEngine.ts
  -> src/utils/processUserInput/processUserInput.ts
  -> src/query.ts
  -> src/services/api/claude.ts
  -> src/services/tools/toolOrchestration.ts
  -> src/services/tools/toolExecution.ts
```

## `src/main.tsx`

定位：

```text
CLI 命令入口和运行模式分发
```

你在这里看：

```text
交互 REPL 怎么启动
--print / headless 模式怎么进入 print.ts
各种 CLI 参数怎么被解析
```

不建议初学阶段深读整个文件。它太大，很多分支和主链无关。

优先看文档：

[phase-1-startup-flow.md](phase-1-startup-flow.md)

## `src/cli/print.ts`

定位：

```text
headless / --print 模式的外层编排器
```

核心函数：

```text
runHeadlessStreaming()
```

它负责：

```text
接收输入事件
处理 control_request
维护命令队列
调用 ask()
消费 ask() 产出的消息
处理 interrupt / end_session / initialize 等协议事件
```

你想看“为什么必须用 inspect 才能断住”“preset 怎么进入完整链路”，看这里。

对应文档：

[phase-3-runHeadlessStreaming.md](phase-3-runHeadlessStreaming.md)

## `src/QueryEngine.ts`

定位：

```text
SDK/headless 路径下的一轮对话编排器
```

核心入口：

```text
ask()
QueryEngine.submitMessage()
```

它负责：

```text
创建 QueryEngine
处理用户输入
构建 systemPrompt / userContext / systemContext
写 transcript
更新 appState / 权限上下文
加载 skills / plugins
调用 query()
把内部 Message 转成 SDK 输出
产出最终 result
```

你想看“一次用户输入怎么进入 queryLoop”，从这里开始。

对应文档：

[phase-2-ask-submitMessage-deep-dive.md](phase-2-ask-submitMessage-deep-dive.md)

## `src/utils/processUserInput/processUserInput.ts`

定位：

```text
用户输入归一化
```

核心函数：

```text
processUserInput()
processUserInputBase()
processTextPrompt()
```

它负责：

```text
把字符串 / 内容块数组 / pastedContents 变成 Message[]
处理图片
处理 slash command
处理 bash mode
收集 attachment
决定 shouldQuery
```

你想看“图片怎么被处理”“slash command 为什么不一定进 query”，看这里。

对应文档：

[phase-2-processUserInputBase-deep-dive.md](phase-2-processUserInputBase-deep-dive.md)

[phase-2-processUserInput-image-debug.md](phase-2-processUserInput-image-debug.md)

## `src/query.ts`

定位：

```text
核心 agent 状态机
```

核心入口：

```text
query()
queryLoop()
```

它负责：

```text
创建 / 结束 Langfuse trace
维护 State
预处理 messagesForQuery
调用模型
收集 assistantMessages / toolUseBlocks
执行工具
把 toolResults 拼回下一轮 messages
处理 prompt-too-long / max_output_tokens / stop hooks / token budget
决定 completed / max_turns / aborted / model_error 等 Terminal
```

你想看“agent 为什么能自己调用工具再继续下一轮”，看这里。

对应文档：

[phase-4-query-loop.md](phase-4-query-loop.md)

## `src/query/deps.ts`

定位：

```text
queryLoop 的依赖注入定义
```

核心内容：

```text
QueryDeps
productionDeps()
```

生产环境里：

```ts
{
  callModel: queryModelWithStreaming,
  microcompact: microcompactMessages,
  autocompact: autoCompactIfNeeded,
  uuid: randomUUID,
}
```

你想看 `deps` 到底是什么，看这里。

## `src/services/api/claude.ts`

定位：

```text
模型 API 适配层
```

核心入口：

```text
queryModelWithStreaming()
queryModelWithoutStreaming()
queryModel()
```

它负责：

```text
把内部 Message 转成 API message
构造 system prompt
构造 tools schema
配置 max_tokens / thinking / betas / task_budget
发起 stream 请求
解析 message_start / content_block_delta / message_delta 等事件
产出 AssistantMessage / StreamEvent
记录 LLM usage
处理 provider 差异和 fallback
```

你想看“底层 stream event 怎么变成 assistant message”，看这里。

对应文档：

[phase-4-query-loop.md](phase-4-query-loop.md) 的第 7 节。

## `src/services/tools/toolOrchestration.ts`

定位：

```text
一批工具调用的调度器
```

核心函数：

```text
runTools()
```

它负责：

```text
把多个 tool_use 分批
决定哪些可以并发
哪些必须串行
创建 Langfuse tool batch span
把每个工具交给 runToolUse()
```

你想看“多个工具怎么一起执行”，看这里。

## `src/services/tools/StreamingToolExecutor.ts`

定位：

```text
边流式接收模型输出，边提前执行工具
```

核心方法：

```text
addTool()
getCompletedResults()
getRemainingResults()
discard()
```

它负责：

```text
assistant 流里刚出现 tool_use 就提前开跑工具
已完成工具结果可以提前 yield
流结束后 drain 剩余结果
fallback / abort 时丢弃旧结果或合成 tool_result
```

这是后面最值得补专题的文件。

## `src/services/tools/toolExecution.ts`

定位：

```text
单个工具调用的真实执行链路
```

核心函数：

```text
runToolUse()
```

它负责：

```text
根据 tool_use.name 找工具
校验 input
执行权限判断 canUseTool()
运行 pre/post hook
调用 tool.call()
包装 tool_result / attachment / progress
记录 Langfuse tool observation
处理错误和 abort
```

你想看“模型发出的 tool_use 到底怎么变成本地操作”，看这里。

## `src/Tool.ts`

定位：

```text
工具接口定义
```

你在这里看：

```text
Tool 类型长什么样
工具需要实现哪些字段
findToolByName 如何找工具
ToolUseContext 包含什么
```

## `src/tools.ts`

定位：

```text
工具注册和工具列表组装
```

你在这里看：

```text
哪些工具会被暴露给模型
不同模式下工具集怎么变化
MCP 工具如何加入
```

## `src/services/langfuse/`

定位：

```text
观测和 trace 记录
```

核心文件：

```text
client.ts
tracing.ts
convert.ts
sanitize.ts
```

它负责：

```text
初始化 Langfuse
创建 trace
记录 LLM observation
记录 tool observation
结束 trace
清洗敏感字段
```

如果没配置 Langfuse key，这条链路基本是 no-op。

## `src/context.ts`

定位：

```text
系统/用户上下文构建
```

你在这里看：

```text
cwd / git / platform / memory / CLAUDE.md 等上下文怎么进入 prompt
```

这个文件适合在你已经理解 `systemPrompt / userContext / systemContext` 后再看。

## `src/utils/claudemd.ts`

定位：

```text
CLAUDE.md 发现和加载
```

你在这里看：

```text
项目层级 CLAUDE.md 怎么找
多级 CLAUDE.md 怎么合并
```

## 推荐断点入口

最短主链：

```text
src/cli/print.ts
  runHeadlessStreaming()

src/QueryEngine.ts
  ask()
  QueryEngine.submitMessage()

src/utils/processUserInput/processUserInput.ts
  processUserInputBase()

src/query.ts
  query()
  queryLoop()

src/services/api/claude.ts
  queryModelWithStreaming()
  queryModel()

src/services/tools/toolOrchestration.ts
  runTools()

src/services/tools/toolExecution.ts
  runToolUse()
```

如果你只能下 5 个断点：

```text
1. QueryEngine.submitMessage()
2. processUserInputBase()
3. queryLoop() while 顶部
4. deps.callModel(...) 那一行
5. runToolUse()
```
