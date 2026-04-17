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
  // 这一层先把真正不会变的参数解构出来。
  // 后面 while(true) 每轮都会继续用，但这些值本身不应该被改。
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

## 6. 你应该怎样逐步读这个方法

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

## 7. 这一讲读完后，下一步该深挖哪里

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

## 8. 一句话总结

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
