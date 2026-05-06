# `query()` / `queryLoop()` 全方法抄录 + 行内注释 + 外部结构图

> 目标：把 `src/query.ts` 里最核心的 `query()` 和 `queryLoop()` 按源码顺序贴出来，在代码块里直接写中文注释，并用 ASCII 图把“模型流式输出 -> 工具执行 -> 下一轮继续”的主回路串起来。

这篇是接在 `phase-3-runHeadlessStreaming.md` 后面读的。

如果上一讲你看到的是：

```text
runHeadlessStreaming()
  -> ask()
```

那这一讲要继续往下走到：

```text
ask()
  -> QueryEngine.submitMessage()
    -> query()
      -> queryLoop()
        -> deps.callModel()
        -> tool_use / tool_result
        -> continue or return
```

先记住一句话：

```text
queryLoop() = 一次用户 turn 的核心状态机
```

它不是单纯“调一次模型”。

它做的是：

```text
准备消息
  -> 可能压缩上下文
  -> 发起流式模型调用
  -> 一边接 assistant 消息，一边识别 tool_use
  -> 工具边流边执行 / 或流后执行
  -> 把 tool_result、attachment、memory、queued command 塞回消息
  -> 再次进入下一轮
  -> 直到不再需要 follow-up
```

---

## 先看总图

```text
runHeadlessStreaming()
   |
   v
ask() / QueryEngine.submitMessage()
   |
   v
query()
   |
   +--> 建 Langfuse trace
   +--> 调 queryLoop()
   |
   v
queryLoop()
   |
   +--> state 初始化
   |
   +--> while (true)
         |
         +--> 1. 预处理 messages
         |      - compact boundary
         |      - tool result budget
         |      - snip
         |      - microcompact
         |      - context collapse
         |      - autocompact
         |
         +--> 2. deps.callModel() 流式采样
         |      - assistant message
         |      - tool_use block
         |      - recoverable error withhold
         |      - streaming fallback
         |
         +--> 3. needsFollowUp ?
         |      |
         |      +--> 否
         |      |     - prompt-too-long 恢复
         |      |     - max_output_tokens 恢复
         |      |     - stop hooks
         |      |     - token budget
         |      |     - return completed
         |      |
         |      +--> 是
         |            - 执行工具
         |            - 生成 tool_result / attachment
         |            - 消费 memory / skill prefetch
         |            - 处理 queued commands
         |            - 检查 maxTurns
         |            - state = next
         |            - continue
         |
         +--> 4. 直到 return Terminal
```

再看一张更贴近“消息怎么流动”的图：

```text
messagesForQuery
   |
   +--> deps.callModel(...)
            |
            +--> assistant(text/thinking/tool_use/...)
                    |
                    +--> yield 给上层
                    +--> assistantMessages[]
                    +--> toolUseBlocks[]
                    +--> StreamingToolExecutor.addTool()
                                      |
                                      +--> 提前完成的 tool_result 直接 yield
                                      +--> 其余工具等流结束后 getRemainingResults()
            |
            +--> 无 tool_use ?
                    |
                    +--> 完成恢复逻辑 / stopHooks / return
            |
            +--> 有 tool_use ?
                    |
                    +--> toolResults[]
                    +--> attachments / memory / queued commands
                    +--> next state.messages =
                          messagesForQuery + assistantMessages + toolResults
                    +--> continue 下一轮
```

阅读方式还是一条：

```text
先看代码块里的中文注释。
再看代码块下面的解释。
从上往下，不跳。
```

---

## 0. 先把这个方法放回调用链里

```text
print.ts
  runHeadlessStreaming()
    for await (const message of ask(...))
      ^
      |
QueryEngine.ts
  ask()
    const engine = new QueryEngine(...)
    yield* engine.submitMessage(...)
                    |
                    v
                  query()
                    |
                    v
                 queryLoop()
```

所以你要分清三层责任：

```text
runHeadlessStreaming()
  = 输入队列 / 控制协议 / run() 编排

QueryEngine.submitMessage()
  = turn 级上下文拼装 / transcript 持久化 / SDK 消息规范化

queryLoop()
  = 真正的模型-工具-继续循环
```

---

## 1. `query()`：外层包壳，只负责 trace 和 queryLoop 委托

```ts
export async function* query(
  // query 的全部输入参数，里面已经带好了 messages、systemPrompt、
  // toolUseContext、canUseTool、querySource 等执行上下文。
  params: QueryParams,
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  // 最终 return 的不是消息，而是一个 Terminal，告诉上层这一轮为什么结束。
  Terminal
> {
  // 本轮 query 消费掉的 queued command UUID。
  // 注意这里只记录“真的被当前 query 消费的 command”，函数正常返回后才补 completed。
  const consumedCommandUuids: string[] = []

  // 这一层负责 Langfuse trace 的生命周期。
  // 如果当前就是某个 subagent 里面继续下钻，就复用已有 trace；
  // 如果不是，就创建一个新的顶层 trace。
  const ownsTrace = !params.toolUseContext.langfuseTrace
  const langfuseTrace = params.toolUseContext.langfuseTrace
    ?? (isLangfuseEnabled()
      ? createTrace({
          sessionId: getSessionId(),
          model: params.toolUseContext.options.mainLoopModel,
          provider: getAPIProvider(),
          input: params.messages,
          querySource: params.querySource,
        })
      : null)

  // 如果拿到了 trace，就把它塞回 toolUseContext。
  // 这样后续工具执行、批次 span、观测数据都能挂在同一条 trace 上。
  const paramsWithTrace: QueryParams = langfuseTrace
    ? {
        ...params,
        toolUseContext: { ...params.toolUseContext, langfuseTrace },
      }
    : params

  let terminal: Terminal | undefined
  try {
    // 真正的主体逻辑全在 queryLoop()。
    terminal = yield* queryLoop(paramsWithTrace, consumedCommandUuids)
  } finally {
    // 只有本层自己创建的 trace，才在这里负责结束。
    // 如果是外层传进来的，就不要越权结束。
    if (ownsTrace) {
      const isAborted =
        terminal?.reason === 'aborted_streaming' ||
        terminal?.reason === 'aborted_tools'
      endTrace(langfuseTrace, undefined, isAborted ? 'interrupted' : undefined)
    }
  }

  // 只有 queryLoop “正常 return” 才会走到这里。
  // 如果 queryLoop throw，或者生成器被外部 return() 提前收掉，这里不会执行。
  // 这和 print.ts 里 command started/completed 的非对称语义是对齐的。
  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }

  // queryLoop 正常返回时 terminal 一定有值。
  return terminal!
}
```

这一层只做 3 件事：

```text
1. 建 trace
2. 调 queryLoop()
3. queryLoop 正常结束后，补 queued command 的 completed 生命周期
```

所以你以后调试时：

```text
如果问题是“为什么这个 turn 会继续下一轮 / 为什么工具没有跑 / 为什么 stop hook 触发了”
  看 queryLoop()

如果问题是“为什么 trace 没关 / command completed 没打 / 是否正常 return”
  看 query()
```

---

## 2. `queryLoop()` 开头：固定参数、State、prefetch、循环骨架

这一段先别急着看细枝末节，只抓住两个对象：

```text
params = 只读输入
state  = 跨迭代可变状态
```

这里先不要急着看 `while (true)`。先把 `params` 里面每个名字当成一个真实对象看清楚。

### 2.1 `QueryParams` 变量词典

源码类型在 `src/query.ts`：

```ts
export type QueryParams = {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  canUseTool: CanUseToolFn
  toolUseContext: ToolUseContext
  fallbackModel?: string
  querySource: QuerySource
  maxOutputTokensOverride?: number
  maxTurns?: number
  skipCacheWrite?: boolean
  taskBudget?: { total: number }
  deps?: QueryDeps
}
```

这一节以后我不再用“作用：xxx”这种写法。每个重要变量都按同一个读法拆：

```text
它装什么
  变量里真实保存的数据类型 / 数据形状

谁写它
  这个值通常从哪里传进来，或者哪段逻辑生成它

谁读它
  后面哪段代码会消费它

什么时候会变
  是整个 query 固定不变，还是每轮 while(true) 会接力更新
```

你读 `queryLoop()` 时可以先把变量分成两堆：

```text
params.*
  = 外层 QueryEngine 给 queryLoop 的“起始输入”
  = 大部分字段在本次 query 生命周期内不重新赋值

state.*
  = queryLoop 自己维护的“循环状态”
  = 每次 continue 前可能被重建，下一轮 while(true) 再读取
```

下面逐个拆。

#### `messages`

`messages` 是当前 query 的起始消息数组。

它不是用户刚输入的原始字符串，也不是 transcript 文件内容。它是已经经过 `processUserInput()`、`QueryEngine.submitMessage()` 整理后的内部 `Message[]`。

一个最小例子：

```ts
messages = [
  {
    type: 'user',
    uuid: 'u1',
    message: {
      role: 'user',
      content: '帮我分析 src/query.ts'
    }
  }
]
```

如果用户带了图片、附件、slash command 展开内容，它可能长这样：

```ts
messages = [
  user('解释这张图'),
  attachment({ type: 'image', ... }),
  user({ isMeta: true, content: 'slash command 展开后的隐藏提示' }),
  attachment({ type: 'command_permissions', allowedTools: ['Read', 'Grep'] })
]
```

进入 `queryLoop()` 后，第一轮会用它初始化：

```ts
state.messages = params.messages
```

后面每次模型调用工具后，`state.messages` 会被改成：

```ts
messagesForQuery + assistantMessages + toolResults
```

所以 `params.messages` 是起点，`state.messages` 才是后面每轮接力的当前状态。

你可以这样记：

```text
params.messages
  = QueryEngine 交给 queryLoop 的第一包消息

state.messages
  = queryLoop 每一轮真正拿来继续跑的消息

messagesForQuery
  = state.messages 经过 compact/snip/microcompact/autocompact 处理后，当前这一轮真正发给模型的消息
```

#### `systemPrompt`

`systemPrompt` 是本轮最终要给模型的系统提示词数组。

它在 `QueryEngine.submitMessage()` 前面已经拼好了，来源包括：

```text
默认 system prompt
  + customSystemPrompt 或 defaultSystemPrompt
  + memoryMechanicsPrompt
  + appendSystemPrompt
```

形状接近：

```ts
systemPrompt = [
  'You are Claude Code...',
  'Follow these tool-use rules...',
  'Additional user-provided system prompt...'
]
```

在 `queryLoop()` 里它先保持不动。真正发 API 前，会和 `systemContext` 再合并：

```ts
const fullSystemPrompt = asSystemPrompt(
  appendSystemContext(systemPrompt, systemContext),
)
```

然后 `queryModel()` 还会继续追加一些 API 层需要的前缀，例如 attribution header、CLI sys prompt prefix、advisor instructions 等。

所以：

```text
systemPrompt
  = QueryEngine 已经拼好的基础系统提示词

fullSystemPrompt
  = systemPrompt + systemContext

queryModel() 里的 system
  = fullSystemPrompt + API 层补充 + cache_control 等结构
```

它在 `queryLoop()` 里不跟着工具结果变化。即使模型调用了 5 次工具，`systemPrompt` 还是同一个数组。

真正变化的是 `messagesForQuery`，也就是用户消息、assistant 消息、tool_result 这一条链。

模拟一下：

```ts
systemPrompt = [
  '你是 Claude Code...',
  '使用工具前遵守这些规则...',
]

systemContext = {
  cwd: '/home/zhangxuan/project/ai/claude-code',
  platform: 'linux',
}

fullSystemPrompt = appendSystemContext(systemPrompt, systemContext)
```

然后 `deps.callModel()` 收到的是：

```ts
{
  messages: prependUserContext(messagesForQuery, userContext),
  systemPrompt: fullSystemPrompt,
  ...
}
```

所以 `systemPrompt` 的后续消费点非常明确：

```text
systemPrompt
  -> appendSystemContext(systemPrompt, systemContext)
  -> fullSystemPrompt
  -> deps.callModel({ systemPrompt: fullSystemPrompt })
  -> queryModelWithStreaming()
  -> queryModel()
  -> 最终 API 请求体里的 system 字段
```

#### `userContext`

`userContext` 是附加给用户侧的上下文，不是普通用户输入。

它来自 `fetchSystemPromptParts()`、coordinator context、MCP/工作目录等上下文构建逻辑。形状是一个 key-value 对象：

```ts
userContext = {
  cwd: '/home/zhangxuan/project/ai/claude-code',
  platform: 'linux',
  today: '2026-05-06',
  ...
}
```

真正发模型前，`queryLoop()` 会把它 prepend 到消息里：

```ts
messages: prependUserContext(messagesForQuery, userContext)
```

也就是说，它最终会影响模型看到的用户上下文，但它不是 `messages` 数组里的普通 `user` message。

对初学者来说，最容易混的是：

```text
user message
  = 用户真实说的话，比如“帮我解释 queryLoop”
  = 在 messages 数组里

userContext
  = 客户端补给模型看的环境信息，比如 cwd、日期、平台
  = 不直接作为 params.messages 的一项出现
  = 发 API 前由 prependUserContext() 临时拼进去
```

所以如果你在 `state.messages` 里没看到 `cwd`，不代表模型看不到 `cwd`。它可能是在 `deps.callModel()` 前才被 `prependUserContext()` 加进去。

#### `systemContext`

`systemContext` 是要追加到系统提示词里的上下文对象。

形状也类似：

```ts
systemContext = {
  currentDirectory: '/home/zhangxuan/project/ai/claude-code',
  gitBranch: 'main',
  ...
}
```

它在这里被使用：

```ts
appendSystemContext(systemPrompt, systemContext)
```

所以 `systemContext` 的去向是 system prompt，不是 user messages。

它和 `userContext` 的区别可以这样看：

```text
systemContext
  -> appendSystemContext()
  -> 进入 system prompt
  -> 更像“规则/运行环境说明”

userContext
  -> prependUserContext()
  -> 进入 user-side messages
  -> 更像“当前请求的环境上下文”
```

#### `canUseTool`

`canUseTool` 是工具执行前的权限裁决函数。

模型发出：

```ts
tool_use: Bash({ command: 'rm -rf /tmp/x' })
```

并不代表马上执行。后面会进入：

```text
queryLoop()
  -> runTools()
  -> runToolUse()
  -> checkPermissionsAndCallTool()
  -> canUseTool(...)
```

`canUseTool` 返回类似：

```ts
{ behavior: 'allow' }
```

或者：

```ts
{ behavior: 'deny', message: '...' }
```

所以它是模型 tool_use 和本地真实工具执行之间的一道权限闸门。

在 `QueryEngine` 里传进来的是：

```ts
canUseTool: wrappedCanUseTool
```

`wrappedCanUseTool` 会在原始 `canUseTool` 外面多做一件事：如果被拒绝，就把拒绝信息记到 `permissionDenials`，最后 SDK result 里可以返回这些拒绝记录。

一个最小数据流：

```text
assistant message 里出现 tool_use
  {
    type: 'tool_use',
    id: 'toolu_1',
    name: 'Bash',
    input: { command: 'pwd' }
  }

queryLoop 收集到 toolUseBlocks[]

runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)

runToolUse()
  -> 找到 Bash 工具
  -> 校验 input
  -> canUseTool(...)
  -> 允许才执行 Bash.call(...)
```

所以 `canUseTool` 不负责“找工具”，也不负责“执行工具”。它只在真正执行前回答一个问题：

```text
这次 tool_use 在当前权限上下文下能不能跑？
```

#### `toolUseContext`

`toolUseContext` 是工具执行期间共享的大上下文。

它不是单个工具的输入，而是所有工具执行时都可能需要的环境包。

里面通常包括：

```text
options.tools
  当前可用工具列表

options.mainLoopModel
  当前主循环模型

options.mcpClients
  MCP 客户端列表

getAppState / setAppState
  读写全局状态

abortController
  用户中断时取消模型流和工具执行

readFileState
  记录读过哪些文件，用于附件、memory 去重等

queryTracking
  queryLoop 里追加的链路追踪信息
```

所以你可以把它理解成：

```text
toolUseContext = 工具执行期的运行环境
```

模型给的 `tool_use.input` 只是“这个工具的参数”。

`toolUseContext` 是“执行这个工具时可用的系统环境”。

你可以把它想成“工具运行时背包”：

```ts
toolUseContext = {
  options: {
    tools: [Read, Grep, Bash, ...],
    mainLoopModel: '...',
    isNonInteractiveSession: true,
    mcpClients: [...],
    agentDefinitions: {...},
  },
  abortController,
  readFileState,
  getAppState,
  setAppState,
  ...
}
```

它会变化。比如：

```text
queryLoop 开始
  toolUseContext.queryTracking 还没有

本轮 while 顶部
  queryLoop 生成 queryTracking
  toolUseContext = { ...toolUseContext, queryTracking }

工具执行后
  某些工具返回 update.newContext
  updatedToolUseContext = update.newContext

下一轮 state
  toolUseContext: toolUseContextWithQueryTracking
```

所以它被放进 `state`，不是只读 params。

#### `fallbackModel`

`fallbackModel` 是模型请求失败或高负载时，用来切换的备用模型。

它不是每轮都用。只有底层 API 调用触发 `FallbackTriggeredError` 时才会走到。

链路是：

```text
queryLoop()
  -> deps.callModel(...)
    -> queryModelWithStreaming()
      -> queryModel()
        -> withRetry(...)
          -> 可能 throw FallbackTriggeredError
```

`queryLoop()` 捕获后会做：

```ts
if (innerError instanceof FallbackTriggeredError && fallbackModel) {
  currentModel = fallbackModel
  attemptWithFallback = true
  toolUseContext.options.mainLoopModel = fallbackModel
  yield createSystemMessage(`Switched to ...`)
  continue
}
```

模拟一下：

```ts
currentModel = 'claude-sonnet-x'
fallbackModel = 'claude-haiku-x'
```

如果 `claude-sonnet-x` 触发 fallback：

```text
当前这一轮 API 请求丢弃
切到 claude-haiku-x
重试当前轮请求
```

这不是“下一次用户输入才生效”，而是在当前 `queryLoop()` 这轮里重试。

注意这里有两种 fallback：

```text
FallbackTriggeredError
  = deps.callModel() 抛出来
  = queryLoop catch 到以后切 currentModel，然后重试当前 API 请求

streamingFallbackOccured
  = 底层流式过程里发生了 streaming -> non-streaming 或模型切换
  = queryLoop 会 tombstone 已经 yield 出去的半截 assistant 消息
```

你看到这段时：

```ts
let currentModel = getRuntimeMainLoopModel(...)
let attemptWithFallback = true
```

可以理解成：

```text
currentModel
  = 这一轮 API 请求当前打算用哪个模型

fallbackModel
  = 如果当前模型触发 fallback，允许切到哪个备用模型

attemptWithFallback
  = 当前 while(attemptWithFallback) 是否还要再尝试一次
```

#### `querySource`

`querySource` 标记这次 query 是从哪里发起的。

常见值包括：

```text
sdk
repl_main_thread
agent:...
compact
session_memory
side_question
```

它后面会影响很多判断：

```text
是否持久化 content replacement
是否启用 agentic query beta
是否跳过某些 compact 阻断
是否作为主线程消费 queued commands
prompt cache / telemetry / analytics 如何打标签
```

比如这次从 `QueryEngine` 进来时是：

```ts
querySource: 'sdk'
```

所以后面判断主线程时会命中：

```ts
const isMainThread =
  querySource.startsWith('repl_main_thread') || querySource === 'sdk'
```

它不是给模型看的业务字段，而是给客户端内部判断用的标签。

例如：

```text
querySource === 'sdk'
  -> 表示这是 headless/SDK 路径进来的主线程 query
  -> queued prompt 可以被主线程消费

querySource.startsWith('agent:')
  -> 表示这是子 agent / sidechain 里的 query
  -> content replacement 持久化位置、queued command 过滤规则会不同

querySource === 'compact'
  -> 表示这是 compact 相关 fork query
  -> 某些 prompt-too-long 预阻塞不能在这里触发，否则 compact 自己没法跑
```

#### `maxTurns`

`maxTurns` 限制的是一次 `query()` 内部最多能进行多少轮模型-工具循环。

它不是 transcript 里的历史轮数。

例如：

```ts
maxTurns = 3
```

可能发生：

```text
turn 1: 模型调用 Read
turn 2: 模型调用 Grep
turn 3: 模型调用 Bash
turn 4: 准备继续时发现超过 maxTurns
  -> yield attachment({ type: 'max_turns_reached' })
  -> return { reason: 'max_turns' }
```

所以它限制的是 agent 在这次请求里自己递归行动的次数。

#### `skipCacheWrite`

`skipCacheWrite` 会被继续传到 API 层：

```ts
skipCacheWrite,
```

之后 `queryModel()` 在构造 API 参数和 prompt cache breakpoint 时会用到它。

直观理解：

```text
正常情况下：这次请求可以参与 prompt cache 写入
skipCacheWrite=true：这次请求尽量不要写入 prompt cache
```

它不改变模型回答逻辑，主要影响 API 请求的缓存行为。

#### `taskBudget`

`taskBudget` 是 API 侧的任务预算。

类型是：

```ts
taskBudget?: { total: number }
```

它和 `TOKEN_BUDGET` 那套本地 continuation 不是一回事。

这里的 `taskBudget` 会一路传给 `queryModel()`，最后变成 API 请求里的：

```ts
output_config.task_budget
```

如果中间发生 compact，`queryLoop()` 还会维护：

```ts
taskBudgetRemaining
```

因为 compact 后，服务器看不到 compact 前已经花掉的完整上下文，客户端要把剩余额度算出来传过去。

#### `deps`

`deps` 是 `queryLoop()` 的依赖注入包。

它不是业务数据，而是一组“外部能力函数”：

```ts
export type QueryDeps = {
  callModel: typeof queryModelWithStreaming
  microcompact: typeof microcompactMessages
  autocompact: typeof autoCompactIfNeeded
  uuid: () => string
}
```

生产环境里如果 `params.deps` 没传，就走：

```ts
const deps = params.deps ?? productionDeps()
```

而 `productionDeps()` 返回：

```ts
{
  callModel: queryModelWithStreaming,
  microcompact: microcompactMessages,
  autocompact: autoCompactIfNeeded,
  uuid: randomUUID,
}
```

所以你可以把 `deps` 理解成：

```text
queryLoop 需要调模型、做 compact、生成 uuid
但 queryLoop 自己不直接硬编码这些实现
而是从 deps 里拿
```

这样测试时可以传假的：

```ts
deps = {
  callModel: fakeModelThatYieldsToolUse,
  microcompact: fakeNoopMicrocompact,
  autocompact: fakeNoopAutocompact,
  uuid: () => 'fixed-id',
}
```

这能让测试不真的请求模型、不真的跑 compact，也能稳定断言 `queryLoop()` 的状态机行为。

`deps` 里面 4 个函数在 `queryLoop()` 的落点如下：

```text
deps.uuid()
  -> 第一次生成 queryTracking.chainId
  -> compact 成功后生成新的 autoCompactTracking.turnId

deps.microcompact(...)
  -> 在每轮 API 请求前，先尝试轻量压缩 messagesForQuery
  -> 输入是当前 messagesForQuery / toolUseContext / querySource
  -> 输出是新的 messagesForQuery 和可选 pendingCacheEdits

deps.autocompact(...)
  -> 在 microcompact / context collapse 之后，判断是否需要完整 compact
  -> 如果 compact 成功，会 yield compact boundary/summary/attachment
  -> 然后当前这一轮 API 请求直接改用 compact 后的 postCompactMessages

deps.callModel(...)
  -> 真正进入模型调用层
  -> 生产环境就是 queryModelWithStreaming()
  -> queryLoop 用 for await 消费它吐出的 assistant / stream_event / error message
```

所以 `deps` 不是“神秘对象”，它只是把几个外部能力函数挂在一起：

```text
生成 id
压缩上下文
调用模型
```

测试里替换它，主要是为了控制这些外部能力，不让测试真的依赖模型、token 估算、随机 UUID。

### 2.2 `State` 变量词典

`State` 的源码类型在 `src/query.ts`：

```ts
type State = {
  messages: Message[]
  toolUseContext: ToolUseContext
  autoCompactTracking: AutoCompactTrackingState | undefined
  maxOutputTokensRecoveryCount: number
  hasAttemptedReactiveCompact: boolean
  maxOutputTokensOverride: number | undefined
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined
  stopHookActive: boolean | undefined
  turnCount: number
  transition: Continue | undefined
}
```

#### `state.messages`

它保存“下一轮 while 开始时要处理的消息历史”。

第一轮来自：

```ts
messages: params.messages
```

如果模型没有调用工具，通常不会构造下一轮 `state`，而是直接 `return { reason: 'completed' }`。

如果模型调用了工具，下一轮来自：

```ts
messages: [...messagesForQuery, ...assistantMessages, ...toolResults]
```

模拟：

```ts
// 第一轮开始
state.messages = [
  user('帮我看 src/query.ts')
]

// 第一轮模型要读文件
assistantMessages = [
  assistant(tool_use Read('src/query.ts'))
]

// 工具返回结果
toolResults = [
  user(tool_result for Read)
]

// 第二轮开始前
state.messages = [
  user('帮我看 src/query.ts'),
  assistant(tool_use Read('src/query.ts')),
  user(tool_result for Read),
]
```

注意 `messagesForQuery` 是这一轮从 `state.messages` 派生出来的临时变量。它可能比 `state.messages` 少，因为 compact boundary 之前的旧消息会被裁掉，也可能被 compact 改写成 summary。

#### `state.toolUseContext`

它保存下一轮工具执行要继续使用的运行环境。

第一轮来自：

```ts
toolUseContext: params.toolUseContext
```

每轮顶部会先拿出来：

```ts
let { toolUseContext } = state
```

这里用 `let`，因为本轮内部会改它：

```ts
toolUseContext = {
  ...toolUseContext,
  queryTracking,
}
```

工具执行阶段也可能返回新上下文：

```ts
if (update.newContext) {
  updatedToolUseContext = {
    ...update.newContext,
    queryTracking,
  }
}
```

最后下一轮保存：

```ts
toolUseContext: toolUseContextWithQueryTracking
```

所以 `toolUseContext` 是“运行环境接力棒”，不是静态配置。

#### `state.autoCompactTracking`

它记录 autocompact 的连续状态。

常见形状：

```ts
autoCompactTracking = {
  compacted: true,
  turnId: 'uuid-after-compact',
  turnCounter: 0,
  consecutiveFailures: 0,
}
```

它主要给 `deps.autocompact()` 用：

```ts
const { compactionResult, consecutiveFailures } = await deps.autocompact(
  messagesForQuery,
  toolUseContext,
  cacheSafeParams,
  querySource,
  tracking,
  snipTokensFreed,
)
```

如果 compact 成功：

```ts
tracking = {
  compacted: true,
  turnId: deps.uuid(),
  turnCounter: 0,
  consecutiveFailures: 0,
}
```

如果后面经历了一轮工具调用：

```ts
tracking.turnCounter++
```

所以它回答的是：

```text
最近有没有 compact 过？
compact 后又过了几轮？
autocompact 连续失败了几次？
```

#### `state.maxOutputTokensRecoveryCount`

它记录 `max_output_tokens` 恢复已经尝试了几次。

场景是：模型回答被输出 token 上限截断，`queryLoop()` 不马上把错误抛给用户，而是尝试继续。

第一次可能先提高 `maxOutputTokensOverride`：

```ts
transition: { reason: 'max_output_tokens_escalate' }
```

后面会追加一条隐藏 meta user message：

```ts
createUserMessage({
  content: 'Output token limit hit. Resume directly ...',
  isMeta: true,
})
```

然后：

```ts
maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1
```

它避免无限重试。

#### `state.hasAttemptedReactiveCompact`

它记录 reactive compact 是否已经试过。

场景是：API 返回 prompt-too-long 或媒体过大错误。

如果还没试过：

```ts
reactiveCompact.tryReactiveCompact(...)
```

如果成功：

```ts
hasAttemptedReactiveCompact: true
transition: { reason: 'reactive_compact_retry' }
```

如果下一轮还是太长，就不能无限 compact 下去，要把错误释放出来。

#### `state.maxOutputTokensOverride`

它是下一次模型请求的临时 `max_tokens` 覆盖值。

默认是：

```ts
maxOutputTokensOverride: params.maxOutputTokensOverride
```

如果触发输出上限恢复，可能变成：

```ts
maxOutputTokensOverride: ESCALATED_MAX_TOKENS
```

然后在 `deps.callModel()` 里传下去：

```ts
options: {
  maxOutputTokensOverride,
}
```

注意它不是永久改配置，只是当前恢复路径的一次请求覆盖。

#### `state.pendingToolUseSummary`

它保存“上一轮工具执行摘要”的后台 Promise。

工具跑完后，`queryLoop()` 可能发起：

```ts
nextPendingToolUseSummary = generateToolUseSummary(...).then(...)
```

但它不阻塞马上进入下一轮模型调用。

下一轮模型流结束后再消费：

```ts
if (pendingToolUseSummary) {
  const summary = await pendingToolUseSummary
  if (summary) {
    yield summary
  }
}
```

这是一种延迟优化：

```text
工具摘要生成大约要一段时间
下一轮模型流本来也要一段时间
所以把摘要生成藏在下一轮模型流期间跑
```

#### `state.stopHookActive`

它记录当前是否处于 stop hook 阻塞后的重试链。

如果模型正常结束，没有工具调用，会跑：

```ts
handleStopHooks(...)
```

如果 hook 返回 blocking errors，`queryLoop()` 会把这些错误塞回 messages，然后继续：

```ts
stopHookActive: true
transition: { reason: 'stop_hook_blocking' }
```

下一轮 `handleStopHooks()` 再看到 `stopHookActive`，就知道这是 hook 触发后的续跑，不是普通结束。

#### `state.turnCount`

它记录当前 query 内部第几轮模型-工具循环。

第一轮：

```ts
turnCount: 1
```

只要有 `tool_use` 并准备继续：

```ts
const nextTurnCount = turnCount + 1
```

然后检查：

```ts
if (maxTurns && nextTurnCount > maxTurns) {
  return { reason: 'max_turns', turnCount: nextTurnCount }
}
```

所以 `turnCount` 不是用户对话历史里的第几轮，而是当前一次 `query()` 里面 agent 自己连续行动了几轮。

#### `state.transition`

它记录“上一次为什么会 continue 到当前这一轮”。

第一轮是：

```ts
transition: undefined
```

后面可能是：

```ts
{ reason: 'next_turn' }
{ reason: 'reactive_compact_retry' }
{ reason: 'collapse_drain_retry', committed: 2 }
{ reason: 'max_output_tokens_escalate' }
{ reason: 'max_output_tokens_recovery', attempt: 1 }
{ reason: 'stop_hook_blocking' }
{ reason: 'token_budget_continuation' }
```

它主要有两个价值：

```text
1. 让恢复逻辑知道上一轮已经做过什么，避免重复做同一个恢复动作
2. 让测试可以断言某条恢复路径确实发生过，而不用解析 message 文本
```

例如 prompt-too-long 时，context collapse drain 只允许先试一次：

```ts
state.transition?.reason !== 'collapse_drain_retry'
```

如果上一轮已经 drain 过，这一轮再遇到 413，就不要继续 drain，而是走 reactive compact 或释放错误。

#### `taskBudgetRemaining`

它不在 `State` 里，但你应该一起看。

源码里是：

```ts
let taskBudgetRemaining: number | undefined = undefined
```

它记录 API task budget 在 compact 后还剩多少。

为什么不放 `State`？源码注释已经说了：如果放进去，所有 `state = next` 的 continue 分支都要跟着传它，改动面会变大。

它只在 compact 相关路径更新：

```ts
taskBudgetRemaining = Math.max(
  0,
  (taskBudgetRemaining ?? params.taskBudget.total) - preCompactContext,
)
```

然后在模型请求里传下去：

```ts
taskBudget: {
  total: params.taskBudget.total,
  ...(taskBudgetRemaining !== undefined && {
    remaining: taskBudgetRemaining,
  }),
}
```

所以它是一个 loop-local 变量：

```text
跨 while 迭代存在
但不通过 State 接力
只服务 task_budget + compact 这条链路
```

### 2.3 把开头那几行带入模拟数据

你前面卡住的代码是这一段：

```ts
const {
  systemPrompt,
  userContext,
  systemContext,
  canUseTool,
  fallbackModel,
  querySource,
  maxTurns,
  skipCacheWrite,
} = params
const deps = params.deps ?? productionDeps()
```

它只是 JavaScript/TypeScript 的对象解构。

如果 `params` 长这样：

```ts
params = {
  messages: [
    user('帮我解释 queryLoop')
  ],
  systemPrompt: [
    'You are Claude Code...',
    'Use tools carefully...',
  ],
  userContext: {
    cwd: '/home/zhangxuan/project/ai/claude-code',
    today: '2026-05-06',
  },
  systemContext: {
    platform: 'linux',
    shell: 'bash',
  },
  canUseTool: wrappedCanUseTool,
  toolUseContext: processUserInputContext,
  fallbackModel: 'claude-haiku-x',
  querySource: 'sdk',
  maxTurns: 10,
  skipCacheWrite: false,
  taskBudget: { total: 200000 },
  deps: undefined,
}
```

执行完解构后，局部变量变成：

```ts
systemPrompt = [
  'You are Claude Code...',
  'Use tools carefully...',
]

userContext = {
  cwd: '/home/zhangxuan/project/ai/claude-code',
  today: '2026-05-06',
}

systemContext = {
  platform: 'linux',
  shell: 'bash',
}

canUseTool = wrappedCanUseTool
fallbackModel = 'claude-haiku-x'
querySource = 'sdk'
maxTurns = 10
skipCacheWrite = false
```

然后这一句：

```ts
const deps = params.deps ?? productionDeps()
```

因为 `params.deps` 是 `undefined`，所以结果是：

```ts
deps = {
  callModel: queryModelWithStreaming,
  microcompact: microcompactMessages,
  autocompact: autoCompactIfNeeded,
  uuid: randomUUID,
}
```

接下来 `queryLoop()` 又初始化 `state`：

```ts
state = {
  messages: params.messages,
  toolUseContext: params.toolUseContext,
  maxOutputTokensOverride: params.maxOutputTokensOverride,
  autoCompactTracking: undefined,
  stopHookActive: undefined,
  maxOutputTokensRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
  turnCount: 1,
  pendingToolUseSummary: undefined,
  transition: undefined,
}
```

这时要注意一个分界：

```text
局部 const 变量
  systemPrompt / userContext / systemContext / canUseTool / fallbackModel / querySource / maxTurns / skipCacheWrite / deps
  = 本次 queryLoop 的固定输入和外部能力

state
  messages / toolUseContext / turnCount / recovery 标记
  = 每轮 while(true) 可能被改写的接力状态
```

所以不是“把 params 全部复制一遍”。

`messages` 和 `toolUseContext` 没有被上面那段 const 解构出来，因为它们要进入 `state`，后面每轮可能变。

`systemPrompt` 没进 `state`，因为工具结果不会改变系统提示词。

`deps` 没进 `state`，因为它是一组函数，不是每轮变化的数据。

### 2.4 再回到源码块

有了上面这些对象的概念，再看源码就不会只看到一堆名字。

```ts
async function* queryLoop(
  params: QueryParams,
  // 这是一个“输出参数”风格的数组，queryLoop 在内部把实际消费的 command.uuid 推进去，
  // 外层 query() 在正常 return 后再统一补 completed。
  consumedCommandUuids: string[],
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
> {
  // 从 params 里拿出整次 queryLoop 都会复用的输入。
  // 这些值是 QueryEngine 调 query() 时传进来的“起始配置”。
  // 它们不是这一轮模型临时吐出来的结果，也不是工具执行后的结果。
  // 下面 while(true) 可能跑很多次，但这些名字不会在每轮末尾通过 state 接力重写。
  const {
    // 给模型的基础系统提示词数组。
    // 后面会和 systemContext 拼成 fullSystemPrompt，再传给 deps.callModel()。
    systemPrompt,
    // 给用户侧补充的环境对象，例如 cwd、日期、平台。
    // 它不是 params.messages 里的普通 user message，发 API 前才由 prependUserContext() 拼进去。
    userContext,
    // 给系统侧补充的环境对象。
    // 后面通过 appendSystemContext(systemPrompt, systemContext) 进入 system prompt。
    systemContext,
    // 工具真正执行前的权限裁决函数。
    // 模型产生 tool_use 后，runTools()/runToolUse() 会拿它判断能不能真的执行。
    canUseTool,
    // 主模型触发 fallback 时使用的备用模型名。
    // 没有 fallback 发生时，它只是一路传下去，不参与普通请求。
    fallbackModel,
    // 标记这次 query 来自 sdk / repl_main_thread / agent / compact 等来源。
    // 后面 queued command、compact 阻断、telemetry 都会看这个标签。
    querySource,
    // 限制这次 query 内部最多连续跑多少轮“模型 -> 工具 -> 模型”。
    // 它不是历史会话轮数。
    maxTurns,
    // 传给 API 层，影响 prompt cache 写入行为。
    // 它不改变模型推理内容，主要影响缓存策略。
    skipCacheWrite,
  } = params
  // deps 是依赖注入包。
  // 正常运行时 params.deps 通常是 undefined，于是 productionDeps() 提供真实实现：
  //   callModel     -> queryModelWithStreaming
  //   microcompact  -> microcompactMessages
  //   autocompact   -> autoCompactIfNeeded
  //   uuid          -> randomUUID
  // 测试时可以传假的 deps，让 queryLoop 不真的请求模型、不真的压缩、不生成随机 id。
  const deps = params.deps ?? productionDeps()

  // state 才是循环真正的“内脏”。
  // 它代表当前 query 迭代到哪一步、下轮重试要带什么、恢复逻辑已经尝试过哪些分支。
  let state: State = {
    messages: params.messages,
    toolUseContext: params.toolUseContext,
    maxOutputTokensOverride: params.maxOutputTokensOverride,
    autoCompactTracking: undefined,
    stopHookActive: undefined,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    turnCount: 1,
    pendingToolUseSummary: undefined,
    transition: undefined,
  }

  // token budget 是整个 query 期间跨轮累积的，所以放在 while 外。
  const budgetTracker = feature('TOKEN_BUDGET') ? createBudgetTracker() : null

  // task_budget.remaining 不放进 State，是为了避免所有 continue 分支都得改一遍。
  // 这也是一个很典型的工程折中：逻辑上是跨轮状态，但实现上尽量减少 continue site 负担。
  let taskBudgetRemaining: number | undefined = undefined

  // QueryConfig 把一批“进入 query 时就固定”的运行态快照下来。
  // 注意 feature() gate 不直接塞这里，是故意的。
  const config = buildQueryConfig()

  // 相关 memory 预取只启动一次，尽量和模型流、工具执行并行隐藏延迟。
  // using 确保无论正常 return、throw，还是生成器被关掉，资源都能在退出时释放。
  using pendingMemoryPrefetch = startRelevantMemoryPrefetch(
    state.messages,
    state.toolUseContext,
  )

  // queryLoop 的主循环。
  // 每一次 while 迭代，基本都对应“一次 API 请求 + 一批工具结果 + 是否继续下一轮”的决策。
  while (true) {
    // 每轮开始，把 state 解构成局部变量。
    // 这样下面代码读起来会更像“顺序逻辑”，而不是一直 state.xxx。
    let { toolUseContext } = state
    const {
      messages,
      autoCompactTracking,
      maxOutputTokensRecoveryCount,
      hasAttemptedReactiveCompact,
      maxOutputTokensOverride,
      pendingToolUseSummary,
      stopHookActive,
      turnCount,
    } = state

    // skill discovery 也是预取式的：
    // 在模型流式输出和工具执行期间，尽量把技能发现异步跑掉。
    const pendingSkillPrefetch = skillPrefetch?.startSkillDiscoveryPrefetch(
      null,
      messages,
      toolUseContext,
    )

    // 每轮 API 调用开始前，先向上层发一个 stream_request_start。
    yield { type: 'stream_request_start' }

    queryCheckpoint('query_fn_entry')

    // 顶层 query 用它做 headless 时延观测；subagent 不记。
    if (!toolUseContext.agentId) {
      headlessProfilerCheckpoint('query_started')
    }

    // queryTracking 记录当前 query chain 的深度。
    // 同一条 query 链继续 follow-up 时 depth 会累加。
    const queryTracking = toolUseContext.queryTracking
      ? {
          chainId: toolUseContext.queryTracking.chainId,
          depth: toolUseContext.queryTracking.depth + 1,
        }
      : {
          chainId: deps.uuid(),
          depth: 0,
        }

    const queryChainIdForAnalytics =
      queryTracking.chainId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

    // 把 queryTracking 塞回当前轮的 toolUseContext。
    toolUseContext = {
      ...toolUseContext,
      queryTracking,
    }

    // 从 compact boundary 之后开始看，边界之前的旧消息这一轮不再直接参与 prompt。
    let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]

    // autocompact 相关 tracking 每轮从 state 接力下来。
    let tracking = autoCompactTracking

    // 在真正 compact 前，先做 tool result budget。
    // 这是“单条消息太大”的治理，不是“整个上下文太大”的治理。
    const persistReplacements =
      querySource.startsWith('agent:') ||
      querySource.startsWith('repl_main_thread')
    messagesForQuery = await applyToolResultBudget(
      messagesForQuery,
      toolUseContext.contentReplacementState,
      persistReplacements
        ? records =>
            void recordContentReplacement(
              records,
              toolUseContext.agentId,
            ).catch(logError)
        : undefined,
      new Set(
        toolUseContext.options.tools
          .filter(t => !Number.isFinite(t.maxResultSizeChars))
          .map(t => t.name),
      ),
    )

    // snip 和 microcompact、autocompact 不是一回事。
    // snip 更像历史瘦身；autocompact 更像“大总结重写”。
    let snipTokensFreed = 0
    if (feature('HISTORY_SNIP')) {
      queryCheckpoint('query_snip_start')
      const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
      messagesForQuery = snipResult.messages
      snipTokensFreed = snipResult.tokensFreed
      if (snipResult.boundaryMessage) {
        yield snipResult.boundaryMessage
      }
      queryCheckpoint('query_snip_end')
    }

    // microcompact 继续做更轻量的压缩。
    queryCheckpoint('query_microcompact_start')
    const microcompactResult = await deps.microcompact(
      messagesForQuery,
      toolUseContext,
      querySource,
    )
    messagesForQuery = microcompactResult.messages
    const pendingCacheEdits = feature('CACHED_MICROCOMPACT')
      ? microcompactResult.compactionInfo?.pendingCacheEdits
      : undefined
    queryCheckpoint('query_microcompact_end')

    // context collapse 再投影一次“折叠后的上下文视图”。
    // 它优先于 autocompact，尽量保留更细粒度的上下文，而不是一下子压成大摘要。
    if (feature('CONTEXT_COLLAPSE') && contextCollapse) {
      const collapseResult = await contextCollapse.applyCollapsesIfNeeded(
        messagesForQuery,
        toolUseContext,
        querySource,
      )
      messagesForQuery = collapseResult.messages
    }

    // systemPrompt + systemContext 组合成真正要送给模型的 system prompt。
    const fullSystemPrompt = asSystemPrompt(
      appendSystemContext(systemPrompt, systemContext),
    )

    // 到这里才做 autocompact。
    queryCheckpoint('query_autocompact_start')
    const { compactionResult, consecutiveFailures } = await deps.autocompact(
      messagesForQuery,
      toolUseContext,
      {
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        forkContextMessages: messagesForQuery,
      },
      querySource,
      tracking,
      snipTokensFreed,
    )
    queryCheckpoint('query_autocompact_end')

    // 如果真的 compact 了，这一轮的 messagesForQuery 就被替换成 compact 后的版本。
    if (compactionResult) {
      const {
        preCompactTokenCount,
        postCompactTokenCount,
        truePostCompactTokenCount,
        compactionUsage,
      } = compactionResult

      logEvent('tengu_auto_compact_succeeded', {
        originalMessageCount: messages.length,
        compactedMessageCount:
          compactionResult.summaryMessages.length +
          compactionResult.attachments.length +
          compactionResult.hookResults.length,
        preCompactTokenCount,
        postCompactTokenCount,
        truePostCompactTokenCount,
        compactionInputTokens: compactionUsage?.input_tokens,
        compactionOutputTokens: compactionUsage?.output_tokens,
        compactionCacheReadTokens:
          compactionUsage?.cache_read_input_tokens ?? 0,
        compactionCacheCreationTokens:
          compactionUsage?.cache_creation_input_tokens ?? 0,
        compactionTotalTokens: compactionUsage
          ? compactionUsage.input_tokens +
            (compactionUsage.cache_creation_input_tokens ?? 0) +
            (compactionUsage.cache_read_input_tokens ?? 0) +
            compactionUsage.output_tokens
          : 0,
        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })

      // 如果启用了 task_budget，这里要把 compact 前那部分已花掉的上下文预算扣掉。
      if (params.taskBudget) {
        const preCompactContext =
          finalContextTokensFromLastResponse(messagesForQuery)
        taskBudgetRemaining = Math.max(
          0,
          (taskBudgetRemaining ?? params.taskBudget.total) - preCompactContext,
        )
      }

      // compact 成功后，tracking 也要重置到“新的 compact 世代”。
      tracking = {
        compacted: true,
        turnId: deps.uuid(),
        turnCounter: 0,
        consecutiveFailures: 0,
      }

      const postCompactMessages = buildPostCompactMessages(compactionResult)

      // compact 产生的 boundary / summary / attachment 会立刻向上层 yield。
      for (const message of postCompactMessages) {
        yield message
      }

      messagesForQuery = postCompactMessages
    } else if (consecutiveFailures !== undefined) {
      // 如果 autocompact 自己失败了，也要把连续失败次数带到下一轮，
      // 否则恢复逻辑可能无限重试。
      tracking = {
        ...(tracking ?? { compacted: false, turnId: '', turnCounter: 0 }),
        consecutiveFailures,
      }
    }

    // 当前轮最终送模型的消息，也写回 toolUseContext.messages。
    toolUseContext = {
      ...toolUseContext,
      messages: messagesForQuery,
    }
```

把 `while(true)` 顶部单独拆开看，会更清楚：

```ts
let { toolUseContext } = state
const {
  messages,
  autoCompactTracking,
  maxOutputTokensRecoveryCount,
  hasAttemptedReactiveCompact,
  maxOutputTokensOverride,
  pendingToolUseSummary,
  stopHookActive,
  turnCount,
} = state
```

这里不是在创建新业务对象，只是从 `state` 里取本轮要用的值。

`toolUseContext` 单独用 `let`，因为本轮中间会重新赋值：

```ts
toolUseContext = {
  ...toolUseContext,
  queryTracking,
}
```

后面还会写：

```ts
toolUseContext = {
  ...toolUseContext,
  messages: messagesForQuery,
}
```

其他字段用 `const`，不是说它们永远不变，而是“在当前这一轮局部代码里不直接改这个变量名”。如果要进入下一轮，会重新构造一个 `next: State`：

```ts
const next: State = {
  messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
  toolUseContext: toolUseContextWithQueryTracking,
  autoCompactTracking: tracking,
  turnCount: nextTurnCount,
  ...
}
state = next
continue
```

所以变量变化不是这样：

```ts
messages.push(...)
turnCount++
```

而是这样：

```text
旧 state
  -> 本轮局部变量
  -> 算出 next State
  -> state = next
  -> while 下一轮重新解构
```

拿一轮工具调用模拟：

```text
while 第 1 轮顶部
  state.turnCount = 1
  messages = [user("分析 query.ts")]

模型输出
  assistantMessages = [assistant(tool_use Read)]
  toolResults = [user(tool_result Read)]

构造 next
  next.turnCount = 2
  next.messages = [user, assistant(tool_use), user(tool_result)]

while 第 2 轮顶部
  const { messages, turnCount } = state
  messages = [user, assistant(tool_use), user(tool_result)]
  turnCount = 2
```

这就是为什么读这段时一定要区分：

```text
params
  外层传入，不随着 while 接力

state
  while 之间的接力对象

本轮局部变量
  从 state 解构出来，方便本轮代码读写
```

这一大段做的其实是：

```text
把“这一轮要给模型看的上下文”准备出来
```

重点别看散：

```text
messages
  -> compact boundary 后半段
  -> tool result budget
  -> snip
  -> microcompact
  -> context collapse
  -> autocompact
  -> messagesForQuery
```

也就是说，真正喂给模型的不是原始 transcript，而是被这一串预处理过后的 `messagesForQuery`。

---

## 3. 模型流主循环：`deps.callModel()`、withhold、tool_use 收集、streaming tool execution

到这里才开始真正“问模型”。

这一段你要抓 4 个数组/变量：

```text
assistantMessages = 模型这轮吐出来的 assistant 消息
toolUseBlocks     = assistant 里的 tool_use 块
toolResults       = 已经拿到的工具结果 / attachment
needsFollowUp     = 这轮结束后是否还要继续下一轮
```

```ts
    // assistantMessages 存这一轮模型吐出的 assistant 片段。
    const assistantMessages: AssistantMessage[] = []
    // toolResults 存这一轮产生的 user/tool_result/attachment 等“回喂模型”的结果。
    const toolResults: (UserMessage | AttachmentMessage)[] = []
    // tool_use 的真实判断不能完全依赖 stop_reason，所以这里自己收集。
    const toolUseBlocks: ToolUseBlock[] = []
    let needsFollowUp = false

    queryCheckpoint('query_setup_start')
    const useStreamingToolExecution = config.gates.streamingToolExecution

    // 开流之前就先准备好 StreamingToolExecutor。
    // 它的意义是：assistant 流里只要冒出 tool_use，就可以立即开跑工具，
    // 不用等整个 assistant 全流完。
    let streamingToolExecutor = useStreamingToolExecution
      ? new StreamingToolExecutor(
          toolUseContext.options.tools,
          canUseTool,
          toolUseContext,
        )
      : null

    const appState = toolUseContext.getAppState()
    const permissionMode = appState.toolPermissionContext.mode
    let currentModel = getRuntimeMainLoopModel({
      permissionMode,
      mainLoopModel: toolUseContext.options.mainLoopModel,
      exceeds200kTokens:
        permissionMode === 'plan' &&
        doesMostRecentAssistantMessageExceed200k(messagesForQuery),
    })

    queryCheckpoint('query_setup_end')

    // dumpPromptsFetch 是一个抓请求体的 fetch 包装器，这里做成每次 query 一个，
    // 避免长会话里闭包把所有历史 request body 都留住。
    const dumpPromptsFetch = config.gates.isAnt
      ? createDumpPromptsFetch(toolUseContext.agentId ?? config.sessionId)
      : undefined

    // 这里是“硬阻塞阈值”防线：
    // 当自动 compact 关闭，且 prompt 已经大到没法继续时，直接报错返回。
    let collapseOwnsIt = false
    if (feature('CONTEXT_COLLAPSE')) {
      collapseOwnsIt =
        (contextCollapse?.isContextCollapseEnabled() ?? false) &&
        isAutoCompactEnabled()
    }

    const mediaRecoveryEnabled =
      reactiveCompact?.isReactiveCompactEnabled() ?? false

    if (
      !compactionResult &&
      querySource !== 'compact' &&
      querySource !== 'session_memory' &&
      !(
        reactiveCompact?.isReactiveCompactEnabled() && isAutoCompactEnabled()
      ) &&
      !collapseOwnsIt
    ) {
      const { isAtBlockingLimit } = calculateTokenWarningState(
        tokenCountWithEstimation(messagesForQuery) - snipTokensFreed,
        toolUseContext.options.mainLoopModel,
      )
      if (isAtBlockingLimit) {
        yield createAssistantAPIErrorMessage({
          content: PROMPT_TOO_LONG_ERROR_MESSAGE,
          error: 'invalid_request',
        })
        return { reason: 'blocking_limit' }
      }
    }

    // 一个 query 迭代里，可能先用主模型跑，随后触发 fallback 再重跑同一轮。
    let attemptWithFallback = true

    queryCheckpoint('query_api_loop_start')
    try {
      while (attemptWithFallback) {
        attemptWithFallback = false
        try {
          let streamingFallbackOccured = false
          queryCheckpoint('query_api_streaming_start')

          // 这里开始真正发模型请求。
          // 注意 userContext 不是塞进 system prompt，而是 prepend 到 messages 最前面。
          for await (const message of deps.callModel({
            messages: prependUserContext(messagesForQuery, userContext),
            systemPrompt: fullSystemPrompt,
            thinkingConfig: toolUseContext.options.thinkingConfig,
            tools: toolUseContext.options.tools,
            signal: toolUseContext.abortController.signal,
            options: {
              async getToolPermissionContext() {
                const appState = toolUseContext.getAppState()
                return appState.toolPermissionContext
              },
              model: currentModel,
              ...(config.gates.fastModeEnabled && {
                fastMode: appState.fastMode,
              }),
              toolChoice: undefined,
              isNonInteractiveSession:
                toolUseContext.options.isNonInteractiveSession,
              fallbackModel,
              onStreamingFallback: () => {
                streamingFallbackOccured = true
              },
              querySource,
              agents: toolUseContext.options.agentDefinitions.activeAgents,
              allowedAgentTypes:
                toolUseContext.options.agentDefinitions.allowedAgentTypes,
              hasAppendSystemPrompt:
                !!toolUseContext.options.appendSystemPrompt,
              maxOutputTokensOverride,
              fetchOverride: dumpPromptsFetch,
              mcpTools: appState.mcp.tools,
              hasPendingMcpServers: appState.mcp.clients.some(
                c => c.type === 'pending',
              ),
              queryTracking,
              effortValue: appState.effortValue,
              advisorModel: appState.advisorModel,
              skipCacheWrite,
              agentId: toolUseContext.agentId,
              addNotification: toolUseContext.addNotification,
              ...(params.taskBudget && {
                taskBudget: {
                  total: params.taskBudget.total,
                  ...(taskBudgetRemaining !== undefined && {
                    remaining: taskBudgetRemaining,
                  }),
                },
              }),
              langfuseTrace: toolUseContext.langfuseTrace,
            },
          })) {
            // 如果流式期间切到 fallback，这一轮前面已经吐出来的 assistant 片段就都不可信了。
            // 这时要 tombstone 掉旧片段，并重建工具执行器，避免旧 tool_use_id 泄漏到新响应里。
            if (streamingFallbackOccured) {
              for (const msg of assistantMessages) {
                yield { type: 'tombstone' as const, message: msg }
              }
              logEvent('tengu_orphaned_messages_tombstoned', {
                orphanedMessageCount: assistantMessages.length,
                queryChainId: queryChainIdForAnalytics,
                queryDepth: queryTracking.depth,
              })

              assistantMessages.length = 0
              toolResults.length = 0
              toolUseBlocks.length = 0
              needsFollowUp = false

              if (streamingToolExecutor) {
                streamingToolExecutor.discard()
                streamingToolExecutor = new StreamingToolExecutor(
                  toolUseContext.options.tools,
                  canUseTool,
                  toolUseContext,
                )
              }
            }

            // 这里做一个很细的兼容操作：
            // tool.backfillObservableInput() 可能给 tool_use.input 补充“只对外展示有帮助”的字段。
            // 但是只允许“新增字段”，不允许改已有字段，否则 transcript 哈希会变。
            let yieldMessage: typeof message = message
            if (message.type === 'assistant') {
              const assistantMsg = message as AssistantMessage
              const contentArr = Array.isArray(assistantMsg.message?.content) ? assistantMsg.message.content as unknown as Array<{ type: string; input?: unknown; name?: string; [key: string]: unknown }> : []
              let clonedContent: typeof contentArr | undefined
              for (let i = 0; i < contentArr.length; i++) {
                const block = contentArr[i]!
                if (
                  block.type === 'tool_use' &&
                  typeof block.input === 'object' &&
                  block.input !== null
                ) {
                  const tool = findToolByName(
                    toolUseContext.options.tools,
                    block.name as string,
                  )
                  if (tool?.backfillObservableInput) {
                    const originalInput = block.input as Record<string, unknown>
                    const inputCopy = { ...originalInput }
                    tool.backfillObservableInput(inputCopy)
                    const addedFields = Object.keys(inputCopy).some(
                      k => !(k in originalInput),
                    )
                    if (addedFields) {
                      clonedContent ??= [...contentArr]
                      clonedContent[i] = { ...block, input: inputCopy }
                    }
                  }
                }
              }
              if (clonedContent) {
                yieldMessage = {
                  ...message,
                  message: { ...(assistantMsg.message ?? {}), content: clonedContent },
                } as typeof message
              }
            }

            // recoverable 错误先不要立刻往上游发。
            // 先“暂扣”住，看下面是否还能自动恢复。
            let withheld = false
            if (feature('CONTEXT_COLLAPSE')) {
              if (
                contextCollapse?.isWithheldPromptTooLong(
                  message as Message,
                  isPromptTooLongMessage as (msg: Message) => boolean,
                  querySource,
                )
              ) {
                withheld = true
              }
            }
            if (reactiveCompact?.isWithheldPromptTooLong(message as Message)) {
              withheld = true
            }
            if (
              mediaRecoveryEnabled &&
              reactiveCompact?.isWithheldMediaSizeError(message as Message)
            ) {
              withheld = true
            }
            if (isWithheldMaxOutputTokens(message)) {
              withheld = true
            }

            if (!withheld) {
              yield yieldMessage
            }

            // assistant 消息一边往上游发，一边记入 assistantMessages，并同步提取 tool_use。
            if (message.type === 'assistant') {
              const assistantMessage = message as AssistantMessage
              assistantMessages.push(assistantMessage)

              const msgToolUseBlocks = (Array.isArray(assistantMessage.message?.content) ? assistantMessage.message.content : []).filter(
                (content: { type: string }) => content.type === 'tool_use',
              ) as ToolUseBlock[]
              if (msgToolUseBlocks.length > 0) {
                toolUseBlocks.push(...msgToolUseBlocks)
                needsFollowUp = true
              }

              // 边流边执行工具：有 tool_use 就立刻扔给 StreamingToolExecutor。
              if (
                streamingToolExecutor &&
                !toolUseContext.abortController.signal.aborted
              ) {
                for (const toolBlock of msgToolUseBlocks) {
                  streamingToolExecutor.addTool(toolBlock, assistantMessage)
                }
              }
            }

            // 某些工具如果已经先跑完了，这里就可以把结果直接流给上游，
            // 不需要等整个 assistant 都结束。
            if (
              streamingToolExecutor &&
              !toolUseContext.abortController.signal.aborted
            ) {
              for (const result of streamingToolExecutor.getCompletedResults()) {
                if (result.message) {
                  yield result.message
                  toolResults.push(
                    ...normalizeMessagesForAPI(
                      [result.message],
                      toolUseContext.options.tools,
                    ).filter(_ => _.type === 'user'),
                  )
                }
              }
            }
          }
          queryCheckpoint('query_api_streaming_end')

          // cached microcompact 的 boundary 要等 API 真正返回 usage 后，才能知道删了多少 token。
          if (feature('CACHED_MICROCOMPACT') && pendingCacheEdits) {
            const lastAssistant = assistantMessages.at(-1)
            const usage = lastAssistant?.message.usage
            const cumulativeDeleted = usage
              ? ((usage as unknown as Record<string, number>)
                  .cache_deleted_input_tokens ?? 0)
              : 0
            const deletedTokens = Math.max(
              0,
              cumulativeDeleted - pendingCacheEdits.baselineCacheDeletedTokens,
            )
            if (deletedTokens > 0) {
              yield createMicrocompactBoundaryMessage(
                pendingCacheEdits.trigger,
                0,
                deletedTokens,
                pendingCacheEdits.deletedToolIds,
                [],
              )
            }
          }
        } catch (innerError) {
          // 这一层 catch 只包“本轮流式采样尝试”。
          // 如果是 fallback trigger，就切模型并重试当前轮，而不是结束整个 queryLoop。
          if (innerError instanceof FallbackTriggeredError && fallbackModel) {
            currentModel = fallbackModel
            attemptWithFallback = true

            // 已经吐出来但还没配套 tool_result 的 tool_use，补一个错误结果，避免 transcript 悬空。
            yield* yieldMissingToolResultBlocks(
              assistantMessages,
              'Model fallback triggered',
            )
            assistantMessages.length = 0
            toolResults.length = 0
            toolUseBlocks.length = 0
            needsFollowUp = false

            if (streamingToolExecutor) {
              streamingToolExecutor.discard()
              streamingToolExecutor = new StreamingToolExecutor(
                toolUseContext.options.tools,
                canUseTool,
                toolUseContext,
              )
            }

            // 当前轮主模型已经切掉，toolUseContext 也同步更新。
            toolUseContext.options.mainLoopModel = fallbackModel

            // thinking signature 与模型绑定；切模型后继续重放原签名会 400。
            if (process.env.USER_TYPE === 'ant') {
              messagesForQuery = stripSignatureBlocks(messagesForQuery)
            }

            logEvent('tengu_model_fallback_triggered', {
              original_model:
                innerError.originalModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              fallback_model:
                fallbackModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              entrypoint:
                'cli' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              queryChainId: queryChainIdForAnalytics,
              queryDepth: queryTracking.depth,
            })

            yield createSystemMessage(
              `Switched to ${renderModelName(innerError.fallbackModel)} due to high demand for ${renderModelName(innerError.originalModel)}`,
              'warning',
            )

            continue
          }
          throw innerError
        }
      }
    } catch (error) {
      // 外层 catch 才是“这个 query 真的出故障了”的兜底。
      logError(error)
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      logEvent('tengu_query_error', {
        assistantMessages: assistantMessages.length,
        toolUses: assistantMessages.flatMap(_ =>
          (Array.isArray(_.message?.content) ? _.message.content as Array<{ type: string }> : []).filter(content => content.type === 'tool_use'),
        ).length,
        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })

      if (
        error instanceof ImageSizeError ||
        error instanceof ImageResizeError
      ) {
        yield createAssistantAPIErrorMessage({
          content: error.message,
        })
        return { reason: 'image_error' }
      }

      // 如果已经有 tool_use 但还没等到 tool_result，就在崩溃路径补齐错误结果。
      yield* yieldMissingToolResultBlocks(assistantMessages, errorMessage)

      yield createAssistantAPIErrorMessage({
        content: errorMessage,
      })

      logAntError('Query error', error)
      return { reason: 'model_error', error }
    }
```

这一段是全文最核心的地方。

你可以把它压缩成一句：

```text
queryLoop 一边消费模型流，一边构建“下一轮所需的材料”
```

也就是：

```text
assistant stream
  -> assistantMessages
  -> toolUseBlocks
  -> 已完成 toolResults
  -> needsFollowUp
```

---

## 4. 无 follow-up 分支：abort、withheld 恢复、stop hooks、token budget、return

这里开始分叉：

```text
如果没有 tool_use
  就不进入工具分支
  而是进入“收尾 / 恢复 / 是否直接结束”的路径
```

```ts
    // 采样结束后，先异步触发 post-sampling hooks。
    if (assistantMessages.length > 0) {
      void executePostSamplingHooks(
        [...messagesForQuery, ...assistantMessages],
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        querySource,
      )
    }

    // 流式阶段被 abort，要比任何“正常收尾逻辑”优先处理。
    if (toolUseContext.abortController.signal.aborted) {
      if (streamingToolExecutor) {
        // 这里一定要把剩余结果消费掉，让执行器有机会产出 synthetic tool_result，
        // 否则 transcript 里会留下裸 tool_use。
        for await (const update of streamingToolExecutor.getRemainingResults()) {
          if (update.message) {
            yield update.message
          }
        }
      } else {
        yield* yieldMissingToolResultBlocks(
          assistantMessages,
          'Interrupted by user',
        )
      }

      if (feature('CHICAGO_MCP') && !toolUseContext.agentId) {
        try {
          const { cleanupComputerUseAfterTurn } = await import(
            './utils/computerUse/cleanup.js'
          )
          await cleanupComputerUseAfterTurn(toolUseContext)
        } catch {
          // 非关键路径，失败静默。
        }
      }

      if (toolUseContext.abortController.signal.reason !== 'interrupt') {
        yield createUserInterruptionMessage({
          toolUse: false,
        })
      }
      return { reason: 'aborted_streaming' }
    }

    // 上一轮工具摘要在本轮模型流期间已经后台生成好了，现在补 yield。
    if (pendingToolUseSummary) {
      const summary = await pendingToolUseSummary
      if (summary) {
        yield summary
      }
    }

    // 只有当这一轮没有 tool_use，才走“直接完成 / 恢复 / 停止”的分支。
    if (!needsFollowUp) {
      const lastMessage = assistantMessages.at(-1)

      // 先看是不是被暂扣的 prompt-too-long。
      const isWithheld413 =
        lastMessage?.type === 'assistant' &&
        lastMessage.isApiErrorMessage &&
        isPromptTooLongMessage(lastMessage)

      // 再看是不是媒体过大类错误，也走 reactive compact 恢复链。
      const isWithheldMedia =
        mediaRecoveryEnabled &&
        reactiveCompact?.isWithheldMediaSizeError(lastMessage as Message)

      // prompt-too-long 的第一个恢复动作不是 reactive compact，而是先 drain context collapse。
      if (isWithheld413) {
        if (
          feature('CONTEXT_COLLAPSE') &&
          contextCollapse &&
          state.transition?.reason !== 'collapse_drain_retry'
        ) {
          const drained = contextCollapse.recoverFromOverflow(
            messagesForQuery,
            querySource,
          )
          if (drained.committed > 0) {
            const next: State = {
              messages: drained.messages,
              toolUseContext,
              autoCompactTracking: tracking,
              maxOutputTokensRecoveryCount,
              hasAttemptedReactiveCompact,
              maxOutputTokensOverride: undefined,
              pendingToolUseSummary: undefined,
              stopHookActive: undefined,
              turnCount,
              transition: {
                reason: 'collapse_drain_retry',
                committed: drained.committed,
              },
            }
            state = next
            continue
          }
        }
      }

      // 如果 prompt-too-long 或 media-size 能交给 reactive compact，就尝试完整压缩恢复。
      if ((isWithheld413 || isWithheldMedia) && reactiveCompact) {
        const compacted = await reactiveCompact.tryReactiveCompact({
          hasAttempted: hasAttemptedReactiveCompact,
          querySource,
          aborted: toolUseContext.abortController.signal.aborted,
          messages: messagesForQuery,
          cacheSafeParams: {
            systemPrompt,
            userContext,
            systemContext,
            toolUseContext,
            forkContextMessages: messagesForQuery,
          },
        })

        if (compacted) {
          if (params.taskBudget) {
            const preCompactContext =
              finalContextTokensFromLastResponse(messagesForQuery)
            taskBudgetRemaining = Math.max(
              0,
              (taskBudgetRemaining ?? params.taskBudget.total) -
                preCompactContext,
            )
          }

          const postCompactMessages = buildPostCompactMessages(compacted)
          for (const msg of postCompactMessages) {
            yield msg
          }
          const next: State = {
            messages: postCompactMessages,
            toolUseContext,
            autoCompactTracking: undefined,
            maxOutputTokensRecoveryCount,
            hasAttemptedReactiveCompact: true,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'reactive_compact_retry' },
          }
          state = next
          continue
        }

        // 恢复失败，才真正把 withheld 错误往外抛。
        yield lastMessage!
        void executeStopFailureHooks(lastMessage!, toolUseContext)
        return { reason: isWithheldMedia ? 'image_error' : 'prompt_too_long' }
      } else if (feature('CONTEXT_COLLAPSE') && isWithheld413) {
        // 如果 reactiveCompact 编译掉了，只能直接把 withheld 413 释放出来。
        yield lastMessage
        void executeStopFailureHooks(lastMessage, toolUseContext)
        return { reason: 'prompt_too_long' }
      }

      // 下面是 max_output_tokens 恢复链。
      if (isWithheldMaxOutputTokens(lastMessage)) {
        // 第一步：如果还没提高 cap，就先把当前轮同样请求提升到更高 output token cap 重试。
        const capEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
          'tengu_otk_slot_v1',
          false,
        )
        if (
          capEnabled &&
          maxOutputTokensOverride === undefined &&
          !process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
        ) {
          logEvent('tengu_max_tokens_escalate', {
            escalatedTo: ESCALATED_MAX_TOKENS,
          })
          const next: State = {
            messages: messagesForQuery,
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount,
            hasAttemptedReactiveCompact,
            maxOutputTokensOverride: ESCALATED_MAX_TOKENS,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'max_output_tokens_escalate' },
          }
          state = next
          continue
        }

        // 第二步：如果已经拉高过 cap 或不允许 escalate，就走 meta-message 恢复。
        if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
          const recoveryMessage = createUserMessage({
            content:
              `Output token limit hit. Resume directly — no apology, no recap of what you were doing. ` +
              `Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.`,
            isMeta: true,
          })

          const next: State = {
            messages: [
              ...messagesForQuery,
              ...assistantMessages,
              recoveryMessage,
            ],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount: maxOutputTokensRecoveryCount + 1,
            hasAttemptedReactiveCompact,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: {
              reason: 'max_output_tokens_recovery',
              attempt: maxOutputTokensRecoveryCount + 1,
            },
          }
          state = next
          continue
        }

        // 再不行，只能把 withheld 错误真正发出去。
        yield lastMessage
      }

      // 如果最后一条是 API 错误消息，就不要再跑 stop hooks 了。
      // 否则会进入 error -> hook blocking -> retry -> error 的死循环。
      if (lastMessage?.isApiErrorMessage) {
        void executeStopFailureHooks(lastMessage, toolUseContext)
        return { reason: 'completed' }
      }

      // 正常 assistant 结束后，才允许 stop hooks 检查是否阻止继续。
      const stopHookResult = yield* handleStopHooks(
        messagesForQuery,
        assistantMessages,
        systemPrompt,
        userContext,
        systemContext,
        toolUseContext,
        querySource,
        stopHookActive,
      )

      if (stopHookResult.preventContinuation) {
        return { reason: 'stop_hook_prevented' }
      }

      // stop hook 如果给出 blocking error，就把这些错误消息拼进 messages，继续下一轮。
      if (stopHookResult.blockingErrors.length > 0) {
        const next: State = {
          messages: [
            ...messagesForQuery,
            ...assistantMessages,
            ...stopHookResult.blockingErrors,
          ],
          toolUseContext,
          autoCompactTracking: tracking,
          maxOutputTokensRecoveryCount: 0,
          hasAttemptedReactiveCompact,
          maxOutputTokensOverride: undefined,
          pendingToolUseSummary: undefined,
          stopHookActive: true,
          turnCount,
          transition: { reason: 'stop_hook_blocking' },
        }
        state = next
        continue
      }

      // 最后才轮到 token budget 决策。
      if (feature('TOKEN_BUDGET')) {
        const decision = checkTokenBudget(
          budgetTracker!,
          toolUseContext.agentId,
          getCurrentTurnTokenBudget(),
          getTurnOutputTokens(),
        )

        if (decision.action === 'continue') {
          incrementBudgetContinuationCount()
          logForDebugging(
            `Token budget continuation #${decision.continuationCount}: ${decision.pct}% (${decision.turnTokens.toLocaleString()} / ${decision.budget.toLocaleString()})`,
          )
          state = {
            messages: [
              ...messagesForQuery,
              ...assistantMessages,
              createUserMessage({
                content: decision.nudgeMessage,
                isMeta: true,
              }),
            ],
            toolUseContext,
            autoCompactTracking: tracking,
            maxOutputTokensRecoveryCount: 0,
            hasAttemptedReactiveCompact: false,
            maxOutputTokensOverride: undefined,
            pendingToolUseSummary: undefined,
            stopHookActive: undefined,
            turnCount,
            transition: { reason: 'token_budget_continuation' },
          }
          continue
        }

        if (decision.completionEvent) {
          if (decision.completionEvent.diminishingReturns) {
            logForDebugging(
              `Token budget early stop: diminishing returns at ${decision.completionEvent.pct}%`,
            )
          }
          logEvent('tengu_token_budget_completed', {
            ...decision.completionEvent,
            queryChainId: queryChainIdForAnalytics,
            queryDepth: queryTracking.depth,
          })
        }
      }

      // 走到这里，说明：
      // - 没有 tool_use
      // - 没有需要继续的恢复链
      // - stop hook 没阻断
      // - token budget 也不要求继续
      return { reason: 'completed' }
    }
```

这一段可以压成一个决策树：

```text
没有 tool_use
  |
  +--> 被 abort ? -> return aborted_streaming
  |
  +--> withheld 413/media ? -> 尝试恢复 -> 失败才真正报错
  |
  +--> withheld max_output_tokens ? -> 提 cap / 发 meta message 重试
  |
  +--> API error ? -> 不跑 stop hooks，直接结束
  |
  +--> stop hooks -> 可能阻断 / 可能塞 blocking error 继续
  |
  +--> token budget -> 可能追加 meta user message 再继续
  |
  +--> return completed
```

这就是 `queryLoop()` 为什么像“状态机”而不是“普通函数”的原因。

---

## 5. 有 follow-up 分支：执行工具、补 attachment、memory/skill 注入、构造下一轮 state

只要这一轮 assistant 里收到了 `tool_use`，就会走这里。

```ts
    let shouldPreventContinuation = false
    let updatedToolUseContext = toolUseContext

    queryCheckpoint('query_tool_execution_start')

    // 这里只是打点：本轮有没有启用 streaming tool execution。
    if (streamingToolExecutor) {
      logEvent('tengu_streaming_tool_execution_used', {
        tool_count: toolUseBlocks.length,
        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    } else {
      logEvent('tengu_streaming_tool_execution_not_used', {
        tool_count: toolUseBlocks.length,
        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    }

    // 如果有 StreamingToolExecutor，就把还没来得及吐出的剩余结果 drain 完；
    // 如果没有，就现在串行/批量跑 runTools()。
    const toolUpdates = streamingToolExecutor
      ? streamingToolExecutor.getRemainingResults()
      : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)

    for await (const update of toolUpdates) {
      if (update.message) {
        yield update.message

        // 某些 hook 会用 attachment 明确要求“不要继续下一轮”。
        if (
          update.message.type === 'attachment' &&
          update.message.attachment!.type === 'hook_stopped_continuation'
        ) {
          shouldPreventContinuation = true
        }

        // 工具结果要转成规范化后的 user 消息，才能回喂给下一轮模型。
        toolResults.push(
          ...normalizeMessagesForAPI(
            [update.message],
            toolUseContext.options.tools,
          ).filter(_ => _.type === 'user'),
        )
      }

      // 某些工具会返回更新过的 ToolUseContext，例如 cwd / readFileState / 权限上下文变化等。
      if (update.newContext) {
        updatedToolUseContext = {
          ...update.newContext,
          queryTracking,
        }
      }
    }
    queryCheckpoint('query_tool_execution_end')

    // 工具摘要不是同步阻塞生成，而是这里“火并忘”，让下一轮模型流期间并发完成。
    let nextPendingToolUseSummary:
      | Promise<ToolUseSummaryMessage | null>
      | undefined
    if (
      config.gates.emitToolUseSummaries &&
      toolUseBlocks.length > 0 &&
      !toolUseContext.abortController.signal.aborted &&
      !toolUseContext.agentId
    ) {
      const lastAssistantMessage = assistantMessages.at(-1)
      let lastAssistantText: string | undefined
      if (lastAssistantMessage) {
        const textBlocks = (Array.isArray(lastAssistantMessage.message?.content) ? lastAssistantMessage.message.content as Array<{ type: string; text?: string }> : []).filter(
          block => block.type === 'text',
        )
        if (textBlocks.length > 0) {
          const lastTextBlock = textBlocks.at(-1)
          if (lastTextBlock && 'text' in lastTextBlock) {
            lastAssistantText = lastTextBlock.text
          }
        }
      }

      const toolUseIds = toolUseBlocks.map(block => block.id)
      const toolInfoForSummary = toolUseBlocks.map(block => {
        const toolResult = toolResults.find(
          result =>
            result.type === 'user' &&
            Array.isArray(result.message.content) &&
            result.message.content.some(
              content =>
                content.type === 'tool_result' &&
                content.tool_use_id === block.id,
            ),
        )
        const resultContent =
          toolResult?.type === 'user' &&
          Array.isArray(toolResult.message.content)
            ? toolResult.message.content.find(
                (c): c is ToolResultBlockParam =>
                  c.type === 'tool_result' && c.tool_use_id === block.id,
              )
            : undefined
        return {
          name: block.name,
          input: block.input,
          output:
            resultContent && 'content' in resultContent
              ? resultContent.content
              : null,
        }
      })

      nextPendingToolUseSummary = generateToolUseSummary({
        tools: toolInfoForSummary,
        signal: toolUseContext.abortController.signal,
        isNonInteractiveSession: toolUseContext.options.isNonInteractiveSession,
        lastAssistantText,
      })
        .then(summary => {
          if (summary) {
            return createToolUseSummaryMessage(summary, toolUseIds)
          }
          return null
        })
        .catch(() => null)
    }

    // 如果工具执行中被中断，优先走中断路径，不再继续构造下一轮。
    if (toolUseContext.abortController.signal.aborted) {
      if (feature('CHICAGO_MCP') && !toolUseContext.agentId) {
        try {
          const { cleanupComputerUseAfterTurn } = await import(
            './utils/computerUse/cleanup.js'
          )
          await cleanupComputerUseAfterTurn(toolUseContext)
        } catch {
          // 非关键路径，失败静默。
        }
      }
      if (toolUseContext.abortController.signal.reason !== 'interrupt') {
        yield createUserInterruptionMessage({
          toolUse: true,
        })
      }
      const nextTurnCountOnAbort = turnCount + 1
      if (maxTurns && nextTurnCountOnAbort > maxTurns) {
        yield createAttachmentMessage({
          type: 'max_turns_reached',
          maxTurns,
          turnCount: nextTurnCountOnAbort,
        })
      }
      return { reason: 'aborted_tools' }
    }

    if (shouldPreventContinuation) {
      return { reason: 'hook_stopped' }
    }

    // 如果刚经历过 compact，这里给“compact 后第几轮”记个数。
    if (tracking?.compacted) {
      tracking.turnCounter++
      logEvent('tengu_post_autocompact_turn', {
        turnId:
          tracking.turnId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        turnCounter: tracking.turnCounter,
        queryChainId: queryChainIdForAnalytics,
        queryDepth: queryTracking.depth,
      })
    }

    // 接下来补 attachment。
    // 注意必须在 tool_result 之后做，不能把普通附件插到 tool_result 中间。
    logEvent('tengu_query_before_attachments', {
      messagesForQueryCount: messagesForQuery.length,
      assistantMessagesCount: assistantMessages.length,
      toolResultsCount: toolResults.length,
      queryChainId: queryChainIdForAnalytics,
      queryDepth: queryTracking.depth,
    })

    // queued command 也会在这里被转成 attachment，喂给当前 turn。
    const sleepRan = toolUseBlocks.some(b => b.name === SLEEP_TOOL_NAME)
    const isMainThread =
      querySource.startsWith('repl_main_thread') || querySource === 'sdk'
    const currentAgentId = toolUseContext.agentId
    const queuedCommandsSnapshot = getCommandsByMaxPriority(
      sleepRan ? 'later' : 'next',
    ).filter(cmd => {
      if (isSlashCommand(cmd)) return false
      if (isMainThread) return cmd.agentId === undefined
      return cmd.mode === 'task-notification' && cmd.agentId === currentAgentId
    })

    for await (const attachment of getAttachmentMessages(
      null,
      updatedToolUseContext,
      null,
      queuedCommandsSnapshot,
      [...messagesForQuery, ...assistantMessages, ...toolResults],
      querySource,
    )) {
      yield attachment
      toolResults.push(attachment)
    }

    // 如果 memory prefetch 此时已经完成，就把还没被读/写过的 memory 作为 attachment 注入。
    if (
      pendingMemoryPrefetch &&
      pendingMemoryPrefetch.settledAt !== null &&
      pendingMemoryPrefetch.consumedOnIteration === -1
    ) {
      const memoryAttachments = filterDuplicateMemoryAttachments(
        await pendingMemoryPrefetch.promise,
        toolUseContext.readFileState,
      )
      for (const memAttachment of memoryAttachments) {
        const msg = createAttachmentMessage(memAttachment)
        yield msg
        toolResults.push(msg)
      }
      pendingMemoryPrefetch.consumedOnIteration = turnCount - 1
    }

    // skill discovery 预取结果也在这里转成 attachment。
    if (skillPrefetch && pendingSkillPrefetch) {
      const skillAttachments =
        await skillPrefetch.collectSkillDiscoveryPrefetch(pendingSkillPrefetch)
      for (const att of skillAttachments) {
        const msg = createAttachmentMessage(att)
        yield msg
        toolResults.push(msg)
      }
    }

    // 真正被消费掉的 prompt/task-notification command，才从队列里删掉，并记 started。
    const consumedCommands = queuedCommandsSnapshot.filter(
      cmd => cmd.mode === 'prompt' || cmd.mode === 'task-notification',
    )
    if (consumedCommands.length > 0) {
      for (const cmd of consumedCommands) {
        if (cmd.uuid) {
          consumedCommandUuids.push(cmd.uuid)
          notifyCommandLifecycle(cmd.uuid, 'started')
        }
      }
      removeFromQueue(consumedCommands)
    }

    const fileChangeAttachmentCount = count(
      toolResults,
      tr =>
        tr.type === 'attachment' && tr.attachment.type === 'edited_text_file',
    )

    logEvent('tengu_query_after_attachments', {
      totalToolResultsCount: toolResults.length,
      fileChangeAttachmentCount,
      queryChainId: queryChainIdForAnalytics,
      queryDepth: queryTracking.depth,
    })

    // 工具集在两轮之间允许刷新，尤其是新接上的 MCP server。
    if (updatedToolUseContext.options.refreshTools) {
      const refreshedTools = updatedToolUseContext.options.refreshTools()
      if (refreshedTools !== updatedToolUseContext.options.tools) {
        updatedToolUseContext = {
          ...updatedToolUseContext,
          options: {
            ...updatedToolUseContext.options,
            tools: refreshedTools,
          },
        }
      }
    }

    const toolUseContextWithQueryTracking = {
      ...updatedToolUseContext,
      queryTracking,
    }

    // 走到这里，说明本轮 assistant 产生了工具结果，下一轮就要继续。
    const nextTurnCount = turnCount + 1

    // 顶层会话的 task summary 也在这里周期性触发。
    if (feature('BG_SESSIONS')) {
      if (
        !toolUseContext.agentId &&
        taskSummaryModule!.shouldGenerateTaskSummary()
      ) {
        taskSummaryModule!.maybeGenerateTaskSummary({
          systemPrompt,
          userContext,
          systemContext,
          toolUseContext,
          forkContextMessages: [
            ...messagesForQuery,
            ...assistantMessages,
            ...toolResults,
          ],
        })
      }
    }

    // 继续前最后一道闸：maxTurns。
    if (maxTurns && nextTurnCount > maxTurns) {
      yield createAttachmentMessage({
        type: 'max_turns_reached',
        maxTurns,
        turnCount: nextTurnCount,
      })
      return { reason: 'max_turns', turnCount: nextTurnCount }
    }

    queryCheckpoint('query_recursive_call')

    // 最关键的一句：
    // 下一轮看到的 messages = 这一轮 prompt 上下文 + assistant 输出 + tool / attachment 输出。
    const next: State = {
      messages: [...messagesForQuery, ...assistantMessages, ...toolResults],
      toolUseContext: toolUseContextWithQueryTracking,
      autoCompactTracking: tracking,
      turnCount: nextTurnCount,
      maxOutputTokensRecoveryCount: 0,
      hasAttemptedReactiveCompact: false,
      pendingToolUseSummary: nextPendingToolUseSummary,
      maxOutputTokensOverride: undefined,
      stopHookActive,
      transition: { reason: 'next_turn' },
    }
    state = next
  } // while (true)
}
```

这个分支的本质是：

```text
tool_use 已经发生
  -> 把工具跑完
  -> 把工具结果变成模型下一轮能理解的 messages
  -> 顺便把 attachment / memory / queued command / skill 全补进去
  -> state = next
  -> continue
```

而最关键的一句就是：

```ts
messages: [...messagesForQuery, ...assistantMessages, ...toolResults]
```

这句决定了为什么 agent 可以：

```text
上一轮 assistant 提议调用工具
下一轮模型马上就“看见”工具结果并继续推理
```

---

## 6. 把 `QueryEngine` 那句 `for await (const message of query(...))` 接进来

前面这篇主要站在 `query.ts` 里看。

但你现在已经是从这句一路追下来的：

```ts
for await (const message of query({
  messages,
  systemPrompt,
  userContext,
  systemContext,
  canUseTool: wrappedCanUseTool,
  toolUseContext: processUserInputContext,
  fallbackModel,
  querySource: 'sdk',
  maxTurns,
  taskBudget,
})) {
```

所以这里要把“`QueryEngine` 传了什么进来”和“`queryLoop()` 真正拿着这些参数做什么”对上。

### 6.1 这几个入参分别是什么

```text
messages
  = 当前这一轮要启动 query() 时的完整消息历史快照
  = 已经包含 processUserInput() 产出的 user / attachment / meta message

systemPrompt
  = QueryEngine 前面拼好的 system prompt
  = 默认提示词 + 可选 memory mechanics + appendSystemPrompt

userContext / systemContext
  = 额外上下文
  = 不是 transcript 里的普通消息，而是拼接到 API 请求前后的结构化上下文

canUseTool
  = 真正执行工具前的权限裁决函数

toolUseContext
  = 工具执行期共享上下文
  = 工具列表、appState 读写、abortController、readFileState、MCP 等都在里面

fallbackModel
  = 当前主模型触发 fallback 时切换到哪个模型

querySource
  = 这次 query 是从哪里发起的
  = 这里是 'sdk'

maxTurns
  = 这一轮 agentic loop 最多允许递归几次

taskBudget
  = API 侧 task budget，总量由 QueryEngine 传进来
```

### 6.2 进入 `queryLoop()` 后，这些参数怎么被分成两类

`queryLoop()` 一上来就做了一个很重要的拆分：

```text
params 里的只读参数
  vs
state 里的跨迭代可变参数
```

也就是：

```text
systemPrompt / userContext / systemContext / canUseTool / fallbackModel / querySource / maxTurns
  -> 整个 query() 生命周期内基本不变

messages / toolUseContext / turnCount / 各种 recovery 标记
  -> 每一轮 while(true) 都可能被改写，再交给下一轮
```

这一点非常关键。

因为外层 `QueryEngine` 传进来的 `messages` 只是：

```text
query() 第一轮的初始消息历史
```

进入 `queryLoop()` 以后，真正不断被接力传下去的是：

```ts
state.messages
```

而不是 `params.messages`。

换句话说：

```text
QueryEngine 只负责把第一轮“起跑线”铺好
queryLoop() 负责之后每一轮怎么继续跑
```

### 6.3 一组最小模拟数据

假设 `QueryEngine` 调 `query()` 时，传进来的是：

```ts
messages = [
  { type: 'user', uuid: 'u1', message: { content: '帮我分析 src/query.ts' } }
]

systemPrompt = ['你是代码助手', '...']

toolUseContext.options.tools = [Read, Grep, Glob, Bash]

fallbackModel = 'claude-haiku-x'
querySource = 'sdk'
maxTurns = 10
```

那 `queryLoop()` 的第一轮起始状态就近似是：

```ts
state = {
  messages: [
    { type: 'user', uuid: 'u1', message: { content: '帮我分析 src/query.ts' } }
  ],
  toolUseContext: processUserInputContext,
  turnCount: 1,
  maxOutputTokensRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
  ...
}
```

然后：

```text
第一轮 assistant 产生 tool_use
  -> 跑工具
  -> 拼出 tool_result
  -> state.messages 变成“用户消息 + assistant(tool_use) + tool_result”
  -> continue 第二轮
```

所以外层这一句：

```ts
for await (const message of query(...))
```

表面看是“一次调用”。

但内部真实发生的是：

```text
第一次 API 请求
  -> 可能一批工具
  -> 第二次 API 请求
  -> 可能再一批工具
  -> ...
  -> 最后 return Terminal
```

---

## 7. `deps.callModel()` 往下：`queryModelWithStreaming()` 只是外壳，真正核心在 `queryModel()`

当你看到：

```ts
for await (const message of deps.callModel({...})) {
```

要立刻在脑子里替换成生产环境真实实现：

```text
deps.callModel
  = queryModelWithStreaming
  = withStreamingVCR(queryModel(...)) 的一层包装
```

代码在：

```ts
export function productionDeps(): QueryDeps {
  return {
    callModel: queryModelWithStreaming,
    microcompact: microcompactMessages,
    autocompact: autoCompactIfNeeded,
    uuid: randomUUID,
  }
}
```

所以这里的分层关系是：

```text
queryLoop()
  -> deps.callModel(...)
      -> queryModelWithStreaming(...)
          -> yield* queryModel(...)
              -> 真正发 API
              -> 读原始 stream
              -> 转成 AssistantMessage / StreamEvent / API error message
```

### 7.1 `queryModelWithStreaming()` 本身几乎不做业务

它本质上只是：

```ts
return yield* withStreamingVCR(messages, async function* () {
  yield* queryModel(...)
})
```

所以真正值得看的不是 `queryModelWithStreaming()`，
而是里面那个 `queryModel()`。

### 7.2 `queryModel()` 先做的不是“读流”，而是“准备 API 请求”

`queryModel()` 前半段做的事非常多，但可以归成一类：

```text
把本地 Message / Tool / Prompt 结构，变成真正能发给模型 API 的请求参数
```

主要包括：

```text
1. 处理 provider / model / beta headers
2. 决定 tool search 是否启用
3. 构造 toolSchemas
4. normalizeMessagesForAPI(messages, filteredTools)
5. 修正 tool_use / tool_result 配对
6. 去掉当前模型不支持的 block/字段
7. 拼最终 system prompt
8. 构造 max_tokens / thinking / effort / task_budget / fastMode 等请求参数
```

所以：

```text
queryLoop() 传进去的是本地内部消息
queryModel() 发出去的是 provider API 需要的 MessageParam / tool schema / stream params
```

### 7.3 真正的原始流解析发生在哪里

最关键的是这一层：

```ts
for await (const part of stream) {
  switch (part.type) {
    case 'message_start'
    case 'content_block_start'
    case 'content_block_delta'
    case 'content_block_stop'
    case 'message_delta'
    case 'message_stop'
  }
  yield { type: 'stream_event', event: part, ... }
}
```

也就是说，`queryModel()` 一边维护自己的局部状态，一边往上层吐两类东西：

```text
1. 已经整理好的 AssistantMessage
2. 原始底层 StreamEvent
```

### 7.4 assistant message 不是在 `message_start` 产生的

这是最容易误解的一点。

很多人以为：

```text
message_start 到了，就已经有 assistant message 了
```

其实不是。

内部顺序更接近：

```text
message_start
  -> 记录 partialMessage 外壳、初始 usage

content_block_start
  -> 在 contentBlocks[index] 里建一个还没拼完的 block

content_block_delta
  -> 往这个 block 里不断追加 text / thinking / partial_json

content_block_stop
  -> 这时才把单个完整 block 封装成一条 AssistantMessage
  -> yield assistant message

message_delta
  -> 回写最终 usage / stop_reason 到“刚才已经 yield 出去的那条 assistant message”
```

所以：

```text
assistant message 的“正文内容”在 content_block_stop 才真正成形
assistant message 的“最终 usage/stop_reason”在 message_delta 才补齐
```

### 7.5 为什么 `queryLoop()` 能一边收 assistant，一边收 `stream_event`

因为 `queryModel()` 本来就同时 `yield` 这两类：

```text
assistant
stream_event
```

所以 `queryLoop()` 的这一句：

```ts
for await (const message of deps.callModel(...)) {
```

拿到的 `message` 其实是一个混合流。

可能依次是：

```text
stream_event(message_start)
stream_event(content_block_start)
stream_event(content_block_delta)
assistant(text block)
stream_event(message_delta)
assistant(tool_use block)
...
```

这也是为什么 `queryLoop()` 要同时维护：

```text
assistantMessages[]
toolUseBlocks[]
needsFollowUp
```

因为它消费的不是“最终一条回答”，而是“半结构化的内部事件流”。

### 7.6 流式失败时，为什么上层很多时候收不到 throw

因为 `queryModel()` 里还有一层很重的恢复逻辑：

```text
streaming 失败
  -> 如果没禁用 fallback
  -> 改走 non-streaming request
  -> 把 non-streaming 的结果重新包装成 AssistantMessage
  -> 继续 yield 给上层
```

所以对 `queryLoop()` 来说，经常出现这种情况：

```text
底层 streaming 已经失败过一次
但上层最后仍然收到了一条正常 assistant message
```

这也是为什么：

```text
queryLoop() 里很多异常不是靠 catch 判断
而是靠“最后一条 assistant 是正常内容还是 API error message”来分流
```

---

## 8. `runTools()` / `runToolUse()`：把 `tool_use` 变成 `tool_result`，再塞回下一轮

前面模型流阶段结束后，`queryLoop()` 手里通常已经有：

```ts
assistantMessages = [...]
toolUseBlocks = [...]
needsFollowUp = true
```

这时它会进入：

```ts
const toolUpdates = streamingToolExecutor
  ? streamingToolExecutor.getRemainingResults()
  : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)
```

这里你可以先把 `runTools()` 理解成：

```text
一批 tool_use 的调度器
```

而 `runToolUse()` 是：

```text
单个 tool_use 的执行器
```

### 8.1 `runTools()` 做的是“批次调度”，不是单个工具执行细节

它先把工具按“能否并发安全执行”分批：

```text
连续的只读 / 并发安全工具
  -> 尽量并发跑

有副作用 / 不安全工具
  -> 串行跑
```

所以 `queryLoop()` 这层并不关心：

```text
Read 和 Grep 是不是可以并发
Bash 和 Edit 要不要串行
```

这些都是 `runTools()` 决定的。

### 8.2 `runToolUse()` 才是真正的单工具调用链

一条 `tool_use` 进入 `runToolUse()` 后，主顺序大致是：

```text
1. 根据 toolUse.name 找 Tool 实现
2. 找不到 -> 直接生成 error tool_result
3. 已经 abort -> 直接生成取消 tool_result
4. zod safeParse 校验 input
5. tool.validateInput 再做业务校验
6. canUseTool 做权限判断
7. 跑 pre/post hooks
8. 真正执行 tool.call()
9. 包装成 user(tool_result) / attachment / progress
```

所以模型发出 `tool_use` 以后，不是“立刻执行系统命令”，中间要过很多关。

### 8.3 为什么工具执行阶段也会不断 `yield`

因为工具执行不是只返回一个最终结果。

它还可能中途产出：

```text
progress
attachment
hook message
最终的 user(tool_result)
```

所以 `runToolUse()` / `runTools()` 也做成了 `AsyncGenerator`。

这让 `queryLoop()` 可以统一用：

```ts
for await (const update of toolUpdates) {
```

消费工具阶段的全部事件。

### 8.4 `tool_result` 为什么会变成 `user` message

因为从模型 API 视角看，工具结果是“用户回给 assistant 的结果块”。

所以 `queryLoop()` 在收工具更新时会做：

```ts
toolResults.push(
  ...normalizeMessagesForAPI([update.message], toolUseContext.options.tools)
    .filter(_ => _.type === 'user'),
)
```

这句很关键。

它的意思是：

```text
工具执行阶段产出的消息，最后要整理成模型下一轮能吃的 user 消息
```

所以你最终看到的不是：

```text
tool object
```

而是：

```text
user message with tool_result block
```

### 8.5 下一轮为什么能立刻“看到”工具结果

答案就藏在这句里：

```ts
messages: [...messagesForQuery, ...assistantMessages, ...toolResults]
```

这句的真实白话是：

```text
下一轮喂给模型的上下文
= 这一轮一开始送给模型看的上下文
+ 这一轮 assistant 刚说过的话
+ 这一轮工具刚执行完回来的结果
```

所以模型第二轮看到的，不是“一个全新会话”，而是：

```text
我刚才提出了工具调用
这里是工具返回结果
现在请你基于这些结果继续推理
```

这就是 agentic loop 能成立的根本原因。

### 8.6 一组完整状态快照

假设第一轮开始时：

```ts
state.messages = [
  user("帮我分析 src/query.ts 的 queryLoop")
]
turnCount = 1
```

第一轮模型输出：

```ts
assistantMessages = [
  assistant(tool_use: Read("src/query.ts")),
  assistant(tool_use: Grep("queryLoop", "src/query.ts"))
]

toolUseBlocks = [
  Read(...),
  Grep(...)
]

needsFollowUp = true
```

工具执行结束后：

```ts
toolResults = [
  progress("Read 进行中"),
  user(tool_result for Read),
  user(tool_result for Grep),
  attachment(dynamic_skill / memory / queued_command?) // 可能有，也可能没有
]
```

构造下一轮 state：

```ts
state = {
  messages: [
    user("帮我分析 src/query.ts 的 queryLoop"),
    assistant(tool_use Read),
    assistant(tool_use Grep),
    progress(...),
    user(tool_result Read),
    user(tool_result Grep),
    ...
  ],
  turnCount: 2,
  transition: { reason: 'next_turn' },
  ...
}
```

然后第二轮模型再基于这整包消息继续回答。

---

## 9. 你应该怎样逐步读这个方法

如果你第一次读 `queryLoop()`，不要从上到下死抠每一行。

我建议你按下面顺序：

### 第一步：先只抓主骨架

```text
while (true)
  -> 预处理上下文
  -> deps.callModel()
  -> needsFollowUp ?
       false -> 恢复/结束
       true  -> 工具执行/继续
```

### 第二步：只跟 4 个变量

```text
messagesForQuery
assistantMessages
toolUseBlocks
toolResults
```

你只要能回答下面 4 个问题，就算过第一关：

```text
1. 这一轮到底给模型看了什么？
2. 模型输出被存到哪里？
3. tool_use 是怎么被识别出来的？
4. tool_result 是怎么拼回下一轮 messages 的？
```

### 第三步：再补恢复分支

重点只看这些 transition：

```text
collapse_drain_retry
reactive_compact_retry
max_output_tokens_escalate
max_output_tokens_recovery
stop_hook_blocking
token_budget_continuation
next_turn
```

你会发现它们其实都在做同一件事：

```text
构造 next State
然后 continue
```

### 第四步：最后再看 feature gate

先别一开始就陷进去：

```text
HISTORY_SNIP
CONTEXT_COLLAPSE
CACHED_MICROCOMPACT
TOKEN_BUDGET
BG_SESSIONS
CHICAGO_MCP
```

这些都是“在主状态机骨架上外挂的增强分支”。

先看主回路，再看 feature gate，阅读成本会低很多。

---

## 10. 这一讲读完后，下一步该深挖哪里

如果你顺着这篇继续往下钻，优先级我建议这样排：

### 1. `StreamingToolExecutor`

文件：`src/services/tools/StreamingToolExecutor.ts`

理由：

```text
queryLoop() 里最关键但最容易“以为懂了”的一句，
就是 streamingToolExecutor.addTool() / getCompletedResults() / getRemainingResults()。
```

真正的并发、顺序保证、兄弟工具出错后的合成 tool_result，全在这里。

### 2. `toolExecution.ts`

文件：`src/services/tools/toolExecution.ts`

理由：

```text
再往下就是单个 tool_use 如何走到 tool.call()，
权限检查 canUseTool() 怎么接进去，
tool_result 怎么被包装回 Message。
```

### 3. `claude.ts` 的流式适配层

文件：`src/services/api/claude.ts`

理由：

```text
queryLoop() 消费的是“已经被适配成 Message/StreamEvent 的流”。
如果你想知道最原始的 SDK stream event 是怎么转成这些消息的，就得往这里走。
```

---

## 11. 一句话总结

`runHeadlessStreaming()` 是外层编排器，`QueryEngine.submitMessage()` 是 turn 级包装层，而 `queryLoop()` 才是 Claude Code agent 真正工作的心脏。

它维护一个 `State`，不断做这件事：

```text
把当前上下文整理好
  -> 问模型
  -> 收集 assistant/tool_use
  -> 跑工具
  -> 把结果重新塞回 messages
  -> 决定是继续还是结束
```

如果你把这条主线读顺了，后面再看 `StreamingToolExecutor`、`toolExecution.ts`、`claude.ts` 就不会散。
