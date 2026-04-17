# `runHeadlessStreaming()` 全方法抄录 + 分段讲解

> 目标：把 `src/cli/print.ts` 里的 `runHeadlessStreaming()` 整个方法按源码顺序贴出来，并且每一段下面直接写中文解释。

这次不走“只讲概念”的路线，直接按源码本身来。

阅读方式只有一条：

```text
先看代码块，再看代码块下面的解释。
从上往下，不跳。
```

先记住这张总图，后面所有代码都只是这张图的展开：

```text
外部输入
   |
   v
structuredIO.structuredInput
   |
   +--> control_request -----> 立即处理并回 control_response
   |
   +--> assistant/system ----> 写入 mutableMessages
   |
   +--> user ----------------> enqueue(prompt) -> run()
                                              |
                                              v
                                             ask()
                                              |
                                              v
                                  structuredIO.outbound / output
```

再记住这句话：

```text
runHeadlessStreaming() = 输入循环 + 内部队列 + run() 主执行器 + ask() 输出转发
```

---

## 1. 方法开头：参数、状态变量、输出流、基础监听（源码行 970-1187）

```ts
function runHeadlessStreaming(
  // 统一的 headless I/O，对外部输入输出都从这里进出。
  structuredIO: StructuredIO,
  // 启动时已有的 MCP 连接；后面运行中还会再叠加 SDK MCP 和动态 MCP。
  mcpClients: MCPServerConnection[],
  commands: Command[],
  tools: Tools,
  // 会话初始消息，后面会被直接拿来作为可变 transcript。
  initialMessages: Message[],
  canUseTool: CanUseToolFn,
  sdkMcpConfigs: Record<string, McpSdkServerConfig>,
  getAppState: () => AppState,
  setAppState: (f: (prev: AppState) => AppState) => void,
  agents: AgentDefinition[],
  options: {
    verbose: boolean | undefined
    jsonSchema: Record<string, unknown> | undefined
    permissionPromptToolName: string | undefined
    allowedTools: string[] | undefined
    thinkingConfig: ThinkingConfig | undefined
    maxTurns: number | undefined
    maxBudgetUsd: number | undefined
    taskBudget: { total: number } | undefined
    systemPrompt: string | undefined
    appendSystemPrompt: string | undefined
    userSpecifiedModel: string | undefined
    fallbackModel: string | undefined
    replayUserMessages?: boolean | undefined
    includePartialMessages?: boolean | undefined
    enableAuthStatus?: boolean | undefined
    agent?: string | undefined
    setSDKStatus?: (status: SDKStatus) => void
    promptSuggestions?: boolean | undefined
    workload?: string | undefined
  },
  turnInterruptionState?: TurnInterruptionState,
): AsyncIterable<StdoutMessage> {
  // 总锁：同一时刻只能有一个 run() 在消费内部队列。
  let running = false
  // 记录 run 当前在哪个阶段，主要给诊断日志用。
  let runPhase:
    | 'draining_commands'
    | 'waiting_for_agents'
    | 'finally_flush'
    | 'finally_post_flush'
    | undefined
  // 输入流是否已经结束。结束输入不代表立刻结束整个会话。
  let inputClosed = false
  let shutdownPromptInjected = false
  // 最终 result 有时要延后发，这里就是临时存放点。
  let heldBackResult: StdoutMessage | null = null
  // 当前 ask 的中断控制器。
  let abortController: AbortController | undefined
  // 整个函数最后 return 给外部的就是这个输出流。
  const output = structuredIO.outbound

  // Ctrl+C：先中断 ask，再优雅退出，而不是粗暴直接结束进程。
  const sigintHandler = () => {
    logForDiagnosticsNoPII('info', 'shutdown_signal', { signal: 'SIGINT' })
    if (abortController && !abortController.signal.aborted) {
      abortController.abort()
    }
    void gracefulShutdown(0)
  }
  process.on('SIGINT', sigintHandler)

  // 进程清理时把当前 run 的状态打出来，方便定位卡死位置。
  registerCleanup(async () => {
    const bg: Record<string, number> = {}
    for (const t of getRunningTasks(getAppState())) {
      if (isBackgroundTask(t)) bg[t.type] = (bg[t.type] ?? 0) + 1
    }
    logForDiagnosticsNoPII('info', 'run_state_at_shutdown', {
      run_active: running,
      run_phase: runPhase,
      worker_status: getSessionState(),
      internal_events_pending: structuredIO.internalEventsPending,
      bg_tasks: bg,
    })
  })

  // 只要 permission mode 变化，就往 output 发一条 status 事件。
  setPermissionModeChangedListener(newMode => {
    if (
      newMode === 'default' ||
      newMode === 'acceptEdits' ||
      newMode === 'bypassPermissions' ||
      newMode === 'plan' ||
      newMode === (feature('TRANSCRIPT_CLASSIFIER') && 'auto') ||
      newMode === 'dontAsk'
    ) {
      output.enqueue({
        type: 'system',
        subtype: 'status',
        status: null,
        permissionMode: newMode as PermissionMode,
        uuid: randomUUID(),
        session_id: getSessionId(),
      })
    }
  })

  // suggestion 推送态：记录 suggestion 的中断、在途 promise、已发/待发状态。
  const suggestionState: {
    abortController: AbortController | null
    inflightPromise: Promise<void> | null
    lastEmitted: {
      text: string
      emittedAt: number
      promptId: PromptVariant
      generationRequestId: string | null
    } | null
    pendingSuggestion: {
      type: 'prompt_suggestion'
      suggestion: string
      uuid: UUID
      session_id: string
    } | null
    pendingLastEmittedEntry: {
      text: string
      promptId: PromptVariant
      generationRequestId: string | null
    } | null
  } = {
    abortController: null,
    inflightPromise: null,
    lastEmitted: null,
    pendingSuggestion: null,
    pendingLastEmittedEntry: null,
  }

  // 如果启用了鉴权状态上报，就把 AWS 鉴权过程持续转发给 output。
  let unsubscribeAuthStatus: (() => void) | undefined
  if (options.enableAuthStatus) {
    const authStatusManager = AwsAuthStatusManager.getInstance()
    unsubscribeAuthStatus = authStatusManager.subscribe(status => {
      output.enqueue({
        type: 'auth_status',
        isAuthenticating: status.isAuthenticating,
        output: status.output,
        error: status.error,
        uuid: randomUUID(),
        session_id: getSessionId(),
      })
    })
  }

  // 把 rate limit 的变化也转换成 SDK 事件流。
  const rateLimitListener = (limits: ClaudeAILimits) => {
    const rateLimitInfo = toSDKRateLimitInfo(limits)
    if (rateLimitInfo) {
      output.enqueue({
        type: 'rate_limit_event',
        rate_limit_info: rateLimitInfo,
        uuid: randomUUID(),
        session_id: getSessionId(),
      } as unknown as Parameters<typeof output.enqueue>[0])
    }
  }
  statusListeners.add(rateLimitListener)

  // 当前会话的可变消息历史。ask() 会直接读写这里。
  const mutableMessages: Message[] = initialMessages

  // 文件阅读状态缓存：记录模型已经读过哪些文件、读到什么内容。
  let readFileState = extractReadFilesFromMessages(
    initialMessages,
    cwd(),
    READ_FILE_STATE_CACHE_SIZE,
  )

  // 并发缓冲区：外部补进来的 read state 先放这里，等下一轮 ask 再合并。
  const pendingSeeds = createFileStateCacheWithSizeLimit(
    READ_FILE_STATE_CACHE_SIZE,
  )

  // 如果上一次会话被打断，这里负责把被打断的 prompt 重新塞回队列自动恢复。
  const resumeInterruptedTurnEnv =
    process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN
  if (
    turnInterruptionState &&
    turnInterruptionState.kind !== 'none' &&
    resumeInterruptedTurnEnv
  ) {
    logForDebugging(
      `[print.ts] Auto-resuming interrupted turn (kind: ${turnInterruptionState.kind})`,
    )

    // 先从 transcript 里删掉被打断的消息，再重新入队，保证模型只看见一次。
    removeInterruptedMessage(mutableMessages, turnInterruptionState.message)
    enqueue({
      mode: 'prompt',
      value: turnInterruptionState.message.message!.content as string | ContentBlockParam[],
      uuid: randomUUID(),
    })
  }

```

这一段是整个方法的地基。

先只认这几个变量：

- `running`：当前 `run()` 有没有正在跑。它是总锁。
- `runPhase`：当前 run 卡在哪个阶段，给诊断日志用。
- `inputClosed`：输入流有没有结束。
- `heldBackResult`：最终 `result` 是否暂时压住不发。
- `abortController`：当前 ask 能不能被中断。
- `output`：整个函数最终返回给外部的输出流。

接着看几个监听：

- `SIGINT`：按 `Ctrl+C` 时，中断当前 ask，然后优雅退出。
- `registerCleanup(...)`：进程关停时，把当前 run 的状态打出来，方便排查“卡在什么地方”。
- `setPermissionModeChangedListener(...)`：只要 permission mode 变了，就往 `output` 发一条 `system/status`。
- `auth_status` / `rate_limit_event`：这两个是附加状态流，和主线无关，但说明这里也是 SDK 事件汇流层。

然后是两个共享运行状态：

- `mutableMessages`：当前会话的可变消息历史。
- `readFileState`：当前会话的文件阅读历史。

`pendingSeeds` 的作用是解决并发：输入循环和 ask 会同时存在，外部补种的 read state 不能直接写进主缓存，否则 ask 结束时可能把它覆盖掉，所以先放到 `pendingSeeds`，下一轮 ask 再合并。

最后的 auto-resume 逻辑你第一遍只要知道一件事：

```text
如果上次中断了，而且环境允许恢复，就把那条被打断的消息重新塞回队列。
```

---

## 2. 模型信息、breadcrumb、SDK MCP 初始化（源码行 1188-1460）

```ts
  // 先整理当前可用模型的能力信息，供 initialize / set_model 等控制逻辑复用。
  const modelOptions = getModelOptions()
  const modelInfos = modelOptions.map(option => {
    const modelId = option.value === null ? 'default' : option.value
    const resolvedModel =
      modelId === 'default'
        ? getDefaultMainLoopModel()
        : parseUserSpecifiedModel(modelId)
    const hasEffort = modelSupportsEffort(resolvedModel)
    const hasAdaptiveThinking = modelSupportsAdaptiveThinking(resolvedModel)
    const hasFastMode = isFastModeSupportedByModel(option.value)
    const hasAutoMode = modelSupportsAutoMode(resolvedModel)
    return {
      name: modelId,
      value: modelId,
      displayName: option.label,
      description: option.description,
      ...(hasEffort && {
        supportsEffort: true,
        supportedEffortLevels: modelSupportsMaxEffort(resolvedModel)
          ? [...EFFORT_LEVELS]
          : EFFORT_LEVELS.filter(l => l !== 'max'),
      }),
      ...(hasAdaptiveThinking && { supportsAdaptiveThinking: true }),
      ...(hasFastMode && { supportsFastMode: true }),
      ...(hasAutoMode && { supportsAutoMode: true }),
    }
  })
  // 当前会话正在使用的模型名，运行中可以被改写。
  let activeUserSpecifiedModel = options.userSpecifiedModel

  // 模型切换时，把“切换发生过”这件事写回消息历史。
  function injectModelSwitchBreadcrumbs(
    modelArg: string,
    resolvedModel: string,
  ): void {
    const breadcrumbs = createModelSwitchBreadcrumbs(
      modelArg,
      modelDisplayString(resolvedModel),
    )
    mutableMessages.push(...breadcrumbs)
    for (const crumb of breadcrumbs) {
      if (
        typeof crumb.message.content === 'string' &&
        crumb.message.content.includes(`<${LOCAL_COMMAND_STDOUT_TAG}>`)
      ) {
        output.enqueue({
          type: 'user',
          content: crumb.message.content,
          message: crumb.message as unknown,
          session_id: getSessionId(),
          parent_tool_use_id: null,
          uuid: crumb.uuid,
          timestamp: crumb.timestamp,
          isReplay: true,
        } as unknown as StdoutMessage)
      }
    }
  }

  // 这一组缓存的是 SDK 那一路的 MCP 连接和工具。
  let sdkClients: MCPServerConnection[] = []
  let sdkTools: Tools = []

  // 记录哪些 client 已经注册过 elicitation handler。
  const elicitationRegistered = new Set<string>()

  // 给 MCP client 挂上 elicitation 请求/完成处理器。
  function registerElicitationHandlers(clients: MCPServerConnection[]): void {
    for (const connection of clients) {
      if (
        connection.type !== 'connected' ||
        elicitationRegistered.has(connection.name)
      ) {
        continue
      }
      // SDK 类型的 MCP 不走这里。
      if (connection.config.type === 'sdk') {
        continue
      }
      const serverName = connection.name

      // 有些 client 没有声明 elicitation capability，这里直接 try/catch 包住。
      try {
        connection.client.setRequestHandler(
          ElicitRequestSchema,
          async (request, extra) => {
            logMCPDebug(
              serverName,
              `Elicitation request received in print mode: ${jsonStringify(request)}`,
            )

            const mode = request.params.mode === 'url' ? 'url' : 'form'

            logEvent('tengu_mcp_elicitation_shown', {
              mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })

            // 先跑 hook；hook 如果能直接回答，就不再转发给 SDK 消费方。
            const hookResponse = await runElicitationHooks(
              serverName,
              request.params,
              extra.signal,
            )
            if (hookResponse) {
              logMCPDebug(
                serverName,
                `Elicitation resolved by hook: ${jsonStringify(hookResponse)}`,
              )
              logEvent('tengu_mcp_elicitation_response', {
                mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
                action:
                  hookResponse.action as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              })
              return hookResponse
            }

            // hook 没接住，再通过控制协议转给 SDK 消费方处理。
            const url =
              'url' in request.params
                ? (request.params.url as string)
                : undefined
            const requestedSchema =
              'requestedSchema' in request.params
                ? (request.params.requestedSchema as
                    | Record<string, unknown>
                    | undefined)
                : undefined

            const elicitationId =
              'elicitationId' in request.params
                ? (request.params.elicitationId as string | undefined)
                : undefined

            const rawResult = await structuredIO.handleElicitation(
              serverName,
              request.params.message,
              requestedSchema,
              extra.signal,
              mode,
              url,
              elicitationId,
            )

            const result = await runElicitationResultHooks(
              serverName,
              rawResult,
              extra.signal,
              mode,
              elicitationId,
            )

            logEvent('tengu_mcp_elicitation_response', {
              mode: mode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              action:
                result.action as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
            return result
          },
        )

        // 把 elicitation 完成也转成一个 system 事件发给外部。
        connection.client.setNotificationHandler(
          ElicitationCompleteNotificationSchema,
          notification => {
            const { elicitationId } = notification.params
            logMCPDebug(
              serverName,
              `Elicitation completion notification: ${elicitationId}`,
            )
            void executeNotificationHooks({
              message: `MCP server "${serverName}" confirmed elicitation ${elicitationId} complete`,
              notificationType: 'elicitation_complete',
            })
            output.enqueue({
              type: 'system',
              subtype: 'elicitation_complete',
              mcp_server_name: serverName,
              elicitation_id: elicitationId,
              uuid: randomUUID(),
              session_id: getSessionId(),
            })
          },
        )

        elicitationRegistered.add(serverName)
      } catch {
        // 没有相关 capability 的 client，静默跳过即可。
      }
    }
  }

  // 每次 run 前都需要把 SDK MCP 的配置同步成最新的 client / tool 视图。
  async function updateSdkMcp() {
    const currentServerNames = new Set(Object.keys(sdkMcpConfigs))
    const connectedServerNames = new Set(sdkClients.map(c => c.name))

    const hasNewServers = Array.from(currentServerNames).some(
      name => !connectedServerNames.has(name),
    )
    const hasRemovedServers = Array.from(connectedServerNames).some(
      name => !currentServerNames.has(name),
    )
    const hasPendingSdkClients = sdkClients.some(c => c.type === 'pending')
    const hasFailedSdkClients = sdkClients.some(c => c.type === 'failed')

    const haveServersChanged =
      hasNewServers ||
      hasRemovedServers ||
      hasPendingSdkClients ||
      hasFailedSdkClients

    if (haveServersChanged) {
      // 先清理已经被删除的旧连接。
      for (const client of sdkClients) {
        if (!currentServerNames.has(client.name)) {
          if (client.type === 'connected') {
            await client.cleanup()
          }
        }
      }

      // 再按当前配置整体重建一遍 SDK MCP client 和工具列表。
      const sdkSetup = await setupSdkMcpClients(
        sdkMcpConfigs,
        (serverName, message) =>
          structuredIO.sendMcpMessage(serverName, message),
      )
      sdkClients = sdkSetup.clients
      sdkTools = sdkSetup.tools

      // 顺手把 SDK MCP tools 同步进 appState。
      const allSdkNames = uniq([...connectedServerNames, ...currentServerNames])
      setAppState(prev => ({
        ...prev,
        mcp: {
          ...prev.mcp,
          tools: [
            ...prev.mcp.tools.filter(
              t =>
                !allSdkNames.some(name =>
                  t.name.startsWith(getMcpPrefix(name)),
                ),
            ),
            ...sdkTools,
          ],
        },
      }))

      // 如果需要，再接上内部专用的 VSCode SDK MCP server。
      setupVscodeSdkMcp(sdkClients)
    }
  }

  // 先异步触发一次 SDK MCP 更新；真正 ask 前，run() 里还会再刷新。
  void updateSdkMcp()

```

这一段开始进入“给后面的 run() 准备运行环境”。

这里先做模型信息整理：

- `modelOptions` -> `modelInfos`
- `activeUserSpecifiedModel`
- `injectModelSwitchBreadcrumbs(...)`

其中 `injectModelSwitchBreadcrumbs(...)` 很重要，它不是给 UI 用的，而是把“模型切换发生过”这件事写回消息历史，让后面的会话上下文也知道。

后面是 SDK MCP 相关的初始化：

- `sdkClients`
- `sdkTools`
- `elicitationRegistered`
- `registerElicitationHandlers(...)`
- `updateSdkMcp()`

这部分的核心思想是：

```text
MCP 不是静态一次性初始化的。
headless 会话跑着跑着，server 可能新增、删除、失败、重连。
所以每次真正执行前，都要能拿到最新的 SDK MCP 状态。
```

`registerElicitationHandlers(...)` 的意思可以粗暴理解成：

```text
如果某个 MCP server 会向客户端要额外输入（elicitation），就在这里把处理器挂上。
```

`updateSdkMcp()` 则负责：

- 对比当前 server 列表和已连接 client 列表
- 发现新增 / 删除 / pending / failed
- 重新建 SDK MCP client
- 同步 `sdkTools`
- 写回 appState 里的 MCP tools

第一遍你不用深究每个分支，只要记：

```text
这一大段在做“本会话的动态 MCP 运行环境维护”。
```

---

## 3. 动态 MCP、工具池、插件热更新、proactive 和中断订阅（源码行 1461-1860）

```ts
  // 动态 MCP：运行中通过 control_request 加进来的 MCP server 走这里。
  let dynamicMcpState: DynamicMcpState = {
    clients: [],
    tools: [],
    configs: {},
  }

  // 真正喂给 ask 的工具池每轮都在这里现算。
  const buildAllTools = (appState: AppState): Tools => {
    const assembledTools = assembleToolPool(
      appState.toolPermissionContext,
      appState.mcp.tools,
    )
    let allTools = uniqBy(
      mergeAndFilterTools(
        [...tools, ...sdkTools, ...dynamicMcpState.tools],
        assembledTools,
        appState.toolPermissionContext.mode,
      ),
      'name',
    )
    if (options.permissionPromptToolName) {
      allTools = allTools.filter(
        tool => !toolMatchesName(tool, options.permissionPromptToolName!),
      )
    }
    const initJsonSchema = getInitJsonSchema()
    if (initJsonSchema && !options.jsonSchema) {
      const syntheticOutputResult = createSyntheticOutputTool(initJsonSchema)
      if ('tool' in syntheticOutputResult) {
        allTools = [...allTools, syntheticOutputResult.tool]
      }
    }
    return allTools
  }

  // bridge 是 remote_control 的远程句柄。
  let bridgeHandle: ReplBridgeHandle | null = null
  let bridgeLastForwardedIndex = 0

  // 把新增的 user / assistant 消息同步给 bridge。
  function forwardMessagesToBridge(): void {
    if (!bridgeHandle) return
    const startIndex = Math.min(
      bridgeLastForwardedIndex,
      mutableMessages.length,
    )
    const newMessages = mutableMessages
      .slice(startIndex)
      .filter(m => m.type === 'user' || m.type === 'assistant')
    bridgeLastForwardedIndex = mutableMessages.length
    if (newMessages.length > 0) {
      bridgeHandle.writeMessages(newMessages)
    }
  }

  // 序列化应用 MCP server 变更，避免多个调用并发互相踩状态。
  let mcpChangesPromise: Promise<{
    response: SDKControlMcpSetServersResponse
    sdkServersChanged: boolean
  }> = Promise.resolve({
    response: {
      added: [] as string[],
      removed: [] as string[],
      errors: {} as Record<string, string>,
    },
    sdkServersChanged: false,
  })

  function applyMcpServerChanges(
    servers: Record<string, McpServerConfigForProcessTransport>,
  ): Promise<{
    response: SDKControlMcpSetServersResponse
    sdkServersChanged: boolean
  }> {
    const doWork = async (): Promise<{
      response: SDKControlMcpSetServersResponse
      sdkServersChanged: boolean
    }> => {
      const oldSdkClientNames = new Set(sdkClients.map(c => c.name))

      const result = await handleMcpSetServers(
        servers,
        { configs: sdkMcpConfigs, clients: sdkClients, tools: sdkTools },
        dynamicMcpState,
        setAppState,
      )

      for (const key of Object.keys(sdkMcpConfigs)) {
        delete sdkMcpConfigs[key]
      }
      Object.assign(sdkMcpConfigs, result.newSdkState.configs)
      sdkClients = result.newSdkState.clients
      sdkTools = result.newSdkState.tools
      dynamicMcpState = result.newDynamicState

      if (result.sdkServersChanged) {
        const newSdkClientNames = new Set(sdkClients.map(c => c.name))
        const allSdkNames = uniq([...oldSdkClientNames, ...newSdkClientNames])
        setAppState(prev => ({
          ...prev,
          mcp: {
            ...prev.mcp,
            tools: [
              ...prev.mcp.tools.filter(
                t =>
                  !allSdkNames.some(name =>
                    t.name.startsWith(getMcpPrefix(name)),
                  ),
              ),
              ...sdkTools,
            ],
          },
        }))
      }

      return {
        response: result.response,
        sdkServersChanged: result.sdkServersChanged,
      }
    }

    mcpChangesPromise = mcpChangesPromise.then(doWork, doWork)
    return mcpChangesPromise
  }

  // 把当前所有 MCP 连接整理成 SDK 可消费的 server 状态数组。
  function buildMcpServerStatuses(): McpServerStatus[] {
    const currentAppState = getAppState()
    const currentMcpClients = currentAppState.mcp.clients
    const allMcpTools = uniqBy(
      [...currentAppState.mcp.tools, ...dynamicMcpState.tools],
      'name',
    )
    const existingNames = new Set([
      ...currentMcpClients.map(c => c.name),
      ...sdkClients.map(c => c.name),
    ])
    return [
      ...currentMcpClients,
      ...sdkClients,
      ...dynamicMcpState.clients.filter(c => !existingNames.has(c.name)),
    ].map(connection => {
      let config
      if (
        connection.config.type === 'sse' ||
        connection.config.type === 'http'
      ) {
        config = {
          type: connection.config.type,
          url: connection.config.url,
          headers: connection.config.headers,
          oauth: connection.config.oauth,
        }
      } else if (connection.config.type === 'claudeai-proxy') {
        config = {
          type: 'claudeai-proxy' as const,
          url: connection.config.url,
          id: connection.config.id,
        }
      } else if (
        connection.config.type === 'stdio' ||
        connection.config.type === undefined
      ) {
        const stdioConfig = connection.config as { command: string; args: string[] }
        config = {
          type: 'stdio' as const,
          command: stdioConfig.command,
          args: stdioConfig.args,
        }
      }
      const serverTools =
        connection.type === 'connected'
          ? filterToolsByServer(allMcpTools, connection.name).map(tool => ({
              name: tool.mcpInfo?.toolName ?? tool.name,
              annotations: {
                readOnly: tool.isReadOnly({}) || undefined,
                destructive: tool.isDestructive?.({}) || undefined,
                openWorld: tool.isOpenWorld?.({}) || undefined,
              },
            }))
          : undefined
      let capabilities: { experimental?: Record<string, unknown> } | undefined
      if (
        (feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
        connection.type === 'connected' &&
        connection.capabilities.experimental
      ) {
        const exp = { ...connection.capabilities.experimental }
        if (
          exp['claude/channel'] &&
          (!isChannelsEnabled() ||
            !isChannelAllowlisted(connection.config.pluginSource))
        ) {
          delete exp['claude/channel']
        }
        if (Object.keys(exp).length > 0) {
          capabilities = { experimental: exp }
        }
      }
      return {
        name: connection.name,
        status: connection.type as McpServerStatus['status'],
        serverInfo:
          connection.type === 'connected' ? connection.serverInfo : undefined,
        error: connection.type === 'failed' ? connection.error : undefined,
        config,
        scope: connection.config.scope,
        tools: serverTools,
        capabilities,
      }
    }) as McpServerStatus[]
  }

  // 后台安装插件，并把插件带来的 MCP 变化同步进当前会话。
  async function installPluginsAndApplyMcpInBackground(): Promise<void> {
    try {
      await Promise.all([
        feature('DOWNLOAD_USER_SETTINGS') &&
        (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) || getIsRemoteMode())
          ? withDiagnosticsTiming('headless_user_settings_download', () =>
              downloadUserSettings(),
            )
          : Promise.resolve(),
        withDiagnosticsTiming('headless_managed_settings_wait', () =>
          waitForRemoteManagedSettingsToLoad(),
        ),
      ])

      const pluginsInstalled = await installPluginsForHeadless()

      if (pluginsInstalled) {
        await applyPluginMcpDiff()
      }
    } catch (error) {
      logError(error)
    }
  }

  // 这里决定插件安装是同步等待还是后台进行。
  let pluginInstallPromise: Promise<void> | null = null
  if (!isBareMode()) {
    if (isEnvTruthy(process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL)) {
      pluginInstallPromise = installPluginsAndApplyMcpInBackground()
    } else {
      void installPluginsAndApplyMcpInBackground()
    }
  }

  // 空闲超时管理。
  const idleTimeout = createIdleTimeoutManager(() => !running)

  // 支持热更新，所以 commands / agents 用可变引用保存当前值。
  let currentCommands = commands
  let currentAgents = agents

  // 插件刷新后，要同步重载 commands / agents / hooks。
  async function refreshPluginState(): Promise<void> {
    const { agentDefinitions: freshAgentDefs } =
      await refreshActivePlugins(setAppState)

    currentCommands = await getCommands(cwd())

    const sdkAgents = currentAgents.filter(a => a.source === 'flagSettings')
    currentAgents = [...freshAgentDefs.allAgents, ...sdkAgents]
  }

  // 插件刷新后，如果 MCP 配置也变了，这里重做一轮 diff。
  async function applyPluginMcpDiff(): Promise<void> {
    const { servers: newConfigs } = await getAllMcpConfigs()
    const supportedConfigs: Record<string, McpServerConfigForProcessTransport> =
      {}
    for (const [name, config] of Object.entries(newConfigs)) {
      const type = config.type
      if (
        type === undefined ||
        type === 'stdio' ||
        type === 'sse' ||
        type === 'http' ||
        type === 'sdk'
      ) {
        supportedConfigs[name] = config as McpServerConfigForProcessTransport
      }
    }
    for (const [name, config] of Object.entries(sdkMcpConfigs)) {
      if (config.type === 'sdk' && !(name in supportedConfigs)) {
        supportedConfigs[name] = config as unknown as McpServerConfigForProcessTransport
      }
    }
    const { response, sdkServersChanged } =
      await applyMcpServerChanges(supportedConfigs)
    if (sdkServersChanged) {
      void updateSdkMcp()
    }
    logForDebugging(
      `Headless MCP refresh: added=${response.added.length}, removed=${response.removed.length}`,
    )
  }

  // 技能变化时，至少要刷新 commands 缓存。
  const unsubscribeSkillChanges = skillChangeDetector.subscribe(() => {
    clearCommandsCache()
    void getCommands(cwd()).then(newCommands => {
      currentCommands = newCommands
    })
  })

  // proactive 模式下，系统可以自己塞一个 tick prompt 驱动后续轮次。
  const scheduleProactiveTick =
    feature('PROACTIVE') || feature('KAIROS')
      ? () => {
          setTimeout(() => {
            if (
              !proactiveModule?.isProactiveActive() ||
              proactiveModule.isProactivePaused() ||
              inputClosed
            ) {
              return
            }
            const tickContent = `<${TICK_TAG}>${new Date().toLocaleTimeString()}</${TICK_TAG}>`
            enqueue({
              mode: 'prompt' as const,
              value: tickContent,
              uuid: randomUUID(),
              priority: 'later',
              isMeta: true,
            })
            void run()
          }, 0)
        }
      : undefined

  // 队列里来了最高优先级的 now 命令时，直接打断当前 ask。
  subscribeToCommandQueue(() => {
    if (abortController && getCommandsByMaxPriority('now').length > 0) {
      abortController.abort('interrupt')
    }
  })
```

这一段仍然是 `run()` 之前的“环境准备区”。

先看几个关键 helper：

### `buildAllTools(appState)`

这是后面每轮 ask 前都会调用的工具池组装器。
它不是简单返回入口参数 `tools`，而是把这些东西合起来：

- 基础 `tools`
- `sdkTools`
- `dynamicMcpState.tools`
- `assembleToolPool(...)` 产物
- permission mode 过滤后的工具

所以：

```text
真正喂给 ask 的工具集合，不是最开始传进函数的 `tools`，而是这里每轮现算出来的 `allTools`。
```

### `forwardMessagesToBridge()`

这是 bridge 相关辅助逻辑。它的作用不是驱动 ask，而是把新产生的 user / assistant 消息同步给远端控制端。

### `applyMcpServerChanges(...)`

这是动态 MCP 变更的入口。它负责把新的 server 配置差异应用到：

- `sdkMcpConfigs`
- `sdkClients`
- `sdkTools`
- `dynamicMcpState`
- `appState`

### 插件相关

- `installPluginsAndApplyMcpInBackground()`
- `pluginInstallPromise`
- `refreshPluginState()`
- `applyPluginMcpDiff()`

这说明 headless 会话不是“启动时把世界固定住”。插件和 MCP 都允许在会话中途变化。

### proactive / queue 订阅

末尾这段很关键：

- `scheduleProactiveTick()`：没外部输入时，也能自己塞一个 tick prompt 继续跑。
- `subscribeToCommandQueue(...)`：如果队列里来了 `now` 优先级的命令，就中断当前 ask。

特别记这一句：

```text
新来的高优先级命令可以抢占当前 ask。
```

---

## 4. `run()` 开始：拿锁、刷新环境、定义 `drainCommandQueue()`（源码行 1862-2140）

```ts
  // run() 是主执行器：真正 dequeue 命令并调用 ask() 的地方都在这里。
  const run = async () => {
    // 已经有 run 在跑时，新的 run 调用直接返回，避免并发执行。
    if (running) {
      return
    }

    // 拿到执行权，切换会话状态。
    running = true
    runPhase = undefined
    notifySessionStateChanged('running')
    idleTimeout.stop()

    headlessProfilerCheckpoint('run_entry')

    await updateSdkMcp()
    headlessProfilerCheckpoint('after_updateSdkMcp')

    // 如果插件安装还没完成，在首轮 ask 前在这里兜底等待。
    if (pluginInstallPromise) {
      const timeoutMs = parseInt(
        process.env.CLAUDE_CODE_SYNC_PLUGIN_INSTALL_TIMEOUT_MS || '',
        10,
      )
      if (timeoutMs > 0) {
        const timeout = sleep(timeoutMs).then(() => 'timeout' as const)
        const result = await Promise.race([pluginInstallPromise, timeout])
        if (result === 'timeout') {
          logError(
            new Error(
              `CLAUDE_CODE_SYNC_PLUGIN_INSTALL: plugin installation timed out after ${timeoutMs}ms`,
            ),
          )
          logEvent('tengu_sync_plugin_install_timeout', {
            timeout_ms: timeoutMs,
          })
        }
      } else {
        await pluginInstallPromise
      }
      pluginInstallPromise = null

      await refreshPluginState()

      const { setupPluginHookHotReload } = await import(
        '../utils/plugins/loadPluginHooks.js'
      )
      setupPluginHookHotReload()
    }

    // 这个 run 只处理主线程命令。
    const isMainThread = (cmd: QueuedCommand) => cmd.agentId === undefined

    try {
      let command: QueuedCommand | undefined
      let waitingForAgents = false

      // 队列排空器：不断 dequeue，然后把命令送进 ask。
      const drainCommandQueue = async () => {
        while ((command = dequeue(isMainThread))) {
          // streaming 模式这里只接受这三种命令。
          if (
            command.mode !== 'prompt' &&
            command.mode !== 'orphaned-permission' &&
            command.mode !== 'task-notification'
          ) {
            throw new Error(
              'only prompt commands are supported in streaming mode',
            )
          }

          // 普通 prompt 可以合批，减少多轮 ask。
          const batch: QueuedCommand[] = [command]
          if (command.mode === 'prompt') {
            while (canBatchWith(command, peek(isMainThread))) {
              batch.push(dequeue(isMainThread)!)
            }
            if (batch.length > 1) {
              command = {
                ...command,
                value: joinPromptValues(batch.map(c => c.value)),
                uuid: batch.findLast(c => c.uuid)?.uuid ?? command.uuid,
              }
            }
          }
          const batchUuids = batch.map(c => c.uuid).filter(u => u !== undefined)

          // 合批后要给其它 uuid 补 replay ack。
          if (options.replayUserMessages && batch.length > 1) {
            for (const c of batch) {
              if (c.uuid && c.uuid !== command.uuid) {
                output.enqueue({
                  type: 'user',
                  content: c.value,
                  message: { role: 'user', content: c.value } as unknown,
                  session_id: getSessionId(),
                  parent_tool_use_id: null,
                  uuid: c.uuid as string,
                  isReplay: true,
                } as unknown as StdoutMessage)
              }
            }
          }

          // 每次真正 ask 前，都重新取最新的 appState / MCP / tools。
          const appState = getAppState()
          const allMcpClients = [
            ...appState.mcp.clients,
            ...sdkClients,
            ...dynamicMcpState.clients,
          ]
          registerElicitationHandlers(allMcpClients)
          for (const client of allMcpClients) {
            reregisterChannelHandlerAfterReconnect(client)
          }

          const allTools = buildAllTools(appState)

          // 这一批命令正式开始执行。
          for (const uuid of batchUuids) {
            notifyCommandLifecycle(uuid, 'started')
          }

          // task-notification 既要发给外部，也要继续往下喂给 ask。
          if (command.mode === 'task-notification') {
            const notificationText =
              typeof command.value === 'string' ? command.value : ''
            const taskIdMatch = notificationText.match(
              /<task-id>([^<]+)<\/task-id>/,
            )
            const toolUseIdMatch = notificationText.match(
              /<tool-use-id>([^<]+)<\/tool-use-id>/,
            )
            const outputFileMatch = notificationText.match(
              /<output-file>([^<]+)<\/output-file>/,
            )
            const statusMatch = notificationText.match(
              /<status>([^<]+)<\/status>/,
            )
            const summaryMatch = notificationText.match(
              /<summary>([^<]+)<\/summary>/,
            )

            const isValidStatus = (
              s: string | undefined,
            ): s is 'completed' | 'failed' | 'stopped' | 'killed' =>
              s === 'completed' ||
              s === 'failed' ||
              s === 'stopped' ||
              s === 'killed'
            const rawStatus = statusMatch?.[1]
            const status = isValidStatus(rawStatus)
              ? rawStatus === 'killed'
                ? 'stopped'
                : rawStatus
              : 'completed'

            const usageMatch = notificationText.match(
              /<usage>([\s\S]*?)<\/usage>/,
            )
            const usageContent = usageMatch?.[1] ?? ''
            const totalTokensMatch = usageContent.match(
              /<total_tokens>(\d+)<\/total_tokens>/,
            )
            const toolUsesMatch = usageContent.match(
              /<tool_uses>(\d+)<\/tool_uses>/,
            )
            const durationMsMatch = usageContent.match(
              /<duration_ms>(\d+)<\/duration_ms>/,
            )

            if (statusMatch) {
              output.enqueue({
                type: 'system',
                subtype: 'task_notification',
                task_id: taskIdMatch?.[1] ?? '',
                tool_use_id: toolUseIdMatch?.[1],
                status,
                output_file: outputFileMatch?.[1] ?? '',
                summary: summaryMatch?.[1] ?? '',
                usage:
                  totalTokensMatch && toolUsesMatch
                    ? {
                        total_tokens: parseInt(totalTokensMatch[1]!, 10),
                        tool_uses: parseInt(toolUsesMatch[1]!, 10),
                        duration_ms: durationMsMatch
                          ? parseInt(durationMsMatch[1]!, 10)
                          : 0,
                      }
                    : undefined,
                session_id: getSessionId(),
                uuid: randomUUID(),
              })
            }
          }

          const input = command.value

          if (structuredIO instanceof RemoteIO && command.mode === 'prompt') {
            logEvent('tengu_bridge_message_received', {
              is_repl: false,
            })
          }

          suggestionState.abortController?.abort()
          suggestionState.abortController = null
          suggestionState.pendingSuggestion = null
          suggestionState.pendingLastEmittedEntry = null
          if (suggestionState.lastEmitted) {
            if (command.mode === 'prompt') {
              const inputText =
                typeof input === 'string'
                  ? input
                  : (
                      input.find(b => b.type === 'text') as
                        | { type: 'text'; text: string }
                        | undefined
                    )?.text
              if (typeof inputText === 'string') {
                logSuggestionOutcome(
                  suggestionState.lastEmitted.text,
                  inputText,
                  suggestionState.lastEmitted.emittedAt,
                  suggestionState.lastEmitted.promptId,
                  suggestionState.lastEmitted.generationRequestId,
                )
              }
              suggestionState.lastEmitted = null
            }
          }

          abortController = createAbortController()
          const turnStartTime = feature('FILE_PERSISTENCE')
            ? Date.now()
            : undefined

          headlessProfilerCheckpoint('before_ask')
          startQueryProfile()
```

这里终于进入主线。

`run()` 是整个方法的主执行器。先用一句话理解它：

```text
run() = 从内部队列取命令，然后真正去调 ask()。
```

一进来先看：

```ts
if (running) {
  return
}
```

这就是全方法最重要的锁。没有这句，就可能同时有两个 run 在 dequeue、改 `mutableMessages`、调 ask，整个会话会乱掉。

拿到锁后做三件事：

1. `running = true`，切状态为 running
2. `await updateSdkMcp()`，拿最新 MCP 视图
3. 如果插件安装还没完成，在这里等它并刷新插件状态

然后定义 `isMainThread` 和 `drainCommandQueue()`。

`drainCommandQueue()` 里最重要的几件事是：

### 只处理主线程命令

```ts
const isMainThread = (cmd: QueuedCommand) => cmd.agentId === undefined
```

### 不是什么都能进 ask

这里只接受：

- `prompt`
- `orphaned-permission`
- `task-notification`

### prompt 可以合批

如果连续多个 prompt 可以合并，就拼成一次 ask，而不是一条一轮。这样做是为了减少回合碎片。

### 每次取到命令都重新取最新环境

这段非常关键：

- `const appState = getAppState()`
- `const allMcpClients = [...]`
- `const allTools = buildAllTools(appState)`

意思是：

```text
每一轮 ask 之前，都重新计算“此刻世界是什么样子”。
```

### `task-notification` 不只是发给外部，还要喂给模型

这里先把 task 状态解析成 SDK 事件发到 `output`，但不会 `continue`，而是继续往下走 ask。也就是说，后台 agent 的完成通知也是主模型下一步决策的输入。

---

## 5. 真正调用 `ask()`：一轮执行如何产出消息（源码行 2141-2404）

```ts
          // 当前 ask 的输入、工具、MCP、上下文都会在这里一次性打包。
          const cmd = command
          await runWithWorkload(cmd.workload ?? options.workload, async () => {
            for await (const message of ask({
              // 这些参数共同构成这一轮 ask 的完整运行环境。
              commands: uniqBy(
                [...currentCommands, ...appState.mcp.commands],
                'name',
              ),
              prompt: input,
              promptUuid: cmd.uuid,
              isMeta: cmd.isMeta,
              cwd: cwd(),
              tools: allTools,
              verbose: options.verbose,
              mcpClients: allMcpClients,
              thinkingConfig: options.thinkingConfig,
              maxTurns: options.maxTurns,
              maxBudgetUsd: options.maxBudgetUsd,
              taskBudget: options.taskBudget,
              canUseTool,
              userSpecifiedModel: activeUserSpecifiedModel,
              fallbackModel: options.fallbackModel,
              jsonSchema: getInitJsonSchema() ?? options.jsonSchema,
              mutableMessages,
              getReadFileCache: () =>
                pendingSeeds.size === 0
                  ? readFileState
                  : mergeFileStateCaches(readFileState, pendingSeeds),
              setReadFileCache: cache => {
                readFileState = cache
                for (const [path, seed] of pendingSeeds.entries()) {
                  const existing = readFileState.get(path)
                  if (!existing || seed.timestamp > existing.timestamp) {
                    readFileState.set(path, seed)
                  }
                }
                pendingSeeds.clear()
              },
              customSystemPrompt: options.systemPrompt,
              appendSystemPrompt: options.appendSystemPrompt,
              getAppState,
              setAppState,
              abortController,
              replayUserMessages: options.replayUserMessages,
              includePartialMessages: options.includePartialMessages,
              handleElicitation: (serverName, params, elicitSignal) =>
                structuredIO.handleElicitation(
                  serverName,
                  params.message,
                  undefined,
                  elicitSignal,
                  params.mode,
                  params.url,
                  'elicitationId' in params ? params.elicitationId : undefined,
                ),
              agents: currentAgents,
              orphanedPermission: cmd.orphanedPermission,
              setSDKStatus: status => {
                output.enqueue({
                  type: 'system',
                  subtype: 'status',
                  status: status as 'compacting' | null,
                  session_id: getSessionId(),
                  uuid: randomUUID(),
                })
              },
            })) {
              // ask 产出的新消息，先同步给 bridge。
              forwardMessagesToBridge()

              if (message.type === 'result') {
                // 先把 SDK 侧积压事件冲出去，避免它们落到 result 后面。
                for (const event of drainSdkEvents()) {
                  output.enqueue(event)
                }

                // 如果后台 agent 还在跑，先把最终 result 压住。
                const currentState = getAppState()
                if (
                  getRunningTasks(currentState).some(
                    t =>
                      (t.type === 'local_agent' ||
                        t.type === 'local_workflow') &&
                      isBackgroundTask(t),
                  )
                ) {
                  heldBackResult = message as StdoutMessage
                } else {
                  heldBackResult = null
                  output.enqueue(message as StdoutMessage)
                }
              } else {
                // 普通消息直接发，但也要先排空 SDK 事件。
                for (const event of drainSdkEvents()) {
                  output.enqueue(event)
                }
                output.enqueue(message as StdoutMessage)
              }
            }
          }) // runWithWorkload 到这里结束

          // 这一批命令 ask 跑完后，统一打 completed。
          for (const uuid of batchUuids) {
            notifyCommandLifecycle(uuid, 'completed')
          }

          // 每轮 ask 之后，再把新增消息同步给 bridge。
          forwardMessagesToBridge()
          bridgeHandle?.sendResult()

          // 文件持久化不是 ask 主线，但也挂在当前轮次收尾里。
          if (feature('FILE_PERSISTENCE') && turnStartTime !== undefined) {
            void executeFilePersistence(
              { turnStartTime } as import('src/utils/filePersistence/types.js').TurnStartTime,
              abortController.signal,
              result => {
                const filesResult = result as unknown as { persistedFiles: { filename: string; file_id: string }[]; failedFiles: { filename: string; error: string }[] }
                output.enqueue({
                  type: 'system' as const,
                  subtype: 'files_persisted' as const,
                  files: filesResult.persistedFiles,
                  failed: filesResult.failedFiles,
                  processed_at: new Date().toISOString(),
                  uuid: randomUUID(),
                  session_id: getSessionId(),
                })
              },
            )
          }

          // suggestion 生成也属于一轮 ask 的收尾动作。
          if (
            options.promptSuggestions &&
            !isEnvDefinedFalsy(process.env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION)
          ) {
            const state = suggestionState as unknown as typeof suggestionState
            state.abortController?.abort()
            const localAbort = new AbortController()
            suggestionState.abortController = localAbort

            const cacheSafeParams = getLastCacheSafeParams()
            if (!cacheSafeParams) {
              logSuggestionSuppressed(
                'sdk_no_params',
                undefined,
                undefined,
                'sdk',
              )
            } else {
              const ref: { promise: Promise<void> | null } = { promise: null }
              ref.promise = (async () => {
                try {
                  const result = await tryGenerateSuggestion(
                    localAbort,
                    mutableMessages,
                    getAppState,
                    cacheSafeParams,
                    'sdk',
                  )
                  if (!result || localAbort.signal.aborted) return
                  const suggestionMsg = {
                    type: 'prompt_suggestion' as const,
                    suggestion: result.suggestion,
                    uuid: randomUUID(),
                    session_id: getSessionId(),
                  }
                  const lastEmittedEntry = {
                    text: result.suggestion,
                    emittedAt: Date.now(),
                    promptId: result.promptId,
                    generationRequestId: result.generationRequestId,
                  }
                  if (heldBackResult) {
                    suggestionState.pendingSuggestion = suggestionMsg
                    suggestionState.pendingLastEmittedEntry = {
                      text: lastEmittedEntry.text,
                      promptId: lastEmittedEntry.promptId,
                      generationRequestId: lastEmittedEntry.generationRequestId,
                    }
                  } else {
                    suggestionState.lastEmitted = lastEmittedEntry
                    output.enqueue(suggestionMsg)
                  }
                } catch (error) {
                  if (
                    error instanceof Error &&
                    (error.name === 'AbortError' ||
                      error.name === 'APIUserAbortError')
                  ) {
                    logSuggestionSuppressed(
                      'aborted',
                      undefined,
                      undefined,
                      'sdk',
                    )
                    return
                  }
                  logError(toError(error))
                } finally {
                  if (suggestionState.inflightPromise === ref.promise) {
                    suggestionState.inflightPromise = null
                  }
                }
              })()
              suggestionState.inflightPromise = ref.promise
            }
          }

          logHeadlessProfilerTurn()
          logQueryProfileReport()
          headlessProfilerStartTurn()
        }
      }

      do {
        for (const event of drainSdkEvents()) {
          output.enqueue(event)
        }

        runPhase = 'draining_commands'
        await drainCommandQueue()

        waitingForAgents = false
        {
          const state = getAppState()
          const hasRunningBg = getRunningTasks(state).some(
            t => isBackgroundTask(t) && t.type !== 'in_process_teammate',
          )
          const hasMainThreadQueued = peek(isMainThread) !== undefined
          if (hasRunningBg || hasMainThreadQueued) {
            waitingForAgents = true
            if (!hasMainThreadQueued) {
              runPhase = 'waiting_for_agents'
              await sleep(100)
            }
          }
        }
```

这里是整条链最核心的位置。

你可以把这段压缩成一句：

```text
把本轮准备好的 prompt、工具、MCP、上下文、模型参数全部打包，然后交给 ask()。
```

重点看这句：

```ts
for await (const message of ask({ ... })) {
  ...
}
```

这说明：

- `runHeadlessStreaming()` 自己不做模型推理
- 它只是调用 `ask()`，然后消费 `ask()` 返回的流式消息

喂给 `ask()` 的核心内容有：

- `prompt: input`
- `tools: allTools`
- `mcpClients: allMcpClients`
- `mutableMessages`
- `getReadFileCache / setReadFileCache`
- `getAppState / setAppState`
- `abortController`
- `agents: currentAgents`

### 为什么这里一定要看 `mutableMessages`

因为它是共享 transcript。ask 不是拿一份静态副本，而是直接参与修改当前会话历史。

### ask 返回的消息如何处理

有两类：

#### 普通消息

- 先 `drainSdkEvents()`
- 再 `output.enqueue(message)`

#### `result`

如果当前还有后台 agent 在跑：

- 先放进 `heldBackResult`
- 暂时不发

如果没有后台任务：

- 直接 `output.enqueue(result)`

这个设计是为了保证时序：

```text
别让“最终 result 已经到了”发生在“后台 agent 的状态事件还在继续往外冒”之前。
```

### 这一轮 ask 结束后还会做什么

- 命令生命周期标记 completed
- bridge 同步
- file persistence 事件
- prompt suggestion
- profiler / query profile

也就是说，一轮 ask 的结束，不代表主循环收工。它还有很多会话级收尾动作。

---

## 6. `run()` 的后半段：等待后台任务、放行 heldBackResult、异常、finally、re-check（源码行 2405-2710）

```ts
      // do-while 结束，表示这轮 run() 认为“该等的后台活”都处理完了。
      } while (waitingForAgents)

      // result 不会立刻发；先扣住，等确认没有后续 agent 结果再统一放行。
      if (heldBackResult) {
        output.enqueue(heldBackResult)
        heldBackResult = null
        // suggestion 也延后到这里一起发，避免 UI 先看到建议、后看到最终结果。
        if (suggestionState.pendingSuggestion) {
          output.enqueue(suggestionState.pendingSuggestion)
          if (suggestionState.pendingLastEmittedEntry) {
            // 真发出后才把 lastEmitted 指针推进，保证节流判断准确。
            suggestionState.lastEmitted = {
              ...suggestionState.pendingLastEmittedEntry,
              emittedAt: Date.now(),
            }
            suggestionState.pendingLastEmittedEntry = null
          }
          suggestionState.pendingSuggestion = null
        }
      }
    } catch (error) {
      // 主执行循环崩溃时，尽量补一条 result 错误事件给调用方。
      try {
        await structuredIO.write({
          type: 'result',
          subtype: 'error_during_execution',
          duration_ms: 0,
          duration_api_ms: 0,
          is_error: true,
          num_turns: 0,
          stop_reason: null,
          session_id: getSessionId(),
          total_cost_usd: 0,
          usage: EMPTY_USAGE,
          modelUsage: {},
          permission_denials: [],
          uuid: randomUUID(),
          errors: [
            errorMessage(error),
            ...getInMemoryErrors().map(_ => _.error),
          ],
        })
      } catch {
        // 错误上报自己再失败，就不继续向外抛了。
      }
      // 当前 suggestion 属于这轮执行上下文，也一起终止。
      suggestionState.abortController?.abort()
      // 这是致命错误路径，直接进入同步优雅退出。
      gracefulShutdownSync(1)
      return
    } finally {
      // finally 的职责是：冲内部事件、回 idle、释放 running 锁。
      runPhase = 'finally_flush'
      await structuredIO.flushInternalEvents()
      runPhase = 'finally_post_flush'
      if (!isShuttingDown()) {
        // 正常空闲才发 idle；如果正在关机，就不要再宣称会话空闲。
        notifySessionStateChanged('idle')
        // SDK 事件缓存到这里统一 drain 到输出流。
        for (const event of drainSdkEvents()) {
          output.enqueue(event)
        }
      }
      // 锁最后释放，避免新 run 插进旧 run 的 finally 中间。
      running = false
      idleTimeout.start()
    }

    if (
      (feature('PROACTIVE') || feature('KAIROS')) &&
      proactiveModule?.isProactiveActive() &&
      !proactiveModule.isProactivePaused()
    ) {
      if (peek(isMainThread) === undefined && !inputClosed) {
        // proactive 模式下，队列空了就自动补一个 tick prompt。
        scheduleProactiveTick!()
        return
      }
    }

    // 释放锁后再看一眼队列，防止新消息卡死在里面。
    if (peek(isMainThread) !== undefined) {
      void run()
      return
    }

    // 下面开始处理协作模式收尾，不再属于 ask 主线。
    {
      const currentAppState = getAppState()
      const teamContext = currentAppState.teamContext

      if (teamContext && isTeamLead(teamContext)) {
        const agentName = 'team-lead'

        // 轮询队友未读消息。
        const POLL_INTERVAL_MS = 500

        while (true) {
          const refreshedState = getAppState()
          // 每轮都重读 state，因为 teammate 状态可能被其他异步路径修改。
          const hasActiveTeammates =
            hasActiveInProcessTeammates(refreshedState) ||
            (refreshedState.teamContext &&
              Object.keys(refreshedState.teamContext.teammates).length > 0)

          if (!hasActiveTeammates) {
            logForDebugging(
              '[print.ts] No more active teammates, stopping poll',
            )
            break
          }

          const unread = await readUnreadMessages(
            agentName,
            refreshedState.teamContext?.teamName,
          )

          if (unread.length > 0) {
            logForDebugging(
              `[print.ts] Team-lead found ${unread.length} unread messages`,
            )

            // 先标记已读，再转 prompt，避免 run() 重入时把同一批消息再处理一次。
            await markMessagesAsRead(
              agentName,
              refreshedState.teamContext?.teamName,
            )

            const teamName = refreshedState.teamContext?.teamName
            for (const m of unread) {
              const shutdownApproval = isShutdownApproved(m.text)
              if (shutdownApproval && teamName) {
                const teammateToRemove = shutdownApproval.from
                logForDebugging(
                  `[print.ts] Processing shutdown_approved from ${teammateToRemove}`,
                )

                const teammateId = refreshedState.teamContext?.teammates
                  ? Object.entries(refreshedState.teamContext.teammates).find(
                      ([, t]) => t.name === teammateToRemove,
                    )?.[0]
                  : undefined

                if (teammateId) {
                  removeTeammateFromTeamFile(teamName, {
                    agentId: teammateId,
                    name: teammateToRemove,
                  })
                  logForDebugging(
                    `[print.ts] Removed ${teammateToRemove} from team file`,
                  )

                  await unassignTeammateTasks(
                    teamName,
                    teammateId,
                    teammateToRemove,
                    'shutdown',
                  )

                  setAppState(prev => {
                    if (!prev.teamContext?.teammates) return prev
                    if (!(teammateId in prev.teamContext.teammates)) return prev
                    const { [teammateId]: _, ...remainingTeammates } =
                      prev.teamContext.teammates
                    return {
                      ...prev,
                      teamContext: {
                        ...prev.teamContext,
                        teammates: remainingTeammates,
                      },
                    }
                  })
                }
              }
            }

            const formatted = unread
              .map(
                (m: { from: string; text: string; color?: string }) =>
                  // 队友消息会被包成特殊标签，供主线程下一轮当 prompt 解析。
                  `<${TEAMMATE_MESSAGE_TAG} teammate_id="${m.from}"${m.color ? ` color="${m.color}"` : ''}>\n${m.text}\n</${TEAMMATE_MESSAGE_TAG}>`,
              )
              .join('\n\n')

            enqueue({
              mode: 'prompt',
              value: formatted,
              uuid: randomUUID(),
            })
            // 队友消息最终也会转成一条新的主线程 prompt。
            void run()
            return // 等这条 prompt 处理完后，run() 还会回到这里继续
          }

          if (inputClosed && !shutdownPromptInjected) {
            shutdownPromptInjected = true
            logForDebugging(
              '[print.ts] Input closed with active teammates, injecting shutdown prompt',
            )
            enqueue({
              mode: 'prompt',
              value: SHUTDOWN_TEAM_PROMPT,
              uuid: randomUUID(),
            })
            // 输入已经关了但队友还在，就注入一次关停提示。
            void run()
            return // 等这条 prompt 处理完后，run() 还会回到这里继续
          }

          await sleep(POLL_INTERVAL_MS)
        }
      }
    }

    // 输入流结束后，还要确认 swarm 是否彻底收干净，才能真正关输出流。
    if (inputClosed) {
      const hasActiveSwarm = await (async () => {
        const currentAppState = getAppState()
        if (hasWorkingInProcessTeammates(currentAppState)) {
          // 先把正在工作的 teammate 等到 idle，再重新统计活跃成员。
          await waitForTeammatesToBecomeIdle(setAppState, currentAppState)
        }

        const refreshedAppState = getAppState()
        const refreshedTeamContext = refreshedAppState.teamContext
        const hasTeamMembersNotCleanedUp =
          refreshedTeamContext &&
          Object.keys(refreshedTeamContext.teammates).length > 0

        return (
          hasTeamMembersNotCleanedUp ||
          hasActiveInProcessTeammates(refreshedAppState)
        )
      })()

      if (hasActiveSwarm) {
        // 还有 swarm 没收干净，就再注入一次关停 prompt。
        enqueue({
          mode: 'prompt',
          value: SHUTDOWN_TEAM_PROMPT,
          uuid: randomUUID(),
        })
        void run()
      } else {
        // 真正关流前，把 suggestion / hook / listener 都尽量收尾。
        if (suggestionState.inflightPromise) {
          // 最多等 5 秒，避免 suggestion 卡死阻塞整个会话退出。
          await Promise.race([suggestionState.inflightPromise, sleep(5000)])
        }
        suggestionState.abortController?.abort()
        suggestionState.abortController = null
        await finalizePendingAsyncHooks()
        unsubscribeSkillChanges()
        unsubscribeAuthStatus?.()
        statusListeners.delete(rateLimitListener)
        output.done()
      }
    }
  }

  // UDS inbox 来消息时，也要唤醒 run() 去消费队列。
  if (feature('UDS_INBOX')) {
    /* 关闭 require-imports 规则，下面这里就是要用 require */
    const { setOnEnqueue } = require('../utils/udsMessaging.js')
    /* 恢复 require-imports 规则 */
    setOnEnqueue(() => {
      if (!inputClosed) {
        void run()
      }
    })
  }

  // cron scheduler 会在 SDK / -p 模式下注入定时 prompt。
  let cronScheduler: import('../utils/cronScheduler.js').CronScheduler | null =
    null
  if (
    cronGate.isKairosCronEnabled()
  ) {
    cronScheduler = cronSchedulerModule.createCronScheduler({
      onFire: prompt => {
        if (inputClosed) return
        enqueue({
          mode: 'prompt',
```

这一段是 `run()` 的收口。

### 为什么用 `do { ... } while (waitingForAgents)`

逻辑是：

1. 先 `await drainCommandQueue()`
2. 再看后台任务是否还在跑
3. 如果后台任务还在跑，或者主线程队列里又有新命令，就继续下一轮

ASCII 理解：

```text
先把当前能做的活做完
-> 再看后台 agent 是否还会带来新活
-> 如果会，就别退出 run
```

这里特别排除了 `in_process_teammate`，因为那类任务是长生命周期的，直接等会等不完。

### `heldBackResult` 在哪里真正放行

只有等 `do-while` 确认：

- 没有该等的后台任务了
- 队列里也没有新的主线程命令了

才会：

- `output.enqueue(heldBackResult)`
- 再把可能延后的 `pendingSuggestion` 一起发出去

### 异常路径

如果 `run()` 内部抛错，不是只打日志，而是尽量主动往外发一个：

- `type: 'result'`
- `subtype: 'error_during_execution'`

这样 SDK 调用方至少能收到一个明确的失败结果，而不是流突然断掉。

### finally

finally 里做的是：

1. `flushInternalEvents()`
2. 切 session state 到 idle
3. `drainSdkEvents()`
4. `running = false`
5. 启动 idle timeout

顺序不能乱。特别是 `running = false` 必须放后面，否则新 run 可能在旧事件还没 flush 完时插进来。

### 最后的 queue re-check

这句非常重要：

```ts
if (peek(isMainThread) !== undefined) {
  void run()
  return
}
```

它是在修一个典型竞态：

```text
旧 run 快结束时，新消息刚好入队；
新消息触发的 run 因为看到 running=true 而直接返回；
如果旧 run 不在释放锁后再看一眼队列，这条消息就会卡死。
```

---

## 7. `run()` 之外的后续逻辑：teammate 轮询、输入关闭后的清理前准备（源码行 2711-2809）

```ts
          // cron 触发时，本质上也是往主队列塞一条 prompt，只是来源不是用户。
          value: prompt,
          uuid: randomUUID(),
          priority: 'later',
          isMeta: true,
          workload: WORKLOAD_CRON,
        })
        void run()
      },
      // 只要 run 正在忙或者输入已经关了，cron 就不应继续发新 prompt。
      isLoading: () => running || inputClosed,
      getJitterConfig: cronJitterConfigModule?.getCronJitterConfig,
      // Kairos 开关一旦关掉，scheduler 就应该视为被杀死。
      isKilled: () => !cronGate?.isKairosCronEnabled(),
    })
    cronScheduler.start()
  }

  const sendControlResponseSuccess = function (
    message: { request_id: string } | SDKControlRequest,
    response?: Record<string, unknown>,
  ) {
    // 所有 control_request 的成功响应都走统一格式，便于 SDK 对 request_id 对账。
    output.enqueue({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: message.request_id,
        response: response,
      },
    })
  }

  const sendControlResponseError = function (
    message: { request_id: string } | SDKControlRequest,
    errorMessage: string,
  ) {
    // 失败响应也统一包装，调用方不用自己猜是哪类错误消息。
    output.enqueue({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: message.request_id,
        error: errorMessage,
      },
    })
  }

  const handledOrphanedToolUseIds = new Set<string>()
  structuredIO.setUnexpectedResponseCallback(async message => {
    // 有些 permission 回复会“迟到”，原 ask 已结束；这里专门兜底处理这种孤儿响应。
    await handleOrphanedPermissionResponse({
      message,
      setAppState,
      handledToolUseIds: handledOrphanedToolUseIds,
      onEnqueued: () => {
        void run()
      },
    })
  })

  // 下面这些 Map/Set 是一次 OAuth 流程跨消息保存的临时上下文。
  const activeOAuthFlows = new Map<string, AbortController>()
  const oauthCallbackSubmitters = new Map<
    string,
    (callbackUrl: string) => void
  >()
  const oauthManualCallbackUsed = new Set<string>()
  const oauthAuthPromises = new Map<string, Promise<void>>()

  let claudeOAuth: {
    service: OAuthService
    flow: Promise<void>
    // 当前 Claude 登录流程只有一份；新流程会覆盖旧引用。
  } | null = null

```

这一段还在 `run()` 逻辑的尾部影响范围里，但已经不属于 ask 主线。

主要是三块：

### teammate / team-lead 轮询

如果当前是 team lead，就会持续检查 unread teammate messages：

- 读未读消息
- 标记已读
- 处理 `shutdown_approved`
- 必要时把 teammate 消息重新格式化成 prompt 入队
- 再次触发 `run()`

这说明：

```text
run() 结束不等于这个 headless 会话已经没有后续输入来源。
team message 也会转成新的 prompt 再跑一轮。
```

### 输入关闭但 swarm 还活着

如果 `inputClosed` 为真，但 swarm / teammate 还没清干净，会注入 `SHUTDOWN_TEAM_PROMPT`，继续走主队列。

### 真正进入“准备关闭输出流”的前置条件

只有当：

- 输入已关闭
- active swarm 也没有了
- prompt suggestion 也尽量等完了
- async hooks 也 final 了

才会走向 `output.done()`。

第一遍你只要记住：

```text
输入结束 != 立刻关流。
会话必须把后台协作和清理都做完。
```

---

## 8. 输入循环开头：`structuredInput`、生命周期、前几类控制分支（源码行 2810-3200）

```ts
  // 输入循环：持续从 structuredInput 读消息，与上面的 run() 并发存在。
  void (async () => {
    let initialized = false
    // 打一条诊断日志，标记消息循环已经启动。
    logForDiagnosticsNoPII('info', 'cli_message_loop_started')
    for await (const message of structuredIO.structuredInput) {
      // 非 user 事件多数不进队列，但可能要补生命周期 completed。
      const eventId = 'uuid' in message ? message.uuid : undefined
      if (
        eventId &&
        message.type !== 'user' &&
        message.type !== 'control_response'
      ) {
        notifyCommandLifecycle(eventId as string, 'completed')
      }

      // control_request 是控制平面消息，不走 ask，直接在这里处理。
      if (message.type === 'control_request') {
        const msg = message as unknown as SDKControlRequest
        const req = msg.request as Record<string, unknown>
        // interrupt：直接打断当前 ask。
        if (msg.request.subtype === 'interrupt') {
          if (feature('COMMIT_ATTRIBUTION')) {
            // 用户主动中断也算一种交互行为，要记进 attribution 统计。
            setAppState(prev => ({
              ...prev,
              attribution: {
                ...prev.attribution,
                escapeCount: prev.attribution.escapeCount + 1,
              },
            }))
          }
          if (abortController) {
            abortController.abort()
          }
          // suggestion 可能还在后台生成，也要一起取消。
          suggestionState.abortController?.abort()
          suggestionState.abortController = null
          suggestionState.lastEmitted = null
          suggestionState.pendingSuggestion = null
          sendControlResponseSuccess(msg)
        // end_session：中断 ask，然后跳出输入循环，后面进入 inputClosed 收尾。
        } else if (req.subtype === 'end_session') {
          logForDebugging(
            `[print.ts] end_session received, reason=${req.reason ?? 'unspecified'}`,
          )
          if (abortController) {
            abortController.abort()
          }
          suggestionState.abortController?.abort()
          suggestionState.abortController = null
          suggestionState.lastEmitted = null
          suggestionState.pendingSuggestion = null
          sendControlResponseSuccess(msg)
          break // 跳出 for-await，后面会继续走 inputClosed=true 的收尾逻辑
        // initialize：建立初始运行环境；如果之前 auto-resume 已经入队了 prompt，这里会立刻 run。
        } else if (msg.request.subtype === 'initialize') {
          if (
            msg.request.sdkMcpServers &&
            msg.request.sdkMcpServers.length > 0
          ) {
            for (const serverName of msg.request.sdkMcpServers) {
              // SDK 显式传进来的 MCP server，先登记到本地配置表。
              sdkMcpConfigs[serverName] = {
                type: 'sdk',
                name: serverName,
              }
            }
          }

          await handleInitializeRequest(
            // initialize 的重活都封装在这个 helper 里。
            msg.request,
            msg.request_id,
            initialized,
            output,
            commands,
            modelInfos,
            structuredIO,
            !!options.enableAuthStatus,
            options,
            agents,
            getAppState,
          )

          if (msg.request.promptSuggestions) {
            // initialize 就可以把 prompt suggestion 打开。
            setAppState(prev => {
              if (prev.promptSuggestionEnabled) return prev
              return { ...prev, promptSuggestionEnabled: true }
            })
          }

          if (
            msg.request.agentProgressSummaries &&
            getFeatureValue_CACHED_MAY_BE_STALE('tengu_slate_prism', true)
          ) {
            // SDK 也能在初始化阶段打开 agent progress summaries。
            setSdkAgentProgressSummariesEnabled(true)
          }

          initialized = true

          if (hasCommandsInQueue()) {
            void run()
          }
        } else if (msg.request.subtype === 'set_permission_mode') {
          const m = msg.request // 这里只是为了让 TypeScript 缩小类型
          // permission mode 直接改 appState，后面的状态广播会自动触发。
          setAppState(prev => ({
            ...prev,
            toolPermissionContext: handleSetPermissionMode(
              m,
              msg.request_id,
              prev.toolPermissionContext,
              output,
            ),
            isUltraplanMode: m.ultraplan ?? prev.isUltraplanMode,
          }))
        } else if (msg.request.subtype === 'set_model') {
          // "default" 需要解析成当前真正默认的主模型。
          const requestedModel = msg.request.model ?? 'default'
          const model =
            requestedModel === 'default'
              ? getDefaultMainLoopModel()
              : requestedModel
          activeUserSpecifiedModel = model
          setMainLoopModelOverride(model)
          notifySessionMetadataChanged({ model })
          injectModelSwitchBreadcrumbs(requestedModel, model)

          sendControlResponseSuccess(msg)
        } else if (msg.request.subtype === 'set_max_thinking_tokens') {
          // null / 0 / 正数分别表示：继承默认、关闭思考、设置预算。
          if (msg.request.max_thinking_tokens === null) {
            options.thinkingConfig = undefined
          } else if (msg.request.max_thinking_tokens === 0) {
            options.thinkingConfig = { type: 'disabled' }
          } else {
            options.thinkingConfig = {
              type: 'enabled',
              budgetTokens: msg.request.max_thinking_tokens,
            }
          }
          sendControlResponseSuccess(msg)
        } else if (msg.request.subtype === 'mcp_status') {
          // 单纯读取 MCP 状态快照。
          sendControlResponseSuccess(msg, {
            mcpServers: buildMcpServerStatuses(),
          })
        } else if (msg.request.subtype === 'get_context_usage') {
          try {
            const appState = getAppState()
            // 现算一遍上下文占用，给外部查看本轮 prompt 会带多少上下文。
            const data = await collectContextData({
              messages: mutableMessages,
              getAppState,
              options: {
                mainLoopModel: getMainLoopModel(),
                tools: buildAllTools(appState),
                agentDefinitions: appState.agentDefinitions,
                customSystemPrompt: options.systemPrompt,
                appendSystemPrompt: options.appendSystemPrompt,
              },
            })
            sendControlResponseSuccess(msg, { ...data })
          } catch (error) {
            sendControlResponseError(msg, errorMessage(error))
          }
        } else if (msg.request.subtype === 'mcp_message') {
          // 透传一条原始 MCP JSON-RPC 消息给指定 transport。
          const mcpRequest = msg.request as Record<string, unknown>
          const sdkClient = sdkClients.find(
            client => client.name === mcpRequest.server_name,
          )
          if (
            sdkClient &&
            sdkClient.type === 'connected' &&
            sdkClient.client?.transport?.onmessage
          ) {
            sdkClient.client.transport.onmessage(mcpRequest.message as import('@modelcontextprotocol/sdk/types.js').JSONRPCMessage)
          }
          sendControlResponseSuccess(msg)
        } else if (msg.request.subtype === 'rewind_files') {
          // 回退某条历史 user message 之后产生的文件变更。
          const appState = getAppState()
          const result = await handleRewindFiles(
            msg.request.user_message_id as UUID,
            appState,
            setAppState,
            msg.request.dry_run ?? false,
          )
          if (result.canRewind || msg.request.dry_run) {
            sendControlResponseSuccess(msg, result)
          } else {
            sendControlResponseError(
              msg,
              (result.error as string) ?? 'Unexpected error',
            )
          }
        } else if (msg.request.subtype === 'cancel_async_message') {
          // 从内部命令队列里删除目标异步消息。
          const targetUuid = msg.request.message_uuid
          const removed = dequeueAllMatching(cmd => cmd.uuid === targetUuid)
          sendControlResponseSuccess(msg, {
            cancelled: removed.length > 0,
          })
        } else if (msg.request.subtype === 'seed_read_state') {
          try {
            // 从外部补种“已读文件状态”，让后续 file-state 感知这份历史。
            const normalizedPath = expandPath(msg.request.path)
            const diskMtime = Math.floor((await stat(normalizedPath)).mtimeMs)
            if (diskMtime <= msg.request.mtime) {
              const raw = await readFile(normalizedPath, 'utf-8')
              const content = (
                raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
              ).replaceAll('\r\n', '\n')
              pendingSeeds.set(normalizedPath, {
                content,
                timestamp: diskMtime,
                offset: undefined,
                limit: undefined,
              })
            }
          } catch {
            // 补种失败不影响主流程，这里直接吞掉。
          }
          sendControlResponseSuccess(msg)
        } else if (msg.request.subtype === 'mcp_set_servers') {
          // 批量应用新的 MCP server 配置。
          const { response, sdkServersChanged } = await applyMcpServerChanges(
            msg.request.servers as Record<string, McpServerConfigForProcessTransport>,
          )
          sendControlResponseSuccess(msg, response)

          if (sdkServersChanged) {
            // SDK server 列表变动时，额外刷新 SDK MCP 连接。
            void updateSdkMcp()
          }
        } else if (msg.request.subtype === 'reload_plugins') {
          try {
            if (
              feature('DOWNLOAD_USER_SETTINGS') &&
              (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) || getIsRemoteMode())
            ) {
              // 远端模式下先同步最新用户设置，避免插件刷新基于旧配置。
              const applied = await redownloadUserSettings()
              if (applied) {
                settingsChangeDetector.notifyChange('userSettings')
              }
            }

            const r = await refreshActivePlugins(setAppState)

            const sdkAgents = currentAgents.filter(
              a => a.source === 'flagSettings',
            )
            // 插件刷新后，把来自 flagSettings 的 SDK agents 再拼回当前 agent 列表。
            currentAgents = [...r.agentDefinitions.allAgents, ...sdkAgents]

            let plugins: SDKControlReloadPluginsResponse['plugins'] = []
            // 三个较慢步骤并行做：命令刷新、插件 MCP diff、插件缓存读取。
            const [cmdsR, mcpR, pluginsR] = await Promise.allSettled([
              getCommands(cwd()),
              applyPluginMcpDiff(),
              loadAllPluginsCacheOnly(),
            ])
            if (cmdsR.status === 'fulfilled') {
              currentCommands = cmdsR.value
            } else {
              logError(cmdsR.reason)
            }
            if (mcpR.status === 'rejected') {
              logError(mcpR.reason)
            }
            if (pluginsR.status === 'fulfilled') {
              plugins = pluginsR.value.enabled.map(p => ({
                name: p.name,
                path: p.path,
                source: p.source,
              }))
            } else {
              logError(pluginsR.reason)
            }

            sendControlResponseSuccess(msg, {
              commands: currentCommands
                .filter(cmd => cmd.userInvocable !== false)
                .map(cmd => ({
                  name: getCommandName(cmd),
                  description: formatDescriptionWithSource(cmd),
                  argumentHint: cmd.argumentHint || '',
                })),
              agents: currentAgents.map(a => ({
                name: a.agentType,
                description: a.whenToUse,
                model: a.model === 'inherit' ? undefined : a.model,
              })),
              plugins,
              mcpServers: buildMcpServerStatuses() as SDKControlReloadPluginsResponse['mcpServers'],
              error_count: r.error_count,
            } satisfies SDKControlReloadPluginsResponse)
          } catch (error) {
            sendControlResponseError(msg, errorMessage(error))
          }
        } else if (msg.request.subtype === 'mcp_reconnect') {
          // 对单个 MCP server 做一次显式重连。
          const currentAppState = getAppState()
          const { serverName } = msg.request
          elicitationRegistered.delete(serverName)
          const config =
            getMcpConfigByName(serverName) ??
            mcpClients.find(c => c.name === serverName)?.config ??
            sdkClients.find(c => c.name === serverName)?.config ??
            dynamicMcpState.clients.find(c => c.name === serverName)?.config ??
            currentAppState.mcp.clients.find(c => c.name === serverName)
              ?.config ??
            null
          if (!config) {
            sendControlResponseError(msg, `Server not found: ${serverName}`)
          } else {
            const result = await reconnectMcpServerImpl(serverName, config)
            const prefix = getMcpPrefix(serverName)
            // 先刷新 appState 中这台 server 的 client/tools/commands/resources。
            setAppState(prev => ({
              ...prev,
              mcp: {
                ...prev.mcp,
                clients: prev.mcp.clients.map(c =>
                  c.name === serverName ? result.client : c,
                ),
                tools: [
                  ...reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
                  ...result.tools,
                ],
                commands: [
                  ...reject(prev.mcp.commands, c =>
                    commandBelongsToServer(c, serverName),
                  ),
                  ...result.commands,
                ],
                resources:
                  result.resources && result.resources.length > 0
                    ? { ...prev.mcp.resources, [serverName]: result.resources }
                    : omit(prev.mcp.resources, serverName),
              },
            }))
            // 再刷新 dynamicMcpState，保证运行时镜像和 appState 保持一致。
            dynamicMcpState = {
              ...dynamicMcpState,
              clients: [
                ...dynamicMcpState.clients.filter(c => c.name !== serverName),
                result.client,
              ],
              tools: [
                ...dynamicMcpState.tools.filter(
                  t => !t.name?.startsWith(prefix),
                ),
                ...result.tools,
              ],
            }
```

这里开始是另一个并发主角：输入循环。

最关键的一句是：

```ts
for await (const message of structuredIO.structuredInput) {
  ...
}
```

这说明 `runHeadlessStreaming()` 一直在后台做这件事：

```text
从外部输入流读消息 -> 看消息类型 -> 决定如何处理。
```

### 第一层分流：非 user 事件先做生命周期收尾

`eventId` 那段逻辑的意思是：

- 非 user 消息大多不需要进内部队列
- 但它们仍然可能要补生命周期 completed

### `control_request` 为何不进队列

因为它们不是“自然语言任务”，而是“直接控制运行时”的命令。

这一段先处理了很多最常见的控制请求：

- `interrupt`
- `end_session`
- `initialize`
- `set_permission_mode`
- `set_model`
- `set_max_thinking_tokens`
- `mcp_status`
- `get_context_usage`
- `mcp_message`
- `rewind_files`
- `cancel_async_message`
- `seed_read_state`
- `mcp_set_servers`
- `reload_plugins`
- `mcp_reconnect`

你第一遍只建议重点看这几个：

### `interrupt`

- `abortController.abort()`
- 停 suggestion
- 回 success

也就是：

```text
直接中断当前 ask，不走模型。
```

### `end_session`

- 中断 ask
- 回 success
- `break` 输入循环

### `initialize`

- 处理 headless / SDK 初始化
- 设置初始运行环境
- 如果 auto-resume 先前已经往队列里塞了命令，这里会立即 `run()`

### `set_model`

- 更新当前模型
- 更新 metadata
- 注入 breadcrumb 到消息历史

### `seed_read_state`

这个分支和前面的 `pendingSeeds` 呼应。它的意思是：

```text
外部客户端说“这个文件之前其实读过”，
那就把那份读文件状态补种回当前会话的 file-state 缓存体系里。
```

---

## 9. 输入循环中段：更多 control_request 分支（源码行 3201-3710）

```ts
            // 重连成功后，把 elicitation / channel handler 重新挂回新 client。
            if (result.client.type === 'connected') {
              registerElicitationHandlers([result.client])
              reregisterChannelHandlerAfterReconnect(result.client)
              sendControlResponseSuccess(msg)
            } else {
              const errorMessage =
                result.client.type === 'failed'
                  ? (result.client.error ?? 'Connection failed')
                  : `Server status: ${result.client.type}`
              sendControlResponseError(msg, errorMessage)
            }
          }
        } else if (msg.request.subtype === 'mcp_toggle') {
          // 运行中动态开关某个 MCP server。
          const currentAppState = getAppState()
          const { serverName, enabled } = msg.request
          elicitationRegistered.delete(serverName)
          const config =
            getMcpConfigByName(serverName) ??
            mcpClients.find(c => c.name === serverName)?.config ??
            sdkClients.find(c => c.name === serverName)?.config ??
            dynamicMcpState.clients.find(c => c.name === serverName)?.config ??
            currentAppState.mcp.clients.find(c => c.name === serverName)
              ?.config ??
            null

          if (!config) {
            sendControlResponseError(msg, `Server not found: ${serverName}`)
          } else if (!enabled) {
            // 关闭 server：先标 disabled，再把相关 tools/commands/resources 清掉。
            setMcpServerEnabled(serverName, false)
            const client = [
              ...mcpClients,
              ...sdkClients,
              ...dynamicMcpState.clients,
              ...currentAppState.mcp.clients,
            ].find(c => c.name === serverName)
            if (client && client.type === 'connected') {
              await clearServerCache(serverName, config)
            }
            const prefix = getMcpPrefix(serverName)
            setAppState(prev => ({
              ...prev,
              mcp: {
                ...prev.mcp,
                clients: prev.mcp.clients.map(c =>
                  c.name === serverName
                    ? { name: serverName, type: 'disabled' as const, config }
                    : c,
                ),
                tools: reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
                commands: reject(prev.mcp.commands, c =>
                  commandBelongsToServer(c, serverName),
                ),
                resources: omit(prev.mcp.resources, serverName),
              },
            }))
            sendControlResponseSuccess(msg)
          } else {
            // 开启 server：重新连一遍，再把产物写回状态。
            setMcpServerEnabled(serverName, true)
            const result = await reconnectMcpServerImpl(serverName, config)
            const prefix = getMcpPrefix(serverName)
            setAppState(prev => ({
              ...prev,
              mcp: {
                ...prev.mcp,
                clients: prev.mcp.clients.map(c =>
                  c.name === serverName ? result.client : c,
                ),
                tools: [
                  ...reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
                  ...result.tools,
                ],
                commands: [
                  ...reject(prev.mcp.commands, c =>
                    commandBelongsToServer(c, serverName),
                  ),
                  ...result.commands,
                ],
                resources:
                  result.resources && result.resources.length > 0
                    ? { ...prev.mcp.resources, [serverName]: result.resources }
                    : omit(prev.mcp.resources, serverName),
              },
            }))
            if (result.client.type === 'connected') {
              registerElicitationHandlers([result.client])
              reregisterChannelHandlerAfterReconnect(result.client)
              sendControlResponseSuccess(msg)
            } else {
              const errorMessage =
                result.client.type === 'failed'
                  ? (result.client.error ?? 'Connection failed')
                  : `Server status: ${result.client.type}`
              sendControlResponseError(msg, errorMessage)
            }
          }
        } else if (req.subtype === 'channel_enable') {
          // 某些 MCP channel 需要单独 enable，这里直接交给 helper。
          const currentAppState = getAppState()
          handleChannelEnable(
            msg.request_id,
            req.serverName as string,
            [
              ...currentAppState.mcp.clients,
              ...sdkClients,
              ...dynamicMcpState.clients,
            ],
            output,
          )
        } else if (req.subtype === 'mcp_authenticate') {
          // 对指定 MCP server 发起 OAuth 登录流程。
          const serverName = req.serverName as string
          const currentAppState = getAppState()
          const config =
            getMcpConfigByName(serverName) ??
            mcpClients.find(c => c.name === serverName)?.config ??
            currentAppState.mcp.clients.find(c => c.name === serverName)
              ?.config ??
            null
          if (!config) {
            sendControlResponseError(msg, `Server not found: ${serverName}`)
          } else if (config.type !== 'sse' && config.type !== 'http') {
            sendControlResponseError(
              msg,
              `Server type "${config.type}" does not support OAuth authentication`,
            )
          } else {
            try {
              // 如果这台 server 之前已有 OAuth 流程，先中断旧流程。
              activeOAuthFlows.get(serverName as string)?.abort()
              const controller = new AbortController()
              activeOAuthFlows.set(serverName as string, controller)

              let resolveAuthUrl: (url: string) => void
              const authUrlPromise = new Promise<string>(resolve => {
                resolveAuthUrl = resolve
              })

              // oauthPromise 代表“整个 OAuth 流程结束”，authUrlPromise 代表“拿到要给用户打开的 URL”。
              const oauthPromise = performMCPOAuthFlow(
                serverName as string,
                config,
                url => resolveAuthUrl!(url),
                controller.signal,
                {
                  skipBrowserOpen: true,
                  onWaitingForCallback: submit => {
                    oauthCallbackSubmitters.set(serverName as string, submit)
                  },
                },
              )

              const authUrl = await Promise.race([
                authUrlPromise,
                oauthPromise.then(() => null as string | null),
              ])

              if (authUrl) {
                // 如果先拿到授权地址，先回给调用方，让用户继续操作。
                sendControlResponseSuccess(msg, {
                  authUrl,
                  requiresUserAction: true,
                })
              } else {
                // 有些流程可能不需要用户手动干预。
                sendControlResponseSuccess(msg, {
                  requiresUserAction: false,
                })
              }

              // 把 promise 暂存起来，后续 callback 分支还要继续 await 它。
              oauthAuthPromises.set(serverName, oauthPromise)

              const fullFlowPromise = oauthPromise
                .then(async () => {
                  // 如果用户在 OAuth 期间把 server 禁掉了，后续重连就不做了。
                  if (isMcpServerDisabled(serverName as string)) {
                    return
                  }
                  // 如果已经走了手动 callback 路径，也不要再自动补一轮。
                  if (oauthManualCallbackUsed.has(serverName as string)) {
                    return
                  }
                  const result = await reconnectMcpServerImpl(
                    serverName as string,
                    config,
                  )
                  const prefix = getMcpPrefix(serverName as string)
                  setAppState(prev => ({
                    ...prev,
                    mcp: {
                      ...prev.mcp,
                      clients: prev.mcp.clients.map(c =>
                        c.name === serverName as string ? result.client : c,
                      ),
                      tools: [
                        ...reject(prev.mcp.tools, t =>
                          t.name?.startsWith(prefix),
                        ),
                        ...result.tools,
                      ],
                      commands: [
                        ...reject(prev.mcp.commands, c =>
                          commandBelongsToServer(c, serverName as string),
                        ),
                        ...result.commands,
                      ],
                      resources:
                        result.resources && result.resources.length > 0
                          ? {
                              ...prev.mcp.resources,
                              [serverName as string]: result.resources,
                            }
                          : omit(prev.mcp.resources, serverName as string),
                    },
                  }))
                  dynamicMcpState = {
                    ...dynamicMcpState,
                    clients: [
                      ...dynamicMcpState.clients.filter(
                        c => c.name !== serverName,
                      ),
                      result.client,
                    ],
                    tools: [
                      ...dynamicMcpState.tools.filter(
                        t => !t.name?.startsWith(prefix),
                      ),
                      ...result.tools,
                    ],
                  }
                })
                .catch(error => {
                  // OAuth 失败这里只记日志，避免打断消息循环。
                  logForDebugging(
                    `MCP OAuth failed for ${serverName as string}: ${error}`,
                    { level: 'error' },
                  )
                })
                .finally(() => {
                  // 无论成功失败，都把这次 OAuth 相关的临时引用清干净。
                  if (activeOAuthFlows.get(serverName as string) === controller) {
                    activeOAuthFlows.delete(serverName as string)
                    oauthCallbackSubmitters.delete(serverName as string)
                    oauthManualCallbackUsed.delete(serverName as string)
                    oauthAuthPromises.delete(serverName as string)
                  }
                })
              void fullFlowPromise
            } catch (error) {
              sendControlResponseError(msg, errorMessage(error))
            }
          }
        } else if (req.subtype === 'mcp_oauth_callback_url') {
          // 用户把浏览器回跳 URL 粘回来，继续完成 MCP OAuth。
          const serverName = req.serverName as string
          const callbackUrl = req.callbackUrl as string
          const submit = oauthCallbackSubmitters.get(serverName)
          if (submit) {
            let hasCodeOrError = false
            try {
              const parsed = new URL(callbackUrl as string | URL)
              hasCodeOrError =
                parsed.searchParams.has('code') ||
                parsed.searchParams.has('error')
            } catch {
              // URL 解析失败留给下面统一报错。
            }
            if (!hasCodeOrError) {
              sendControlResponseError(
                msg,
                'Invalid callback URL: missing authorization code. Please paste the full redirect URL including the code parameter.',
              )
            } else {
              // 标记已经改走“手动回调 URL”路径，阻止自动分支重复执行。
              oauthManualCallbackUsed.add(serverName)
              submit(callbackUrl as string)
              const authPromise = oauthAuthPromises.get(serverName)
              if (authPromise) {
                try {
                  // 继续等完整 OAuth 结束，再回 success。
                  await authPromise
                  sendControlResponseSuccess(msg)
                } catch (error) {
                  sendControlResponseError(
                    msg,
                    error instanceof Error
                      ? error.message
                      : 'OAuth authentication failed',
                  )
                }
              } else {
                sendControlResponseSuccess(msg)
              }
            }
          } else {
            sendControlResponseError(
              msg,
              `No active OAuth flow for server: ${serverName}`,
            )
          }
        } else if (req.subtype === 'claude_authenticate') {
          // 这不是某个 MCP server 的 OAuth，而是 Claude 自身账号登录。
          const loginWithClaudeAi = req.loginWithClaudeAi as boolean | undefined

          // 新流程开始前，先清理掉旧的 Claude OAuth service。
          claudeOAuth?.service.cleanup()

          logEvent('tengu_oauth_flow_start', {
            loginWithClaudeAi: (loginWithClaudeAi ?? true) as boolean | number,
          })

          const service = new OAuthService()
          let urlResolver!: (urls: {
            manualUrl: string
            automaticUrl: string
          }) => void
          // 这里同样拆成“先拿 URL”和“整个 flow 完成”两层等待。
          const urlPromise = new Promise<{
            manualUrl: string
            automaticUrl: string
          }>(resolve => {
            urlResolver = resolve
          })

          const flow = service
            .startOAuthFlow(
              async (manualUrl, automaticUrl) => {
                // 一旦 service 给出 URL，立刻 resolve 给外部。
                urlResolver({ manualUrl, automaticUrl: automaticUrl! })
              },
              {
                loginWithClaudeAi: (loginWithClaudeAi ?? true) as boolean,
                skipBrowserOpen: true,
              },
            )
            .then(async tokens => {
              // 成功拿到 token 后安装到本地认证存储。
              await installOAuthTokens(tokens)
              logEvent('tengu_oauth_success', {
                loginWithClaudeAi: (loginWithClaudeAi ?? true) as boolean | number,
              })
            })
            .finally(() => {
              // flow 结束即清理 service；如果它还是当前 flow，就把全局引用也清掉。
              service.cleanup()
              if (claudeOAuth?.service === service) {
                claudeOAuth = null
              }
            })

          claudeOAuth = { service, flow }

          // catch 只做日志，真正响应由下面的 race/then 分支负责。
          void flow.catch(err =>
            logForDebugging(`claude_authenticate flow ended: ${err}`, {
              level: 'info',
            }),
          )

          try {
            const { manualUrl, automaticUrl } = await Promise.race([
              urlPromise,
              flow.then(() => {
                throw new Error(
                  'OAuth flow completed without producing auth URLs',
                )
              }),
            ])
            sendControlResponseSuccess(msg, {
              manualUrl,
              automaticUrl,
            })
          } catch (error) {
            sendControlResponseError(msg, errorMessage(error))
          }
        } else if (
          req.subtype === 'claude_oauth_callback' ||
          req.subtype === 'claude_oauth_wait_for_completion'
        ) {
          if (!claudeOAuth) {
            sendControlResponseError(
              msg,
              'No active claude_authenticate flow',
            )
          } else {
            if (req.subtype === 'claude_oauth_callback') {
              // 手动把 authorization code/state 喂回 service。
              claudeOAuth.service.handleManualAuthCodeInput({
                authorizationCode: req.authorizationCode as string,
                state: req.state as string,
              })
            }
            const { flow } = claudeOAuth
            // 不阻塞输入循环，完成后再异步回包账户信息。
            void flow.then(
              () => {
                const accountInfo = getAccountInformation()
                sendControlResponseSuccess(msg, {
                  account: {
                    email: accountInfo?.email,
                    organization: accountInfo?.organization,
                    subscriptionType: accountInfo?.subscription,
                    tokenSource: accountInfo?.tokenSource,
                    apiKeySource: accountInfo?.apiKeySource,
                    apiProvider: getAPIProvider(),
                  },
                })
              },
              (error: unknown) =>
                sendControlResponseError(msg, errorMessage(error)),
            )
          }
        } else if (req.subtype === 'mcp_clear_auth') {
          // 清空某个 MCP server 的 token，再重连成未认证态。
          const serverName = req.serverName as string
          const currentAppState = getAppState()
          const config =
            getMcpConfigByName(serverName) ??
            mcpClients.find(c => c.name === serverName)?.config ??
            currentAppState.mcp.clients.find(c => c.name === serverName)
              ?.config ??
            null
          if (!config) {
            sendControlResponseError(msg, `Server not found: ${serverName}`)
          } else if (config.type !== 'sse' && config.type !== 'http') {
            sendControlResponseError(
              msg,
              `Cannot clear auth for server type "${config.type}"`,
            )
          } else {
            await revokeServerTokens(serverName, config)
            const result = await reconnectMcpServerImpl(serverName, config)
            const prefix = getMcpPrefix(serverName)
            setAppState(prev => ({
              ...prev,
              mcp: {
                ...prev.mcp,
                clients: prev.mcp.clients.map(c =>
                  c.name === serverName as string ? result.client : c,
                ),
                tools: [
                  ...reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
                  ...result.tools,
                ],
                commands: [
                  ...reject(prev.mcp.commands, c =>
                    commandBelongsToServer(c, serverName),
                  ),
                  ...result.commands,
                ],
                resources:
                  result.resources && result.resources.length > 0
                    ? {
                        ...prev.mcp.resources,
                        [serverName]: result.resources,
                      }
                    : omit(prev.mcp.resources, serverName),
              },
            }))
            sendControlResponseSuccess(msg, {})
          }
        } else if (msg.request.subtype === 'apply_flag_settings') {
          const prevModel = getMainLoopModel()
```

这一段仍然全部属于 `control_request` 分支的继续。

这里主要是更重的运行时控制能力：

- `mcp_toggle`
- `channel_enable`
- `mcp_authenticate`
- `mcp_oauth_callback_url`
- `claude_authenticate`
- `claude_oauth_callback`
- `claude_oauth_wait_for_completion`
- `mcp_clear_auth`
- `apply_flag_settings`

这一大段你第一遍不要强行看透所有 OAuth 细节。

第一遍只抓住两个结论：

### 结论 1：输入循环不仅收“聊天消息”，也收“系统控制协议”

也就是说，这里本质上兼任了一个 headless control plane。

### 结论 2：很多运行时能力都能在会话进行中动态修改

比如：

- 开关 MCP server
- 做 OAuth
- 应用新的 flag settings
- 中途改模型或配置

特别是 `apply_flag_settings`，它说明当前会话不是静态配置，而是允许运行中改 settings，再立即影响后续 ask。

---

## 10. 输入循环后段：settings、stop_task、title、side question、remote_control（源码行 3711-4038）

```ts

          // 先把现有 inline flag settings 和新请求合并。
          const existing = getFlagSettingsInline() ?? {}
          const incoming = msg.request.settings
          const merged = { ...existing, ...incoming }
          for (const key of Object.keys(merged)) {
            // 显式传 null 代表删除这个设置项，而不是保留 null。
            if (merged[key as keyof typeof merged] === null) {
              delete merged[key as keyof typeof merged]
            }
          }
          setFlagSettingsInline(merged)
          // 通知 settings detector，后续依赖方会据此重算。
          settingsChangeDetector.notifyChange('flagSettings')

          if ('model' in incoming) {
            // model 被包含在 settings 里时，要同步改主模型 override。
            if (incoming.model != null) {
              setMainLoopModelOverride(String(incoming.model))
            } else {
              setMainLoopModelOverride(undefined)
            }
          }

          const newModel = getMainLoopModel()
          if (newModel !== prevModel) {
            // 如果 apply_flag_settings 顺手把模型也变了，要补 metadata 和 breadcrumb。
            activeUserSpecifiedModel = newModel
            const modelArg = incoming.model ? String(incoming.model) : 'default'
            notifySessionMetadataChanged({ model: newModel })
            injectModelSwitchBreadcrumbs(modelArg, newModel)
          }

          sendControlResponseSuccess(msg)
        } else if (msg.request.subtype === 'get_settings') {
          // 回当前 settings 以及真正生效后的 applied model/effort。
          const currentAppState = getAppState()
          const model = getMainLoopModel()
          const effort = modelSupportsEffort(model)
            ? resolveAppliedEffort(model, currentAppState.effortValue)
            : undefined
          sendControlResponseSuccess(msg, {
            ...getSettingsWithSources(),
            applied: {
              model,
              effort: typeof effort === 'string' ? effort : null,
            },
          })
        } else if (msg.request.subtype === 'stop_task') {
          // 停掉某个 task_id 对应的后台任务。
          const { task_id: taskId } = msg.request
          try {
            await stopTask(taskId, {
              getAppState,
              setAppState,
            })
            sendControlResponseSuccess(msg, {})
          } catch (error) {
            sendControlResponseError(msg, errorMessage(error))
          }
        } else if (req.subtype === 'generate_session_title') {
          // 异步生成会话标题，不阻塞输入循环。
          const description = req.description as string
          const persist = req.persist as boolean
          const titleSignal = (
            abortController && !abortController.signal.aborted
              ? abortController
              : createAbortController()
          ).signal
          void (async () => {
            try {
              const title = await generateSessionTitle(description, titleSignal)
              if (title && persist) {
                try {
                  // persist=true 时，把 AI 生成的标题落库到当前 session。
                  saveAiGeneratedTitle(getSessionId() as UUID, title)
                } catch (e) {
                  logError(e)
                }
              }
              sendControlResponseSuccess(msg, { title })
            } catch (e) {
              sendControlResponseError(msg, errorMessage(e))
            }
          })()
        } else if (req.subtype === 'side_question') {
          // side_question 是“旁路问答”，不直接进入主 prompt 队列。
          const question = req.question as string
          void (async () => {
            try {
              const saved = getLastCacheSafeParams()
              const cacheSafeParams = saved
                ? {
                    ...saved,
                    toolUseContext: {
                      // 旁路问题必须有自己新的 abortController，避免误伤主 ask。
                      ...saved.toolUseContext,
                      abortController: createAbortController(),
                    },
                  }
                : await buildSideQuestionFallbackParams({
                    // 如果拿不到上次缓存的 ask 参数，就现场拼一套兜底参数。
                    tools: buildAllTools(getAppState()),
                    commands: currentCommands,
                    mcpClients: [
                      ...getAppState().mcp.clients,
                      ...sdkClients,
                      ...dynamicMcpState.clients,
                    ],
                    messages: mutableMessages,
                    readFileState,
                    getAppState,
                    setAppState,
                    customSystemPrompt: options.systemPrompt,
                    appendSystemPrompt: options.appendSystemPrompt,
                    thinkingConfig: options.thinkingConfig,
                    agents: currentAgents,
                  })
              const result = await runSideQuestion({
                question,
                cacheSafeParams,
              })
              // 只把旁路问题的文本回答回给控制请求调用方。
              sendControlResponseSuccess(msg, { response: result.response })
            } catch (e) {
              sendControlResponseError(msg, errorMessage(e))
            }
          })()
        } else if (
          (feature('PROACTIVE') || feature('KAIROS')) &&
          (msg.request as { subtype: string }).subtype === 'set_proactive'
        ) {
          const req = msg.request as unknown as {
            subtype: string
            enabled: boolean
          }
          if (req.enabled) {
            if (!proactiveModule!.isProactiveActive()) {
              // 主动模式打开后，立刻补一次 tick，让系统先跑起来。
              proactiveModule!.activateProactive('command')
              scheduleProactiveTick!()
            }
          } else {
            // 关闭主动模式后，不再自动注入 tick prompt。
            proactiveModule!.deactivateProactive()
          }
          sendControlResponseSuccess(msg)
        } else if (req.subtype === 'remote_control') {
          // remote_control 是给当前 headless 会话外挂一个 bridge 入口。
          if (req.enabled as boolean) {
            if (bridgeHandle) {
              // 已经开过 bridge，就直接把现有连接信息返回。
              sendControlResponseSuccess(msg, {
                session_url: getRemoteSessionUrl(
                  bridgeHandle.bridgeSessionId,
                  bridgeHandle.sessionIngressUrl,
                ),
                connect_url: buildBridgeConnectUrl(
                  bridgeHandle.environmentId,
                  bridgeHandle.sessionIngressUrl,
                ),
                environment_id: bridgeHandle.environmentId,
              })
            } else {
              let bridgeFailureDetail: string | undefined
              try {
                const { initReplBridge } = await import(
                  'src/bridge/initReplBridge.js'
                )
                const handle = await initReplBridge({
                  onInboundMessage(msg) {
                    // 远端传来的普通消息，转成本地 prompt 入队。
                    const fields = extractInboundMessageFields(msg)
                    if (!fields) return
                    const { content, uuid } = fields
                    enqueue({
                      value: content,
                      mode: 'prompt' as const,
                      uuid,
                      skipSlashCommands: true,
                    })
                    void run()
                  },
                  onPermissionResponse(response) {
                    // 远端的人类审批响应，重新注入 structuredIO 控制流。
                    structuredIO.injectControlResponse(response)
                  },
                  onInterrupt() {
                    // 远端也能触发本地 abort。
                    abortController?.abort()
                  },
                  onSetModel(model) {
                    // 远端切模型，等价于本地 set_model。
                    const resolved =
                      model === 'default' ? getDefaultMainLoopModel() : model
                    activeUserSpecifiedModel = resolved
                    setMainLoopModelOverride(resolved)
                  },
                  onSetMaxThinkingTokens(maxTokens) {
                    // 远端切 thinking 预算，逻辑与 set_max_thinking_tokens 一致。
                    if (maxTokens === null) {
                      options.thinkingConfig = undefined
                    } else if (maxTokens === 0) {
                      options.thinkingConfig = { type: 'disabled' }
                    } else {
                      options.thinkingConfig = {
                        type: 'enabled',
                        budgetTokens: maxTokens,
                      }
                    }
                  },
                  onStateChange(state, detail) {
                    // bridge 自己的状态变化也要回写到 output，供调用方感知。
                    if (state === 'failed') {
                      bridgeFailureDetail = detail
                    }
                    logForDebugging(
                      `[bridge:sdk] State change: ${state}${detail ? ` — ${detail}` : ''}`,
                    )
                    output.enqueue({
                      type: 'system' as StdoutMessage['type'],
                      subtype: 'bridge_state' as string,
                      state,
                      detail,
                      uuid: randomUUID(),
                      session_id: getSessionId(),
                    } as StdoutMessage)
                  },
                  // 建桥成功时，把当前消息历史带过去，让远端界面有上下文。
                  initialMessages:
                    mutableMessages.length > 0 ? mutableMessages : undefined,
                })
                if (!handle) {
                  sendControlResponseError(
                    msg,
                    bridgeFailureDetail ??
                      'Remote Control initialization failed',
                  )
                } else {
                  // 保存 bridge 句柄，并把 structuredIO 的控制请求转发钩子接到 bridge。
                  bridgeHandle = handle
                  bridgeLastForwardedIndex = mutableMessages.length
                  structuredIO.setOnControlRequestSent(request => {
                    handle.sendControlRequest(request)
                  })
                  structuredIO.setOnControlRequestResolved(requestId => {
                    handle.sendControlCancelRequest(requestId)
                  })
                  sendControlResponseSuccess(msg, {
                    session_url: getRemoteSessionUrl(
                      handle.bridgeSessionId,
                      handle.sessionIngressUrl,
                    ),
                    connect_url: buildBridgeConnectUrl(
                      handle.environmentId,
                      handle.sessionIngressUrl,
                    ),
                    environment_id: handle.environmentId,
                  })
                }
              } catch (err) {
                sendControlResponseError(msg, errorMessage(err))
              }
            }
          } else {
            if (bridgeHandle) {
              // 关闭 remote control：先解绑转发钩子，再 teardown bridge。
              structuredIO.setOnControlRequestSent(undefined)
              structuredIO.setOnControlRequestResolved(undefined)
              await bridgeHandle.teardown()
              bridgeHandle = null
            }
            sendControlResponseSuccess(msg)
          }
        } else {
          // 未识别 subtype 直接返回错误，避免静默吞掉控制命令。
          sendControlResponseError(
            msg,
            `Unsupported control request subtype: ${(msg.request as { subtype: string }).subtype}`,
          )
        }
        continue
```

这一段还是 `control_request` 的后半。

包含的能力有：

- `get_settings`
- `stop_task`
- `generate_session_title`
- `side_question`
- `set_proactive`
- `remote_control`
- 未知 subtype 的兜底 error

这里第一遍最值得理解的是两个点：

### `generate_session_title` / `side_question` 为什么是 fire-and-forget

因为输入循环是串行读 stdin / structuredInput 的。
如果在这里同步 await 一个较慢的 API 调用，会把后续的：

- user message
- interrupt
- 其他 control_request

全部堵住。

所以这里很多慢操作都写成：

```text
启动一个后台异步任务，但不要阻塞输入循环继续读下一条消息。
```

### `remote_control`

这一段说明 bridge 是怎么接到 headless 会话上的：

- 远端来的入站消息 -> enqueue prompt -> `void run()`
- 远端的 permission response -> 注入回 structuredIO 控制流
- 远端可以改 model / thinking tokens
- bridge 状态变化会再写回 `output`

如果你暂时不研究 bridge，可以先只记一句：

```text
remote_control 本质上是“给当前 headless 会话再挂一个远程输入输出口”。
```

---

## 11. 输入循环结尾：`control_response` / replay / `user` 入队 / 关闭输出流（源码行 4039-4155）

```ts
      // control_response 一般不进队列，必要时只做 replay。
      } else if (message.type === 'control_response') {
        if (options.replayUserMessages) {
          // replay 模式下，把控制响应也原样回放到输出流。
          output.enqueue(message as StdoutMessage)
        }
        continue
      // keep_alive 直接忽略。
      } else if (message.type === 'keep_alive') {
        continue
      // 环境变量更新已经在 structuredIO 层处理过，这里只是做类型分流。
      } else if (message.type === 'update_environment_variables') {
        continue
      // assistant/system replay 不触发 ask，只写回 mutableMessages 当上下文。
      } else if (message.type === 'assistant' || message.type === 'system') {
        // assistant/system 不触发新 ask，只是补进会话历史。
        const internalMsgs = toInternalMessages([message as SDKMessage])
        mutableMessages.push(...internalMsgs)
        if (message.type === 'assistant' && options.replayUserMessages) {
          output.enqueue(message as StdoutMessage)
        }
        continue
      }
      // 只有走到这里的才是真正的 user message 主线入口。
      if (message.type !== 'user') {
        continue
      }
      // 断言成 SDKUserMessage，下面开始做去重和入队。
      const userMsg = message as SDKUserMessage

      // 收到第一条真实 prompt，就视为会话初始化完成。
      initialized = true

      // 先按 UUID 去重，避免同一条 user message 被执行两次。
      if (userMsg.uuid) {
        const sessionId = getSessionId() as UUID
        // 既查持久化 session，又查本进程内 Set，双重去重。
        const existsInSession = await doesMessageExistInSession(
          sessionId,
          userMsg.uuid as UUID,
        )

        if (existsInSession || receivedMessageUuids.has(userMsg.uuid as UUID)) {
          logForDebugging(`Skipping duplicate user message: ${userMsg.uuid}`)
          if (options.replayUserMessages) {
            logForDebugging(
              `Sending acknowledgment for duplicate user message: ${userMsg.uuid}`,
            )
            // 对重复消息仍回一个 replay ack，避免调用方一直等待。
            output.enqueue({
              type: 'user',
              content: (userMsg.message as { content?: string })?.content ?? '',
              message: userMsg.message as unknown,
              session_id: sessionId,
              parent_tool_use_id: null,
              uuid: userMsg.uuid as string,
              timestamp: (userMsg as { timestamp?: string }).timestamp,
              isReplay: true,
            } as unknown as StdoutMessage)
          }
          if (existsInSession) {
            notifyCommandLifecycle(userMsg.uuid as string, 'completed')
          }
          continue
        }

        // 这条 uuid 现在正式登记为“已收过”。
        trackReceivedMessageUuid(userMsg.uuid as UUID)
      }

      // 真正把 user message 转成内部 prompt 命令塞进队列。
      enqueue({
        mode: 'prompt' as const,
        // resolveAndPrepend 会把用户输入解析并按需要补前缀内容。
        value: await resolveAndPrepend(userMsg, (userMsg.message as { content: ContentBlockParam[] }).content),
        uuid: userMsg.uuid as `${string}-${string}-${string}-${string}-${string}`,
        priority: (userMsg as { priority?: string }).priority as import('src/types/textInputTypes.js').QueuePriority,
      })
      if (feature('COMMIT_ATTRIBUTION')) {
        // 每收到一条真实 user prompt，都要推进 attribution 计数并异步落快照。
        setAppState(prev => ({
          ...prev,
          attribution: incrementPromptCount(prev.attribution, snapshot => {
            void recordAttributionSnapshot(snapshot).catch(error => {
              logForDebugging(`Attribution: Failed to save snapshot: ${error}`)
            })
          }),
        }))
      }
      // 入队之后，唤醒 run() 去真正消费它。
      void run()
    }
    // 输入流结束了，但这里只是标记 inputClosed；是否关流还要看 run 是否也停了。
    inputClosed = true
    cronScheduler?.stop()
    if (!running) {
      // 没有 ask 在跑时，才真正做最后清理并关闭输出流。
      if (suggestionState.inflightPromise) {
        // 最多等 5 秒，防止 suggestion promise 无期限挂住。
        await Promise.race([suggestionState.inflightPromise, sleep(5000)])
      }
      suggestionState.abortController?.abort()
      suggestionState.abortController = null
      await finalizePendingAsyncHooks()
      unsubscribeSkillChanges()
      unsubscribeAuthStatus?.()
      statusListeners.delete(rateLimitListener)
      output.done()
    }
  })()

  // 函数本身很快返回；真正的活都在后台两个循环里继续进行。
  return output
```

这是整方法真正的最后一段，也最贴近你最关心的主线。

先看非 user 的剩余分支：

- `control_response`：必要时 replay 到输出
- `keep_alive`：忽略
- `update_environment_variables`：忽略
- `assistant` / `system`：写回 `mutableMessages`，必要时 echo 到输出

这说明：

```text
assistant/system replay 不会触发 ask，
它们只是进入当前会话历史，给后续 ask 当上下文。
```

### 最关键的部分：`user`

这里的逻辑非常清楚：

1. 把 `message` 断言成 `userMsg`
2. 检查 UUID 是否重复
3. 如果重复：
   - 可能回 replay ack
   - 不再执行
4. 如果不重复：
   - `trackReceivedMessageUuid(...)`
   - `resolveAndPrepend(...)`
   - `enqueue({ mode: 'prompt', ... })`
   - `void run()`

这就是整条主线的真正入口：

```text
外部 user message
-> 入内部 prompt 队列
-> 唤醒 run()
-> run() 去调 ask()
```

### 输入循环结束后

最后几行的含义是：

- `inputClosed = true`
- 停 cron scheduler
- 如果当前没有 run 在跑了：
  - 等 suggestion 尽量结束
  - final async hooks
  - 取消监听
  - `output.done()`

最后一行：

```ts
return output
```

这句特别重要。它说明整个函数不是“等所有事情结束后再返回结果”，而是：

```text
先把 output 这个异步输出流交给调用方，
然后后台继续靠输入循环和 run() 往这个流里推消息。
```

---

## 最后再压缩成一句话

如果你读完整篇，最后只想留一句最短总结，那就是：

```text
runHeadlessStreaming() 里面一直并发跑着两件事：

1. 输入循环：
   从 structuredInput 收消息，
   把 control_request 直接处理，
   把 user message 变成 prompt 命令入队。

2. run()：
   从内部队列取命令，
   组装本轮 ask 所需的环境，
   调 ask()，
   再把 ask() 的输出持续转发到 output。
```

所以整条主线可以再画成最后一张最短图：

```text
structuredInput
   |
   +--> control_request -> 直接处理
   |
   +--> user -> enqueue(prompt) -> run() -> ask() -> output
   |
   +--> assistant/system -> mutableMessages
```

如果你接下来还要继续读，我建议顺序是：

```text
runHeadlessStreaming()
  -> ask()
    -> QueryEngine.submitMessage()
      -> query()
        -> queryLoop()
```
