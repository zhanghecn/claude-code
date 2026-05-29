# queryLoop 上下文压缩源码顺序导读

这份文档只解决一个问题：

```text
queryLoop 每一轮准备调用模型前，
messagesForQuery 依次经过哪些“变短”步骤，
每一步到底改了什么，
deps.autocompact 为什么在这些步骤后面。
```

先记住一句具体的话：

```text
messagesForQuery 是“本轮准备发给模型看的消息数组”。

queryLoop 不会一上来就完整总结对话。
它会先尝试便宜的小处理：
  用旧 compact_boundary 切片
  清掉 JS 内存里的 toolUseResult
  替换超大的 tool_result 正文
  按 snip_boundary 移除指定消息
  清理旧工具结果或排队 cache_edits
  走 contextCollapse 投影视图

这些处理完后，如果 messagesForQuery 仍然太长，
才把它交给 deps.autocompact 做“自动完整摘要压缩”。
```

---

## 1. 先看完整顺序

这是 `src/query.ts` 里真实顺序。先看图，不要先看函数名。

```text
state.messages
  │
  ▼
getMessagesAfterCompactBoundary()
  用上一次 compact_boundary 切掉更旧历史
  │
  ▼
delete msg.toolUseResult
  只删 UI 用的大对象，不改 message.content
  │
  ▼
applyToolResultBudget()
  单条 user message 的 tool_result 太大时，把正文换成 persisted-output 短文本
  │
  ▼
snipCompactIfNeeded()
  如果有 snip_boundary，就按 removedUuids 从本轮模型视图删除消息
  │
  ▼
deps.microcompact()
  清理旧工具结果，或排队 cache_edits 给 API 层删除服务端缓存
  │
  ▼
contextCollapse.applyCollapsesIfNeeded()
  当前仓库是 stub，直接返回原 messages
  │
  ▼
deps.autocompact()
  判断是否需要完整摘要压缩
  │
  ├─ 不需要压缩:
  │    messagesForQuery 保持上一步结果
  │
  └─ 需要压缩:
       compactConversation()
       createCompactBoundaryMessage()
       buildPostCompactMessages()
       messagesForQuery = [compact_boundary, summary, attachments, hooks]
```

这条线里，只有 `deps.autocompact()` 可能生成：

```text
compact_boundary
compact summary
```

前面的 `applyToolResultBudget`、`snip`、`microcompact` 都不是“总结整段对话”。

---

## 2. 用一组模拟数据贯穿全文

假设 `queryLoop` 本轮开始时，`state.messages` 是：

```ts
const stateMessages = [
  {
    // b0 是上一次完整 compact 留下来的边界。
    type: 'system',
    subtype: 'compact_boundary',
    uuid: 'b0',
    content: 'Conversation compacted',
  },
  {
    // s0 是上一次 compact 生成的摘要消息。
    type: 'user',
    uuid: 's0',
    isCompactSummary: true,
    message: {
      role: 'user',
      content: '这里是上次压缩后的摘要。',
    },
  },
  {
    // u1 是较旧用户消息，后面会被 snip_boundary 标记移除。
    type: 'user',
    uuid: 'u1',
    message: {
      role: 'user',
      content: '旧问题：请研究很多文件。',
    },
  },
  {
    // a1 是模型消息，里面请求调用 Read 工具。
    type: 'assistant',
    uuid: 'a1',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_read_1',
          name: 'Read',
          input: { file_path: 'src/query.ts' },
        },
      ],
    },
  },
  {
    // tr1 是 Read 工具结果。
    // message.content 里的 tool_result 会发给模型。
    // toolUseResult 是 UI / 内存用的大对象，后面会被 delete。
    type: 'user',
    uuid: 'tr1',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_read_1',
          content: '这里假设是 500KB 的文件正文。',
        },
      ],
    },
    toolUseResult: { rawFileText: '同一份 500KB 原始内容，供 UI 使用' },
  },
  {
    // sn1 告诉 snipCompactIfNeeded：u1 可以从模型视图移除。
    type: 'system',
    subtype: 'snip_boundary',
    uuid: 'sn1',
    snipMetadata: {
      removedUuids: ['u1'],
    },
  },
  {
    // u2 是本轮最新用户问题。
    type: 'user',
    uuid: 'u2',
    message: {
      role: 'user',
      content: '继续解释 queryLoop 压缩顺序。',
    },
  },
]
```

下面每一节都用这组数据演示。

---

## 3. 第一步：getMessagesAfterCompactBoundary 使用旧边界切片

源码位置：`src/query.ts`。

```ts
// messages 是 state.messages。
// messagesForQuery 是本轮继续处理的模型视图。
let messagesForQuery = getMessagesAfterCompactBoundary(messages)
```

`getMessagesAfterCompactBoundary()` 在 `src/utils/messages.ts`：

```ts
export function findLastCompactBoundaryIndex<
  T extends Message | NormalizedMessage,
>(messages: T[]): number {
  // 从后往前找最近的 compact_boundary。
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message && isCompactBoundaryMessage(message)) {
      return i
    }
  }

  // 没有 compact_boundary，就返回 -1。
  return -1
}

export function getMessagesAfterCompactBoundary<
  T extends Message | NormalizedMessage,
>(messages: T[], options?: { includeSnipped?: boolean }): T[] {
  // 找最后一个 compact_boundary 的下标。
  const boundaryIndex = findLastCompactBoundaryIndex(messages)

  // 找不到边界：使用全部 messages。
  // 找到边界：从边界开始切片，保留边界本身。
  const sliced = boundaryIndex === -1 ? messages : messages.slice(boundaryIndex)

  // HISTORY_SNIP 开启时，还会额外套一层 snip 投影。
  // 后面第 6 节会单独讲 query.ts 里显式 snipCompactIfNeeded 的那一步。
  if (!options?.includeSnipped && feature('HISTORY_SNIP')) {
    const { projectSnippedView } =
      require('../services/compact/snipProjection.js') as typeof import('../services/compact/snipProjection.js')
    return projectSnippedView(sliced as Message[]) as T[]
  }

  return sliced
}
```

代入数据：

```text
state.messages:
  [b0, s0, u1, a1, tr1, sn1, u2]

最后一个 compact_boundary:
  b0

messagesForQuery:
  [b0, s0, u1, a1, tr1, sn1, u2]
```

如果前面还有更老的 `[old1, old2]`，它们会被切掉：

```text
state.messages:
  [old1, old2, b0, s0, u1, a1, tr1, sn1, u2]

messagesForQuery:
  [b0, s0, u1, a1, tr1, sn1, u2]
```

这一节不是新压缩。它只是使用“之前已经压缩成功留下的边界”。

---

## 4. 第二步：删除 toolUseResult，只释放 JS 内存

源码位置：`src/query.ts`。

```ts
for (const msg of messagesForQuery) {
  if (
    // 只有 user message 可能带工具结果。
    msg.type === 'user' &&

    // toolUseResult 是内部字段，不是 API 消息正文。
    'toolUseResult' in msg &&
    msg.toolUseResult !== undefined
  ) {
    // 删除 UI 用的大对象。
    // API 仍然使用 msg.message.content 里的 tool_result。
    delete (msg as Message & { toolUseResult?: unknown }).toolUseResult
  }
}
```

代入数据：

```text
删除前 tr1:
  message.content[0].content = 500KB 文件正文
  toolUseResult.rawFileText = 500KB 原始内容

删除后 tr1:
  message.content[0].content = 500KB 文件正文
  toolUseResult 不存在
```

这一节也不是压缩模型上下文。因为模型看到的是：

```text
tr1.message.content
```

不是：

```text
tr1.toolUseResult
```

所以这一步只是防止 CLI 进程内存越涨越大。

---

## 5. 第三步：applyToolResultBudget 替换过大的 tool_result 正文

源码位置：`src/query.ts`。

```ts
const persistReplacements =
  // 子 agent 会话恢复时需要读回替换记录。
  querySource.startsWith('agent:') ||

  // 主 REPL 会话 /resume 时需要读回替换记录。
  querySource.startsWith('repl_main_thread')

messagesForQuery = await applyToolResultBudget(
  // 输入：前两步处理后的 messagesForQuery。
  messagesForQuery,

  // undefined 表示功能关闭，applyToolResultBudget 会原样返回。
  // 有值表示要记录 seenIds 和 replacements。
  toolUseContext.contentReplacementState,

  // 只有需要 resume 的 querySource 才写 transcript。
  persistReplacements
    ? records =>
        void recordContentReplacement(
          records,
          toolUseContext.agentId,
        ).catch(logError)
    : undefined,

  // 某些工具自己控制输出大小，不走这里的预算替换。
  new Set(
    toolUseContext.options.tools
      .filter(t => !Number.isFinite(t.maxResultSizeChars))
      .map(t => t.name),
  ),
)
```

这一步做什么：

```text
检查每一组会被 API 合并成同一条 user message 的 tool_result 总大小。
如果太大：
  把最大的 fresh tool_result 原文保存到磁盘
  用一段 persisted-output 短文本替换 tool_result.content
```

它不删除 `tr1`，只替换字段：

```text
替换前:
  tr1.message.content[0].content = 500KB 文件正文

替换后:
  tr1.message.content[0].content = <persisted-output>短文本</persisted-output>
```

替换文本来自 `src/utils/toolResultStorage.ts`：

```ts
export function buildLargeToolResultMessage(
  result: PersistedToolResult,
): string {
  // 开始标签，告诉模型这是被持久化的输出。
  let message = `${PERSISTED_OUTPUT_TAG}\n`

  // 告诉模型完整输出太大，已经保存到哪个文件。
  message += `Output too large (${formatFileSize(result.originalSize)}). Full output saved to: ${result.filepath}\n\n`

  // 保留开头一小段预览。
  message += `Preview (first ${formatFileSize(PREVIEW_SIZE_BYTES)}):\n`
  message += result.preview

  // 如果后面还有内容，源码会写入换行、三个点、换行。
  message += result.hasMore ? '\n...\n' : '\n'

  // 结束标签。
  message += PERSISTED_OUTPUT_CLOSING_TAG
  return message
}
```

代入数据：

```text
进入本步:
  [b0, s0, u1, a1, tr1(500KB), sn1, u2]

离开本步:
  [b0, s0, u1, a1, tr1(<persisted-output>短文本</persisted-output>), sn1, u2]
```

为什么要记录 `content-replacement`：

```text
同一个 tool_use_id 第一次被替换后，
后续每一轮和 /resume 后都要继续使用同一段替换文本。

否则 prompt cache 前缀会变：
  第一次模型看到短文本
  resume 后模型看到原始 500KB

这样缓存和上下文预算都会不稳定。
```

这一步仍然不是完整 compact。它没有生成摘要，也没有生成 `compact_boundary`。

---

## 6. 第四步：snipCompactIfNeeded 按 snip_boundary 删除指定消息

`snip` 不等于 summary compact。

它的意思是：

```text
之前某个工具或命令已经写入了 snip_boundary。
snip_boundary.snipMetadata.removedUuids 记录哪些消息可以从模型视图移除。
queryLoop 每轮看到这个边界后，就把这些 uuid 对应的消息过滤掉。
```

源码位置：`src/query.ts`。

```ts
let snipTokensFreed = 0
if (feature('HISTORY_SNIP')) {
  // snipCompactIfNeeded 输入当前 messagesForQuery。
  const snipResult = snipModule!.snipCompactIfNeeded(messagesForQuery)

  // 输出替换回 messagesForQuery。
  messagesForQuery = snipResult.messages

  // 记录估算释放了多少 token。
  // 后面 autocompact 判断阈值时会用到。
  snipTokensFreed = snipResult.tokensFreed

  // 如果 snip 执行了，把 snip_boundary yield 给 UI / transcript。
  if (snipResult.boundaryMessage) {
    yield snipResult.boundaryMessage
  }
}
```

`snipCompactIfNeeded()` 在 `src/services/compact/snipCompact.ts`：

```ts
export function snipCompactIfNeeded(
  messages: Message[],
  _options?: { force?: boolean },
): {
  messages: Message[]
  executed: boolean
  tokensFreed: number
  boundaryMessage?: Message
} {
  // 从后往前找最后一个 snip_boundary。
  let boundaryIdx = -1
  let removedUuids: string[] | undefined

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

  // 没有 snip_boundary，就不改 messages。
  if (boundaryIdx === -1) {
    return { messages, executed: false, tokensFreed: 0 }
  }

  const boundaryMessage = messages[boundaryIdx]!

  // 有边界但没有 removedUuids，就退化为只保留边界及之后的消息。
  if (!removedUuids || removedUuids.length === 0) {
    const kept = messages.slice(boundaryIdx)
    return {
      messages: kept,
      executed: true,
      tokensFreed: 0,
      boundaryMessage,
    }
  }

  // 有 removedUuids，就过滤掉这些 uuid 对应的消息。
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

代入数据：

```text
进入本步:
  [b0, s0, u1, a1, tr1(短文本), sn1, u2]

sn1.snipMetadata.removedUuids:
  ['u1']

离开本步:
  [b0, s0, a1, tr1(短文本), sn1, u2]
```

为什么 `snipTokensFreed` 要传给后面的 autocompact：

```text
snip 删除了 u1。
但某些 token 估算可能还读到旧 assistant usage。
所以 queryLoop 把 snipTokensFreed 传给 autocompact，
让它判断“现在是否还需要完整 compact”时把这部分扣掉。
```

这一节不是摘要压缩。它只是按 UUID 过滤消息。

---

## 7. 第五步：microcompact 清理旧工具结果

`microcompact` 的名字容易误导。这里的 `micro` 表示：

```text
只处理工具结果占用，
不总结对话，
不生成 compact_summary。
```

源码位置：`src/query.ts`。

```ts
const microcompactResult = await deps.microcompact(
  // 输入：snip 之后的 messagesForQuery。
  messagesForQuery,

  // 工具上下文，里面有模型、工具、agentId 等。
  toolUseContext,

  // querySource 用来判断主线程、子 agent、compact 临时调用等。
  querySource,
)

// microcompact 可能返回同一个数组，也可能返回改过的数组。
messagesForQuery = microcompactResult.messages

if (microcompactResult.clearedToolUseIds?.length) {
  const replacements = toolUseContext?.contentReplacementState?.replacements
  if (replacements) {
    for (const id of microcompactResult.clearedToolUseIds) {
      // 如果某个工具结果已经被 microcompact 清掉，
      // 那 contentReplacementState 里对应的替换文本也不用继续保留。
      replacements.delete(id)
    }
  }
}

// cached microcompact 不立刻 yield 边界。
// 它要等 API 返回真实 cache_deleted_input_tokens 后再 yield。
const pendingCacheEdits = feature('CACHED_MICROCOMPACT')
  ? microcompactResult.compactionInfo?.pendingCacheEdits
  : undefined
```

`deps.microcompact` 是从 `src/query/deps.ts` 注入的：

```ts
export type QueryDeps = {
  // callModel 是请求模型。
  callModel: typeof queryModelWithStreaming

  // microcompact 是 microcompactMessages。
  microcompact: typeof microcompactMessages

  // autocompact 是 autoCompactIfNeeded。
  autocompact: typeof autoCompactIfNeeded

  // uuid 用于生成 ID。
  uuid: () => string
}

export function productionDeps(): QueryDeps {
  return {
    callModel: queryModelWithStreaming,
    microcompact: microcompactMessages,
    autocompact: autoCompactIfNeeded,
    uuid: randomUUID,
  }
}
```

`microcompactMessages()` 在 `src/services/compact/microCompact.ts`：

```ts
export async function microcompactMessages(
  messages: Message[],
  toolUseContext?: ToolUseContext,
  querySource?: QuerySource,
): Promise<MicrocompactResult> {
  // 时间触发路径先跑。
  // 如果服务端缓存已经冷了，就直接在本地清旧工具结果，减少下一次重写前缀的体积。
  const timeBasedResult = maybeTimeBasedMicrocompact(messages, querySource)
  if (timeBasedResult) {
    return timeBasedResult
  }

  // cached microcompact 只在支持 cache editing 的模型和主线程里跑。
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

  // 其他情况不做 microcompact，直接原样返回。
  return { messages }
}
```

代入数据有三种结果：

```text
情况 A：不触发 microcompact
  输入: [b0, s0, a1, tr1(短文本), sn1, u2]
  输出: [b0, s0, a1, tr1(短文本), sn1, u2]

情况 B：time-based microcompact
  输入: [b0, s0, a1, tr1(短文本), sn1, u2]
  输出: [b0, s0, a1, tr1([Old tool result content cleared]), sn1, u2]

情况 C：cached microcompact
  输入: [b0, s0, a1, tr1(短文本), sn1, u2]
  输出: [b0, s0, a1, tr1(短文本), sn1, u2]
  额外: pendingCacheEdits 记录要让 API 删除哪些缓存里的 tool_result
```

cached microcompact 为什么看起来没改数组：

```text
它不是改本地 messages。
它是准备 cache_edits。
真正删除发生在 API 服务端缓存层。
所以 query.ts 先保存 pendingCacheEdits，
等 API 响应后再根据 cache_deleted_input_tokens yield microcompact_boundary。
```

这一节仍然不是完整摘要压缩。

---

## 8. 第六步：contextCollapse 当前是 stub

源码位置：`src/query.ts`。

```ts
if (feature('CONTEXT_COLLAPSE') && contextCollapse) {
  const collapseResult = await contextCollapse.applyCollapsesIfNeeded(
    // 输入：microcompact 之后的 messagesForQuery。
    messagesForQuery,

    // 上下文给 collapse 模块判断。
    toolUseContext,

    // querySource 标识调用来源。
    querySource,
  )

  // 输出替换回 messagesForQuery。
  messagesForQuery = collapseResult.messages
}
```

当前仓库的实现是 `src/services/contextCollapse/index.ts`：

```ts
// src/services/contextCollapse/index.ts

export const applyCollapsesIfNeeded: (
  // 输入消息数组。
  messages: Message[],

  // 当前工具上下文。
  toolUseContext: ToolUseContext,

  // 当前 query 来源。
  querySource: QuerySource,

  // 返回 CollapseResult，里面有 messages 字段。
) => Promise<CollapseResult> = async (messages: Message[]) => ({ messages })
```

也就是说，当前实现直接返回原数组：

```text
进入本步:
  [b0, s0, a1, tr1(短文本), sn1, u2]

离开本步:
  [b0, s0, a1, tr1(短文本), sn1, u2]
```

源码注释里说它设计上应该：

```text
在 autocompact 前投影一个更短的 collapsed view。
如果 collapsed view 已经让 token 降到阈值以下，就不用完整 autocompact。
```

但你读当前仓库时要以实现为准：

```text
contextCollapse 代码路径存在。
当前 index.ts 是 stub。
所以现在它不改变 messagesForQuery。
```

---

## 9. 第七步：deps.autocompact 是自动完整摘要压缩判断器

现在再看你卡住的这行。

源码位置：`src/query.ts`。

```ts
const { compactionResult, consecutiveFailures } = await deps.autocompact(
  // 输入：前面所有步骤处理后的 messagesForQuery。
  messagesForQuery,

  // 工具上下文。
  toolUseContext,

  {
    // compactConversation 需要这些上下文构造摘要请求。
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext,

    // 如果 compact 走 forked agent，总结 agent 看到的历史就是这组 messages。
    forkContextMessages: messagesForQuery,
  },

  // 标识这次 query 来自主线程、子 agent、compact、session_memory 等。
  querySource,

  // auto compact 跟踪状态：是否刚 compact 过、连续失败次数等。
  tracking,

  // 前面 snip 释放的 token 估算。
  snipTokensFreed,
)
```

`deps.autocompact` 不是神秘函数。它在 `src/query/deps.ts` 里等于：

```ts
export function productionDeps(): QueryDeps {
  return {
    callModel: queryModelWithStreaming,
    microcompact: microcompactMessages,

    // deps.autocompact 实际就是 autoCompactIfNeeded。
    autocompact: autoCompactIfNeeded,

    uuid: randomUUID,
  }
}
```

所以这行可以直接翻译成：

```text
把已经经过切片、tool_result 预算、snip、microcompact、contextCollapse 的 messagesForQuery，
交给 autoCompactIfNeeded。

autoCompactIfNeeded 判断：
  现在是否超过自动 compact 阈值？
  如果没有超过，就返回 wasCompacted=false。
  如果超过，就尝试生成 compact summary。
```

`autoCompactIfNeeded()` 在 `src/services/compact/autoCompact.ts`：

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
  // DISABLE_COMPACT 开启时，自动 compact 直接不做。
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return { wasCompacted: false }
  }

  // 连续失败太多次后，跳过后续自动 compact。
  if (
    tracking?.consecutiveFailures !== undefined &&
    tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
  ) {
    return { wasCompacted: false }
  }

  const model = toolUseContext.options.mainLoopModel

  // 判断当前 messages 是否已经达到自动 compact 阈值。
  const shouldCompact = await shouldAutoCompact(
    messages,
    model,
    querySource,
    snipTokensFreed,
  )

  // 没到阈值：不 compact。
  if (!shouldCompact) {
    return { wasCompacted: false }
  }
```

继续往下：

```ts
  // 先尝试 session memory compact。
  // 如果已有结构化记忆足够恢复上下文，就不用传统 summarizer。
  const sessionMemoryResult = await trySessionMemoryCompaction(
    messages,
    toolUseContext.agentId,
    recompactionInfo.autoCompactThreshold,
  )
  if (sessionMemoryResult) {
    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)
    markPostCompaction()
    return {
      wasCompacted: true,
      compactionResult: sessionMemoryResult,
    }
  }

  try {
    // session memory 没接住，才进入传统 compactConversation。
    const compactionResult = await compactConversation(
      messages,
      toolUseContext,
      cacheSafeParams,
      true,
      undefined,
      true,
      recompactionInfo,
    )

    setLastSummarizedMessageId(undefined)
    runPostCompactCleanup(querySource)

    return {
      wasCompacted: true,
      compactionResult,
      consecutiveFailures: 0,
    }
  } catch (error) {
    // compact 失败时记录失败次数，避免每轮都无限重试。
    const prevFailures = tracking?.consecutiveFailures ?? 0
    const nextFailures = prevFailures + 1
    return { wasCompacted: false, consecutiveFailures: nextFailures }
  }
}
```

所以 `deps.autocompact` 内部顺序是：

```text
autoCompactIfNeeded(messagesForQuery)
  │
  ├─ DISABLE_COMPACT?
  │    是 -> 不 compact
  │
  ├─ 连续失败次数太多?
  │    是 -> 不 compact
  │
  ├─ shouldAutoCompact?
  │    否 -> 不 compact
  │
  ├─ trySessionMemoryCompaction?
  │    成功 -> 返回 CompactionResult
  │
  └─ compactConversation?
       成功 -> 返回 CompactionResult
       失败 -> 返回 consecutiveFailures
```

代入数据：

```text
进入 autocompact:
  [b0, s0, a1, tr1(短文本), sn1, u2]

如果没到阈值:
  compactionResult = undefined
  consecutiveFailures = undefined
  messagesForQuery 继续保持这组数组

如果到了阈值并压缩成功:
  compactionResult = {
    boundaryMarker: b1,
    summaryMessages: [s1],
    attachments: [att1],
    hookResults: [hook1]
  }
```

---

## 10. compactConversation 真正生成摘要

`autoCompactIfNeeded` 只是判断和调度。
传统完整摘要是在 `compactConversation()` 里做的。

源码位置：`src/services/compact/compact.ts`。

```ts
export async function compactConversation(
  messages: Message[],
  context: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  suppressFollowUpQuestions: boolean,
  customInstructions?: string,
  isAutoCompact: boolean = false,
  recompactionInfo?: RecompactionInfo,
): Promise<CompactionResult> {
  // 压缩前先估算 token。
  const preCompactTokenCount = tokenCountWithEstimation(messages)

  // 运行 PreCompact hooks。
  const hookResult = await executePreCompactHooks(
    {
      trigger: isAutoCompact ? 'auto' : 'manual',
      customInstructions: customInstructions ?? null,
    },
    context.abortController.signal,
  )

  // hooks 可以追加自定义摘要指令。
  customInstructions = mergeHookInstructions(
    customInstructions,
    hookResult.newCustomInstructions,
  )

  // 构造 compact prompt。
  const compactPrompt = getCompactPrompt(customInstructions)

  // summaryRequest 是发给总结模型的 user message。
  const summaryRequest = createUserMessage({
    content: compactPrompt,
  })
```

它接着调用 summarizer：

```ts
  let messagesToSummarize = messages
  let summaryResponse: AssistantMessage
  let summary: string | null

  for (;;) {
    // 这里才是真正让模型读旧 messages 并生成摘要。
    summaryResponse = await streamCompactSummary({
      messages: messagesToSummarize,
      summaryRequest,
      appState,
      context,
      preCompactTokenCount,
      cacheSafeParams: retryCacheSafeParams,
    })

    // 从 assistant response 里拿摘要文本。
    summary = getAssistantMessageText(summaryResponse)

    // 如果 compact 请求自己也太长，就截掉更老的消息后重试。
    if (!summary?.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE)) break
  }
```

然后恢复压缩后还必须保留的上下文：

```ts
  // compact 后会清 readFileState。
  // 所以先保存一个快照，用于生成 post-compact 文件附件。
  let preCompactReadFileState = cacheToObject(context.readFileState)

  // 清掉旧 readFileState。
  context.readFileState.clear()
  context.loadedNestedMemoryPaths?.clear()

  // 生成压缩后要重新注入的附件。
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
```

最后创建边界和摘要消息：

```ts
  const boundaryMarker = createCompactBoundaryMessage(
    // auto compact 传 'auto'，手动 /compact 传 'manual'。
    isAutoCompact ? 'auto' : 'manual',

    // 压缩前 token 数。
    preCompactTokenCount ?? 0,

    // 记录压缩前最后一条消息 uuid。
    messages.at(-1)?.uuid,
  )

  const summaryMessages: UserMessage[] = [
    createUserMessage({
      // 把 summarizer 输出包装成“继续会话用的用户消息”。
      content: getCompactUserSummaryMessage(
        summary,
        suppressFollowUpQuestions,
        transcriptPath,
      ),

      // 标记这是 compact summary。
      isCompactSummary: true,

      // UI transcript 可见性控制。
      isVisibleInTranscriptOnly: true,
    }),
  ]
```

完整摘要压缩的输出是 `CompactionResult`：

```text
CompactionResult
  boundaryMarker   -> compact_boundary SystemMessage
  summaryMessages  -> compact 摘要 UserMessage
  attachments      -> 文件、agent、plan、skill、MCP 等恢复上下文
  hookResults      -> SessionStart hook 重新注入的上下文
```

---

## 11. queryLoop 收到 compactionResult 后怎么替换 messagesForQuery

源码位置：`src/query.ts`。

```ts
if (compactionResult) {
  // 把 CompactionResult 拼成压缩后的消息数组。
  const postCompactMessages = buildPostCompactMessages(compactionResult)

  // yield 给 UI / transcript。
  for (const message of postCompactMessages) {
    yield message
  }

  // 本轮后面 callModel 使用压缩后的数组。
  messagesForQuery = postCompactMessages
} else if (consecutiveFailures !== undefined) {
  // autocompact 失败时，记录连续失败次数。
  tracking = {
    ...(tracking ?? { compacted: false, turnId: '', turnCounter: 0 }),
    consecutiveFailures,
  }
}
```

`buildPostCompactMessages()` 在 `src/services/compact/compact.ts`：

```ts
export function buildPostCompactMessages(result: CompactionResult): Message[] {
  return ([result.boundaryMarker] as Message[]).concat(
    // compact 摘要。
    result.summaryMessages,

    // 某些路径会保留最近原文。
    stripToolUseResults(result.messagesToKeep),

    // 压缩后恢复的结构化附件。
    result.attachments,

    // SessionStart hooks 注入的消息。
    result.hookResults,
  )
}
```

代入数据：

```text
autocompact 前:
  messagesForQuery = [b0, s0, a1, tr1(短文本), sn1, u2]

autocompact 成功:
  compactionResult = {
    boundaryMarker: b1,
    summaryMessages: [s1],
    attachments: [att1],
    hookResults: [hook1]
  }

buildPostCompactMessages 后:
  postCompactMessages = [b1, s1, att1, hook1]

queryLoop 替换:
  messagesForQuery = [b1, s1, att1, hook1]
```

这就是完整摘要压缩真正改变数组的位置。

---

## 12. autocompact 后面还有两种压缩相关路径

你说“源码里压缩的地方很多”，是对的。
`queryLoop` 里 `deps.autocompact()` 不是最后一个相关位置。

### 12.1 predictive autocompact：预测本轮增长会爆窗

位置在第一次 autocompact 之后、真正 callModel 之前。

源码位置：`src/query.ts`。

```ts
if (!compactionResult && isAutoCompactEnabled()) {
  const model = toolUseContext.options.mainLoopModel

  // 当前 token。
  const currentTokens =
    tokenCountWithEstimation(messagesForQuery) - snipTokensFreed

  // 估算本轮模型回答和工具调用最多会增长多少。
  const estimatedGrowth = estimateMaxTurnGrowth(model)

  // 如果当前 tokens 已经超过“窗口减去预计增长”，就提前 compact。
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

为什么第一次 autocompact 后还要 predictive autocompact：

```text
第一次 autocompact:
  判断“现在是否已经到自动压缩阈值”

predictive autocompact:
  判断“现在虽然还没到阈值，但本轮如果继续生成内容，可能会爆窗”
```

两者调用的是同一个 `deps.autocompact()`。
区别是触发条件不同。

### 12.2 reactive compact：API 已经报 prompt-too-long 后补救

位置在 callModel 之后。

源码位置：`src/query.ts`。

```ts
if ((isWithheld413 || isWithheldMedia) && reactiveCompact) {
  const compacted = await reactiveCompact.tryReactiveCompact({
    // 防止同一次失败无限 reactive compact。
    hasAttempted: hasAttemptedReactiveCompact,

    querySource,
    aborted: toolUseContext.abortController.signal.aborted,

    // 这里用的是刚才导致 API 报错的 messagesForQuery。
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
}
```

区别：

```text
autocompact:
  API 调用前主动判断。

predictive autocompact:
  API 调用前预测本轮增长风险。

reactive compact:
  API 已经报 prompt-too-long 或 media-size 后，紧急 compact，再 retry。
```

---

## 13. 为什么不是一上来就 autocompact

因为完整摘要压缩会改变对话形态：

```text
压缩前:
  [b0, s0, a1, tr1, sn1, u2]

压缩后:
  [b1, s1, att1, hook1]
```

这会丢掉很多原始消息细节。

所以 queryLoop 的策略是：

```text
先做不改变语义结构的小处理:
  删除 toolUseResult
  替换超大 tool_result 正文
  snip 删除已标记消息
  microcompact 清理旧工具结果
  contextCollapse 投影更短视图

这些都不够，才做完整摘要 compact。
```

这也解释了为什么 `deps.autocompact()` 在第七步：

```text
它不是第一道压缩。
它是“前面这些小处理之后，仍然太长时”的完整摘要压缩入口。
```

---

## 14. 所有压缩名字放在一张表里

```text
名称                         发生位置                  是否生成摘要   是否生成 compact_boundary
------------------------------------------------------------------------------------------------
getMessagesAfterCompactBoundary queryLoop 开头          否             否，使用旧 boundary
delete toolUseResult            queryLoop 开头          否             否
applyToolResultBudget           queryLoop 前置处理      否             否
snipCompactIfNeeded             queryLoop 前置处理      否             否，使用 snip_boundary
microcompact                     queryLoop 前置处理      否             否，可能生成 microcompact_boundary
contextCollapse                  queryLoop 前置处理      当前 stub 否    否
autocompact                      queryLoop API 前        是             是
predictive autocompact           queryLoop API 前        是             是
reactive compact                 API 报错后              是             是
/compact                         slash command           是             是
session memory compact           autocompact 内部优先     是             是
```

注意两种 boundary：

```text
compact_boundary
  完整摘要压缩边界。
  getMessagesAfterCompactBoundary 会用它切片。

microcompact_boundary
  microcompact 的记录消息。
  不会被 getMessagesAfterCompactBoundary 当成切片边界。
```

---

## 15. 从头到尾再跑一遍

```text
1. queryLoop 开始
   state.messages = [b0, s0, u1, a1, tr1(500KB + toolUseResult), sn1, u2]

2. getMessagesAfterCompactBoundary
   结果 = [b0, s0, u1, a1, tr1(500KB + toolUseResult), sn1, u2]

3. delete toolUseResult
   结果 = [b0, s0, u1, a1, tr1(500KB), sn1, u2]

4. applyToolResultBudget
   结果 = [b0, s0, u1, a1, tr1(persisted-output 短文本), sn1, u2]

5. snipCompactIfNeeded
   sn1.removedUuids = ['u1']
   结果 = [b0, s0, a1, tr1(persisted-output 短文本), sn1, u2]

6. microcompact
   可能不动
   可能把旧工具结果清成 [Old tool result content cleared]
   可能只排队 pendingCacheEdits

7. contextCollapse
   当前仓库 stub，结果不变

8. deps.autocompact
   如果没到阈值:
     messagesForQuery 保持第 7 步结果

   如果到阈值:
     compactConversation 生成摘要
     buildPostCompactMessages 生成 [b1, s1, att1, hook1]
     messagesForQuery = [b1, s1, att1, hook1]

9. blocking limit / predictive autocompact
   如果本轮预计会爆窗，可能再次调用 deps.autocompact

10. callModel
    模型读取最终 messagesForQuery

11. 如果 API 报 prompt-too-long
    reactiveCompact.tryReactiveCompact
    成功后 state.messages = [b2, s2, att2, hook2]
    continue 重试
```

读到这里再看这行：

```text
const { compactionResult, consecutiveFailures } = await deps.autocompact(
```

它的位置就清楚了：

```text
它不是“压缩流程开头”。
它是在一串局部瘦身之后，
判断是否需要完整摘要压缩的入口。
```
