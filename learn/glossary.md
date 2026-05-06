# 高频概念词典

这份文档只解释读源码时反复出现、容易混的词。

## `Message`

项目内部使用的消息类型。

它不是 API 原始返回，也不是最终 SDK 输出。你可以把它理解成：

```text
Claude Code 内部流转用的统一消息对象
```

常见类型：

```text
user
assistant
system
attachment
progress
tombstone
tool_use_summary
```

重点：

```text
processUserInputBase()
  -> 产出 Message[]

queryLoop()
  -> 消费 Message[]
  -> yield Message / StreamEvent / RequestStartEvent

submitMessage()
  -> 再把内部 Message 转成 SDKMessage
```

## `SDKMessage`

对外暴露给 SDK/headless 调用者的消息。

它通常由 `QueryEngine.submitMessage()` 消费内部 `Message` 后转换出来。

不要把它和内部 `Message` 混在一起：

```text
Message
  = Claude Code 内部状态机用

SDKMessage
  = 外部调用者看到的输出协议
```

## `messages`

在不同层含义略有不同。

在 `QueryEngine.submitMessage()` 里：

```text
messages
  = 本轮进入 query() 前的完整内部消息快照
```

在 `queryLoop()` 里：

```text
params.messages
  = queryLoop 第一轮的起始消息

state.messages
  = 每轮 while(true) 接力用的当前消息

messagesForQuery
  = state.messages 经过 compact / snip / microcompact / autocompact 后，当前这一轮真正发给模型的消息
```

## `tool_use`

模型输出里的工具调用请求。

形状近似：

```ts
{
  type: 'tool_use',
  id: 'toolu_1',
  name: 'Read',
  input: { file_path: 'src/query.ts' }
}
```

它只是模型说“我想调用工具”，不是工具已经执行。

后续链路：

```text
assistant message
  -> queryLoop 收集 toolUseBlocks
  -> runTools()
  -> runToolUse()
  -> canUseTool()
  -> tool.call()
```

## `tool_result`

工具执行后的结果块。

从模型 API 视角看，工具结果通常作为 `user` message 里的 `tool_result` block 回传给模型。

所以你会看到：

```text
assistant(tool_use)
user(tool_result)
```

这不是用户真的手写了一句话，而是客户端把工具结果包装成模型能继续理解的消息格式。

## `attachment`

内部附件消息。

它可能表示：

```text
图片
文件变化
memory 注入
skill discovery
queued command
max_turns_reached
hook_stopped_continuation
```

附件不一定都直接来自用户输入。很多是在 `queryLoop()` 工具执行后补进去的。

## `transcript`

会话持久化日志。

它不是 memory，也不是模型一定会看到的上下文。

在 `QueryEngine.submitMessage()` 里，用户消息会尽早写入 transcript，原因是：

```text
如果进程在 API 返回前被杀掉
也能恢复到“用户消息已经被接受”的位置
```

所以 transcript 主要服务：

```text
resume
post-hoc debugging
会话审计
```

## `memory`

给模型提供的长期/项目上下文。

它可能来自：

```text
CLAUDE.md
项目 memory 文件
nested memory
相关 memory prefetch
```

memory 和 transcript 不同：

```text
transcript
  = 记录发生过什么

memory
  = 给模型补充它应该知道什么
```

## `systemPrompt`

系统提示词数组。

在 `QueryEngine.submitMessage()` 里拼好，传给 `query()`。

在 `queryLoop()` 里会和 `systemContext` 合成：

```ts
fullSystemPrompt = appendSystemContext(systemPrompt, systemContext)
```

再传给模型层。

它不是每轮工具调用后都会变。真正跟着工具结果变化的是 `messagesForQuery`。

## `userContext`

发给模型前追加到用户侧的环境上下文。

它不是用户原始输入，也不一定直接出现在 `state.messages` 里。

在 `queryLoop()` 调模型前使用：

```ts
messages: prependUserContext(messagesForQuery, userContext)
```

## `systemContext`

追加到系统提示词里的环境上下文。

和 `userContext` 的区别：

```text
systemContext
  -> appendSystemContext()
  -> system prompt

userContext
  -> prependUserContext()
  -> user-side messages
```

## `QueryParams`

`query()` / `queryLoop()` 的输入包。

它描述“这一轮 query 从外层拿到了什么”：

```text
messages
systemPrompt
userContext
systemContext
canUseTool
toolUseContext
fallbackModel
querySource
maxTurns
taskBudget
deps
```

大部分 `QueryParams` 字段是本次 query 生命周期内的固定输入。

## `State`

`queryLoop()` 在 `while(true)` 之间接力的状态对象。

典型字段：

```text
messages
toolUseContext
turnCount
transition
maxOutputTokensRecoveryCount
hasAttemptedReactiveCompact
pendingToolUseSummary
```

如果你看到：

```ts
state = next
continue
```

意思是：

```text
当前轮没有结束整个 query
而是构造下一轮状态，重新进入 while(true)
```

## `deps`

`queryLoop()` 的依赖注入包。

生产环境：

```ts
deps = {
  callModel: queryModelWithStreaming,
  microcompact: microcompactMessages,
  autocompact: autoCompactIfNeeded,
  uuid: randomUUID,
}
```

测试里可以替换这些函数，避免真的请求模型或生成随机 id。

## `querySource`

标记这次 query 从哪里来。

常见值：

```text
sdk
repl_main_thread
agent:...
compact
session_memory
side_question
```

它主要给内部判断用，不是给模型看的业务字段。

影响点：

```text
queued command 是否由主线程消费
content replacement 是否持久化
compact/session_memory 是否跳过某些阻断
telemetry 如何打标签
```

## `Langfuse trace`

观测/追踪用的根对象。

它不是 prompt，不是 memory，不是 transcript，也不是模型会看到的消息。

它记录：

```text
一次 query 用了哪个模型
LLM 输入/输出是什么
token usage
工具调用输入/输出
耗时
是否中断或报错
```

链路：

```text
query()
  -> createTrace()
  -> toolUseContext.langfuseTrace
  -> deps.callModel(... langfuseTrace ...)
  -> recordLLMObservation()
  -> runTools()
  -> recordToolObservation()
  -> endTrace()
```

如果没有配置 `LANGFUSE_PUBLIC_KEY` 和 `LANGFUSE_SECRET_KEY`，就是 no-op。

## `canUseTool`

工具执行前的权限判断函数。

模型产生 `tool_use` 后，工具并不会立刻执行。中间会经过：

```text
runTools()
  -> runToolUse()
  -> canUseTool()
  -> tool.call()
```

它回答的问题是：

```text
这次工具调用能不能真的执行？
```

## `fallbackModel`

主模型触发 fallback 时使用的备用模型。

如果底层模型请求抛出 `FallbackTriggeredError`，`queryLoop()` 会切到 `fallbackModel` 并重试当前轮请求。

它不是普通每轮都会用的模型名。

## `processUserInputBase()`

输入归一化函数。

它负责把：

```text
字符串输入
内容块数组
pastedContents
图片
slash command
bash mode
附件
```

整理成内部 `Message[]` 和一些控制字段，例如 `shouldQuery`。

## `shouldQuery`

表示处理完用户输入后，是否需要进入模型 query。

例如 slash command 可能只在本地执行，不需要请求模型。

如果：

```ts
shouldQuery === false
```

`submitMessage()` 会走快速路径，不进入 `query()`。

## `AsyncGenerator`

异步生成器。

在这个项目里，它让函数可以一边执行一边不断产出消息。

典型形态：

```ts
for await (const message of query(...)) {
  // 每来一个内部消息，就处理一个
}
```

`queryLoop()`、模型流、工具执行都大量使用这个模式。

## `yield*`

把另一个 generator 的输出直接转发出来。

例如：

```ts
terminal = yield* queryLoop(...)
```

意思是：

```text
query() 自己不逐条处理 queryLoop 的输出
而是把 queryLoop yield 出来的东西原样向外 yield
等 queryLoop return 后，再拿到它的 return 值
```
