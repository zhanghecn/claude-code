# queryLoop 完整源码导读

这份文档只讲 `src/query.ts` 里的主循环。

目标是让你能从头到尾回答：

```text
一次用户输入进来后，
query() 做了什么包装，
queryLoop 每一轮怎么准备 messagesForQuery，
模型输出怎么被收集，
tool_use 怎么触发工具执行，
tool_result 怎么拼回下一轮，
各种恢复分支为什么要 continue，
最后 state.messages 为什么这样组成。
```

本文用同一组模拟数据贯穿，不把每个函数孤立讲。

---

## 1. 先看完整路线

```text
query(params)
  │
  ├─ 创建 / 复用 Langfuse trace
  │
  ├─ yield* queryLoop(...)
  │
  └─ finally:
       finalizeAutonomyCommandsForTurn()
       endTrace()
       flushLangfuse()
       清理 trace 引用和 performance buffer

queryLoop(params)
  │
  ├─ 取 immutable params
  ├─ 初始化 State
  ├─ buildQueryConfig()
  ├─ startRelevantMemoryPrefetch()  // 每个用户 turn 只启动一次
  │
  └─ while (true)
       │
       ├─ 从 state 解包本轮材料
       ├─ 启动 per-iteration skill/tool discovery prefetch
       ├─ yield stream_request_start
       ├─ 建立 queryTracking
       │
       ├─ 构造 messagesForQuery
       │    ├─ getMessagesAfterCompactBoundary()
       │    ├─ 删除 toolUseResult
       │    ├─ applyToolResultBudget()
       │    ├─ snipCompactIfNeeded()
       │    ├─ microcompact()
       │    ├─ contextCollapse.applyCollapsesIfNeeded()
       │    └─ autocompact()
       │
       ├─ 创建本轮收集器
       │    ├─ assistantMessages = []
       │    ├─ toolResults = []
       │    ├─ toolUseBlocks = []
       │    ├─ needsFollowUp = false
       │    └─ streamingToolExecutor?
       │
       ├─ API 前保护
       │    ├─ blocking limit
       │    └─ predictive autocompact
       │
       ├─ callModel 流式读取
       │    ├─ yield 模型消息
       │    ├─ 收集 assistantMessages
       │    ├─ 从 assistant message 找 tool_use
       │    ├─ tool_use 让 needsFollowUp = true
       │    └─ streamingToolExecutor 可边流式边执行工具
       │
       ├─ 模型流结束后的公共收尾
       │    ├─ cache warning
       │    ├─ post-sampling hooks
       │    ├─ streaming abort 恢复
       │    └─ 输出上一轮 pendingToolUseSummary
       │
       ├─ 分支 A：没有 tool_use
       │    ├─ prompt-too-long / media reactive compact
       │    ├─ max_output_tokens 恢复
       │    ├─ API error 结束
       │    ├─ stop hooks
       │    ├─ token budget continuation
       │    └─ completed
       │
       └─ 分支 B：有 tool_use
            ├─ 执行工具，收集 toolResults
            ├─ 生成下一轮 pendingToolUseSummary
            ├─ 工具中断 / hook stop 检查
            ├─ 队列命令转 attachment
            ├─ getAttachmentMessages()
            ├─ 消费 memory / skill / tool discovery prefetch
            ├─ refresh tools
            ├─ task summary
            ├─ maxTurns
            └─ state = {
                 messages: messagesForQuery + assistantMessages + toolResults,
                 transition: { reason: 'next_turn' }
               }
               回到 while 顶部
```

先记住这条主线：

```text
没有 tool_use:
  queryLoop 尝试结束。

有 tool_use:
  queryLoop 执行工具，把工具结果拼回 messages，然后继续下一轮。
```

---

## 2. 本文贯穿使用的模拟数据

假设用户输入是：

```text
帮我读 src/query.ts，并解释 queryLoop 怎么跑。
```

进入 `query()` 时，`params.messages` 里大概有：

```ts
const initialMessages = [
  {
    // u1 是用户刚输入的消息。
    type: 'user',
    uuid: 'u1',
    message: {
      role: 'user',
      content: '帮我读 src/query.ts，并解释 queryLoop 怎么跑。',
    },
  },
]
```

第一轮模型可能返回：

```ts
const a1 = {
  // a1 是模型消息。
  type: 'assistant',
  uuid: 'a1',
  message: {
    role: 'assistant',
    content: [
      {
        // 模型说明自己要做什么。
        type: 'text',
        text: '我先读取 src/query.ts。',
      },
      {
        // tool_use 表示模型请求 CLI 调用工具。
        type: 'tool_use',
        id: 'toolu_read_1',
        name: 'Read',
        input: { file_path: 'src/query.ts' },
      },
    ],
  },
}
```

工具执行后会产生：

```ts
const tr1 = {
  // tool_result 在内部是 UserMessage。
  type: 'user',
  uuid: 'tr1',
  message: {
    role: 'user',
    content: [
      {
        // tool_result 必须通过 tool_use_id 指回 tool_use.id。
        type: 'tool_result',
        tool_use_id: 'toolu_read_1',
        content: 'src/query.ts 的文件内容。',
      },
    ],
  },
}
```

第一轮结束准备进入第二轮时，核心拼接会变成：

```text
下一轮 state.messages =
  messagesForQuery + assistantMessages + toolResults

代入:
  [u1] + [a1] + [tr1]

结果:
  [u1, a1, tr1]
```

后面所有章节都围绕这三个数组：

```text
messagesForQuery
  本轮调用模型前，准备给模型看的历史。

assistantMessages
  本轮模型刚返回的 assistant 消息。

toolResults
  本轮工具执行后产生的 user/tool_result 或 attachment 消息。
```

---

## 3. query() 是外壳，queryLoop() 才跑主循环

源码位置：`src/query.ts`。

```ts
export async function* query(
  params: QueryParams,
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
> {
  // 记录本轮 query 消费了哪些队列命令。
  // queryLoop 内部会往这两个数组里 push。
  const consumedCommandUuids: string[] = []
  const consumedAutonomyCommands: QueuedCommand[] = []

  // 如果外部没有传 langfuseTrace，query() 自己创建一个。
  const ownsTrace = !params.toolUseContext.langfuseTrace

  // 如果启用了 Langfuse，就创建 trace。
  const langfuseTrace =
    params.toolUseContext.langfuseTrace ??
    (isLangfuseEnabled()
      ? createTrace({
          sessionId: getSessionId(),
          model: params.toolUseContext.options.mainLoopModel,
          provider: getAPIProvider(),
          input: params.messages,
          querySource: params.querySource,
        })
      : null)

  // 把 trace 放回 toolUseContext，让工具执行也能记录观测数据。
  const paramsWithTrace: QueryParams = langfuseTrace
    ? {
        ...params,
        toolUseContext: { ...params.toolUseContext, langfuseTrace },
      }
    : params

  let terminal: Terminal | undefined
  try {
    // 这里才把执行权交给 queryLoop。
    terminal = yield* queryLoop(
      paramsWithTrace,
      consumedCommandUuids,
      consumedAutonomyCommands,
    )
  } finally {
    // queryLoop 正常结束、报错、用户中断，都会进 finally。
    // 所以队列命令和 trace 清理放在这里。
  }

  return terminal!
}
```

`query()` 的作用：

```text
1. 建 trace。
2. 把 trace 塞进 toolUseContext。
3. yield* queryLoop。
4. queryLoop 退出后做全局清理。
```

`yield* queryLoop(...)` 的含义：

```text
queryLoop yield 出来的每一条消息，
都会透传给 query() 的调用者。

queryLoop return 的 Terminal，
会赋给 terminal。
```

所以之后我们只看 `queryLoop()`。

---

## 4. query() 的 finally 为什么这么多清理

`queryLoop` 有很多退出方式：

```text
completed
blocking_limit
image_error
model_error
aborted_streaming
aborted_tools
prompt_too_long
stop_hook_prevented
hook_stopped
max_turns
throw error
generator 被 .return() 关闭
```

如果把清理写在每个分支里，很容易漏。

所以 `query()` 用 `finally` 统一处理：

```ts
finally {
  // 根据 terminal 或 thrownError，判断队列命令应该算完成、取消、失败。
  await finalizeAutonomyCommandsForTurn({
    commands: consumedAutonomyCommands,
    outcome: getAutonomyTurnOutcome({
      terminal,
      ...(didThrow ? { thrownError } : {}),
    }),
    priority: 'later',
  })

  // 如果 trace 是 query() 自己创建的，它也负责结束。
  if (ownsTrace) {
    const isAborted =
      terminal?.reason === 'aborted_streaming' ||
      terminal?.reason === 'aborted_tools'
    endTrace(langfuseTrace, undefined, isAborted ? 'interrupted' : undefined)
    await flushLangfuse()
  }

  // 清掉 trace 引用，避免 SpanImpl 持有大量历史 JSON。
  if (paramsWithTrace !== params) {
    paramsWithTrace.toolUseContext.langfuseTrace = null
    paramsWithTrace.toolUseContext.langfuseRootTrace = null
    paramsWithTrace.toolUseContext.langfuseBatchSpan = null
  }
}
```

这里和 `queryLoop` 的关联：

```text
queryLoop 负责推进对话。
query 负责本次推进结束后的外层清理。
```

---

## 5. queryLoop 入口：先拆出不会变的参数

源码位置：`src/query.ts`。

```ts
async function* queryLoop(
  params: QueryParams,
  consumedCommandUuids: string[],
  consumedAutonomyCommands: QueuedCommand[],
): AsyncGenerator<
  | StreamEvent
  | RequestStartEvent
  | Message
  | TombstoneMessage
  | ToolUseSummaryMessage,
  Terminal
> {
  // 这些参数在整个 queryLoop 调用期间不重新赋值。
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

  // deps 默认是 productionDeps。
  // 测试可以传 fake deps，避免 mock 一堆模块。
  const deps = params.deps ?? productionDeps()
}
```

`deps` 的真实来源在 `src/query/deps.ts`：

```ts
export function productionDeps(): QueryDeps {
  return {
    // 真正请求模型的函数。
    callModel: queryModelWithStreaming,

    // queryLoop 里的 deps.microcompact 实际是 microcompactMessages。
    microcompact: microcompactMessages,

    // queryLoop 里的 deps.autocompact 实际是 autoCompactIfNeeded。
    autocompact: autoCompactIfNeeded,

    // 生成 queryTracking / compact turnId 等 ID。
    uuid: randomUUID,
  }
}
```

为什么要有 `deps`：

```text
生产环境:
  用真实 callModel / microcompact / autocompact。

测试环境:
  直接传假的 deps。
  这样测试 queryLoop 不需要 spyOn 很多深层模块。
```

---

## 6. State：每次 continue 都靠它保存下一轮输入

`queryLoop` 不是递归调用自己，而是一个 `while (true)`。

每次需要继续时，它会写：

```ts
// 把下一轮要使用的完整状态写回 state。
state = next

// 回到 while 顶部，重新从 state 解包 messages/toolUseContext 等字段。
continue
```

`State` 类型在 `src/query.ts`：

```ts
type State = {
  // 下一轮 while 开头用它构造 messagesForQuery。
  messages: Message[]

  // 工具执行、权限、模型、readFileState、agentId 都在这里。
  toolUseContext: ToolUseContext

  // 自动 compact 的跨轮跟踪状态。
  autoCompactTracking: AutoCompactTrackingState | undefined

  // max_output_tokens 恢复已经尝试几次。
  maxOutputTokensRecoveryCount: number

  // reactive compact 是否已经尝试过，防止死循环。
  hasAttemptedReactiveCompact: boolean

  // 某些 max output 恢复路径会临时提高 maxOutputTokens。
  maxOutputTokensOverride: number | undefined

  // 上一轮工具执行后后台生成的工具摘要。
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined

  // stop hook 是否正在阻塞续跑。
  stopHookActive: boolean | undefined

  // 当前是第几轮 agent loop。
  turnCount: number

  // 上一轮为什么 continue，主要用于恢复路径和测试断言。
  transition: Continue | undefined
}
```

初始化：

```ts
let state: State = {
  // 第一轮从 params.messages 开始。
  messages: params.messages,

  // 第一轮用 params.toolUseContext。
  toolUseContext: params.toolUseContext,

  // 如果调用方传了 maxOutputTokensOverride，第一轮使用它。
  maxOutputTokensOverride: params.maxOutputTokensOverride,

  // 这些恢复状态第一轮都为空或 false。
  autoCompactTracking: undefined,
  stopHookActive: undefined,
  maxOutputTokensRecoveryCount: 0,
  hasAttemptedReactiveCompact: false,
  turnCount: 1,
  pendingToolUseSummary: undefined,
  transition: undefined,
}
```

代入模拟数据：

```text
第一轮 state:
  messages = [u1]
  turnCount = 1
  transition = undefined
```

如果第一轮模型调用工具，后面会写：

```text
第二轮 state:
  messages = [u1, a1, tr1]
  turnCount = 2
  transition = { reason: 'next_turn' }
```

---

## 7. buildQueryConfig：把运行时开关拍成快照

源码位置：`src/query.ts`。

```ts
// config 在 queryLoop 入口只构造一次。
const config = buildQueryConfig()
```

真实实现：`src/query/config.ts`。

```ts
export function buildQueryConfig(): QueryConfig {
  return {
    // 当前 sessionId。
    sessionId: getSessionId(),

    gates: {
      // 是否启用边流式输出边执行工具。
      streamingToolExecution: checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
        'tengu_streaming_tool_execution2',
      ),

      // 是否输出工具摘要。
      emitToolUseSummaries: isEnvTruthy(
        process.env.CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES,
      ),

      // 是否 Anthropic 内部用户。
      isAnt: process.env.USER_TYPE === 'ant',

      // fast mode 是否可用。
      fastModeEnabled: !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_FAST_MODE),
    },
  }
}
```

为什么只构造一次：

```text
这些是一次 query turn 内不应该来回变化的运行时开关。
如果每轮 while 都重新读，可能同一个用户问题中途行为变化。
```

注意：

```text
feature('FLAG') 没放进 QueryConfig。

原因是 feature() 是 bun:bundle 的编译期 / tree-shaking 边界，
必须留在具体 if 位置。
```

---

## 8. startRelevantMemoryPrefetch：每个用户 turn 只启动一次

源码位置：`src/query.ts`。

```ts
using pendingMemoryPrefetch = startRelevantMemoryPrefetch(
  // 用初始 state.messages 找最后一条真实用户消息。
  state.messages,

  // 用 toolUseContext 访问 agentDefinitions、readFileState、abortController 等。
  state.toolUseContext,
)
```

这一步在 `while (true)` 外面。

原因：

```text
一个用户问题可能触发多轮 agent loop。

如果放在 while 里面：
  第 1 轮问 sideQuery：这个用户问题需要哪些 memory？
  第 2 轮又问 sideQuery：同一个用户问题需要哪些 memory？
  第 3 轮还问 sideQuery：同一个用户问题需要哪些 memory？

所以它只在用户 turn 开始时启动一次。
```

`startRelevantMemoryPrefetch()` 做的是“召回记忆”，不是“写入记忆”：

```text
已有 memory 文件
  │
  ▼
扫描 memory headers
  │
  ▼
sideQuery 让 Sonnet 选最多 5 个相关 memory
  │
  ▼
读取 memory 文件内容
  │
  ▼
生成 relevant_memories attachment
```

它返回的 handle：

```ts
export type MemoryPrefetch = {
  // 后台任务，完成后得到 Attachment[]。
  promise: Promise<Attachment[]>

  // null 表示还没完成；number 表示完成时间。
  settledAt: number | null

  // -1 表示还没被消费；其他数字表示在哪一轮消费。
  consumedOnIteration: number

  // using 退出作用域时会调用。
  [Symbol.dispose](): void
}
```

`using` 的作用：

```text
queryLoop 可能 completed、error、abort、return、throw。
using 保证退出时一定调用 [Symbol.dispose]。

dispose 里会：
  abort 还没结束的 memory sideQuery
  记录 telemetry
```

它的消费点不在这里，而是在工具执行后：

```ts
if (
  pendingMemoryPrefetch &&
  pendingMemoryPrefetch.settledAt !== null &&
  pendingMemoryPrefetch.consumedOnIteration === -1
) {
  // 只在已经完成时 await。
  // 如果 settledAt 还是 null，就不等它。
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
```

完整数据流：

```text
queryLoop 入口:
  启动 pendingMemoryPrefetch

while 第 1 轮:
  模型流式输出
  工具执行
  到附件注入阶段检查 settledAt

如果已经完成:
  relevant_memories -> AttachmentMessage -> toolResults

下一轮 state.messages:
  messagesForQuery + assistantMessages + toolResults
  其中 toolResults 里包含 relevant_memories

下一轮模型:
  能看到相关 memory
```

这就是为什么它是 prefetch：

```text
它把 memory sideQuery 的延迟藏在主模型流式输出和工具执行时间里。
```

---

## 9. while 开头：从 state 解包本轮材料

源码位置：`src/query.ts`。

```ts
while (true) {
  // toolUseContext 这一轮内部会被重新赋值。
  let { toolUseContext } = state

  // 其他字段本轮只读，需要 continue 时统一写 next state。
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
}
```

第一轮代入：

```text
messages = [u1]
turnCount = 1
pendingToolUseSummary = undefined
```

第二轮代入：

```text
messages = [u1, a1, tr1]
turnCount = 2
pendingToolUseSummary = 可能有值
```

这里还没有 `messagesForQuery`。
`messagesForQuery` 是后面从 `messages` 加工出来的。

---

## 10. per-iteration prefetch：skill / tool discovery 每轮都可能启动

源码位置：`src/query.ts`。

```ts
const pendingSkillPrefetch = skillPrefetch?.startSkillDiscoveryPrefetch(
  // 这里传 null，表示不是 turn-0 用户输入阻塞路径。
  null,

  // 当前轮 state.messages。
  messages,

  // 当前工具上下文。
  toolUseContext,
)

const pendingToolPrefetch =
  searchExtraToolsPrefetch?.startSearchExtraToolsPrefetch(
    // 当前工具列表。
    toolUseContext.options.tools ?? [],

    // 当前轮 state.messages。
    messages,
  )
```

它们为什么在 `while` 里面：

```text
skill discovery / tool discovery 依赖每一轮新增的工具结果和写文件行为。

第 1 轮模型 Read 了文件。
第 2 轮才可能根据 Read / Edit / Write 结果发现新 skill 或新工具。

所以它们是 per-iteration。
```

和 memory prefetch 的区别：

```text
memory prefetch:
  针对用户原始问题。
  一个用户 turn 只启动一次。

skill/tool prefetch:
  针对每一轮工具执行后出现的新线索。
  每轮都可以启动，但内部有 guard，没线索会快速返回。
```

消费点也在工具执行后，和 memory 一起注入 `toolResults`。

---

## 11. 本轮开始事件、queryCheckpoint、queryTracking

源码位置：`src/query.ts`。

```ts
// 通知外部：本轮准备开始发请求。
yield { type: 'stream_request_start' }

// 性能打点。
queryCheckpoint('query_fn_entry')

// 顶层主线程记录 headless latency；subagent 跳过。
if (!toolUseContext.agentId) {
  headlessProfilerCheckpoint('query_started')
}

// 如果上轮已有 queryTracking，就沿用 chainId，depth + 1。
// 如果没有，就创建新 chainId。
const queryTracking = toolUseContext.queryTracking
  ? {
      chainId: toolUseContext.queryTracking.chainId,
      depth: toolUseContext.queryTracking.depth + 1,
    }
  : {
      chainId: deps.uuid(),
      depth: 0,
    }

// 把 queryTracking 写回 toolUseContext。
toolUseContext = {
  ...toolUseContext,
  queryTracking,
}
```

代入：

```text
第 1 轮:
  queryTracking = { chainId: 'chain-1', depth: 0 }

第 2 轮:
  queryTracking = { chainId: 'chain-1', depth: 1 }
```

它的用途：

```text
logEvent 里记录同一条用户请求下的多轮链路。
工具执行、compact、fallback、错误恢复都能挂到同一个 chainId。
```

---

## 12. messagesForQuery：把 state.messages 变成“本轮入模视图”

源码位置：`src/query.ts`。

```ts
// 输入：state.messages。
// 输出：本轮准备进入模型调用前处理管线的消息数组。
let messagesForQuery = getMessagesAfterCompactBoundary(messages)
```

`messages` 是 state 里的完整候选历史。
`messagesForQuery` 是本轮继续处理、最终可能发给模型的数组。

后面会依次处理：

```text
messages
  │
  ▼
getMessagesAfterCompactBoundary
  │
  ▼
delete toolUseResult
  │
  ▼
applyToolResultBudget
  │
  ▼
snipCompactIfNeeded
  │
  ▼
microcompact
  │
  ▼
contextCollapse
  │
  ▼
autocompact
  │
  ▼
最终 messagesForQuery
```

这段已经有单独文档：

[context-compaction-source-guide.md](/home/zhangxuan/project/ai/claude-code/docs/context/context-compaction-source-guide.md:1)

这里保留主线理解：

```text
第 1 轮:
  messages = [u1]
  messagesForQuery = [u1]

第 2 轮:
  messages = [u1, a1, tr1]
  messagesForQuery = [u1, a1, tr1]

如果前面发生过 compact:
  messages = [old, old, b1, s1, u2]
  messagesForQuery = [b1, s1, u2]
```

---

## 13. 删除 toolUseResult：只删内部大对象

源码位置：`src/query.ts`。

```ts
for (const msg of messagesForQuery) {
  if (
    // 只有 UserMessage 可能带工具结果对象。
    msg.type === 'user' &&

    // toolUseResult 是内部字段，不是 API 需要的 message.content。
    'toolUseResult' in msg &&
    msg.toolUseResult !== undefined
  ) {
    // 删除它，避免长会话内存膨胀。
    delete (msg as Message & { toolUseResult?: unknown }).toolUseResult
  }
}
```

这一步不改变模型看到的 `tool_result`。

```text
删除前 tr1:
  message.content[0].content = 'src/query.ts 的文件内容'
  toolUseResult = UI 用原始对象

删除后 tr1:
  message.content[0].content = 'src/query.ts 的文件内容'
  toolUseResult 不存在
```

所以它不是压缩上下文，只是释放 JS 内存。

---

## 14. applyToolResultBudget：单条工具结果太大时替换正文

源码位置：`src/query.ts`。

```ts
const persistReplacements =
  // agent resume 要能读回替换记录。
  querySource.startsWith('agent:') ||

  // 主线程 /resume 要能读回替换记录。
  querySource.startsWith('repl_main_thread')

messagesForQuery = await applyToolResultBudget(
  // 当前模型视图。
  messagesForQuery,

  // undefined 表示功能关闭，函数原样返回。
  toolUseContext.contentReplacementState,

  // 需要 resume 的路径才写 transcript content-replacement entry。
  persistReplacements
    ? records =>
        void recordContentReplacement(
          records,
          toolUseContext.agentId,
        ).catch(logError)
    : undefined,

  // maxResultSizeChars = Infinity 的工具不走这个预算替换。
  new Set(
    toolUseContext.options.tools
      .filter(t => !Number.isFinite(t.maxResultSizeChars))
      .map(t => t.name),
  ),
)
```

代入：

```text
输入:
  [u1, a1, tr1(500KB tool_result)]

输出:
  [u1, a1, tr1(<persisted-output>短文本</persisted-output>)]
```

它不删除 `tr1`。
它只替换：

```text
tr1.message.content[0].content
```

为什么在这里做：

```text
后面的 microcompact 可能只按 tool_use_id 操作。
如果 tool_result 正文特别大，要先在这里按 content 大小处理。
```

---

## 15. snip / microcompact / contextCollapse / autocompact：入模前变短管线

源码位置：`src/query.ts`。

```ts
let snipTokensFreed = 0
if (feature('HISTORY_SNIP')) {
  // 按 snip_boundary.removedUuids 过滤消息。
  const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
  messagesForQuery = snipResult.messages
  snipTokensFreed = snipResult.tokensFreed
  if (snipResult.boundaryMessage) {
    yield snipResult.boundaryMessage
  }
}

const microcompactResult = await deps.microcompact(
  // snip 后的 messagesForQuery。
  messagesForQuery,
  toolUseContext,
  querySource,
)
messagesForQuery = microcompactResult.messages

if (feature('CONTEXT_COLLAPSE') && contextCollapse) {
  // 当前仓库的 contextCollapse 是 stub，通常直接返回原 messages。
  const collapseResult = await contextCollapse.applyCollapsesIfNeeded(
    messagesForQuery,
    toolUseContext,
    querySource,
  )
  messagesForQuery = collapseResult.messages
}

const { compactionResult, consecutiveFailures } = await deps.autocompact(
  // 前面所有变短步骤后的 messagesForQuery。
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
```

这几个名字的区别：

```text
snip:
  按 snip_boundary 删除指定 uuid 的消息。

microcompact:
  清旧 tool_result，或排队 cache_edits 给 API 服务端缓存删除。

contextCollapse:
  设计上是局部折叠上下文；当前仓库是 stub。

autocompact:
  判断是否需要完整摘要 compact。
  成功时生成 compact_boundary + summary。
```

如果 `autocompact` 成功：

```ts
if (compactionResult) {
  // 把 CompactionResult 变成新的消息数组。
  const postCompactMessages = buildPostCompactMessages(compactionResult)

  // 输出给 UI / transcript。
  for (const message of postCompactMessages) {
    yield message
  }

  // 本轮后面的 callModel 改用 compact 后的 messages。
  messagesForQuery = postCompactMessages
}
```

代入：

```text
autocompact 前:
  messagesForQuery = [u1, a1, tr1]

autocompact 成功后:
  messagesForQuery = [b1, s1, att1, hook1]
```

---

## 16. 把最终 messagesForQuery 写回 toolUseContext

源码位置：`src/query.ts`。

```ts
toolUseContext = {
  // 保留原工具上下文。
  ...toolUseContext,

  // 写入最终入模视图。
  // 后面工具权限、hooks、工具执行都可以看到这轮上下文。
  messages: messagesForQuery,
}
```

为什么要在压缩后写：

```text
如果 autocompact 成功，
messagesForQuery 已经从 [u1, a1, tr1] 变成 [b1, s1, att1, hook1]。

工具上下文应该看到最终版本，
而不是压缩前版本。
```

---

## 17. 创建本轮收集器：assistantMessages / toolResults / toolUseBlocks

源码位置：`src/query.ts`。

```ts
// 本轮模型新返回的 assistant 消息。
const assistantMessages: AssistantMessage[] = []

// 本轮工具执行产生的结果。
// AttachmentMessage 也会放进来，因为下一轮模型也要看到它们。
const toolResults: (UserMessage | AttachmentMessage)[] = []

// 从 assistantMessages 里抽出来的 tool_use 块。
const toolUseBlocks: ToolUseBlock[] = []

// 是否需要继续下一轮。
// 只要发现 tool_use，就设为 true。
let needsFollowUp = false
```

用模拟数据看：

```text
callModel 前:
  assistantMessages = []
  toolUseBlocks = []
  toolResults = []
  needsFollowUp = false

模型返回 a1 后:
  assistantMessages = [a1]
  toolUseBlocks = [Read(toolu_read_1)]
  toolResults = []
  needsFollowUp = true

Read 执行后:
  assistantMessages = [a1]
  toolUseBlocks = [Read(toolu_read_1)]
  toolResults = [tr1]
  needsFollowUp = true
```

为什么不用 `stop_reason === 'tool_use'`：

```text
源码注释说 stop_reason 不可靠。
所以判断是否继续，不靠 stop_reason。
而是扫描 assistant message.content 里是否真的有 tool_use。
```

---

## 18. StreamingToolExecutor：边流式输出边执行工具

源码位置：`src/query.ts`。

```ts
const useStreamingToolExecution = config.gates.streamingToolExecution
let streamingToolExecutor = useStreamingToolExecution
  ? new StreamingToolExecutor(
      // 当前工具列表。
      toolUseContext.options.tools,

      // 权限检查函数。
      canUseTool,

      // 工具执行上下文。
      toolUseContext,
    )
  : null
```

不开启时：

```text
1. 等模型完整输出结束
2. 收集所有 tool_use
3. runTools(toolUseBlocks)
4. 得到 toolResults
```

开启时：

```text
1. 模型流式输出过程中发现 tool_use
2. 立刻 streamingToolExecutor.addTool(...)
3. 模型还在流式输出，工具已经开始跑
4. 每次循环检查 getCompletedResults()
5. 已完成的工具结果马上 yield 并 push 到 toolResults
6. 流结束后 getRemainingResults() 等剩余工具
```

目的：

```text
把工具执行耗时藏进模型流式输出时间里。
```

---

## 19. 选择当前模型、创建 dumpPromptsFetch

源码位置：`src/query.ts`。

```ts
const appState = toolUseContext.getAppState()
const permissionMode = appState.toolPermissionContext.mode

let currentModel = getRuntimeMainLoopModel({
  // plan mode / normal mode 可能影响模型选择。
  permissionMode,

  // 主循环模型配置。
  mainLoopModel: toolUseContext.options.mainLoopModel,

  // plan 模式下，如果最近 assistant 消息超过 200k token，会影响选择。
  exceeds200kTokens:
    permissionMode === 'plan' &&
    doesMostRecentAssistantMessageExceed200k(messagesForQuery),
})

// Ant 内部调试时，用 fetch wrapper dump prompts。
const dumpPromptsFetch = config.gates.isAnt
  ? createDumpPromptsFetch(toolUseContext.agentId ?? config.sessionId)
  : undefined
```

这一步不改消息数组。

它只是决定：

```text
这轮 callModel 用哪个 model。
是否给 API fetch 套一层 dumpPromptsFetch。
```

---

## 20. API 前保护：blocking limit

源码位置：`src/query.ts`。

```ts
let collapseOwnsIt = false
if (feature('CONTEXT_COLLAPSE')) {
  // 如果 contextCollapse 能处理 overflow，就不要在这里提前返回。
  collapseOwnsIt =
    (contextCollapse?.isContextCollapseEnabled() ?? false) &&
    isAutoCompactEnabled()
}

const mediaRecoveryEnabled =
  reactiveCompact?.isReactiveCompactEnabled() ?? false

if (
  // 如果刚 compact 成功，不需要再 blocking。
  !compactionResult &&

  // compact / session_memory 自己就是为了降 token，不能在这里挡住。
  querySource !== 'compact' &&
  querySource !== 'session_memory' &&

  // reactive compact 可用时，让真实 API 413 触发 reactive，而不是这里伪造错误。
  !(reactiveCompact?.isReactiveCompactEnabled() && isAutoCompactEnabled()) &&

  // contextCollapse 可用时，也让真实 API 413 给它恢复机会。
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
```

这一步解决的问题：

```text
如果自动 compact 被关闭，
而上下文已经接近硬限制，
就提前返回 prompt-too-long 风格错误。

这样用户还有机会手动 /compact。
```

为什么有很多 skip 条件：

```text
有些恢复机制必须看到真实 API 错误才能工作。
如果这里提前伪造错误，它们就没有机会恢复。
```

---

## 21. API 前保护：predictive autocompact

源码位置：`src/query.ts`。

```ts
if (!compactionResult && isAutoCompactEnabled()) {
  const model = toolUseContext.options.mainLoopModel

  // 当前上下文 token。
  const currentTokens =
    tokenCountWithEstimation(messagesForQuery) - snipTokensFreed

  // 估算本轮继续生成和工具调用可能增长多少。
  const estimatedGrowth = estimateMaxTurnGrowth(model)

  // 当前 token 如果已经超过这个阈值，本轮继续跑可能爆窗。
  const predictiveThreshold =
    getEffectiveContextWindowSize(model) - estimatedGrowth

  if (currentTokens > predictiveThreshold) {
    const predictiveResult = await deps.autocompact(
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

    if (predictiveResult.compactionResult) {
      messagesForQuery = buildPostCompactMessages(
        predictiveResult.compactionResult,
      )
      snipTokensFreed = 0
    }
  }
}
```

它和前面的 autocompact 区别：

```text
前面的 autocompact:
  判断“现在是否已经达到自动 compact 阈值”。

predictive autocompact:
  判断“现在还没爆，但本轮继续增长可能爆”。
```

---

## 22. callModel：真正请求模型

源码位置：`src/query.ts`。

```ts
for await (const message of deps.callModel({
  // userContext 在这里 prepend 到 messagesForQuery 前面。
  messages: prependUserContext(messagesForQuery, userContext),

  // fullSystemPrompt = systemPrompt + systemContext。
  systemPrompt: fullSystemPrompt,

  // thinking、tools、abort signal。
  thinkingConfig: toolUseContext.options.thinkingConfig,
  tools: toolUseContext.options.tools,
  signal: toolUseContext.abortController.signal,

  options: {
    // 权限上下文每次取最新 AppState。
    async getToolPermissionContext() {
      const appState = toolUseContext.getAppState()
      return appState.toolPermissionContext
    },

    // 本轮选中的模型。
    model: currentModel,

    // fallback model 可用时，API 层可以触发 fallback。
    fallbackModel,

    // fallback 发生时设置标志。
    onStreamingFallback: () => {
      streamingFallbackOccured = true
    },

    // querySource、agents、mcpTools 等都会传给 API 层。
    querySource,
    agents: toolUseContext.options.agentDefinitions.activeAgents,
    mcpTools: appState.mcp.tools,
    agentId: toolUseContext.agentId,
    langfuseTrace: toolUseContext.langfuseTrace,
  },
})) {
  // 每个流式 message 在循环体内处理。
}
```

代入第一轮：

```text
messagesForQuery = [u1]
userContext = 可能包含 CLAUDE.md / 环境信息

callModel 实际看到:
  prependUserContext([u1], userContext)
```

`deps.callModel` 实际是：

```text
queryModelWithStreaming
```

它会产出：

```text
assistant message
system event
API error synthetic assistant
stream event
```

---

## 23. streaming fallback：旧半截消息要 tombstone

模型流式过程中可能触发 fallback。

源码位置：`src/query.ts`。

```ts
if (streamingFallbackOccured) {
  // 之前已经 yield 出去的 assistant partial message 不能继续保留。
  // 它们可能带无效 thinking signature。
  for (const msg of assistantMessages) {
    yield { type: 'tombstone' as const, message: msg }
  }

  // 清空本次失败尝试留下的收集器。
  assistantMessages.length = 0
  toolResults.length = 0
  toolUseBlocks.length = 0
  needsFollowUp = false

  // 如果已经启动了 streaming tools，也要丢弃。
  if (streamingToolExecutor) {
    streamingToolExecutor.discard()
    streamingToolExecutor = new StreamingToolExecutor(
      toolUseContext.options.tools,
      canUseTool,
      toolUseContext,
    )
  }
}
```

为什么要 tombstone：

```text
旧模型半路 fallback。
之前流出来的 assistant 片段不能进入 transcript。
否则下一次 API 可能看到无效 thinking signature 或孤儿 tool_use。

tombstone 告诉 UI / transcript：刚才那条消息作废。
```

---

## 24. backfill tool_use input：给外部展示补字段，但不改原消息

源码位置：`src/query.ts`。

```ts
let yieldMessage: typeof message = message
if (message.type === 'assistant') {
  const assistantMsg = message as AssistantMessage
  const contentArr = Array.isArray(assistantMsg.message?.content)
    ? (assistantMsg.message.content as unknown as Array<{
        type: string
        input?: unknown
        name?: string
        [key: string]: unknown
      }>)
    : []

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

        // 工具可以补充“给外部看”的字段。
        tool.backfillObservableInput(inputCopy)

        // 只有新增字段时才克隆。
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
    // yield 用 clone。
    // 原 message 不改，避免 prompt cache 字节变化。
    yieldMessage = {
      ...message,
      message: {
        ...(assistantMsg.message ?? {}),
        content: clonedContent,
      },
    } as typeof message
  }
}
```

这一步有两个版本：

```text
yieldMessage:
  给 UI / SDK / transcript 看的版本，可能补了展示字段。

message:
  原始 API 消息，后面 push 到 assistantMessages。
  不修改，避免 prompt cache 前缀变。
```

---

## 25. withheld：可恢复错误先不 yield

源码位置：`src/query.ts`。

```ts
// 默认不隐藏当前流式消息。
let withheld = false

if (feature('CONTEXT_COLLAPSE')) {
  if (
    contextCollapse?.isWithheldPromptTooLong(
      message as Message,
      isPromptTooLongMessage as (msg: Message) => boolean,
      querySource,
    )
  ) {
    // contextCollapse 认为这是可恢复的 prompt-too-long，先别 yield。
    withheld = true
  }
}

if (reactiveCompact?.isWithheldPromptTooLong(message as Message)) {
  // reactive compact 也能恢复 prompt-too-long，先别 yield。
  withheld = true
}

if (
  mediaRecoveryEnabled &&
  reactiveCompact?.isWithheldMediaSizeError(message as Message)
) {
  // media-size 错误可能通过 reactive compact 恢复，先别 yield。
  withheld = true
}

if (isWithheldMaxOutputTokens(message)) {
  // max_output_tokens 后面可能走恢复路径，先别 yield。
  withheld = true
}

if (!withheld) {
  // 不可恢复或普通消息，立即输出给 UI / SDK。
  yield yieldMessage
}
```

为什么有些错误先不 yield：

```text
prompt-too-long:
  后面可能 reactive compact 后重试成功。

media-size:
  后面可能 reactive compact strip 后重试成功。

max_output_tokens:
  后面可能提高 maxOutputTokens 或加 recovery message 后继续。
```

如果提前 yield 错误：

```text
SDK / UI 可能认为本轮已经失败并停止监听。
但 queryLoop 后面其实还会恢复并 continue。
```

所以：

```text
可恢复错误:
  先 push 到 assistantMessages 供后面判断。
  暂时不 yield。

不可恢复或恢复失败:
  后面再 yield。
```

---

## 26. 收集 assistantMessages、toolUseBlocks，并启动 streaming tools

源码位置：`src/query.ts`。

```ts
if (message.type === 'assistant') {
  const assistantMessage = message as AssistantMessage

  // 原始 assistant message 放进本轮收集器。
  assistantMessages.push(assistantMessage)

  // 从 content 里找 tool_use。
  const msgToolUseBlocks = (
    Array.isArray(assistantMessage.message?.content)
      ? assistantMessage.message.content
      : []
  ).filter(
    (content: { type: string }) => content.type === 'tool_use',
  ) as ToolUseBlock[]

  if (msgToolUseBlocks.length > 0) {
    // 保存工具调用块。
    toolUseBlocks.push(...msgToolUseBlocks)

    // 只要有工具调用，本轮就不能直接 completed。
    needsFollowUp = true
  }

  if (
    streamingToolExecutor &&
    !toolUseContext.abortController.signal.aborted
  ) {
    for (const toolBlock of msgToolUseBlocks) {
      // 边流式输出边开始执行工具。
      streamingToolExecutor.addTool(toolBlock, assistantMessage)
    }
  }
}
```

代入第一轮：

```text
收到 a1:
  assistantMessages = [a1]
  msgToolUseBlocks = [Read(toolu_read_1)]
  toolUseBlocks = [Read(toolu_read_1)]
  needsFollowUp = true
```

这个判断比 `stop_reason` 更可靠：

```text
只要 content 里真的出现 tool_use，
queryLoop 就认为需要执行工具并继续。
```

---

## 27. streamingToolExecutor.getCompletedResults：流式期间收工具结果

源码位置：`src/query.ts`。

```ts
if (
  streamingToolExecutor &&
  !toolUseContext.abortController.signal.aborted
) {
  for (const result of streamingToolExecutor.getCompletedResults()) {
    if (result.message) {
      // 工具结果先 yield 给 UI / transcript。
      yield result.message

      // 再转成 API 能接受的 user tool_result message，放进 toolResults。
      toolResults.push(
        ...normalizeMessagesForAPI(
          [result.message],
          toolUseContext.options.tools,
        ).filter(_ => _.type === 'user'),
      )
    }
  }
}
```

为什么要 `normalizeMessagesForAPI`：

```text
工具执行 update.message 可能是内部 Message / Attachment。
下一轮拼进 state.messages 前，要保留 API 需要的 user tool_result 形态。
```

如果 Read 很快完成，流式期间可能已经得到：

```text
toolResults = [tr1]
```

如果没完成，后面工具执行分支会用 `getRemainingResults()` 等剩余结果。

---

## 28. cached microcompact boundary：等 API 回来才知道删了多少

源码位置：`src/query.ts`。

```ts
if (feature('CACHED_MICROCOMPACT') && pendingCacheEdits) {
  const lastAssistant = assistantMessages.at(-1)
  const usage = lastAssistant?.message.usage

  // API 返回的是累计值，所以要减 baseline。
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
```

为什么不在 microcompact 那一步直接 yield：

```text
cached microcompact 是让 API 服务端缓存删除内容。
客户端在 API 请求前只知道“准备删哪些 tool ids”。
真正删了多少 token，只有 API 响应 usage 里知道。
```

---

## 29. fallback 抛错路径：切换模型后重试同一请求

源码位置：`src/query.ts`。

```ts
if (innerError instanceof FallbackTriggeredError && fallbackModel) {
  // 切到 fallback model。
  currentModel = fallbackModel
  attemptWithFallback = true

  // 给已经出现但没有 tool_result 的 tool_use 补错误结果。
  yield* yieldMissingToolResultBlocks(
    assistantMessages,
    'Model fallback triggered',
  )

  // 清空本次失败尝试的收集器。
  assistantMessages.length = 0
  toolResults.length = 0
  toolUseBlocks.length = 0
  needsFollowUp = false

  // 丢弃旧 streaming tool executor，避免旧 tool_use_id 的结果漏进新请求。
  if (streamingToolExecutor) {
    streamingToolExecutor.discard()
    streamingToolExecutor = new StreamingToolExecutor(
      toolUseContext.options.tools,
      canUseTool,
      toolUseContext,
    )
  }

  // 更新主循环模型。
  toolUseContext.options.mainLoopModel = fallbackModel

  // 内部用户路径：不同模型的 thinking signature 不兼容，重试前要 strip。
  if (process.env.USER_TYPE === 'ant') {
    messagesForQuery = stripSignatureBlocks(messagesForQuery)
  }

  yield createSystemMessage(
    `Switched to ${renderModelName(innerError.fallbackModel)} due to high demand for ${renderModelName(innerError.originalModel)}`,
    'warning',
  )

  // 回到 attemptWithFallback while，重新 callModel。
  continue
}
```

为什么要补 `yieldMissingToolResultBlocks`：

```text
Anthropic 工具协议要求：
  assistant tool_use 必须有对应 user tool_result。

fallback 发生时，如果已经流出 tool_use 但不会继续了，
必须补一个 is_error 的 tool_result，
否则 transcript / 下一次 API 会出现孤儿 tool_use。
```

---

## 30. callModel 抛普通错误：补工具结果后结束

源码位置：`src/query.ts`。

```ts
} catch (error) {
  const errorMessage =
    error instanceof Error ? error.message : String(error)

  // 如果流式过程中已经出现 tool_use，
  // 这里补齐 tool_result，避免协议不完整。
  yield* yieldMissingToolResultBlocks(assistantMessages, errorMessage)

  // 再输出真正错误。
  yield createAssistantAPIErrorMessage({
    content: errorMessage,
  })

  return { reason: 'model_error', error }
}
```

这里和 fallback 的共同点：

```text
只要 assistantMessages 里有 tool_use，
而本轮不能正常进入工具执行阶段，
就必须补 tool_result。
```

---

## 31. 模型流正常结束后的公共收尾

源码位置：`src/query.ts`。

```ts
if (
  assistantMessages.length > 0 &&
  !toolUseContext.options.isNonInteractiveSession
) {
  const lastAssistant = assistantMessages.at(-1)
  const usage = lastAssistant?.message?.usage
  if (usage) {
    const warningInfo = shouldShowCacheWarning(
      usage,
      querySource,
      getCacheThreshold(),
    )
    if (warningInfo) {
      yield createCacheWarningMessage(warningInfo)
    }
  }
}

if (assistantMessages.length > 0) {
  // post-sampling hooks 不阻塞主流程。
  void executePostSamplingHooks(
    messagesForQuery.concat(assistantMessages),
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext,
    querySource,
  )
}
```

这里的输入：

```text
messagesForQuery:
  本轮模型调用前上下文。

assistantMessages:
  本轮模型输出。
```

组合：

```text
messagesForQuery.concat(assistantMessages)
```

表示：

```text
hooks 看的是“模型这轮到底基于什么上下文给了什么回答”。
```

---

## 32. streaming abort：用户在模型流式阶段中断

源码位置：`src/query.ts`。

```ts
if (toolUseContext.abortController.signal.aborted) {
  if (streamingToolExecutor) {
    // streaming tool executor 会为排队/进行中的工具生成 synthetic tool_result。
    for await (const update of streamingToolExecutor.getRemainingResults()) {
      if (update.message) {
        yield update.message
      }
    }
  } else {
    // 非 streaming 模式下，手动补 tool_result。
    yield* yieldMissingToolResultBlocks(
      assistantMessages,
      'Interrupted by user',
    )
  }

  if (toolUseContext.abortController.signal.reason !== 'interrupt') {
    yield createUserInterruptionMessage({
      toolUse: false,
    })
  }

  return { reason: 'aborted_streaming' }
}
```

为什么先补工具结果再返回：

```text
如果用户 Ctrl+C 时模型已经输出 tool_use，
但工具没有机会执行，
也要给每个 tool_use 配一个 tool_result。
```

`toolUse: false` 的意思：

```text
中断发生在模型流式阶段，不是在工具执行阶段。
```

---

## 33. pendingToolUseSummary：上一轮工具摘要现在才 yield

源码位置：`src/query.ts`。

```ts
if (pendingToolUseSummary) {
  // 这是上一轮工具执行后后台生成的摘要。
  const summary = await pendingToolUseSummary
  if (summary) {
    yield summary
  }
}
```

为什么是“上一轮”：

```text
工具执行结束后会启动 generateToolUseSummary。
这个摘要生成不阻塞下一轮 API 调用。

下一轮模型流式输出期间，它大概率已经完成。
所以在下一轮模型流结束后 yield。
```

它不影响 `messagesForQuery`。
它主要是给 UI / 外部消费者看的工具摘要。

---

## 34. 分岔点：needsFollowUp 决定结束还是执行工具

源码位置：`src/query.ts`。

```ts
if (!needsFollowUp) {
  // 没有 tool_use。
  // 先跑各种恢复和 hooks。
  // 都不要求继续时，return completed。
}

// 走到这里说明 needsFollowUp = true。
// 后面执行工具。
```

代入：

```text
普通回答:
  assistantMessages = [a_done]
  toolUseBlocks = []
  needsFollowUp = false
  -> 结束分支

模型请求 Read:
  assistantMessages = [a1]
  toolUseBlocks = [Read(toolu_read_1)]
  needsFollowUp = true
  -> 工具分支
```

这就是 agent loop 的关键分叉。

---

## 35. 没有 tool_use：先处理 prompt-too-long / media 恢复

源码位置：`src/query.ts`。

```ts
// 取本轮最后一条 assistant 消息。
// 可恢复错误也是 assistant synthetic error，所以从这里判断。
const lastMessage = assistantMessages.at(-1)

// prompt-too-long 错误：后面可能 collapse drain 或 reactive compact。
const isWithheld413 =
  lastMessage?.type === 'assistant' &&
  lastMessage.isApiErrorMessage &&
  isPromptTooLongMessage(lastMessage)

// media-size 错误：后面可能 reactive compact strip/retry。
const isWithheldMedia =
  mediaRecoveryEnabled &&
  reactiveCompact?.isWithheldMediaSizeError(lastMessage as Message)
```

如果是 prompt-too-long，先给 contextCollapse 一个恢复机会：

```ts
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
        // 下一轮使用 collapse drain 后的 messages。
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
```

如果 collapse 没恢复，就尝试 reactive compact：

```ts
if ((isWithheld413 || isWithheldMedia) && reactiveCompact) {
  // 用刚才导致 API 报错的 messagesForQuery 尝试紧急 compact。
  const compacted = await reactiveCompact.tryReactiveCompact({
    // 防止同一次失败无限 reactive compact。
    hasAttempted: hasAttemptedReactiveCompact,
    querySource,
    aborted: toolUseContext.abortController.signal.aborted,

    // 这里不能加 assistant error；compact 的输入是失败请求的原始上下文。
    messages: messagesForQuery,

    // compactConversation / forked summarizer 需要这些上下文。
    cacheSafeParams: {
      systemPrompt,
      userContext,
      systemContext,
      toolUseContext,
      forkContextMessages: messagesForQuery,
    },
  })

  if (compacted) {
    // compact 成功后，把 CompactionResult 变成新的消息数组。
    const postCompactMessages = buildPostCompactMessages(compacted)

    // 输出 compact boundary / summary / attachments。
    for (const msg of postCompactMessages) {
      yield msg
    }

    state = {
      // 下一轮用 compact 后的短上下文重试。
      messages: postCompactMessages,
      toolUseContext,
      autoCompactTracking: undefined,
      maxOutputTokensRecoveryCount,

      // 标记 reactive compact 已经尝试过，避免失败后循环 compact。
      hasAttemptedReactiveCompact: true,
      maxOutputTokensOverride: undefined,
      pendingToolUseSummary: undefined,
      stopHookActive: undefined,
      turnCount,
      transition: { reason: 'reactive_compact_retry' },
    }

    // 回 while 顶部重新 callModel。
    continue
  }
}
```

这两个 `continue` 的意思：

```text
不要结束 queryLoop。
换一组更短 messages，回 while 顶部重新 callModel。
```

---

## 36. 没有 tool_use：max_output_tokens 恢复

源码位置：`src/query.ts`。

```ts
if (isWithheldMaxOutputTokens(lastMessage)) {
  const capEnabled = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_otk_slot_v1',
    false,
  )

  if (
    capEnabled &&
    maxOutputTokensOverride === undefined &&
    !process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  ) {
    state = {
      // 同一批 messages 再请求一次。
      messages: messagesForQuery,
      toolUseContext,
      autoCompactTracking: tracking,
      maxOutputTokensRecoveryCount,
      hasAttemptedReactiveCompact,

      // 把下一轮 max output 提高到 ESCALATED_MAX_TOKENS。
      maxOutputTokensOverride: ESCALATED_MAX_TOKENS,

      pendingToolUseSummary: undefined,
      stopHookActive: undefined,
      turnCount,
      transition: { reason: 'max_output_tokens_escalate' },
    }
    continue
  }
```

如果提高上限后仍不够，就加一个 meta user message 让模型继续：

```ts
  if (maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
    const recoveryMessage = createUserMessage({
      content:
        `Output token limit hit. Resume directly — no apology, no recap of what you were doing. ` +
        `Pick up mid-thought if that is where the cut happened. Break remaining work into smaller pieces.`,
      isMeta: true,
    })

    state = {
      messages: [
        // 保留本轮入模上下文。
        ...messagesForQuery,

        // 保留刚才被截断的 assistant 输出。
        ...assistantMessages,

        // 加一条 meta 指令，让模型从中断处继续。
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
    continue
  }
}
```

这条恢复路径的关键：

```text
messages = messagesForQuery + assistantMessages + recoveryMessage

也就是：
  保留已经输出的半截回答，
  再告诉模型继续。
```

---

## 37. 没有 tool_use：API error 不跑 stop hooks

源码位置：`src/query.ts`。

```ts
if (lastMessage?.isApiErrorMessage) {
  // API error 不是模型正常回答。
  // stop hooks 不应该评估它，否则可能 error -> hook blocking -> retry -> error。
  void executeStopFailureHooks(lastMessage, toolUseContext)
  return {
    reason: 'model_error',
    error: lastMessage.error ?? lastMessage.apiError ?? 'api_error',
  }
}
```

这一步处理的是：

```text
rate limit
auth failure
prompt too long 恢复失败
其他 API synthetic assistant error
```

---

## 38. 没有 tool_use：stop hooks 可能阻止结束或要求继续

源码位置：`src/query.ts`。

```ts
const stopHookResult = yield* handleStopHooks(
  // 本轮入模前上下文。
  messagesForQuery,

  // 本轮模型回答。
  assistantMessages,

  // hooks 可能需要完整 prompt/context。
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

if (stopHookResult.blockingErrors.length > 0) {
  state = {
    messages: [
      // 保留原上下文。
      ...messagesForQuery,

      // 保留模型回答。
      ...assistantMessages,

      // 加 hook blocking errors，让下一轮模型修正。
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
  continue
}
```

两种结果：

```text
preventContinuation:
  hook 明确要求停止，queryLoop 结束。

blockingErrors:
  hook 给了问题列表，把它们拼进 messages，继续下一轮让模型修。
```

---

## 39. 没有 tool_use：token budget 可能让它继续

源码位置：`src/query.ts`。

```ts
if (feature('TOKEN_BUDGET')) {
  const decision = checkTokenBudget(
    budgetTracker!,
    toolUseContext.agentId,
    getCurrentTurnTokenBudget(),
    getTurnOutputTokens(),
  )

  if (decision.action === 'continue') {
    state = {
      messages: [
        // 保留本轮上下文。
        ...messagesForQuery,

        // 保留模型刚才的回答。
        ...assistantMessages,

        // 加预算提示，让模型继续完成任务。
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
}

return { reason: 'completed' }
```

所以没有工具调用时，真正结束前要过这些门：

```text
prompt-too-long / media recovery
max_output_tokens recovery
API error
stop hooks
token budget

都没有要求继续，才 completed。
```

---

## 40. 有 tool_use：进入工具执行分支

只要 `needsFollowUp = true`，代码会跳过完成分支，来到工具执行。

源码位置：`src/query.ts`。

```ts
let shouldPreventContinuation = false
let updatedToolUseContext = toolUseContext

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

const toolUpdates = streamingToolExecutor
  // streaming 模式：拿剩余还没完成的工具结果。
  ? streamingToolExecutor.getRemainingResults()

  // 普通模式：现在才统一执行所有工具。
  : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)
```

为什么 `updatedToolUseContext` 单独存在：

```text
某些工具执行后会返回 newContext。
比如权限状态、readFileState、工具状态可能变化。

本轮工具还没执行完时，先收集到 updatedToolUseContext。
最后进入下一轮 state 时再写回。
```

---

## 41. 工具 update：yield、收集 toolResults、更新上下文

源码位置：`src/query.ts`。

```ts
for await (const update of toolUpdates) {
  if (update.message) {
    // 工具执行消息先 yield 给 UI / transcript。
    yield update.message

    if (
      update.message.type === 'attachment' &&
      update.message.attachment!.type === 'hook_stopped_continuation'
    ) {
      // hook 要求后面不要继续。
      shouldPreventContinuation = true
    }

    // 把工具消息转换成下一轮模型能看的 user tool_result。
    toolResults.push(
      ...normalizeMessagesForAPI(
        [update.message],
        toolUseContext.options.tools,
      ).filter(_ => _.type === 'user'),
    )
  }

  if (update.newContext) {
    // 工具执行可以更新 ToolUseContext。
    updatedToolUseContext = {
      ...update.newContext,
      queryTracking,
    }
  }
}
```

代入 Read：

```text
toolUseBlocks:
  [Read(toolu_read_1)]

runTools 输出 update.message:
  tr1

toolResults:
  [tr1]

updatedToolUseContext:
  readFileState 里记录 src/query.ts 已读
```

---

## 42. 生成下一轮工具摘要，不阻塞下一轮 API

源码位置：`src/query.ts`。

```ts
let nextPendingToolUseSummary:
  | Promise<ToolUseSummaryMessage | null>
  | undefined

if (
  config.gates.emitToolUseSummaries &&
  toolUseBlocks.length > 0 &&
  !toolUseContext.abortController.signal.aborted &&
  !toolUseContext.agentId
) {
  // 找最后一个 assistant text，作为摘要上下文。
  const lastAssistantMessage = assistantMessages.at(-1)
  let lastAssistantText: string | undefined

  // 收集工具名、input、output。
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

    return {
      name: block.name,
      input: block.input,
      output: null,
    }
  })

  // 后台启动，不 await。
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
```

这个 promise 不在当前轮 yield。
它会写进下一轮 state：

```text
state.pendingToolUseSummary = nextPendingToolUseSummary
```

下一轮模型流结束后，才：

```text
await pendingToolUseSummary
yield summary
```

---

## 43. 工具阶段中断 / hook_stopped

源码位置：`src/query.ts`。

```ts
if (toolUseContext.abortController.signal.aborted) {
  if (toolUseContext.abortController.signal.reason !== 'interrupt') {
    yield createUserInterruptionMessage({
      // 中断发生在工具执行阶段。
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
```

区别：

```text
aborted_tools:
  用户或 abortController 中断了工具执行。

hook_stopped:
  工具 / hook 明确返回 hook_stopped_continuation attachment。
```

---

## 44. compact 后 turnCounter 记录

源码位置：`src/query.ts`。

```ts
if (tracking?.compacted) {
  // compact 后每进入一轮工具后续，都加一次 counter。
  tracking.turnCounter++

  logEvent('tengu_post_autocompact_turn', {
    turnId:
      tracking.turnId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    turnCounter: tracking.turnCounter,
    queryChainId: queryChainIdForAnalytics,
    queryDepth: queryTracking.depth,
  })
}
```

它的用途：

```text
记录自动 compact 后又连续跑了几轮。
下一次 recompaction 可以知道距离上次 compact 过了几轮。
```

---

## 45. 队列命令和附件注入前的状态

工具执行完后，当前有：

```text
messagesForQuery:
  本轮入模前上下文

assistantMessages:
  本轮模型请求工具的 assistant 消息

toolResults:
  工具执行结果

updatedToolUseContext:
  工具执行后更新过的上下文
```

源码打点：

```ts
logEvent('tengu_query_before_attachments', {
  // 本轮模型调用前的上下文数量。
  messagesForQueryCount: messagesForQuery.length,

  // 本轮模型输出消息数量。
  assistantMessagesCount: assistantMessages.length,

  // 到目前为止已经收集到的工具结果数量。
  toolResultsCount: toolResults.length,

  // 关联同一用户 turn 下的多轮 query。
  queryChainId: queryChainIdForAnalytics,
  queryDepth: queryTracking.depth,
})
```

为什么附件要在工具后注入：

```text
有些附件依赖刚执行完的工具状态：
  edited_text_file
  relevant_memories 去重
  nested memory triggers
  skill discovery
  queued commands
```

---

## 46. 队列命令转 attachment

源码位置：`src/query.ts`。

```ts
const sleepRan = toolUseBlocks.some(b => b.name === SLEEP_TOOL_NAME)
const isMainThread =
  querySource.startsWith('repl_main_thread') || querySource === 'sdk'
const currentAgentId = toolUseContext.agentId

const queuedCommandsSnapshot = getCommandsByMaxPriority(
  // Sleep 后 drain later，否则 drain next。
  sleepRan ? 'later' : 'next',
).filter(cmd => {
  // slash command 不作为普通文本发给模型。
  if (isSlashCommand(cmd)) return false

  // 主线程只消费没有 agentId 的命令。
  if (isMainThread) return cmd.agentId === undefined

  // subagent 只消费发给自己的 task-notification。
  return cmd.mode === 'task-notification' && cmd.agentId === currentAgentId
})

const queuedAutonomyClaim = await claimConsumableQueuedAutonomyCommands(
  queuedCommandsSnapshot,
)
```

这里解决的问题：

```text
工具执行期间，后台任务、shell、agent 可能产生通知。
这些通知要在下一轮模型之前转成附件，让模型知道外部状态变化。
```

被消费的命令会记录：

```ts
if (claimedConsumedCommands.length > 0) {
  // 给 query() finally 用：最终标记这些 autonomy commands 的结果。
  consumedAutonomyCommands.push(...claimedConsumedCommands)

  for (const cmd of claimedConsumedCommands) {
    if (cmd.uuid) {
      // 给 query() 返回后通知 command lifecycle completed。
      consumedCommandUuids.push(cmd.uuid)

      // 现在已经把命令转成附件，本轮开始消费它。
      notifyCommandLifecycle(cmd.uuid, 'started')
    }
  }

  // 从全局队列移除，避免下一轮重复注入。
  removeFromQueue(claimedConsumedCommands)
}
```

这些数组会被外层 `query()` 的 finally 用来最终标记 completed / failed / cancelled。

---

## 47. getAttachmentMessages：注入常规附件

源码位置：`src/query.ts`。

```ts
for await (const attachment of getAttachmentMessages(
  // input 这里传 null，因为不是用户输入初始附件路径。
  null,

  // 工具执行后的上下文。
  updatedToolUseContext,

  // context 参数这里传 null。
  null,

  // 队列命令转成的附件命令。
  queuedAutonomyClaim.attachmentCommands,

  // 当前完整本轮历史：
  // 入模前上下文 + 模型输出 + 工具结果。
  messagesForQuery.concat(assistantMessages, toolResults),

  // 调用来源。
  querySource,
)) {
  yield attachment
  toolResults.push(attachment)
}
```

为什么传：

```text
messagesForQuery.concat(assistantMessages, toolResults)
```

因为附件生成要知道：

```text
本轮之前模型看到了什么
本轮模型刚说了什么
工具刚返回了什么
```

比如：

```text
edited_text_file attachment:
  需要知道刚才是否编辑了文件。

queued command attachment:
  需要插入到下一轮模型能看的 toolResults。
```

---

## 48. 消费 memory / skill / tool discovery prefetch

源码位置：`src/query.ts`。

```ts
if (
  // prefetch 功能开启且启动成功。
  pendingMemoryPrefetch &&

  // 只在后台任务已经完成时消费；这里不会等待未完成任务。
  pendingMemoryPrefetch.settledAt !== null &&

  // 一次用户 turn 只消费一次。
  pendingMemoryPrefetch.consumedOnIteration === -1
) {
  // 过滤掉模型已经通过 Read/Write/Edit 看到过的 memory 文件。
  const memoryAttachments = filterDuplicateMemoryAttachments(
    await pendingMemoryPrefetch.promise,
    toolUseContext.readFileState,
  )

  for (const memAttachment of memoryAttachments) {
    // Attachment -> AttachmentMessage。
    const msg = createAttachmentMessage(memAttachment)

    // 先输出给 UI / transcript。
    yield msg

    // 再放进 toolResults，让下一轮模型看到。
    toolResults.push(msg)
  }

  // 记录已经在哪一轮消费，避免重复注入。
  pendingMemoryPrefetch.consumedOnIteration = turnCount - 1
}
```

这个检查的关键：

```text
settledAt !== null:
  只在已经完成时消费。
  不阻塞等待 memory sideQuery。

consumedOnIteration === -1:
  只消费一次。
```

然后 skill discovery：

```ts
if (skillPrefetch && pendingSkillPrefetch) {
  // 收集后台 skill discovery 结果；这个 collect 可以等待 skill prefetch 完成。
  const skillAttachments =
    await skillPrefetch.collectSkillDiscoveryPrefetch(pendingSkillPrefetch)

  for (const att of skillAttachments) {
    // skill 发现结果也作为 attachment 注入下一轮。
    const msg = createAttachmentMessage(att)
    yield msg
    toolResults.push(msg)
  }
}
```

再 tool discovery：

```ts
if (searchExtraToolsPrefetch && pendingToolPrefetch) {
  // 收集后台 extra tools discovery 结果。
  const toolAttachments =
    await searchExtraToolsPrefetch.collectSearchExtraToolsPrefetch(
      pendingToolPrefetch,
    )

  for (const att of toolAttachments) {
    // 新工具发现结果作为 attachment 注入下一轮。
    const msg = createAttachmentMessage(att)
    yield msg
    toolResults.push(msg)
  }
}
```

共同点：

```text
prefetch 阶段:
  尽早启动，和模型 / 工具并行。

consume 阶段:
  工具后统一注入 toolResults。

下一轮:
  state.messages 包含这些 attachments，模型可以看到。
```

---

## 49. refresh tools：下一轮工具列表可能变化

源码位置：`src/query.ts`。

```ts
if (updatedToolUseContext.options.refreshTools) {
  // 某些 MCP / 动态工具状态会在工具执行后变化。
  const refreshedTools = updatedToolUseContext.options.refreshTools()

  if (refreshedTools !== updatedToolUseContext.options.tools) {
    // 只在工具数组真的变化时创建新的 context。
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
  // 使用工具执行后更新过的上下文。
  ...updatedToolUseContext,

  // 保留同一条 query chain 的 tracking 信息。
  queryTracking,
}
```

为什么要在工具后刷新：

```text
MCP server 可能刚连接。
工具执行可能改变可用工具集合。

下一轮模型请求前，需要用新的工具 schema。
```

---

## 50. task summary 和 maxTurns

源码位置：`src/query.ts`。

```ts
const nextTurnCount = turnCount + 1

if (feature('BG_SESSIONS')) {
  if (
    !toolUseContext.agentId &&
    taskSummaryModule!.shouldGenerateTaskSummary()
  ) {
    // 后台 session 状态摘要，给 claude ps 等场景用。
    taskSummaryModule!.maybeGenerateTaskSummary({
      systemPrompt,
      userContext,
      systemContext,
      toolUseContext,
      forkContextMessages: messagesForQuery.concat(
        assistantMessages,
        toolResults,
      ),
    })
  }
}

if (maxTurns && nextTurnCount > maxTurns) {
  yield createAttachmentMessage({
    type: 'max_turns_reached',
    maxTurns,
    turnCount: nextTurnCount,
  })
  return { reason: 'max_turns', turnCount: nextTurnCount }
}
```

`maxTurns` 检查放在这里，因为：

```text
只有当本轮已经产生 toolResults、准备进入下一轮时，
turnCount 才需要 +1。
```

---

## 51. 写 next state：下一轮为什么要 concat 三段

源码位置：`src/query.ts`。

```ts
const next: State = {
  // 下一轮 while 顶部会从这个 messages 重新构造 messagesForQuery。
  messages: messagesForQuery.concat(assistantMessages, toolResults),

  // 工具执行后的上下文，带 queryTracking。
  toolUseContext: toolUseContextWithQueryTracking,

  // compact 跟踪状态继续带下去。
  autoCompactTracking: tracking,

  // 下一轮 turnCount。
  turnCount: nextTurnCount,

  // 新一轮正常工具后续，max output 恢复清零。
  maxOutputTokensRecoveryCount: 0,

  // 新一轮正常工具后续，reactive compact guard 重置。
  hasAttemptedReactiveCompact: false,

  // 工具摘要 promise 带到下一轮。
  pendingToolUseSummary: nextPendingToolUseSummary,

  // max output 临时覆盖清空。
  maxOutputTokensOverride: undefined,

  // stopHookActive 原样带下去。
  stopHookActive,

  // 标记这是普通工具后续。
  transition: { reason: 'next_turn' },
}

state = next
```

为什么必须是：

```text
messagesForQuery.concat(assistantMessages, toolResults)
```

因为下一轮模型需要看到完整链条：

```text
messagesForQuery:
  本轮模型调用前已经保留下来的历史。

assistantMessages:
  本轮模型刚说了什么、请求了哪些 tool_use。

toolResults:
  CLI 对这些 tool_use 返回了什么 tool_result / attachment。
```

代入：

```text
messagesForQuery:
  [u1]

assistantMessages:
  [a1: assistant 请求 Read]

toolResults:
  [tr1: Read 的 tool_result]

next.messages:
  [u1, a1, tr1]
```

下一轮 `while` 顶部：

```text
messages = [u1, a1, tr1]
messagesForQuery = getMessagesAfterCompactBoundary(messages)
```

模型下一轮才能理解：

```text
我刚才请求 Read。
现在 Read 的结果回来了。
我可以基于文件内容继续回答。
```

---

## 52. Terminal 和 Continue 对照表

`Terminal` 表示 `queryLoop` 真的结束：

```text
completed
  模型没有工具调用，恢复、hooks、预算都没有要求继续。

blocking_limit
  API 前硬限制触发，且没有恢复机制接管。

image_error
  图片 / media 错误恢复失败。

model_error
  API / runtime 错误。

aborted_streaming
  用户在模型流式阶段中断。

aborted_tools
  用户在工具执行阶段中断。

prompt_too_long
  prompt-too-long 恢复失败。

stop_hook_prevented
  stop hook 明确阻止继续。

hook_stopped
  工具 / hook 要求停止后续。

max_turns
  达到最大轮数。
```

`Continue` 表示 `queryLoop` 不结束，只换 state 回到 while 顶部：

```text
collapse_drain_retry
  contextCollapse drain 后重试。

reactive_compact_retry
  API 报太长后 compact，再重试。

max_output_tokens_escalate
  提高 max output 后重试同一请求。

max_output_tokens_recovery
  加 recovery meta message 后继续。

stop_hook_blocking
  stop hook 给了错误，要求模型修正。

token_budget_continuation
  token budget 让模型继续完成任务。

next_turn
  正常工具调用后续。
```

---

## 53. 一条完整时间线

```text
0. query(params)
   params.messages = [u1]

1. query() 创建 trace
   paramsWithTrace.toolUseContext.langfuseTrace = trace

2. queryLoop 初始化 state
   state.messages = [u1]
   state.turnCount = 1

3. while 第 1 轮开始
   messages = [u1]

4. 启动 memory prefetch
   pendingMemoryPrefetch 在 while 外已启动

5. 启动 per-iteration skill/tool prefetch
   pendingSkillPrefetch / pendingToolPrefetch

6. queryTracking
   { chainId: 'c1', depth: 0 }

7. 构造 messagesForQuery
   [u1]

8. 压缩 / 瘦身管线
   结果仍是 [u1]

9. 创建收集器
   assistantMessages = []
   toolResults = []
   toolUseBlocks = []
   needsFollowUp = false

10. callModel
    输入 prependUserContext([u1], userContext)

11. 流式收到 a1
    assistantMessages = [a1]
    toolUseBlocks = [Read(toolu_read_1)]
    needsFollowUp = true

12. needsFollowUp = true
    进入工具执行分支

13. 执行 Read
    toolResults = [tr1]
    updatedToolUseContext.readFileState 记录 src/query.ts

14. 工具后附件
    getAttachmentMessages(...)
    memory / skill / tool discovery prefetch 如果完成，也 push 到 toolResults

15. 写 next state
    state.messages = [u1, a1, tr1, maybeAttachments]
    state.turnCount = 2
    transition = { reason: 'next_turn' }

16. while 第 2 轮开始
    messages = [u1, a1, tr1, maybeAttachments]
    messagesForQuery = [u1, a1, tr1, maybeAttachments]

17. callModel
    模型看到 Read 结果，继续回答或继续调用工具

18. 如果第 2 轮没有 tool_use
    stop hooks / token budget 都不要求继续
    return { reason: 'completed' }

19. query() finally
    finalizeAutonomyCommandsForTurn
    endTrace
    flushLangfuse
    清理 trace 引用
```

---

## 54. 读源码时抓这五个问题

看到 `queryLoop` 里的任意一段代码，先问：

```text
1. 它发生在 callModel 前、流式过程中、流式后、工具前、工具后、还是退出清理？

2. 它改的是哪个数组？
   messagesForQuery
   assistantMessages
   toolUseBlocks
   toolResults
   state.messages

3. 它是阻塞等待，还是后台 prefetch？

4. 它会 return Terminal，还是 state = next 后 continue？

5. 它产生的东西下一次在哪里被消费？
```

把这五个问题套回几个关键点：

```text
startRelevantMemoryPrefetch:
  while 外启动，工具后消费，写入 toolResults，using 负责退出清理。

assistantMessages:
  callModel 流式过程中 push，stop hooks / 下一轮 state 会消费。

toolUseBlocks:
  从 assistantMessages 抽取，工具执行分支消费。

toolResults:
  工具执行和附件注入阶段 push，下一轮 state.messages 消费。

messagesForQuery:
  每轮从 state.messages 加工出来，callModel 消费。

state.messages:
  每次 continue 前写入，下一轮 while 顶部消费。
```

---

## 55. 源码定位索引

```text
src/query.ts
  query()
    外层 trace / autonomy command lifecycle / cleanup

  queryLoop()
    主循环

  yieldMissingToolResultBlocks()
    失败、fallback、中断时补 tool_result

src/query/deps.ts
  productionDeps()
    callModel / microcompact / autocompact / uuid 注入

src/query/config.ts
  buildQueryConfig()
    streamingToolExecution、tool summary、fast mode 等运行时开关

src/query/transitions.ts
  Terminal / Continue 类型

src/query/stopHooks.ts
  handleStopHooks()

src/services/api/claude.ts
  queryModelWithStreaming()

src/services/tools/toolOrchestration.ts
  runTools()

src/services/tools/StreamingToolExecutor.ts
  streaming tool execution

src/utils/attachments.ts
  getAttachmentMessages()
  startRelevantMemoryPrefetch()
  filterDuplicateMemoryAttachments()

src/services/compact/autoCompact.ts
  autoCompactIfNeeded()

src/services/compact/microCompact.ts
  microcompactMessages()
```
