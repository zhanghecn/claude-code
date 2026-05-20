# Claude Code 上下文压缩系统源码导读

这份文档只讲“上下文压缩”。它和 `memory-system-source-guide.md` 的关系是：

- 记忆系统负责把长期有价值的信息提取到 Session Memory / CLAUDE.md 等外部上下文里。
- 压缩系统负责在一次会话太长时，把模型当前要看的 `messages` 变短，让会话还能继续。

你可以先把压缩系统理解成一句话：

> Claude Code 不会一直把完整历史塞给模型。每轮请求前，它先从最近一次 compact 边界之后取消息，再依次尝试 snip、microcompact、context collapse、auto compact；如果 API 仍然报上下文过长，再 reactive compact 生成摘要并重试。

---

## 0. 先建立全局地图

核心文件：

```text
src/query.ts
  每一轮请求的总调度器。真正决定“这次发给模型的 messages 长什么样”。

src/services/compact/compact.ts
  完整 compact / partial compact 的核心实现：生成摘要、创建边界、恢复附件。

src/services/compact/prompt.ts
  compact 摘要提示词模板。这里能看到真实 summarization prompt。

src/services/compact/autoCompact.ts
  自动压缩阈值、开关、失败熔断、session memory 优先逻辑。

src/services/compact/microCompact.ts
  微压缩：清理旧工具结果，或者通过 cache_edits 删除服务端缓存中的工具结果。

src/services/compact/cachedMicrocompact.ts
  cached microcompact 的状态机：登记 tool_use_id、决定删除哪些、生成 cache_edits。

src/services/compact/apiMicrocompact.ts
  API 原生 context_management 配置：让服务端清 thinking / tool result。

src/services/compact/snipCompact.ts
src/services/compact/snipProjection.ts
  snip：把已经标记可移除的历史从模型视图中过滤掉。

src/services/compact/sessionMemoryCompact.ts
  用 Session Memory 替代传统摘要的压缩路径。

src/services/compact/reactiveCompact.ts
  API 返回 prompt-too-long / media-too-large 后的紧急压缩。

src/services/compact/postCompactCleanup.ts
  压缩成功后清理各种模块级缓存。

src/commands/compact/compact.ts
  `/compact` 手动命令入口。

src/utils/messages.ts
  compact_boundary / microcompact_boundary 消息结构，以及“从最近边界切片”的函数。

src/QueryEngine.ts
  SDK/headless 层如何记录 compact boundary、释放旧历史、让 resume 仍然正确。

src/services/api/claude.ts
  API 请求层：插入 cache_edits、context_management，消费 cached microcompact 状态。
```

你之后搜索源码，建议从这条命令开始：

```bash
rg -n "compact|microcompact|snip|cache_edits|context_management|compact_boundary" src/query.ts src/services/compact src/commands/compact src/utils/messages.ts src/services/api/claude.ts src/QueryEngine.ts
```

---

## 1. 七种“压缩”不要混在一起

这个项目里“上下文压缩”不是一个动作，而是一组策略。

```text
┌────────────────────────────┬────────────────────────────┬──────────────────────────────┐
│ 名称                       │ 触发位置                   │ 本质                         │
├────────────────────────────┼────────────────────────────┼──────────────────────────────┤
│ /compact 手动压缩           │ src/commands/compact        │ 生成摘要，替换旧历史         │
│ auto compact 自动压缩       │ src/query.ts -> autoCompact  │ 达到阈值后自动生成摘要       │
│ session memory compact      │ auto/manual compact 前       │ 用 Session Memory 作为摘要   │
│ partial compact             │ message selector             │ 只压缩选中点之前/之后一段    │
│ microcompact 微压缩         │ 每轮 API 前                  │ 清工具结果，不总结对话       │
│ snip compact                │ 每轮 API 前                  │ 删除被 snip 标记的消息       │
│ reactive compact            │ API 报 413 / media error 后  │ 紧急 compact 后重试          │
└────────────────────────────┴────────────────────────────┴──────────────────────────────┘
```

最重要的分界线：

```text
真正“写摘要”的压缩
  /compact
  auto compact
  partial compact
  session memory compact
  reactive compact

不写摘要、只删/隐藏局部内容的压缩
  snip compact
  microcompact
  API context_management
```

---

## 2. 一轮请求里的压缩管线

主流程在 `src/query.ts`。每轮请求进入 API 前，消息会经过这条管线：

```text
用户输入 + 历史 messages
        │
        ▼
getMessagesAfterCompactBoundary()
只取最近 compact_boundary 之后的消息
        │
        ▼
applyToolResultBudget()
按单条工具结果预算替换超大内容
        │
        ▼
snipCompactIfNeeded()
过滤被 snip_boundary 标记删除的消息
        │
        ▼
microcompactMessages()
清旧工具结果，或生成 cache_edits
        │
        ▼
contextCollapse.applyCollapsesIfNeeded()
如果启用 context collapse，先做细粒度折叠
        │
        ▼
autoCompactIfNeeded()
如果接近上下文窗口，生成摘要
        │
        ▼
blocking limit / predictive autocompact
防止本轮调用后爆窗
        │
        ▼
queryModelWithStreaming()
真正请求模型
        │
        ▼
如果返回 prompt-too-long/media-too-large
        │
        ├─ contextCollapse.recoverFromOverflow()
        │
        └─ reactiveCompact.tryReactiveCompact()
```

真实源码片段，中文注释是本文添加的：

```ts
// src/query.ts

// 1. 永远先从最近一次 compact 边界之后开始。
//    这意味着 compact 之前的旧历史不会继续进入下一轮模型请求。
let messagesForQuery = getMessagesAfterCompactBoundary(messages)

// 2. snip 在 microcompact 前执行。
//    snip 会把已经标记删除的消息从模型视图中过滤掉。
let snipTokensFreed = 0
if (feature('HISTORY_SNIP')) {
  const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)
  messagesForQuery = snipResult.messages
  snipTokensFreed = snipResult.tokensFreed
  if (snipResult.boundaryMessage) {
    yield snipResult.boundaryMessage
  }
}

// 3. microcompact 在 auto compact 前执行。
//    它可能直接替换旧 tool_result，也可能只排队 cache_edits。
const microcompactResult = await deps.microcompact(
  messagesForQuery,
  toolUseContext,
  querySource,
)
messagesForQuery = microcompactResult.messages

// 4. auto compact 判断是否需要生成摘要。
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
```

注意 `snipTokensFreed`：snip 删除了消息，但最后一个 assistant usage 里可能还是旧的 token 统计，所以 auto compact 计算阈值时要减去这个估算值。

---

## 3. compact_boundary 是整套系统的切割线

压缩成功后，系统不会真的把所有历史都物理删除。核心动作是插入一个 `compact_boundary`，之后所有模型请求都从这个边界开始切片。

源码：

```ts
// src/utils/messages.ts

export function createCompactBoundaryMessage(
  trigger: 'manual' | 'auto',
  preTokens: number,
  lastPreCompactMessageUuid?: UUID,
  userContext?: string,
  messagesSummarized?: number,
): SystemCompactBoundaryMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    content: `Conversation compacted`,
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    level: 'info',
    compactMetadata: {
      trigger,
      preTokens,
      userContext,
      messagesSummarized,
    },
    ...(lastPreCompactMessageUuid && {
      logicalParentUuid: lastPreCompactMessageUuid,
    }),
  }
}

export function getMessagesAfterCompactBoundary<
  T extends Message | NormalizedMessage,
>(messages: T[], options?: { includeSnipped?: boolean }): T[] {
  const boundaryIndex = findLastCompactBoundaryIndex(messages)
  const sliced = boundaryIndex === -1 ? messages : messages.slice(boundaryIndex)
  if (!options?.includeSnipped && feature('HISTORY_SNIP')) {
    const { projectSnippedView } =
      require('../services/compact/snipProjection.js') as typeof import('../services/compact/snipProjection.js')
    return projectSnippedView(sliced as Message[]) as T[]
  }
  return sliced
}
```

中文解读：

- `subtype: 'compact_boundary'` 是边界类型。
- `trigger` 记录是 `manual` 还是 `auto`。
- `preTokens` 记录压缩前 token 数。
- `logicalParentUuid` 让 transcript / resume 知道这个边界接在哪条消息后面。
- `getMessagesAfterCompactBoundary()` 每轮都向后扫描最后一个边界，然后 `slice(boundaryIndex)`。
- 如果启用 `HISTORY_SNIP`，切完 compact 边界后还会投影 snipped view。

压缩后的消息顺序由 `buildPostCompactMessages()` 固定：

```ts
// src/services/compact/compact.ts

export interface CompactionResult {
  boundaryMarker: SystemMessage
  summaryMessages: UserMessage[]
  attachments: AttachmentMessage[]
  hookResults: HookResultMessage[]
  messagesToKeep?: Message[]
  userDisplayMessage?: string
  preCompactTokenCount?: number
  postCompactTokenCount?: number
  truePostCompactTokenCount?: number
  compactionUsage?: ReturnType<typeof getTokenUsage>
}

export function buildPostCompactMessages(result: CompactionResult): Message[] {
  return ([result.boundaryMarker] as Message[]).concat(
    result.summaryMessages,
    stripToolUseResults(result.messagesToKeep),
    result.attachments,
    result.hookResults,
  )
}
```

压缩后的模型上下文长这样：

```text
compact_boundary
        │
        ├─ summaryMessages
        │    一条 user message，内容是“本会话从之前跑满上下文的对话继续... + 摘要”
        │
        ├─ messagesToKeep
        │    部分压缩 / session memory / reactive 路径可能保留最近原文
        │
        ├─ attachments
        │    文件、计划、技能、MCP、agent listing、deferred tools 等恢复信息
        │
        └─ hookResults
             SessionStart hooks 重新注入的上下文
```

---

## 4. 手动 `/compact` 入口

命令注册在 `src/commands/compact/index.ts`：

```ts
const compact = {
  type: 'local',
  name: 'compact',
  description:
    'Clear conversation history but keep a summary in context. Optional: /compact [instructions for summarization]',
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_COMPACT),
  supportsNonInteractive: true,
  argumentHint: '<optional custom summarization instructions>',
  load: () => import('./compact.js'),
} satisfies Command
```

真正执行在 `src/commands/compact/compact.ts`：

```ts
export const call: LocalCommandCall = async (args, context) => {
  let { messages } = context

  // REPL 保留完整 scrollback，但 compact 模型不应该总结已被边界切掉的历史。
  messages = getMessagesAfterCompactBoundary(messages)

  const customInstructions = args.trim()

  // 没有自定义指令时，优先尝试 session memory compact。
  // 因为 session memory 已经有结构化记忆，没必要再花一次总结调用。
  if (!customInstructions) {
    const sessionMemoryResult = await trySessionMemoryCompaction(
      messages,
      context.agentId,
    )
    if (sessionMemoryResult) {
      runPostCompactCleanup()
      suppressCompactWarning()
      return {
        type: 'compact',
        compactionResult: sessionMemoryResult,
        displayText: buildDisplayText(context),
      }
    }
  }

  // 传统 compact 前先 microcompact，尽量减少摘要请求输入。
  const microcompactResult = await microcompactMessages(messages, context)
  const messagesForCompact = microcompactResult.messages

  const result = await compactConversation(
    messagesForCompact,
    context,
    await getCacheSharingParams(context, messagesForCompact),
    false,
    customInstructions,
    false,
  )
}
```

手动 `/compact xxx` 中的 `xxx` 会作为 `customInstructions` 拼进摘要提示词。没有 `xxx` 时，才会走 session memory compact 优先路径。

---

## 5. traditional compact 的核心：compactConversation()

`compactConversation()` 是传统完整压缩的核心。它做的事可以拆成八步：

```text
compactConversation(messages)
        │
        ├─ 1. 统计压缩前 token
        ├─ 2. 执行 PreCompact hooks，合并自定义摘要指令
        ├─ 3. 构造 compact prompt
        ├─ 4. 调用 streamCompactSummary() 生成摘要
        ├─ 5. 如果摘要请求本身 prompt-too-long，丢弃最旧 API round 后重试
        ├─ 6. 清 readFileState / nested memory cache
        ├─ 7. 构造 post-compact attachments
        └─ 8. 创建 boundary + summary message + hooks，并返回 CompactionResult
```

关键源码：

```ts
// src/services/compact/compact.ts

export async function compactConversation(
  messages: Message[],
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  suppressFollowUpQuestions: boolean,
  customInstructions?: string,
  isAutoCompact: boolean = false,
  recompactionInfo?: RecompactionInfo,
): Promise<CompactionResult> {
  if (messages.length === 0) {
    throw new Error(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)
  }

  const preCompactTokenCount = tokenCountWithEstimation(messages)

  // PreCompact hook 可以返回新的摘要指令。
  const hookResult = await executePreCompactHooks(
    {
      trigger: isAutoCompact ? 'auto' : 'manual',
      customInstructions: customInstructions ?? null,
    },
    context.abortController.signal,
  )
  customInstructions = mergeHookInstructions(
    customInstructions,
    hookResult.newCustomInstructions,
  )

  const compactPrompt = getCompactPrompt(customInstructions)
  const summaryRequest = createUserMessage({
    content: compactPrompt,
  })

  let messagesToSummarize = messages
  let retryCacheSafeParams = cacheSafeParams
  let summaryResponse: AssistantMessage
  let summary: string | null
  let ptlAttempts = 0
  for (;;) {
    summaryResponse = await streamCompactSummary({
      messages: messagesToSummarize,
      summaryRequest,
      appState,
      context,
      preCompactTokenCount,
      cacheSafeParams: retryCacheSafeParams,
    })
    summary = getAssistantMessageText(summaryResponse)
    if (!summary?.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE)) break

    // 如果 compact 请求自己都太长，就从头丢最旧 API round 再重试。
    ptlAttempts++
    const truncated =
      ptlAttempts <= MAX_PTL_RETRIES
        ? truncateHeadForPTLRetry(messagesToSummarize, summaryResponse)
        : null
    if (!truncated) {
      throw new Error(ERROR_MESSAGE_PROMPT_TOO_LONG)
    }
    messagesToSummarize = truncated
    retryCacheSafeParams = {
      ...retryCacheSafeParams,
      forkContextMessages: truncated,
    }
  }
}
```

摘要生成成功后，开始重建“压缩后的上下文”：

```ts
// src/services/compact/compact.ts

// 先把读过的文件状态保存下来，随后清空。
// 清空是为了避免旧文件缓存继续占内存；后面会用附件恢复必要文件片段。
let preCompactReadFileState = cacheToObject(context.readFileState)
context.readFileState.clear()
context.loadedNestedMemoryPaths?.clear()

// 并行恢复最近文件附件和异步 agent 状态。
const [fileAttachments, asyncAgentAttachments] = await Promise.all([
  createPostCompactFileAttachments(
    preCompactReadFileState,
    context,
    POST_COMPACT_MAX_FILES_TO_RESTORE,
  ),
  createAsyncAgentAttachmentsIfNeeded(context),
])

const postCompactFileAttachments: AttachmentMessage[] = [
  ...fileAttachments,
  ...asyncAgentAttachments,
]

// 计划文件、计划模式、已调用技能、deferred tools、agent listing、MCP instructions
// 都会重新以 attachment 形式注入，避免摘要把这些结构性上下文吃掉。
const planAttachment = createPlanAttachmentIfNeeded(context.agentId)
const planModeAttachment = await createPlanModeAttachmentIfNeeded(context)
const skillAttachment = createSkillAttachmentIfNeeded(context.agentId)
```

最后创建边界和摘要：

```ts
// src/services/compact/compact.ts

const boundaryMarker = createCompactBoundaryMessage(
  isAutoCompact ? 'auto' : 'manual',
  preCompactTokenCount ?? 0,
  messages.at(-1)?.uuid,
)

const summaryMessages: UserMessage[] = [
  createUserMessage({
    content: getCompactUserSummaryMessage(
      summary,
      suppressFollowUpQuestions,
      transcriptPath,
    ),
    isCompactSummary: true,
    isVisibleInTranscriptOnly: true,
  }),
]

const postCompactHookResult = await executePostCompactHooks(
  {
    trigger: isAutoCompact ? 'auto' : 'manual',
    compactSummary: summary,
  },
  context.abortController.signal,
)

return {
  boundaryMarker,
  summaryMessages,
  attachments: postCompactFileAttachments,
  hookResults: hookMessages,
  userDisplayMessage: combinedUserDisplayMessage || undefined,
  preCompactTokenCount,
  postCompactTokenCount: compactionCallTotalTokens,
  truePostCompactTokenCount,
  compactionUsage,
}
```

这里有一个容易混淆的点：

- `postCompactTokenCount` 在这个实现里主要是 compact API 调用本身的 token usage。
- `truePostCompactTokenCount` 才更接近“压缩后实际上下文有多大”。

---

## 6. 摘要是怎么生成的：streamCompactSummary()

`streamCompactSummary()` 有两条路径：

```text
优先路径：forked agent + prompt cache sharing
  目的：复用主会话已经缓存的 system/tools/messages 前缀，降低 compact 成本。

回退路径：queryModelWithStreaming()
  目的：普通流式请求，只给 FileReadTool 或额外搜索工具。
```

源码：

```ts
// src/services/compact/compact.ts

if (promptCacheSharingEnabled) {
  const result = await runForkedAgent({
    promptMessages: [summaryRequest],
    cacheSafeParams,
    canUseTool: createCompactCanUseTool(),
    querySource: 'compact',
    forkLabel: 'compact',
    maxTurns: 1,
    skipCacheWrite: true,
    overrides: { abortController: context.abortController },
  })
  const assistantMsg = getLastAssistantMessage(result.messages)
  const assistantText = assistantMsg
    ? getAssistantMessageText(assistantMsg)
    : null
  if (assistantMsg && assistantText && !assistantMsg.isApiErrorMessage) {
    return assistantMsg
  }
}
```

中文解读：

- `querySource: 'compact'` 标记这是压缩子任务。
- `maxTurns: 1` 要求 summarizer 一轮内完成。
- `skipCacheWrite: true` 避免把 compact fork 写入缓存。
- `canUseTool: createCompactCanUseTool()` 禁止工具调用。

禁止工具调用的函数很直接：

```ts
// src/services/compact/compact.ts

export function createCompactCanUseTool(): CanUseToolFn {
  return async () => ({
    behavior: 'deny' as const,
    message: 'Tool use is not allowed during compaction',
    decisionReason: {
      type: 'other' as const,
      reason: 'compaction agent should only produce text summary',
    },
  })
}
```

回退路径：

```ts
// src/services/compact/compact.ts

const streamingGen = queryModelWithStreaming({
  messages: normalizeMessagesForAPI(
    stripImagesFromMessages(
      stripReinjectedAttachments([
        ...getMessagesAfterCompactBoundary(messages),
        summaryRequest,
      ]),
    ),
    context.options.tools,
  ),
  systemPrompt: asSystemPrompt([
    'You are a helpful AI assistant tasked with summarizing conversations.',
  ]),
  thinkingConfig: { type: 'disabled' as const },
  tools,
  signal: context.abortController.signal,
})
```

这里能看出几个设计点：

- compact fallback 的 system prompt 很短，只说“你是负责总结对话的助手”。
- thinking 被禁用，目的是降低复杂度和输出不可控性。
- `stripImagesFromMessages()` 会把图片/文档替换成 `[image]` / `[document]`，避免摘要请求本身因为媒体太大失败。
- `stripReinjectedAttachments()` 去掉压缩后会重新注入的附件，避免摘要污染。

---

## 7. 真实 compact 提示词与中文解读

提示词在 `src/services/compact/prompt.ts`。

### 7.1 禁止工具调用前缀

真实片段：

```ts
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`
```

中文解读：

- 这段不是给普通 Claude Code 主循环的，而是给 compact summarizer 的。
- 它要求模型只输出文本，不调用任何工具。
- 输出结构必须先 `<analysis>`，再 `<summary>`。
- 后续 `formatCompactSummary()` 会删除 `<analysis>`，只保留整理后的摘要。

### 7.2 完整压缩提示词主体

真实片段：

```ts
const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

${DETAILED_ANALYSIS_INSTRUCTION_BASE}

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request.
`
```

中文解读：

这不是普通“帮我总结一下”。它明确要求保留：

- 用户原始意图；
- 技术概念；
- 文件和代码片段；
- 错误和修复；
- 当前工作状态；
- 下一步，而且下一步必须紧贴最近用户请求。

这解释了为什么 compact 后模型通常能继续做任务：摘要不是自然语言闲聊总结，而是面向“继续开发”的状态迁移文档。

### 7.3 自定义指令拼接

```ts
export function getCompactPrompt(customInstructions?: string): string {
  let prompt = NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT

  if (customInstructions && customInstructions.trim() !== '') {
    prompt += `\n\nAdditional Instructions:\n${customInstructions}`
  }

  prompt += NO_TOOLS_TRAILER

  return prompt
}
```

中文解读：

- `/compact 重点记录测试失败原因` 里的后半段会进入 `Additional Instructions`。
- PreCompact hook 返回的 `newCustomInstructions` 也会并入这里。
- 这就是“压缩摘要提示词可扩展”的入口。

### 7.4 摘要进入下一轮上下文时的包装

```ts
export function getCompactUserSummaryMessage(
  summary: string,
  suppressFollowUpQuestions?: boolean,
  transcriptPath?: string,
  recentMessagesPreserved?: boolean,
): string {
  const formattedSummary = formatCompactSummary(summary)

  let baseSummary = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

${formattedSummary}`

  if (transcriptPath) {
    baseSummary += `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${transcriptPath}`
  }

  if (recentMessagesPreserved) {
    baseSummary += `\n\nRecent messages are preserved verbatim.`
  }

  if (suppressFollowUpQuestions) {
    let continuation = `${baseSummary}
Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.`
    return continuation
  }

  return baseSummary
}
```

中文解读：

- 摘要不是以 assistant 身份塞回去，而是创建一条 synthetic user message。
- 它告诉模型：“这是从跑满上下文的上一段会话继续。”
- 如果是 auto/reactive compact，通常 `suppressFollowUpQuestions=true`，会要求模型不要寒暄、不要重新概括，直接继续干活。
- 如果有 transcript path，模型可以被提醒去读完整 transcript。

---

## 8. 自动压缩：阈值、窗口、熔断

自动压缩在 `src/services/compact/autoCompact.ts`。

阈值计算：

```text
effectiveContextWindow
  = model context window - reserved summary output tokens

autoCompactThreshold
  = effectiveContextWindow - autocompactBuffer

autocompactBuffer
  800k+ 窗口: 50k
  400k+ 窗口: 30k
  其他: 13k
```

源码：

```ts
// src/services/compact/autoCompact.ts

const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

export function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  let contextWindow = getContextWindowForModel(model, getSdkBetas())

  const autoCompactWindow = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW
  if (autoCompactWindow) {
    const parsed = parseInt(autoCompactWindow, 10)
    if (!isNaN(parsed) && parsed > 0) {
      contextWindow = Math.min(contextWindow, parsed)
    }
  }

  return contextWindow - reservedTokensForSummary
}

export function getAutocompactBufferTokens(model: string): number {
  const effectiveWindow = getEffectiveContextWindowSize(model)
  if (effectiveWindow >= 800_000) return 50_000
  if (effectiveWindow >= 400_000) return 30_000
  return AUTOCOMPACT_BUFFER_TOKENS
}

export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)
  const autocompactThreshold =
    effectiveContextWindow - getAutocompactBufferTokens(model)
  return autocompactThreshold
}
```

自动压缩开关：

```ts
export function isAutoCompactEnabled(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return false
  }
  if (isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)) {
    return false
  }
  const userConfig = getGlobalConfig()
  return userConfig.autoCompactEnabled
}
```

自动压缩真正执行：

```ts
export async function autoCompactIfNeeded(
  messages: Message[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource?: QuerySource,
  tracking?: AutoCompactTrackingState,
  snipTokensFreed?: number,
): Promise<{
  wasCompacted: boolean
  compactionResult?: CompactionResult
  consecutiveFailures?: number
}> {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return { wasCompacted: false }
  }

  // 连续失败 3 次后熔断，避免每轮都烧一次 compact API。
  if (
    tracking?.consecutiveFailures !== undefined &&
    tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
  ) {
    return { wasCompacted: false }
  }

  const shouldCompact = await shouldAutoCompact(
    messages,
    model,
    querySource,
    snipTokensFreed,
  )

  if (!shouldCompact) {
    return { wasCompacted: false }
  }

  // 优先 session memory compact。
  const sessionMemoryResult = await trySessionMemoryCompaction(
    messages,
    toolUseContext.agentId,
    recompactionInfo.autoCompactThreshold,
  )
  if (sessionMemoryResult) {
    runPostCompactCleanup(querySource)
    markPostCompaction()
    return {
      wasCompacted: true,
      compactionResult: sessionMemoryResult,
    }
  }

  // 其次传统 compact。
  const compactionResult = await compactConversation(
    messages,
    toolUseContext,
    cacheSafeParams,
    true,
    undefined,
    true,
    recompactionInfo,
  )
}
```

要点：

- `DISABLE_COMPACT=1` 会同时关掉手动和自动 compact。
- `DISABLE_AUTO_COMPACT=1` 只关自动 compact，保留 `/compact`。
- 自动 compact 前会先尝试 session memory compact。
- 失败会记录 `consecutiveFailures`，最多连续尝试 3 次。

---

## 9. predictive autocompact：本轮还没爆，但预计会爆

`src/query.ts` 里还有一个预测式压缩。它不只看当前 token 是否超过 auto threshold，还估算“本轮模型输出 + 工具结果”会不会把上下文推爆。

```ts
// src/services/compact/autoCompact.ts

const TOOL_RESULT_GROWTH_ESTIMATE = 15_000

export function estimateMaxTurnGrowth(model: string): number {
  const maxOutput = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  return maxOutput + TOOL_RESULT_GROWTH_ESTIMATE
}
```

在 `query.ts` 中使用：

```ts
// src/query.ts

if (!compactionResult && isAutoCompactEnabled()) {
  const model = toolUseContext.options.mainLoopModel
  const currentTokens =
    tokenCountWithEstimation(messagesForQuery) - snipTokensFreed
  const estimatedGrowth = estimateMaxTurnGrowth(model)
  const predictiveThreshold =
    getEffectiveContextWindowSize(model) - estimatedGrowth
  if (currentTokens > predictiveThreshold) {
    const predictiveResult = await deps.autocompact(...)
    if (predictiveResult.compactionResult) {
      messagesForQuery = buildPostCompactMessages(
        predictiveResult.compactionResult,
      )
    }
  }
}
```

中文解读：

- 普通 auto compact 是“已经接近阈值就压缩”。
- predictive autocompact 是“虽然现在还能发，但模型一回复、工具一跑，大概率下一步爆窗，所以提前压缩”。

---

## 10. microcompact：不总结，只清工具结果

microcompact 在 `src/services/compact/microCompact.ts`。它的目标不是把对话总结成摘要，而是清理最占 token 的旧工具结果。

可清理的工具：

```ts
const COMPACTABLE_TOOLS = new Set<string>([
  FILE_READ_TOOL_NAME,
  ...SHELL_TOOL_NAMES,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
])
```

整体入口：

```ts
export async function microcompactMessages(
  messages: Message[],
  toolUseContext?: ToolUseContext,
  querySource?: QuerySource,
): Promise<MicrocompactResult> {
  clearCompactWarningSuppression()

  // 1. 先尝试 time-based microcompact。
  const timeBasedResult = maybeTimeBasedMicrocompact(messages, querySource)
  if (timeBasedResult) {
    return timeBasedResult
  }

  // 2. 如果启用 cached microcompact，走 cache_edits。
  if (feature('CACHED_MICROCOMPACT')) {
    const mod = await getCachedMCModule()
    const model = toolUseContext?.options.mainLoopModel ?? getMainLoopModel()
    if (
      mod.isCachedMicrocompactEnabled() &&
      mod.isModelSupportedForCacheEditing(model) &&
      isMainThreadSource(querySource)
    ) {
      return await cachedMicrocompactPath(messages, querySource)
    }
  }

  // 3. 其他情况不做旧版内容修改，交给 autocompact 处理压力。
  return { messages }
}
```

---

## 11. time-based microcompact：缓存冷了，直接改内容

time-based microcompact 的判断逻辑：

```ts
export function evaluateTimeBasedTrigger(
  messages: Message[],
  querySource: QuerySource | undefined,
): { gapMinutes: number; config: TimeBasedMCConfig } | null {
  const config = getTimeBasedMCConfig()
  if (!config.enabled || !querySource || !isMainThreadSource(querySource)) {
    return null
  }
  const lastAssistant = messages.findLast(m => m.type === 'assistant')
  if (!lastAssistant) {
    return null
  }
  const gapMinutes =
    (Date.now() -
      new Date(lastAssistant.timestamp as string | number).getTime()) /
    60_000
  if (!Number.isFinite(gapMinutes) || gapMinutes < config.gapThresholdMinutes) {
    return null
  }
  return { gapMinutes, config }
}
```

触发后会把旧 `tool_result.content` 替换成固定占位符：

```ts
export const TIME_BASED_MC_CLEARED_MESSAGE = '[Old tool result content cleared]'

function maybeTimeBasedMicrocompact(
  messages: Message[],
  querySource: QuerySource | undefined,
): MicrocompactResult | null {
  const trigger = evaluateTimeBasedTrigger(messages, querySource)
  if (!trigger) {
    return null
  }

  const compactableIds = collectCompactableToolIds(messages)
  const keepRecent = Math.max(1, config.keepRecent)
  const keepSet = new Set(compactableIds.slice(-keepRecent))
  const clearSet = new Set(compactableIds.filter(id => !keepSet.has(id)))

  const result: Message[] = messages.map(message => {
    if (message.type !== 'user' || !Array.isArray(message.message!.content)) {
      return message
    }
    const newContent = message.message!.content.map(block => {
      if (
        block.type === 'tool_result' &&
        clearSet.has(block.tool_use_id) &&
        block.content !== TIME_BASED_MC_CLEARED_MESSAGE
      ) {
        return { ...block, content: TIME_BASED_MC_CLEARED_MESSAGE }
      }
      return block
    })
    return {
      ...message,
      message: { ...message.message, content: newContent },
    }
  })

  resetMicrocompactState()
  return { messages: result, clearedToolUseIds: [...clearSet] }
}
```

中文解读：

- 如果距离上次 assistant 消息已经过了配置阈值，服务端 prompt cache 很可能已经冷掉。
- 既然缓存反正没法命中，就直接改本地消息内容，把旧工具结果替换成 `[Old tool result content cleared]`。
- 这种方式会改变传给模型的内容，但能显著减少 token。

---

## 12. cached microcompact：缓存热的时候不改消息，只发 cache_edits

cached microcompact 的目标是：

> 不改变本地 `messages`，只告诉 API 删除缓存里某些旧 tool_result 的引用，从而保留 prompt cache 前缀。

状态结构：

```ts
// src/services/compact/cachedMicrocompact.ts

export type CachedMCState = {
  registeredTools: Set<string>
  toolOrder: string[]
  deletedRefs: Set<string>
  pinnedEdits: PinnedCacheEdits[]
  toolsSentToAPI: boolean
}

const TRIGGER_THRESHOLD = 10
const KEEP_RECENT = 5

export function getToolResultsToDelete(state: CachedMCState): string[] {
  const { triggerThreshold, keepRecent } = getCachedMCConfig()
  const active = state.toolOrder.filter(id => !state.deletedRefs.has(id))
  if (active.length <= triggerThreshold) return []
  const toDelete = active.slice(0, active.length - keepRecent)
  return toDelete
}

export function createCacheEditsBlock(
  _state: CachedMCState,
  toolIds: string[],
): CacheEditsBlock | null {
  if (toolIds.length === 0) return null
  return {
    type: 'cache_edits',
    edits: toolIds.map(id => ({
      type: 'delete_tool_result',
      tool_use_id: id,
    })),
  }
}
```

中文解读：

- 默认超过 10 个工具结果后触发。
- 保留最近 5 个工具结果。
- 老的 tool_use_id 会被生成 `cache_edits`。

在 `microCompact.ts` 中，cached path 不改 messages：

```ts
async function cachedMicrocompactPath(
  messages: Message[],
  querySource: QuerySource | undefined,
): Promise<MicrocompactResult> {
  const compactableToolIds = new Set(collectCompactableToolIds(messages))

  // 注册 tool_result 所属的 tool_use_id。
  for (const message of messages) {
    if (message.type === 'user' && Array.isArray(message.message!.content)) {
      for (const block of message.message!.content) {
        if (
          block.type === 'tool_result' &&
          compactableToolIds.has(block.tool_use_id) &&
          !state.registeredTools.has(block.tool_use_id)
        ) {
          mod.registerToolResult(state, block.tool_use_id)
        }
      }
    }
  }

  const toolsToDelete = mod.getToolResultsToDelete(state)

  if (toolsToDelete.length > 0) {
    const cacheEdits = mod.createCacheEditsBlock(state, toolsToDelete)
    if (cacheEdits) {
      pendingCacheEdits = cacheEdits
    }

    // messages 原样返回，真正的删除请求由 API 层插入。
    return {
      messages,
      compactionInfo: {
        pendingCacheEdits: {
          trigger: 'auto',
          deletedToolIds: toolsToDelete,
          baselineCacheDeletedTokens: baseline,
        },
      },
    }
  }

  return { messages }
}
```

API 层在 `src/services/api/claude.ts` 消费这些 cache edits：

```ts
// src/services/api/claude.ts

const consumedCacheEdits = cachedMCEnabled ? consumePendingCacheEdits() : null
const consumedPinnedEdits = cachedMCEnabled ? getPinnedCacheEdits() : []

return {
  model: normalizeModelStringForAPI(options.model),
  messages: addCacheBreakpoints(
    messagesForAPI,
    enablePromptCaching,
    options.querySource,
    useCachedMC,
    consumedCacheEdits as any,
    consumedPinnedEdits as any,
    options.skipCacheWrite,
  ),
  system,
  tools: allTools,
}
```

`addCacheBreakpoints()` 会把 cache edits 插入用户消息，并重新发送已 pinned 的 edits：

```ts
// src/services/api/claude.ts

// 重新插入历史 pinned cache_edits，保证后续请求位置稳定。
for (const pinned of pinnedEdits ?? []) {
  const msg = result[pinned.userMessageIndex]
  if (msg && msg.role === 'user') {
    const dedupedBlock = deduplicateEdits(pinned.block)
    if (dedupedBlock.edits.length > 0) {
      insertBlockAfterToolResults(msg.content, dedupedBlock)
    }
  }
}

// 新的 cache_edits 插入最后一个 user message，并 pin 起来。
if (newCacheEdits && result.length > 0) {
  const dedupedNewEdits = deduplicateEdits(newCacheEdits)
  if (dedupedNewEdits.edits.length > 0) {
    for (let i = result.length - 1; i >= 0; i--) {
      const msg = result[i]
      if (msg && msg.role === 'user') {
        insertBlockAfterToolResults(msg.content, dedupedNewEdits)
        pinCacheEdits(i, newCacheEdits as any)
        break
      }
    }
  }
}
```

cached microcompact 的边界消息会等 API 回来后再发，因为要拿真实删除 token 数：

```ts
// src/query.ts

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
```

---

## 13. 静态缓存 vs 动态缓存分割线

这一节专门把“缓存”分清楚，否则很容易把 prompt cache、readFileState、session storage、microcompact state 混成一团。

```text
==================== 静态 / 稳定缓存 ====================

目标：
  尽量让 API prompt cache 命中。

代表：
  - compact fork 复用 cacheSafeParams
  - cached microcompact 用 cache_edits，不改本地 messages
  - pinned cache_edits 固定插入位置
  - feature/beta headers 尽量 session-stable

特点：
  不能随便改 system/tools/messages 前缀，否则 cache key 变了。

==================== 动态 / 会话内缓存 ====================

目标：
  减少本进程内存、清理已经失效的上下文状态。

代表：
  - readFileState
  - loadedNestedMemoryPaths
  - getUserContext.cache
  - getMemoryFiles cache
  - microcompact module state
  - context collapse store
  - session messages cache

特点：
  compact 后通常要清掉或重建，否则旧上下文会泄漏到新上下文。
```

`postCompactCleanup.ts` 是动态缓存清理的集中入口：

```ts
// src/services/compact/postCompactCleanup.ts

export function runPostCompactCleanup(querySource?: QuerySource): void {
  const isMainThreadCompact =
    querySource === undefined ||
    querySource.startsWith('repl_main_thread') ||
    querySource === 'sdk'

  resetMicrocompactState()

  if (feature('CONTEXT_COLLAPSE')) {
    if (isMainThreadCompact) {
      require('../contextCollapse/index.js').resetContextCollapse()
    }
  }

  if (isMainThreadCompact) {
    getUserContext.cache.clear?.()
    resetGetMemoryFilesCache('compact')
  }

  clearSystemPromptSections()
  clearClassifierApprovals()
  clearSpeculativeChecks()
  clearBetaTracingState()
  clearSessionMessagesCache()
}
```

重点看两条注释背后的设计：

- subagent 和 main thread 在同一进程里共享模块级状态，所以 subagent compact 不能随便 reset main thread 的 context collapse / memory cache。
- `sentSkillNames` 不在这里清理，因为重注入完整 skill listing 会带来额外 token 成本；已调用技能会通过 compact attachment 恢复。

---

## 14. API 原生 context_management

除了本地 microcompact，API 请求层还会构造 `context_management`：

```ts
// src/services/compact/apiMicrocompact.ts

export function getAPIContextManagement(options?: {
  hasThinking?: boolean
  isRedactThinkingActive?: boolean
  clearAllThinking?: boolean
}): ContextManagementConfig | undefined {
  const strategies: ContextEditStrategy[] = []

  if (hasThinking && !isRedactThinkingActive) {
    strategies.push({
      type: 'clear_thinking_20251015',
      keep: clearAllThinking ? { type: 'thinking_turns', value: 1 } : 'all',
    })
  }

  const useClearToolResults =
    process.env.USE_API_CLEAR_TOOL_RESULTS !== undefined
      ? isEnvTruthy(process.env.USE_API_CLEAR_TOOL_RESULTS)
      : true

  if (useClearToolResults) {
    const strategy: ContextEditStrategy = {
      type: 'clear_tool_uses_20250919',
      trigger: {
        type: 'input_tokens',
        value: triggerThreshold,
      },
      clear_at_least: {
        type: 'input_tokens',
        value: triggerThreshold - keepTarget,
      },
      clear_tool_inputs: TOOLS_CLEARABLE_RESULTS,
    }

    strategies.push(strategy)
  }

  return strategies.length > 0 ? { edits: strategies } : undefined
}
```

API 请求中只有 beta header 存在时才发送：

```ts
// src/services/api/claude.ts

const contextManagement = getAPIContextManagement({
  hasThinking,
  isRedactThinkingActive: betasParams.includes(REDACT_THINKING_BETA_HEADER),
  clearAllThinking: false,
})

return {
  ...
  ...(contextManagement &&
    useBetas &&
    betasParams.includes(CONTEXT_MANAGEMENT_BETA_HEADER) && {
      context_management: contextManagement,
    }),
}
```

中文解读：

- `microCompact.ts` 是客户端自己决定怎么清。
- `apiMicrocompact.ts` 是请求 API 时告诉服务端“你可以怎么清”。
- 两者可以同时存在，但作用层不同。

---

## 15. snip compact：按 UUID 删除已标记历史

snip 是更直接的历史裁剪：某些消息先被标记为 removed，之后每轮模型请求会过滤掉这些 UUID。

源码：

```ts
// src/services/compact/snipCompact.ts

export function snipCompactIfNeeded(
  messages: Message[],
): {
  messages: Message[]
  executed: boolean
  tokensFreed: number
  boundaryMessage?: Message
} {
  let boundaryIdx = -1
  let removedUuids: string[] | undefined

  // 找最后一个 snip_boundary。
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!
    if (
      msg.type === 'system' &&
      (msg as Record<string, unknown>).subtype === 'snip_boundary'
    ) {
      boundaryIdx = i
      const meta = (msg as Record<string, unknown>).snipMetadata as
        | { removedUuids?: string[] }
        | undefined
      removedUuids = meta?.removedUuids
      break
    }
  }

  if (boundaryIdx === -1) {
    return { messages, executed: false, tokensFreed: 0 }
  }

  const removedSet = new Set(removedUuids)
  const kept: Message[] = []
  let tokensFreed = 0

  for (const msg of messages) {
    if (removedSet.has(msg.uuid)) {
      tokensFreed += estimateMessageTokens(msg)
      continue
    }
    kept.push(msg)
  }

  return {
    messages: kept,
    executed: true,
    tokensFreed,
    boundaryMessage,
  }
}
```

`getMessagesAfterCompactBoundary()` 也会调用 `projectSnippedView()`：

```ts
// src/services/compact/snipProjection.ts

export function projectSnippedView(messages: Message[]): Message[] {
  const removedSet = new Set<string>()

  for (const msg of messages) {
    if (
      msg.type === 'system' &&
      (msg as Record<string, unknown>).subtype === 'snip_boundary'
    ) {
      const meta = (msg as Record<string, unknown>).snipMetadata as
        | { removedUuids?: string[] }
        | undefined
      if (meta?.removedUuids) {
        for (const uuid of meta.removedUuids) {
          removedSet.add(uuid)
        }
      }
    }
  }

  if (removedSet.size === 0) {
    return messages
  }

  return messages.filter(msg => !removedSet.has(msg.uuid))
}
```

中文解读：

- snip 不生成摘要。
- snip 是按消息 UUID 删除。
- REPL 可以保留完整 scrollback，但模型视图会过滤。
- snip 的 token savings 会传给 auto compact 阈值判断。

---

## 16. session memory compact：用记忆文件替代重新总结

这块和记忆系统交叉，但在压缩系统里必须理解。

触发位置：

- 手动 `/compact` 且没有自定义指令时；
- 自动 compact 达到阈值时。

源码入口：

```ts
// src/services/compact/sessionMemoryCompact.ts

export async function trySessionMemoryCompaction(
  messages: Message[],
  agentId?: AgentId,
  autoCompactThreshold?: number,
): Promise<CompactionResult | null> {
  if (!shouldUseSessionMemoryCompaction()) {
    return null
  }

  await initSessionMemoryCompactConfig()
  await waitForSessionMemoryExtraction()

  const lastSummarizedMessageId = getLastSummarizedMessageId()
  const sessionMemory = await getSessionMemoryContent()

  if (!sessionMemory) {
    return null
  }

  if (await isSessionMemoryEmpty(sessionMemory)) {
    return null
  }

  let lastSummarizedIndex: number

  if (lastSummarizedMessageId) {
    lastSummarizedIndex = messages.findIndex(
      msg => msg.uuid === lastSummarizedMessageId,
    )

    if (lastSummarizedIndex === -1) {
      return null
    }
  } else {
    // resume 场景：有 session memory，但不知道边界，就默认不保留旧消息。
    lastSummarizedIndex = messages.length - 1
  }

  const startIndex = calculateMessagesToKeepIndex(
    messages,
    lastSummarizedIndex,
  )

  const messagesToKeep = messages
    .slice(startIndex)
    .filter(m => !isCompactBoundaryMessage(m))
}
```

保留最近消息时，不能切断 tool_use/tool_result 对：

```ts
// src/services/compact/sessionMemoryCompact.ts

export function adjustIndexToPreserveAPIInvariants(
  messages: Message[],
  startIndex: number,
): number {
  let adjustedIndex = startIndex

  // 1. 如果保留范围里有 tool_result，需要向前找对应 tool_use。
  const allToolResultIds: string[] = []
  for (let i = startIndex; i < messages.length; i++) {
    allToolResultIds.push(...getToolResultIds(messages[i]!))
  }

  // 2. 如果同一个 assistant message.id 被流式拆成多条消息，
  //    也要把同 id 的 thinking/tool_use 块一起保留。
  const messageIdsInKeptRange = new Set<string>()
  for (let i = adjustedIndex; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.type === 'assistant' && msg.message!.id) {
      messageIdsInKeptRange.add(msg.message!.id)
    }
  }

  return adjustedIndex
}
```

创建结果时，summary 不是重新调用模型生成，而是直接包 Session Memory：

```ts
function createCompactionResultFromSessionMemory(
  messages: Message[],
  sessionMemory: string,
  messagesToKeep: Message[],
  hookResults: HookResultMessage[],
  transcriptPath: string,
  agentId?: AgentId,
): CompactionResult {
  const boundaryMarker = createCompactBoundaryMessage(
    'auto',
    preCompactTokenCount ?? 0,
    messages[messages.length - 1]?.uuid,
  )

  const { truncatedContent, wasTruncated } =
    truncateSessionMemoryForCompact(sessionMemory)

  let summaryContent = getCompactUserSummaryMessage(
    truncatedContent,
    true,
    transcriptPath,
    true,
  )

  const summaryMessages = [
    createUserMessage({
      content: summaryContent,
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    }),
  ]

  return {
    boundaryMarker: annotateBoundaryWithPreservedSegment(
      boundaryMarker,
      summaryMessages[summaryMessages.length - 1]!.uuid,
      messagesToKeep,
    ),
    summaryMessages,
    attachments,
    hookResults,
    messagesToKeep,
  }
}
```

中文解读：

- traditional compact 是“把历史发给模型，让模型总结”。
- session memory compact 是“已经有 Session Memory，就把它包装成 compact summary”。
- 它还会保留一段最近原文，避免只剩长期记忆而丢掉刚刚发生的细节。
- `annotateBoundaryWithPreservedSegment()` 给 resume/persistence 提供重链接元数据。

---

## 17. partial compact：只压缩一段

`partialCompactConversation()` 支持两种方向：

```text
direction = "from"
  保留 pivot 之前的消息
  总结 pivot 之后的消息
  summary 放在后面
  更容易保留 prompt cache 前缀

direction = "up_to"
  总结 pivot 之前的消息
  保留 pivot 之后的消息
  summary 放在前面
  适合“把旧历史压缩，保留最近原文”
```

源码：

```ts
// src/services/compact/compact.ts

const messagesToSummarize =
  direction === 'up_to'
    ? allMessages.slice(0, pivotIndex)
    : allMessages.slice(pivotIndex)

const messagesToKeep =
  direction === 'up_to'
    ? allMessages
        .slice(pivotIndex)
        .filter(
          m =>
            m.type !== 'progress' &&
            !isCompactBoundaryMessage(m) &&
            !(m.type === 'user' && m.isCompactSummary),
        )
    : allMessages.slice(0, pivotIndex).filter(m => m.type !== 'progress')
```

partial compact 的 prompt 也不一样：

```ts
// src/services/compact/prompt.ts

const PARTIAL_COMPACT_PROMPT = `Your task is to create a detailed summary of the RECENT portion of the conversation — the messages that follow earlier retained context. The earlier messages are being kept intact and do NOT need to be summarized. Focus your summary on what was discussed, learned, and accomplished in the recent messages only.
...`

const PARTIAL_COMPACT_UP_TO_PROMPT = `Your task is to create a detailed summary of this conversation. This summary will be placed at the start of a continuing session; newer messages that build on this context will follow after your summary (you do not see them here). Summarize thoroughly so that someone reading only your summary and then the newer messages can fully understand what happened and continue the work.
...`
```

中文解读：

- `from` 是“前面保留，后面总结”。
- `up_to` 是“前面总结，后面保留”。
- `up_to` 会过滤旧 compact boundary 和旧 compact summary，避免后续 `findLastCompactBoundaryIndex()` 找错边界。

---

## 18. reactive compact：API 已经报错后的急救

有些时候 proactive / auto compact 没来得及，API 会返回 prompt-too-long 或 media-size error。`src/query.ts` 会先暂存这个错误，不立即给用户，然后尝试恢复。

`reactiveCompact.ts` 的判断：

```ts
// src/services/compact/reactiveCompact.ts

export const isReactiveCompactEnabled: () => boolean = () => {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) return false
  return true
}

export const isWithheldPromptTooLong: (message: Message) => boolean =
  message => {
    if (message.type !== 'assistant' || !message.isApiErrorMessage) return false
    return isPromptTooLongMessage(message as AssistantMessage)
  }

export const isWithheldMediaSizeError: (message: Message) => boolean =
  message => {
    if (message.type !== 'assistant' || !message.isApiErrorMessage) return false
    return isMediaSizeErrorMessage(message as AssistantMessage)
  }
```

恢复逻辑在 `query.ts`：

```ts
// src/query.ts

const isWithheld413 =
  lastMessage?.type === 'assistant' &&
  lastMessage.isApiErrorMessage &&
  isPromptTooLongMessage(lastMessage)

const isWithheldMedia =
  mediaRecoveryEnabled &&
  reactiveCompact?.isWithheldMediaSizeError(lastMessage as Message)

if (isWithheld413) {
  // 如果 context collapse 有 staged collapses，先 drain。
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
      state = next
      continue
    }
  }
}

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
    const postCompactMessages = buildPostCompactMessages(compacted)
    for (const msg of postCompactMessages) {
      yield msg
    }
    state = {
      messages: postCompactMessages,
      transition: { reason: 'reactive_compact_retry' },
      hasAttemptedReactiveCompact: true,
    }
    continue
  }
}
```

中文解读：

- reactive compact 是“失败后补救”，不是常规入口。
- `hasAttemptedReactiveCompact` 防止 compact 后仍失败时无限循环。
- 对 prompt-too-long，context collapse 有机会先恢复，因为它保留更细粒度上下文。
- 对 media-size error，collapse 没法剥媒体，所以直接 reactive compact。

---

## 19. 压缩失败时的最后手段：truncateHeadForPTLRetry()

有一种特殊失败：不是普通对话太长，而是“拿这段对话去做 compact summary 的请求本身也太长”。这时 `compactConversation()` 会调用 `truncateHeadForPTLRetry()`。

```ts
// src/services/compact/compact.ts

export function truncateHeadForPTLRetry(
  messages: Message[],
  ptlResponse: AssistantMessage,
): Message[] | null {
  const groups = groupMessagesByApiRound(input)
  if (groups.length < 2) return null

  const tokenGap = getPromptTooLongTokenGap(ptlResponse)
  let dropCount: number
  if (tokenGap !== undefined) {
    let acc = 0
    dropCount = 0
    for (const g of groups) {
      acc += roughTokenCountEstimationForMessages(g)
      dropCount++
      if (acc >= tokenGap) break
    }
  } else {
    dropCount = Math.max(1, Math.floor(groups.length * 0.2))
  }

  dropCount = Math.min(dropCount, groups.length - 1)
  const sliced = groups.slice(dropCount).flat()

  if (sliced[0]?.type === 'assistant') {
    return [
      createUserMessage({ content: PTL_RETRY_MARKER, isMeta: true }),
      ...sliced,
    ]
  }
  return sliced
}
```

分组函数：

```ts
// src/services/compact/grouping.ts

export function groupMessagesByApiRound(messages: Message[]): Message[][] {
  const groups: Message[][] = []
  let current: Message[] = []
  let lastAssistantId: string | undefined

  for (const msg of messages) {
    if (
      msg.type === 'assistant' &&
      msg.message!.id !== lastAssistantId &&
      current.length > 0
    ) {
      groups.push(current)
      current = [msg]
    } else {
      current.push(msg)
    }
    if (msg.type === 'assistant') {
      lastAssistantId = msg.message!.id
    }
  }

  if (current.length > 0) {
    groups.push(current)
  }
  return groups
}
```

中文解读：

- 它按 API round 分组，而不是按人类 user turn 分组。
- 如果 compact 请求太长，就丢最旧的 API round。
- 如果丢完后第一条变成 assistant，会补一个 synthetic user marker，避免 API 要求第一条必须是 user 的校验失败。

---

## 20. QueryEngine：SDK/headless 怎么处理 compact boundary

`src/QueryEngine.ts` 负责把 `query()` yield 出来的消息记录到 session storage，并输出 SDK 事件。

compact boundary 到达时，它会做两件关键事。

第一，写入边界前，先把 preserved segment tail 之前的消息刷盘：

```ts
// src/QueryEngine.ts

if (
  persistSession &&
  message.type === 'system' &&
  message.subtype === 'compact_boundary'
) {
  const compactMsg = message as SystemCompactBoundaryMessage
  const tailUuid =
    compactMsg.compactMetadata?.preservedSegment?.tailUuid
  if (tailUuid) {
    const tailIdx = this.mutableMessages.findLastIndex(
      m => m.uuid === tailUuid,
    )
    if (tailIdx !== -1) {
      await recordTranscript(this.mutableMessages.slice(0, tailIdx + 1))
    }
  }
}
```

第二，compact boundary 写入后，释放边界之前的内存历史：

```ts
// src/QueryEngine.ts

if (msg.subtype === 'compact_boundary' && msg.compactMetadata) {
  const compactMsg = msg as SystemCompactBoundaryMessage

  // query.ts 内部已经只会从 boundary 后面取消息；
  // SDK mutableMessages 也可以释放 boundary 之前的旧历史。
  const mutableBoundaryIdx = this.mutableMessages.length - 1
  if (mutableBoundaryIdx > 0) {
    this.mutableMessages.splice(0, mutableBoundaryIdx)
  }
  const localBoundaryIdx = messages.length - 1
  if (localBoundaryIdx > 0) {
    messages.splice(0, localBoundaryIdx)
  }

  yield {
    type: 'system',
    subtype: 'compact_boundary' as const,
    session_id: getSessionId(),
    uuid: msg.uuid,
    compact_metadata: toSDKCompactMetadata(
      compactMsg.compactMetadata,
    ),
  }
}
```

中文解读：

- interactive REPL 可以保留 UI scrollback，但 SDK/headless 长会话必须主动释放旧 history，否则内存会涨。
- compact boundary 也会作为 SDK system event 输出，外部客户端可以感知发生了压缩。
- preserved segment 元数据用于 resume 时把“摘要 + 保留原文”重新接成正确链。

---

## 21. 压缩后恢复哪些上下文

压缩不是只留下摘要。`compactConversation()` 会尽量恢复“继续工作必须要的结构性上下文”。

```text
post compact attachments
        │
        ├─ 最近读过的文件片段
        ├─ async agent 状态
        ├─ 当前 plan 文件
        ├─ plan mode 指令
        ├─ 已调用 skill 内容
        ├─ deferred tools delta
        ├─ agent listing delta
        └─ MCP instructions delta
```

源码位置都在 `src/services/compact/compact.ts`：

```ts
const [fileAttachments, asyncAgentAttachments] = await Promise.all([
  createPostCompactFileAttachments(...),
  createAsyncAgentAttachmentsIfNeeded(context),
])

const planAttachment = createPlanAttachmentIfNeeded(context.agentId)
const planModeAttachment = await createPlanModeAttachmentIfNeeded(context)
const skillAttachment = createSkillAttachmentIfNeeded(context.agentId)

for (const att of getDeferredToolsDeltaAttachment(...)) {
  postCompactFileAttachments.push(createAttachmentMessage(att))
}
for (const att of getAgentListingDeltaAttachment(context, [])) {
  postCompactFileAttachments.push(createAttachmentMessage(att))
}
for (const att of getMcpInstructionsDeltaAttachment(...)) {
  postCompactFileAttachments.push(createAttachmentMessage(att))
}
```

你可以把这理解成：

```text
摘要解决“发生过什么”
附件解决“继续做事还需要哪些机器可读上下文”
hooks 解决“项目启动时应该重新注入哪些环境信息”
```

---

## 22. 总结一遍：从用户输入到压缩后继续执行

完整串起来是这样：

```text
用户继续输入
  │
  ▼
query.ts 进入一轮循环
  │
  ├─ getMessagesAfterCompactBoundary()
  │    只保留最近 compact_boundary 之后
  │
  ├─ snipCompactIfNeeded()
  │    删除 snip_boundary 标记的 UUID
  │
  ├─ microcompactMessages()
  │    旧工具结果清空，或生成 cache_edits
  │
  ├─ contextCollapse.applyCollapsesIfNeeded()
  │    如果启用，先细粒度折叠
  │
  ├─ autoCompactIfNeeded()
  │    token 到阈值 -> session memory compact 或 traditional compact
  │
  ├─ buildPostCompactMessages()
  │    boundary + summary + kept messages + attachments + hooks
  │
  ├─ queryModelWithStreaming()
  │    请求模型
  │
  └─ 如果 API 返回 prompt-too-long/media-too-large
       ├─ contextCollapse recover
       └─ reactive compact -> buildPostCompactMessages() -> retry
```

压缩系统的核心不只是“省 token”，而是做一次上下文形态转换：

```text
压缩前：
  大量原始消息 + 工具结果 + 附件 + 文件缓存 + hooks 历史

压缩后：
  compact_boundary
  + 一条可继续工作的结构化摘要
  + 必要的最近原文
  + 必要附件
  + session start hook 上下文
```

---

## 23. 调试入口和源码阅读路线

按这个顺序读，比较不容易迷路：

```text
1. src/query.ts
   看一轮请求前到底依次调用哪些压缩策略。

2. src/utils/messages.ts
   看 compact_boundary 怎么创建、怎么切片。

3. src/commands/compact/compact.ts
   看手动 /compact 如何进入系统。

4. src/services/compact/compact.ts
   看完整摘要压缩怎么生成 CompactionResult。

5. src/services/compact/prompt.ts
   看真实 compact prompt。

6. src/services/compact/autoCompact.ts
   看自动阈值和熔断。

7. src/services/compact/microCompact.ts
   看工具结果清理。

8. src/services/compact/cachedMicrocompact.ts
   看 cache_edits 的状态机。

9. src/services/api/claude.ts
   看 cache_edits/context_management 怎么进入 API body。

10. src/services/compact/sessionMemoryCompact.ts
    看记忆系统如何接管压缩摘要。

11. src/services/compact/reactiveCompact.ts
    看 API 报错后的紧急压缩。

12. src/QueryEngine.ts
    看 SDK/headless 如何持久化 compact boundary 并释放旧消息。
```

常用搜索命令：

```bash
rg -n "getMessagesAfterCompactBoundary|createCompactBoundaryMessage|buildPostCompactMessages" src
rg -n "compactConversation|partialCompactConversation|streamCompactSummary" src/services/compact
rg -n "autoCompactIfNeeded|shouldAutoCompact|getAutoCompactThreshold" src/services/compact
rg -n "microcompact|cache_edits|context_management" src/services/compact src/services/api/claude.ts
rg -n "tryReactiveCompact|isWithheldPromptTooLong|PROMPT_TOO_LONG" src/query.ts src/services/compact
rg -n "trySessionMemoryCompaction|calculateMessagesToKeepIndex|preservedSegment" src/services/compact src
```

---

## 24. 你现在应该能回答的几个问题

读完后，检查自己是否能回答：

```text
Q1: 为什么 compact 后模型不会再看到完整旧历史？
A1: 因为每轮先 getMessagesAfterCompactBoundary()，只取最后 compact_boundary 之后。

Q2: compact summary 是 assistant message 吗？
A2: 不是。它被包装成 synthetic user message，带 isCompactSummary。

Q3: microcompact 会生成摘要吗？
A3: 不会。它只清工具结果或发 cache_edits。

Q4: auto compact 之前为什么先尝试 session memory compact？
A4: 如果 Session Memory 已经提取了结构化长期记忆，可以直接用它当摘要，减少一次 summarizer 调用。

Q5: cached microcompact 为什么不直接改 messages？
A5: 为了保留 prompt cache 前缀，通过 API cache_edits 删除服务端缓存引用。

Q6: reactive compact 和 auto compact 区别是什么？
A6: auto 是请求前主动压缩；reactive 是 API 已报上下文/媒体过大后补救并重试。

Q7: compact 后为什么还要恢复 attachments？
A7: 摘要保留语义历史，attachments 恢复继续工作需要的文件、计划、技能、MCP、工具 schema 等结构上下文。
```

