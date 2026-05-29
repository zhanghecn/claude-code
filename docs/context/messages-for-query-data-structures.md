# messagesForQuery 数据结构导读

这份文档只回答一个问题：`messagesForQuery` 里到底会有哪些数据结构，它们从哪里来，又会怎样被转换成 API 请求里的消息。

先给结论：

```text
queryLoop 内部的 messagesForQuery
  类型：Message[]
  内容：user / assistant / system / attachment / progress / grouped_tool_use 等内部消息结构都可能在运行时消息流里出现

真正发给模型前的 messagesForAPI
  类型：(UserMessage | AssistantMessage)[]
  来源：normalizeMessagesForAPI(messagesForQuery, tools)
  内容：只保留或转换成 Anthropic API 能接受的 user / assistant 两类消息
```

所以要分清两层：

```text
内部层：
  messagesForQuery 是 CLI 的内部消息数组。
  它可以包含 compact_boundary、snip_boundary、attachment、toolUseResult 等内部字段。

API 层：
  callModel 内部会调用 normalizeMessagesForAPI。
  普通 system/progress 会被过滤，attachment 会被转换成“CLI 注入的 user 消息”。
```

你在控制台看到的这种结构：

```text
Array(5) [
  { type: 'progress', data, parentToolUseID, toolUseID, timestamp, uuid },
  { type: 'attachment', attachment, timestamp, uuid },
  { type: 'user', message: { role: 'user', content: '...' }, isMeta, isVirtual },
  ...
]
```

说明你看的不是“最终 API body”，而是 CLI 内部/上层 UI 持有的消息对象数组。这个数组里会混合多种内部消息：

```text
progress:
  工具运行中的进度，只给 UI/流式事件看。

attachment:
  文件、记忆、队列命令等附件容器，后面才转换成“CLI 注入的 user 消息”。

user:
  用户亲手输入、CLI 注入说明、tool_result、compact summary 都共用这个结构。
```

所以下面会先按“运行时字段”解释，再讲它们怎么进入或离开 `messagesForQuery`。

---

## 1. messagesForQuery 从哪里开始

源码位置：`src/query.ts`。

```ts
// messages 来自 state.messages。
// state.messages 是上一轮留下来的完整内部消息历史。
const { messages } = state

// messagesForQuery 不是新造的消息类型。
// 它先从 messages 里按 compact_boundary 切出“本轮模型还能看到的部分”。
let messagesForQuery = getMessagesAfterCompactBoundary(messages)
```

这里的类型关系：

```ts
// packages/@ant/model-provider/src/types/message.ts
export type Message = {
  type: MessageType      // user / assistant / system / attachment / progress 等
  uuid: UUID             // 每条内部消息都有 uuid

  // true 表示：这条虽然 role='user'，但不是用户亲手输入的。
  // 它是 CLI 塞给模型看的说明、提醒、恢复指令、附件说明。
  isMeta?: boolean

  isCompactSummary?: boolean
  toolUseResult?: unknown // UI/内部用的原始工具结果，不是 API 必需字段
  attachment?: { type: string; [key: string]: unknown }
  message?: {
    role?: string
    id?: string
    content?: MessageContent
    usage?: BetaUsage | Record<string, unknown>
  }
  [key: string]: unknown
}
```

`messagesForQuery` 一开始只是 `Message[]` 的一个切片：

```text
state.messages
  [u1, a1, tr1, b1, s1, u2, a2, tr2, att1]
                    │
                    │ getMessagesAfterCompactBoundary(messages)
                    ▼
messagesForQuery
  [b1, s1, u2, a2, tr2, att1]
```

---

## 2. MessageType 总表：内部可能出现哪些 type

源码位置：`packages/@ant/model-provider/src/types/message.ts`。

```ts
export type MessageType =
  | 'user'                 // 用户侧消息：用户输入、CLI 注入说明、tool_result
  | 'assistant'            // 模型返回消息，也包括 tool_use
  | 'system'               // CLI 内部系统事件、compact 边界、snip 边界等
  | 'attachment'           // 文件、记忆、技能、队列命令等附件
  | 'progress'             // 工具进度/UI 进度，API 前会过滤
  | 'grouped_tool_use'     // UI 聚合展示形态，通常不作为 API 消息
  | 'collapsed_read_search'// UI 折叠展示形态，通常不作为 API 消息
```

但是在 `queryLoop` 主线上，最常见、最需要理解的是这四类：

```text
UserMessage
  用户亲手输入、CLI 注入说明、compact summary、tool_result。

AssistantMessage
  模型输出、thinking、tool_use、API error。

SystemMessage
  compact_boundary、microcompact_boundary、snip_boundary、informational 等。

AttachmentMessage
  文件/记忆/技能/工具发现/队列命令等上下文容器。
```

---

## 3. 运行时通用字段字典

你看到的每个对象外层字段，大多来自这个基础类型：

```ts
// packages/@ant/model-provider/src/types/message.ts
export type Message = {
  // 分辨消息种类的字段。读任何消息先看它。
  type: MessageType

  // 内部消息 id，不等于 assistant.message.id，也不等于 tool_use.id。
  uuid: UUID

  // true 表示：
  // 外层 type 是 'user'，message.role 也是 'user'，
  // 但内容不是用户亲手输入的。
  // 它是 CLI 为了让模型知道某些情况而塞进去的说明。
  isMeta?: boolean

  // true 表示这是 compact 生成的历史摘要。
  isCompactSummary?: boolean

  // 工具执行的原始结果，给 UI/内部展示用。
  // API 真正需要的是 message.content 里的 tool_result block。
  toolUseResult?: unknown

  // true 表示只在 transcript 里可见，普通对话 UI 可能不按用户消息展示。
  isVisibleInTranscriptOnly?: boolean

  // attachment message 才有。里面是真正的附件数据。
  attachment?: {
    type: string
    toolUseID?: string
    [key: string]: unknown
  }

  // user / assistant 都会有 message。
  // 这是更接近 Anthropic API 的嵌套结构。
  message?: {
    role?: string
    id?: string
    content?: MessageContent
    usage?: BetaUsage | Record<string, unknown>
    [key: string]: unknown
  }

  // 反编译/兼容层允许附加字段，所以控制台里会看到更多字段。
  [key: string]: unknown
}
```

常见字段含义：

```text
type
  外层消息种类。先看它再决定怎么读其它字段。

uuid
  CLI 内部消息 uuid。用于 UI diff、snip 删除、compact parent 关系等。

timestamp
  创建消息的时间。很多 create*Message 函数都会写入。

message.role
  API 角色。user message 通常是 'user'，assistant message 通常是 'assistant'。

message.content
  真正会被模型读取的内容候选。
  可以是字符串，也可以是 content block 数组。

isMeta
  先不要把它理解成抽象术语。

  它回答的是这个问题：
    “这条 type='user' 的消息，是不是用户亲手输入的？”

  isMeta === true:
    不是用户亲手输入。
    是 CLI 为了让模型继续工作，临时塞进去的一条说明。

  isMeta === undefined:
    没有这个标记。
    通常按“用户亲手输入的普通 user 消息”理解，或者至少不是 CLI 标记的辅助说明。

  为什么需要它：
    Anthropic API 只有 user/assistant 这种对话角色。
    但 CLI 还需要把“文件内容”“记忆”“继续生成提醒”“工具被拒绝说明”发给模型。
    这些内容不是 assistant 说的，也不是真实用户手打的。
    所以 CLI 把它们包装成 role='user'，同时用 isMeta=true 标记：
      这是一条系统注入给模型看的 user 消息。

isVirtual
  展示/内部临时消息。`normalizeMessagesForAPI()` 会过滤 user/assistant 的 virtual 消息。

isVisibleInTranscriptOnly
  只在 transcript 保留，用于 compact summary 等。

toolUseID
  常见于 progress / attachment，表示这条消息关联哪个工具调用。

parentToolUseID
  progress 专用较多。表示这个进度属于哪个父工具调用。

sourceToolAssistantUUID
  tool_result user message 上常见。
  表示它对应哪条 assistant message 里的 tool_use。

toolUseResult
  工具原始结果。queryLoop 下一轮会删除它，避免大对象长期占内存。
```

你看到 `isMeta: undefined, isVirtual: undefined` 不是类型错了。它们是可选标记，没用到时就是 `undefined`。

按你给的 `Array(5)`，可以这样读：

```ts
const observed = [
  {
    // 第 1 条：工具执行中的进度。
    // 给 UI 展示“工具还在跑到哪里了”，不是最终工具结果。
    type: 'progress',
    uuid: 'progress-message-uuid',
    timestamp: '2026-05-27T01:02:17.262Z',
    toolUseID: '8e231cdb-27dd-4890-ab8e-93f6b551bcb8',
    parentToolUseID: '8e231cdb-27dd-4890-ab8e-93f6b551bcb8',
    data: {
      // data 的字段由具体工具决定。
      // Bash/PowerShell/Grep/WebFetch 都可能不同。
    },
  },

  {
    // 第 2 条：附件容器。
    // 真正内容要展开 attachment.type 看。
    type: 'attachment',
    uuid: '64dbbdeb-b404-4e94-ab39-8f3f74a8f9c4',
    timestamp: '2026-05-27T01:02:17.459Z',
    attachment: {
      type: 'queued_command',
      prompt: '工具执行期间排队进来的内容',
    },
  },

  {
    // 第 3 条：普通用户输入。
    type: 'user',
    uuid: 'user-message-uuid',
    timestamp: '2026-05-27T01:02:17.500Z',

    // 这些是可选标记。
    // undefined 不是一种特殊业务状态，只是“这条消息没有这个标记”。
    isMeta: undefined,
    isVirtual: undefined,
    isVisibleInTranscriptOnly: undefined,

    message: {
      role: 'user',
      content:
        '帮我找到 tmp/agent-loop-debug-fixture 项目里所有未使用的导入语句，然后删掉它们。',
    },
  },
]
```

这三类对象后面的命运不同：

```text
progress
  UI 可见；normalizeMessagesForAPI 过滤；不作为模型上下文正文。

attachment
  UI/内部先保留；normalizeMessagesForAPI 转成 CLI 注入的 user 消息或 tool_result 等。

user
  通常会保留到 API；如果相邻还有 user，可能被合并。
```

---

## 4. ProgressMessage：你截图里第一个对象

你截图里的结构：

```text
{
  data: Object,
  parentToolUseID: "8e231cdb-27dd-4890-ab8e-93f6b551bcb8",
  timestamp: "2026-05-27T01:02:17.262Z",
  toolUseID: "8e231cdb-27dd-4890-ab8e-93f6b551bcb8",
  type: "progress",
  uuid: "..."
}
```

对应源码是 `src/utils/messages.ts`：

```ts
export function createProgressMessage<P extends Progress>({
  // 当前 progress 消息自己的工具进度 id。
  // 有些工具会生成 bash-progress-0 / ps-progress-0 这种子 id。
  toolUseID,

  // 父工具调用 id。
  // 也就是 assistant message 里 tool_use block 的 id。
  parentToolUseID,

  // 工具自己上报的进度数据。
  // 不同工具 data 结构不同：Bash/PowerShell/WebFetch/Grep 都可能不同。
  data,
}: {
  toolUseID: string
  parentToolUseID: string
  data: P
}): ProgressMessage<P> {
  return {
    type: 'progress',
    data,
    toolUseID,
    parentToolUseID,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}
```

它从哪里来：

```text
工具执行中
  -> tool.call(..., progress => onToolProgress(progress))
  -> createProgressMessage({ toolUseID, parentToolUseID, data })
  -> yield 给 queryLoop 上层/UI
```

源码位置：`src/services/tools/toolExecution.ts`。

```ts
stream.enqueue({
  message: createProgressMessage({
    // 工具上报的进度 id。
    toolUseID: progress.toolUseID as string,

    // 当前正在执行的父 tool_use id。
    parentToolUseID: toolUseID,

    // 工具上报的进度 payload。
    data: progress.data,
  }),
})
```

模拟数据：

```ts
// Bash/PowerShell 这类长运行工具会不断产生 progress。
const p1 = {
  type: 'progress',
  uuid: 'p1',
  timestamp: '2026-05-27T01:02:17.262Z',

  // 这条 progress 自己的 id。
  toolUseID: 'bash-progress-0',

  // 它属于哪个真正的 tool_use。
  parentToolUseID: 'toolu_bash_1',

  // data 是工具自定义结构。
  data: {
    type: 'bash_progress',
    output: '正在扫描 imports...',
    elapsedTimeSeconds: 2,
    totalLines: 34,
  },
}
```

注意：

```text
progress 是过程消息，不是模型需要继续推理的内容。
normalizeMessagesForAPI() 会过滤 progress。

但你在 UI 消息数组、流式事件数组、调试数组里能看到它。
这就是你截图里第一个对象的来源。
```

---

## 5. UserMessage：用户输入、CLI 注入说明、summary、tool_result 都是它

源码位置：`src/utils/messages.ts`。

```ts
export function createUserMessage({
  content,
  isMeta,
  isVisibleInTranscriptOnly,
  isCompactSummary,
  summarizeMetadata,
  toolUseResult,
  mcpMeta,
  uuid,
  timestamp,
  imagePasteIds,
  sourceToolAssistantUUID,
  permissionMode,
  origin,
}: {
  content: string | ContentBlockParam[]
  isMeta?: true
  isVisibleInTranscriptOnly?: true
  isCompactSummary?: true
  toolUseResult?: unknown
  sourceToolAssistantUUID?: UUID
  origin?: MessageOrigin
}) {
  const m: UserMessage = {
    type: 'user',
    message: {
      role: 'user',
      // content 可以是普通字符串，也可以是 content block 数组。
      content: content || NO_CONTENT_MESSAGE,
    },
    isMeta,
    isVisibleInTranscriptOnly,
    isCompactSummary,
    summarizeMetadata,
    uuid: uuid || randomUUID(),
    timestamp: timestamp ?? new Date().toISOString(),
    toolUseResult,
    mcpMeta,
    imagePasteIds,
    sourceToolAssistantUUID,
    permissionMode,
    origin,
  }
}
```

### 5.1 普通用户输入

来源：

```text
REPL / SDK / queued prompt
  -> createUserMessage({ content: 用户文本 })
  -> state.messages
  -> 下一轮 getMessagesAfterCompactBoundary()
  -> messagesForQuery
```

模拟数据：

```ts
// 普通用户消息。
// 这是用户真正输入的内容，不是系统注入。
const u1 = {
  type: 'user',
  uuid: 'u1',
  timestamp: '2026-05-26T10:00:00.000Z',

  // 这些字段在控制台里可能显示为 undefined。
  // 这些是可选标记。
  // undefined 表示“这条普通用户消息没有这些额外标记”。
  isMeta: undefined,
  isVirtual: undefined,
  isVisibleInTranscriptOnly: undefined,

  message: {
    role: 'user',
    content: '帮我梳理 queryLoop',
  },
}
```

这正对应你截图里的第三个对象：

```text
{
  isMeta: undefined,
  isVirtual: undefined,
  isVisibleInTranscriptOnly: undefined,
  message: {
    content: "帮我找到 tmp/agent-loop-debug-fixture 项目里所有未使用的导入语句，然后删掉它们。",
    role: "user"
  },
  type: "user",
  uuid: "...",
  timestamp: "..."
}
```

字段解释：

```text
type: 'user'
  这是用户侧消息。

message.role: 'user'
  发给 API 时的角色。

message.content: string
  用户实际输入文本。

isMeta: undefined
  没有被标记成“CLI 注入说明”。
  对这条消息来说，它就是用户亲手输入的普通内容。

isVirtual: undefined
  不是只用于展示的虚拟消息。

isVisibleInTranscriptOnly: undefined
  不只是 transcript 可见。
```

### 5.2 CLI 注入说明：为什么它也是 UserMessage

来源：

```text
自动恢复 / token budget / hook / attachment 转换
  -> createUserMessage({ content, isMeta: true })
  -> messagesForQuery 或 normalizeMessagesForAPI 后的 messagesForAPI
```

模拟数据：

```ts
// 这条不是用户亲手输入。
// 这是 CLI 塞给模型看的“继续生成提醒”。
// 因为 API 没有 cli/system-reminder 这种 role，
// 所以它被包装成 role='user'，再用 isMeta=true 做内部标记。
const injected1 = {
  type: 'user',
  uuid: 'injected1',
  isMeta: true,
  message: {
    role: 'user',
    content:
      'Output token limit hit. Resume directly, no apology, no recap.',
  },
}
```

为什么不直接用 `system`？

```text
内部可以有 type='system'。
但是普通 system message 在 normalizeMessagesForAPI() 里大多会被过滤。

如果 CLI 真的想让模型读到这段内容，
就必须把它变成 API 会接受的 user/assistant 消息。

这些内容不是 assistant 说的，所以包装成 user。
又因为它不是用户亲手输入，所以加 isMeta=true。
```

### 5.3 compact summary 也是 UserMessage

来源：

```text
auto/manual compact
  -> compact summarizer 得到 summary 文本
  -> createUserMessage({ content: getCompactUserSummaryMessage(summary, false, transcriptPath), isCompactSummary: true })
  -> buildPostCompactMessages()
  -> messagesForQuery
```

源码位置：`src/services/compact/compact.ts`。

```ts
const summaryMessages: UserMessage[] = [
  createUserMessage({
    // summary 文本会被包装成普通 user role。
    content: getCompactUserSummaryMessage(summary, false, transcriptPath),

    // 标记它是 compact 摘要。
    isCompactSummary: true,

    // 通常只在 transcript 里可见，不按普通用户输入展示。
    isVisibleInTranscriptOnly: true,
  }),
]
```

模拟数据：

```ts
// compact 后的摘要消息。
// 虽然 type 是 user，但语义是“压缩后的历史摘要”。
const s1 = {
  type: 'user',
  uuid: 's1',
  isCompactSummary: true,
  isVisibleInTranscriptOnly: true,
  message: {
    role: 'user',
    content:
      'Summary: 用户正在研究 queryLoop，已经理解 state 和 queryTracking。',
  },
}
```

### 5.4 tool_result 也是 UserMessage

模型输出 `tool_use` 后，CLI 执行工具，结果用 `createUserMessage()` 包成 `tool_result`。

来源：

```text
AssistantMessage.content 里出现 tool_use
  -> runTools() / StreamingToolExecutor
  -> createUserMessage({ content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: result }] })
  -> toolResults
  -> 下一轮 state.messages = messagesForQuery + assistantMessages + toolResults
  -> 下一轮 messagesForQuery
```

源码位置：`src/services/tools/toolExecution.ts`。

```ts
yield {
  message: createUserMessage({
    content: [
      {
        type: 'tool_result',
        content: '<tool_use_error>Error: No such tool available</tool_use_error>',
        is_error: true,
        tool_use_id: toolUse.id,
      },
    ],

    // toolUseResult 是内部/UI 原始结果。
    // queryLoop 后面会删除它，因为 API 只需要 message.content 里的 tool_result。
    toolUseResult: 'Error: No such tool available',

    // 指向哪个 assistant message 里产生了对应 tool_use。
    sourceToolAssistantUUID: assistantMessage.uuid,
  }),
}
```

模拟数据：

```ts
// 工具结果消息。
// type 仍然是 user，因为 Anthropic API 里 tool_result 属于 user turn。
const tr1 = {
  type: 'user',
  uuid: 'tr1',
  sourceToolAssistantUUID: 'a1',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_read_1',
        content: 'src/query.ts 文件内容：async function queryLoop(params, consumedCommandUuids, consumedAutonomyCommands) 位于第 392 行。',
      },
    ],
  },

  // 内部展示/恢复用，进入下一轮 messagesForQuery 后会被删除。
  toolUseResult: {
    type: 'text',
    file: { filePath: 'src/query.ts' },
    content: 'src/query.ts 文件内容：async function queryLoop(params, consumedCommandUuids, consumedAutonomyCommands) 位于第 392 行。',
  },
}
```

---

## 6. AssistantMessage：模型输出和 tool_use

源码位置：`src/utils/messages.ts`。

```ts
export function createAssistantMessage({
  content,
  usage,
  isVirtual,
}: {
  content: string | BetaContentBlock[]
  usage?: Usage
  isVirtual?: true
}): AssistantMessage {
  return baseCreateAssistantMessage({
    // 字符串会被转换成 text content block。
    content:
      typeof content === 'string'
        ? [{ type: 'text', text: content || NO_CONTENT_MESSAGE }]
        : content,
    usage,
    isVirtual,
  })
}
```

`queryLoop` 里不是手动创建普通 assistant，而是 `deps.callModel()` 流式产出：

```text
deps.callModel({ messages, systemPrompt, tools, signal, options })
  -> yield AssistantMessage
  -> assistantMessages.push(message)
  -> 如果里面有 tool_use，needsFollowUp = true
  -> 下一轮 state.messages 拼入 assistantMessages
```

模拟数据：

```ts
// 模型输出工具调用。
// 下一条 tool_result 必须用 tool_use_id='toolu_read_1' 配对。
const a1 = {
  type: 'assistant',
  uuid: 'a1',
  message: {
    id: 'msg_abc',
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: '我先读取 query.ts。',
      },
      {
        type: 'tool_use',
        id: 'toolu_read_1',
        name: 'Read',
        input: { file_path: 'src/query.ts' },
      },
    ],
    usage: {
      input_tokens: 12000,
      output_tokens: 300,
    },
  },
}
```

如果 API error 被包装成 assistant，也还是 `AssistantMessage`：

```ts
// API error 也是 assistant 形态。
// queryLoop 后面会根据 isApiErrorMessage / apiError 决定是否恢复或终止。
const err1 = {
  type: 'assistant',
  uuid: 'err1',
  isApiErrorMessage: true,
  apiError: 'max_output_tokens',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'Output exceeded max tokens' }],
  },
}
```

---

## 7. SystemMessage：内部边界和事件

`SystemMessage` 在内部数组里很常见，但大多数不会直接发给 API。

### 7.1 compact_boundary

来源：

```text
manual compact / autocompact / reactive compact
  -> createCompactBoundaryMessage()
  -> buildPostCompactMessages()
  -> messagesForQuery
```

源码位置：`src/utils/messages.ts`。

```ts
export function createCompactBoundaryMessage(
  // trigger 记录是手动 compact 还是自动 compact。
  trigger: 'manual' | 'auto',

  // preTokens 是 compact 前的 token 估算。
  preTokens: number,

  // 记录 compact 前最后一条消息，用于逻辑父子关系。
  lastPreCompactMessageUuid?: UUID,

  // 用户手动 compact 时可能带的额外说明。
  userContext?: string,

  // 被摘要覆盖的消息数量。
  messagesSummarized?: number,
): SystemCompactBoundaryMessage {
  return {
    // 这是内部 system message。
    type: 'system',

    // getMessagesAfterCompactBoundary 识别的就是这个 subtype。
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    uuid: randomUUID(),
    level: 'info',

    // compactMetadata 后续用于追踪和 UI 展示。
    compactMetadata: {
      trigger,
      preTokens,
      userContext,
      messagesSummarized,
    },

    // 如果知道 compact 前最后一条消息，把它记录为逻辑父节点。
    ...(lastPreCompactMessageUuid && {
      logicalParentUuid: lastPreCompactMessageUuid,
    }),
  }
}
```

模拟数据：

```ts
// compact 边界。
// getMessagesAfterCompactBoundary 会从最后一个 compact_boundary 开始切片。
const b1 = {
  type: 'system',
  subtype: 'compact_boundary',
  uuid: 'b1',
  content: 'Conversation compacted',
  compactMetadata: {
    trigger: 'auto',
    preTokens: 185000,
    messagesSummarized: 40,
  },
}
```

### 7.2 microcompact_boundary

来源：

```text
cached microcompact 成功删除服务端缓存中的旧 tool_result
  -> createMicrocompactBoundaryMessage()
  -> yield 给上层
  -> 后续可能进入 state.messages
  -> 下一轮 messagesForQuery
```

模拟数据：

```ts
// microcompact 边界。
// 它记录旧工具结果被清理了多少 token。
const mb1 = {
  type: 'system',
  subtype: 'microcompact_boundary',
  uuid: 'mb1',
  content: 'Context microcompacted',
  microcompactMetadata: {
    trigger: 'auto',
    preTokens: 170000,
    tokensSaved: 42000,
    compactedToolIds: ['toolu_read_1'],
    clearedAttachmentUUIDs: [],
  },
}
```

### 7.3 snip_boundary

来源：

```text
snip 命令 / snip compact 逻辑
  -> 创建 subtype='snip_boundary' 的 system message
  -> snipMetadata.removedUuids 记录要隐藏的消息 uuid
  -> snipCompactIfNeeded()/projectSnippedView() 按 uuid 过滤
```

模拟数据：

```ts
// snip 边界。
// 它不是摘要，而是“这些 uuid 后续不再进入模型视图”的记录。
const sn1 = {
  type: 'system',
  subtype: 'snip_boundary',
  uuid: 'sn1',
  snipMetadata: {
    removedUuids: ['u2'],
  },
}
```

### 7.4 informational / local_command

`createSystemMessage()` 创建普通系统提示消息：

```ts
// 普通 informational system message。
// normalizeMessagesForAPI 会过滤普通 system，不会直接发给模型。
const sys1 = {
  type: 'system',
  subtype: 'informational',
  uuid: 'sys1',
  content: 'Switched to fallback model',
  level: 'warning',
}
```

特殊情况：`subtype='local_command'` 会在 `normalizeMessagesForAPI()` 里转换成 `UserMessage`，因为模型需要看到本地命令输出。

---

## 8. AttachmentMessage：你截图里第二个对象

你截图里的结构：

```text
{
  attachment: Object,
  timestamp: "2026-05-27T01:02:17.459Z",
  type: "attachment",
  uuid: "64dbbdeb-b404-4e94-ab39-8f3f74a8f9c4"
}
```

外层字段解释：

```text
type: 'attachment'
  说明这不是普通 user/assistant，而是 CLI 的上下文附件容器。

uuid
  这条附件消息自己的内部消息 id。

timestamp
  附件消息创建时间。

attachment
  真正的数据在这里面。必须继续看 attachment.type 才知道是什么附件。
```

源码位置：`src/utils/attachments.ts`。

```ts
export function createAttachmentMessage(
  attachment: Attachment,
): AttachmentMessage<Attachment> {
  return {
    // attachment 里放具体附件类型和数据。
    attachment,

    // 内部消息 type 是 attachment。
    type: 'attachment',

    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
  }
}
```

常见来源：

```text
getAttachmentMessages()
  -> @提及文件 / IDE 选中内容 / todo reminder / queued command

pendingMemoryPrefetch
  -> relevant_memories attachment

skillPrefetch
  -> skill_discovery attachment

searchExtraToolsPrefetch
  -> tool_discovery attachment

compact 后恢复文件
  -> file / compact_file_reference attachment
```

`attachment.type` 常见值：

```text
file
  文件内容附件，通常来自 @文件、compact 后恢复文件、工具读取结果恢复。

directory
  目录列表附件。

selected_lines_in_ide
  IDE 里选中的代码行。

opened_file_in_ide
  IDE 当前打开的文件提示。

todo_reminder / task_reminder
  Todo 或任务提醒。

nested_memory / relevant_memories
  CLAUDE.md / memory 系统注入的记忆内容。

skill_discovery / skill_listing / dynamic_skill
  技能发现或技能内容注入。

tool_discovery
  额外工具发现结果。

queued_command
  工具执行期间排队进来的用户消息或任务通知。

hook_stopped_continuation
  hook 要求停止继续时注入的附件。
```

所以看到 `attachment: Object` 时，下一步不要停在外层，应该展开它：

```ts
// 只看外层无法知道具体语义。
const att = {
  type: 'attachment',
  uuid: '64dbbdeb-b404-4e94-ab39-8f3f74a8f9c4',
  timestamp: '2026-05-27T01:02:17.459Z',

  // 继续看这里的 type。
  attachment: {
    type: 'queued_command',
    prompt: '用户在工具执行期间追加的一条消息',
    commandMode: 'prompt',
    isMeta: false,
  },
}
```

模拟数据：

```ts
// 文件附件。
// 在 messagesForQuery 内部还是 attachment。
const attFile = {
  type: 'attachment',
  uuid: 'att_file_1',
  attachment: {
    type: 'file',
    filename: 'src/query.ts',
    content: {
      type: 'text',
      content: '文件内容：async function queryLoop(params, consumedCommandUuids, consumedAutonomyCommands) 从 state 读取 messages。',
      lineCount: 2000,
    },
    truncated: true,
  },
}

// 记忆附件。
// queryLoop 工具执行后消费 pendingMemoryPrefetch 时会注入。
const attMem = {
  type: 'attachment',
  uuid: 'att_mem_1',
  attachment: {
    type: 'relevant_memories',
    memories: [
      {
        path: '.claude/memory.md',
        content: '用户偏好：喜欢中文源码注释。',
        mtimeMs: 1770000000000,
      },
    ],
  },
}
```

附件不会原样发给 API。`normalizeMessagesForAPI()` 会调用 `normalizeAttachmentForAPI()`：

```ts
case 'attachment': {
  // 把 attachment 转成一个或多个 UserMessage。
  const rawAttachmentMessage = normalizeAttachmentForAPI(
    message.attachment as Attachment,
  )

  // 如果上一条也是 user，就合并到同一个 user turn。
  const lastMessage = last(result)
  if (lastMessage?.type === 'user') {
    result[result.length - 1] = rawAttachmentMessage.reduce(
      (p, c) => mergeUserMessagesAndToolResults(p, c),
      lastMessage,
    )
    return
  }

  result.push(...rawAttachmentMessage)
}
```

例如文件附件会被转换成“模拟工具调用 + 工具结果”：

```text
AttachmentMessage(type='file')
  │
  │ normalizeAttachmentForAPI()
  ▼
UserMessage(isMeta=true): CLI 说明：Called the Read tool with file_path='src/query.ts'
UserMessage(tool_result): 文件内容
UserMessage(isMeta=true): CLI 说明：文件太大被截断的提示
```

---

## 9. grouped / collapsed：内部展示形态

`progress` 前面已经单独讲过。`MessageType` 里还有两个常见 UI 聚合形态：

```text
grouped_tool_use
  UI 把多个工具调用聚合展示后的结构。

collapsed_read_search
  UI 把 Read/Grep/Glob 等折叠展示后的结构。
```

它们不应该作为模型推理的主要上下文。`normalizeMessagesForAPI()` 明确过滤 `progress`，普通 system 也会过滤：

```ts
reorderedMessages.filter(msg => {
  if (
    // progress 是 UI 进度，不发 API。
    msg.type === 'progress' ||

    // 普通 system 是 CLI 内部事件，不发 API。
    // 例外：local_command system 会转成 user。
    (msg.type === 'system' && !isSystemLocalCommandMessage(msg)) ||

    // synthetic API error 也不发。
    isSyntheticApiErrorMessage(msg)
  ) {
    return false
  }
  return true
})
```

---

## 10. messagesForQuery 到 messagesForAPI 的转换

源码位置：`src/services/api/claude.ts`。

```ts
// queryLoop 传进来的是内部 Message[]。
// 这里才转成 API 可接受的 user/assistant 序列。
let messagesForAPI = normalizeMessagesForAPI(messages, filteredTools)

// 修复 tool_use/tool_result 配对。
// 缺 tool_result 会补 synthetic error，孤立 tool_result 会被剥掉。
messagesForAPI = ensureToolResultPairing(messagesForAPI)

// 去掉过多媒体，避免 API 因超过媒体数量限制报错。
messagesForAPI = stripExcessMediaItems(
  messagesForAPI,
  API_MAX_MEDIA_PER_REQUEST,
)
```

转换规则可以这样记：

```text
UserMessage
  保留；连续 user 会合并；tool_result 保留配对。

AssistantMessage
  保留；tool_use 的 input/name 会做规范化。

AttachmentMessage
  转换成一个或多个 UserMessage。

SystemMessage
  普通 system 过滤。
  local_command 转成 UserMessage。
  compact_boundary / snip_boundary 不直接发 API。

ProgressMessage
  过滤。
```

---

## 11. 完整模拟：一组 messagesForQuery 的变形

### 11.1 上一轮结束时写入 state.messages

```ts
const stateMessages = [
  // 旧历史，已经会被 compact boundary 切掉。
  { type: 'user', uuid: 'u_old', message: { role: 'user', content: '旧问题' } },
  { type: 'assistant', uuid: 'a_old', message: { role: 'assistant', content: [{ type: 'text', text: '旧回答' }] } },

  // compact 边界。
  { type: 'system', subtype: 'compact_boundary', uuid: 'b1', compactMetadata: { trigger: 'auto', preTokens: 180000 } },

  // compact 摘要。
  { type: 'user', uuid: 's1', isCompactSummary: true, message: { role: 'user', content: 'Summary: 旧历史摘要：用户正在研究 queryLoop。' } },

  // 用户新问题。
  { type: 'user', uuid: 'u1', message: { role: 'user', content: '继续解释 messagesForQuery' } },

  // 模型上轮请求工具。
  {
    type: 'assistant',
    uuid: 'a1',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'toolu_read_1', name: 'Read', input: { file_path: 'src/query.ts' } },
      ],
    },
  },

  // 工具结果。
  {
    type: 'user',
    uuid: 'tr1',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_read_1', content: 'query.ts 内容：async function queryLoop 位于 src/query.ts。' },
      ],
    },
    toolUseResult: { raw: 'UI 展示用原始结果' },
  },

  // 工具后注入的记忆附件。
  {
    type: 'attachment',
    uuid: 'att_mem_1',
    attachment: {
      type: 'relevant_memories',
      memories: [{ path: 'memory.md', content: '用户偏好中文注释', mtimeMs: 1770000000000 }],
    },
  },
]
```

### 11.2 getMessagesAfterCompactBoundary 后

```text
输入 state.messages:
  [u_old, a_old, b1, s1, u1, a1, tr1, att_mem_1]

找到最后一个 compact_boundary:
  b1

输出 messagesForQuery:
  [b1, s1, u1, a1, tr1, att_mem_1]
```

此时 `messagesForQuery` 的类型分布：

```text
b1         SystemMessage(subtype='compact_boundary')
s1         UserMessage(isCompactSummary=true)
u1         UserMessage(普通用户输入)
a1         AssistantMessage(含 tool_use)
tr1        UserMessage(含 tool_result，带 toolUseResult 内部字段)
att_mem_1  AttachmentMessage(type='relevant_memories')
```

### 11.3 queryLoop 删除 toolUseResult

```ts
for (const msg of messagesForQuery) {
  if (
    msg.type === 'user' &&
    'toolUseResult' in msg &&
    msg.toolUseResult !== undefined
  ) {
    // tr1 的 message.content.tool_result 保留。
    // 只删除内部/UI 用的 toolUseResult。
    delete msg.toolUseResult
  }
}
```

执行后：

```text
messagesForQuery:
  [b1, s1, u1, a1, tr1(无 toolUseResult), att_mem_1]
```

### 11.4 经过 snip / microcompact / autocompact

假设本轮没有 autocompact，只做了 microcompact，把 `tr1` 的大内容替换成占位：

```text
messagesForQuery:
  [b1, s1, u1, a1, tr1(内容变短), att_mem_1]
```

如果 autocompact 触发成功，则整个数组会被替换：

```text
compactionResult
  boundaryMarker: b2
  summaryMessages: [s2]
  messagesToKeep: []
  attachments: [att_file_1]
  hookResults: []

buildPostCompactMessages(compactionResult)
  -> [b2, s2, att_file_1]

messagesForQuery
  -> [b2, s2, att_file_1]
```

源码：

```ts
export function buildPostCompactMessages(result: CompactionResult): Message[] {
  return ([result.boundaryMarker] as Message[]).concat(
    // compact summary，通常是 UserMessage。
    result.summaryMessages,

    // 需要原样保留的消息，但会剥掉 toolUseResult。
    stripToolUseResults(result.messagesToKeep),

    // compact 后恢复的文件/技能/记忆附件。
    result.attachments,

    // hook 注入结果。
    result.hookResults,
  )
}
```

### 11.5 callModel 前还是 Message[]

`queryLoop` 调用模型时传的是内部 `Message[]`：

```ts
for await (const message of deps.callModel({
  // prependUserContext 只是把 userContext 放到 messagesForQuery 前面。
  // 这里还不是最终 API message 序列。
  messages: prependUserContext(messagesForQuery, userContext),
  systemPrompt: fullSystemPrompt,
  tools: toolUseContext.options.tools,
  signal: toolUseContext.abortController.signal,
  options: {
    model: currentModel,
    querySource,
    queryTracking,
  },
})) {
  // 流式处理 assistant message。
}
```

### 11.6 claude.ts 内部转换成 messagesForAPI

假设传入：

```text
messagesForQuery:
  [b1, s1, u1, a1, tr1, att_mem_1]
```

`normalizeMessagesForAPI()` 后大致变成：

```text
messagesForAPI:
  [s1+u1, a1, tr1+att_mem_1_as_cli_injected_user]
```

解释：

```text
b1:
  system compact_boundary，过滤，不直接发给 API。

s1:
  UserMessage，保留。

u1:
  UserMessage，和前一个 user 可能合并。

a1:
  AssistantMessage，保留，tool_use input/name 会规范化。

tr1:
  UserMessage(tool_result)，保留，因为必须和 a1.tool_use 配对。

att_mem_1:
  AttachmentMessage，转换成 isMeta=true 的 UserMessage，再和相邻 user 合并。
```

---

## 12. 一张总流程图

```text
用户输入 / 工具结果 / 附件 / compact / snip
        │
        ▼
state.messages: Message[]
        │
        │ getMessagesAfterCompactBoundary()
        ▼
messagesForQuery: Message[]
        │
        ├─ 删除 user.toolUseResult
        ├─ applyToolResultBudget()
        ├─ snipCompactIfNeeded()
        ├─ microcompact()
        ├─ contextCollapse()
        └─ autocompact()
              │
              └─ 可能替换为 buildPostCompactMessages()
        │
        ▼
deps.callModel({ messages: prependUserContext(messagesForQuery, userContext) })
        │
        ▼
queryModelWithStreaming()
        │
        │ normalizeMessagesForAPI()
        ▼
messagesForAPI: (UserMessage | AssistantMessage)[]
        │
        ├─ UserMessage 保留/合并
        ├─ AssistantMessage 保留/规范化 tool_use
        ├─ AttachmentMessage 转 isMeta=true 的 UserMessage
        ├─ SystemMessage 大多过滤
        └─ ProgressMessage 过滤
        │
        ▼
Anthropic / OpenAI / Gemini / Grok provider request
```

---

## 13. 阅读源码时的定位问题

看到一条 `messagesForQuery` 里的消息时，按这几个问题判断：

```text
1. msg.type 是什么？
   user / assistant / system / attachment / progress

2. 如果是 user，它是用户亲手输入、CLI 注入说明、summary，还是 tool_result？
   看 isMeta / isCompactSummary / message.content[0].type。

3. 如果是 assistant，它有没有 tool_use？
   有 tool_use 就必须在后面找到对应 tool_result。

4. 如果是 system，它是不是 boundary？
   compact_boundary 影响切片；snip_boundary 影响过滤；普通 informational 不进 API。

5. 如果是 attachment，它不会原样进 API。
   去看 normalizeAttachmentForAPI() 会把它转成什么 UserMessage。

6. 它是否还有 toolUseResult？
   有的话是内部/UI 字段，queryLoop 会删除；API 看 message.content。
```
