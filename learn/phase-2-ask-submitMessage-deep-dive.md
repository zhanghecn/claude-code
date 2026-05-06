# `ask()` -> `engine.submitMessage()` 深入拆解

> 面向刚开始读 Claude Code 源码的人。
>
> 目标不是“快速扫一眼”，而是把 `src/QueryEngine.ts` 里这条链路按执行顺序拆开，看清：
>
> 1. 外层调用者到底怎样进入 `ask()`
> 2. `ask()` 这个薄包装层具体做什么
> 3. `submitMessage()` 这么长，到底在管理哪些状态
> 4. 它什么时候才真正进入 `query()`
> 5. 内部 `Message` 和外部 `SDKMessage` 是怎样来回转换的
> 6. 一次普通对话 / 一次带工具调用的对话，内部状态怎样流转
>
> 配套源码位置：
>
> - `src/cli/print.ts:2145` 调用 `ask()`
> - `src/QueryEngine.ts:1211` `ask()`
> - `src/QueryEngine.ts:211` `QueryEngine.submitMessage()`
> - `src/query.ts:222` `query()`
> - `src/query.ts:281` `queryLoop()`
> - `src/utils/processUserInput/processUserInput.ts:85` `processUserInput()`
> - `src/utils/processUserInput/processTextPrompt.ts:19` `processTextPrompt()`
> - `src/utils/queryHelpers.ts:111` `normalizeMessage()`

---

## 1. 先建立总图

先不要一上来就陷进 1000 多行的 `submitMessage()`。先记住它在整个系统里的位置：

```text
src/cli/print.ts
  -> ask(...)
    -> new QueryEngine(...)
    -> engine.submitMessage(prompt, options)
      -> processUserInput(...)
      -> yield system/init
      -> query(...)
        -> queryLoop(...)
          -> deps.callModel(...)
          -> tool loop
      -> normalizeMessage(...)
      -> yield result
```

这条链路可以粗分成 4 层：

| 层 | 代表函数 | 主要职责 |
|---|---|---|
| 入口层 | `print.ts` 里的 `for await (const message of ask(...))` | 驱动一次 headless turn |
| 包装层 | `ask()` | 创建 `QueryEngine`，转发 `submitMessage()` 的输出 |
| turn 编排层 | `submitMessage()` | 管理“一次用户提交”的完整生命周期 |
| 模型循环层 | `query()` / `queryLoop()` | 真正和模型流式交互，执行工具，再续下一轮 |

一句话概括：

`ask()` 很薄，`submitMessage()` 很厚，`queryLoop()` 才是 agent 真正运转的循环核心。

---

## 2. 从入口开始：外面是谁调 `ask()`

在 `src/cli/print.ts:2145`，headless / print 模式会这样调用：

```ts
for await (const message of ask({
  commands: uniqBy([...currentCommands, ...appState.mcp.commands], 'name'),
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
  getReadFileCache,
  setReadFileCache,
  getAppState,
  setAppState,
  abortController,
  replayUserMessages: true,
  includePartialMessages: options.includePartialMessages,
  handleElicitation,
  agents: currentAgents,
  setSDKStatus,
  orphanedPermission,
})) {
  // 每来一条消息就立刻消费一条
}
```

这里有 3 个要点：

1. 调用方拿到的不是“最终字符串”，而是一个异步消息流。
2. 所以 `ask()` 必须是 `async function*`，因为它要边执行边 `yield`。
3. 调用方完全不用关心内部是 `processUserInput()`、`query()` 还是工具循环，它只关心“不断收到消息”。

这就是高层 API 封装的价值：

- 外层只需要消费流
- 内层负责把复杂状态机包装成统一的 `SDKMessage` 流

---

## 3. `ask()` 本身非常薄，但它很关键

源码位置：`src/QueryEngine.ts:1211`

先停一下。

如果你是第一次读这里，下面这些名字先要认出来，不然后面的对象字面量会很像“天书”：

| 名字 | 先把它理解成什么 |
|---|---|
| `cwd` | 当前项目目录 |
| `tools` | Claude 这轮能调用的工具列表 |
| `commands` | 斜杠命令列表，比如 `/help`、`/clear` 这种 |
| `mcpClients` | 已连接的 MCP 服务 |
| `agents` | 子 agent 的定义列表 |
| `canUseTool` | 一个“权限检查函数”，专门回答“这个工具现在能不能用” |
| `getAppState` | 读取当前全局状态的函数 |
| `setAppState` | 修改当前全局状态的函数 |
| `mutableMessages` | 当前这段会话已经积累下来的消息历史 |
| `readFileCache` | 读文件缓存，避免重复读同一个文件 |

还有两个后面会频繁出现的名字，也先认识一下：

| 名字 | 先把它理解成什么 |
|---|---|
| `processUserInput()` | 把“用户刚输入的原始内容”整理成系统内部消息 |
| `query()` | 真正开始和模型对话的那一层 |

下面再看代码，就会顺很多。

这段是按原逻辑缩写过的版本，重点保留关键语义。这里的行内注释只写“这是什么”，不提前塞太多后续概念：

```ts
export async function* ask({
  commands,
  prompt,
  promptUuid,
  isMeta,
  cwd,
  tools,
  mcpClients,
  verbose = false,
  thinkingConfig,
  maxTurns,
  maxBudgetUsd,
  taskBudget,
  canUseTool,
  mutableMessages = [],
  getReadFileCache,
  setReadFileCache,
  customSystemPrompt,
  appendSystemPrompt,
  userSpecifiedModel,
  fallbackModel,
  jsonSchema,
  getAppState,
  setAppState,
  abortController,
  replayUserMessages = false,
  includePartialMessages = false,
  handleElicitation,
  agents = [],
  setSDKStatus,
  orphanedPermission,
}: {
  // 省略类型定义
}): AsyncGenerator<SDKMessage, void, unknown> {
  const engine = new QueryEngine({
    cwd,                           // 当前项目目录
    tools,                         // 这轮可用的工具列表
    commands,                      // 斜杠命令列表
    mcpClients,                    // 已连接的 MCP 服务
    agents: agents ?? [],          // 子 agent 列表；没传就用空数组
    canUseTool,                    // 工具权限检查函数
    getAppState,                   // 读取全局状态
    setAppState,                   // 更新全局状态
    initialMessages: mutableMessages, // 之前已经积累的消息历史
    readFileCache: cloneFileStateCache(getReadFileCache()), // 这轮要用的读文件缓存副本
    customSystemPrompt,
    appendSystemPrompt,
    userSpecifiedModel,
    fallbackModel,
    thinkingConfig,
    maxTurns,
    maxBudgetUsd,
    taskBudget,
    jsonSchema,
    verbose,
    handleElicitation,
    replayUserMessages,
    includePartialMessages,
    setSDKStatus,
    abortController,
    orphanedPermission,
  })

  try {
    yield* engine.submitMessage(prompt, {
      uuid: promptUuid,            // 这条输入自己的 id
      isMeta,                      // 这条输入是不是隐藏给用户的系统消息
    })
  } finally {
    setReadFileCache(engine.getReadFileState()) // 把这轮更新后的读文件缓存写回去
  }
}
```

### 3.1 `ask()` 的真正职责

不要把 `ask()` 想复杂。它几乎只做 3 件事：

1. 根据调用方给的参数创建一个 `QueryEngine`
2. 用 `yield*` 把 `engine.submitMessage()` 的输出原样往外转发
3. 在 `finally` 里把这轮更新过的读文件缓存写回去

如果你现在还不认识 `QueryEngine`，也没关系。先把它当成：

- “一次对话提交的总调度器”

它会接住用户输入，然后继续往下调用 `submitMessage()`。

### 3.2 这里的 `yield*` 在做什么

`yield* engine.submitMessage(...)` 的语义是：

```ts
for await (const msg of engine.submitMessage(...)) {
  yield msg
}
```

这样写的意义是：

- `ask()` 不需要重新定义消息协议
- 它只作为“管道接头”
- 下层产出什么，上层就转发什么

### 3.3 `ask()` 新建 `QueryEngine` 的作用

这看起来容易误解：既然一个 conversation 理论上应该一个 `QueryEngine`，那 `ask()` 每次还 `new` 到底是在干什么？

这里的关键不在“对象实例是否复用”，而在“会话状态是否复用”。

复用主要靠这两个入口参数：

```ts
initialMessages: mutableMessages
readFileCache: cloneFileStateCache(getReadFileCache())
```

也就是说：

- 消息历史通过外部共享的 `mutableMessages` 继续传下去
- 文件读取缓存通过 getter/clone/finally-writeback 继续传下去

所以即使 `QueryEngine` 对象本身是新的，会话上下文仍然是延续的。

如果你只想先抓住最直白的一层，可以先这么记：

- `new QueryEngine({...})`
  就是在“把这轮执行要用到的材料打包交给一个总调度器”

---

## 4. 先看 `QueryEngine` 这个类持有哪些状态

源码位置：`src/QueryEngine.ts:186`

```ts
export class QueryEngine {
  private config: QueryEngineConfig
  private mutableMessages: Message[]
  private abortController: AbortController
  private permissionDenials: SDKPermissionDenial[]
  private totalUsage: NonNullableUsage
  private hasHandledOrphanedPermission = false
  private readFileState: FileStateCache
  private discoveredSkillNames = new Set<string>()
  private loadedNestedMemoryPaths = new Set<string>()
}
```

这些字段不要死记，先分组理解：

| 字段 | 含义 | 作用 |
|---|---|---|
| `config` | 构造时注入的静态/半静态配置 | 避免 `submitMessage()` 传参过长，也避免 turn 内层层透传 |
| `mutableMessages` | 当前 conversation 的累积消息历史 | 下一次 turn 要接着上一次 history 继续问模型 |
| `abortController` | 本次会话/当前 turn 的中断信号 | 流式模型请求和工具执行都要响应 abort |
| `permissionDenials` | 权限拒绝记录 | 最终 `result` 要回报这轮有哪些工具被拒绝 |
| `totalUsage` | 整个 `submitMessage()` 过程累计的 token usage | 最终结果消息要给 SDK/UI 消费 |
| `readFileState` | 读文件缓存 | 防止重复读大文件、支撑 memory/filter 逻辑 |
| `discoveredSkillNames` | 本 turn 动态发现过的 skill | 避免重复发现、用于统计 |
| `loadedNestedMemoryPaths` | 已加载过的 memory 路径 | 避免同一路径反复附加 |

构造函数本身很简单：

```ts
constructor(config: QueryEngineConfig) {
  this.config = config
  this.mutableMessages = config.initialMessages ?? []
  this.abortController = config.abortController ?? createAbortController()
  this.permissionDenials = []
  this.readFileState = config.readFileCache
  this.totalUsage = EMPTY_USAGE
}
```

每行关键点：

- `this.mutableMessages = config.initialMessages ?? []`
  作用：如果是恢复会话或多轮会话，就接着已有历史；如果没有，就从空历史开始。

- `this.abortController = config.abortController ?? createAbortController()`
  作用：允许外部统一控制一次长流程的中断；没传就自己创建。

- `this.permissionDenials = []`
  作用：每个 `QueryEngine` 生命周期里自己维护一份权限拒绝记录。

- `this.totalUsage = EMPTY_USAGE`
  作用：后面可以直接用 `accumulateUsage()` 累加，不需要先判空。

---

## 5. `submitMessage()` 的整体骨架

源码位置：`src/QueryEngine.ts:211`

先看骨架，再一段段展开：

```ts
async *submitMessage(prompt, options) {
  // 1. 解构 config，准备本 turn 需要的运行参数
  // 2. 包装 canUseTool，顺便记录权限拒绝
  // 3. 决定模型 / thinking / system prompt
  // 4. 构建 processUserInputContext
  // 5. processUserInput(prompt) -> 产出内部 messages
  // 6. 把用户输入写入 mutableMessages / transcript
  // 7. yield system/init
  // 8. 如果 shouldQuery === false，直接本地返回 result
  // 9. 否则进入 for await (const message of query(...))
  // 10. 消费 query() 的内部消息流，转成 SDKMessage
  // 11. 汇总 usage / stop_reason / 最终文本
  // 12. yield result
}
```

理解这 12 步，你就理解了 `submitMessage()` 的 90%。

---

## 6. `submitMessage()` 第一段：解构配置并初始化 turn

源码位置：`src/QueryEngine.ts:215-244`

```ts
const {
  cwd,
  commands,
  tools,
  mcpClients,
  verbose = false,
  thinkingConfig,
  maxTurns,
  maxBudgetUsd,
  taskBudget,
  canUseTool,
  customSystemPrompt,
  appendSystemPrompt,
  userSpecifiedModel,
  fallbackModel,
  jsonSchema,
  getAppState,
  setAppState,
  replayUserMessages = false,
  includePartialMessages = false,
  agents = [],
  setSDKStatus,
  orphanedPermission,
} = this.config

this.discoveredSkillNames.clear()
setCwd(cwd)
const persistSession = !isSessionPersistenceDisabled()
const startTime = Date.now()
```

每行关键逻辑说明：

- 解构 `this.config`
  作用：把本轮要用的配置先拉平，后面代码更短，也更清楚“这一轮实际用了哪些配置”。

- `this.discoveredSkillNames.clear()`
  作用：清掉上一个 turn 的技能发现记录，避免污染本轮。

- `setCwd(cwd)`
  作用：统一本轮工作目录，后面的路径解析、工具执行、附件搜索都依赖它。

- `persistSession = !isSessionPersistenceDisabled()`
  作用：后面很多地方都要判断是否写 transcript，先变成局部布尔值更集中。

- `startTime = Date.now()`
  作用：统计整个 turn 的总耗时，不只是模型 API 耗时。

---

## 7. `submitMessage()` 第二段：包装 `canUseTool`

源码位置：`src/QueryEngine.ts:245-274`

```ts
const wrappedCanUseTool: CanUseToolFn = async (
  tool,
  input,
  toolUseContext,
  assistantMessage,
  toolUseID,
  forceDecision,
) => {
  const result = await canUseTool(
    tool,
    input,
    toolUseContext,
    assistantMessage,
    toolUseID,
    forceDecision,
  )

  if (result.behavior !== 'allow') {
    this.permissionDenials.push({
      type: 'permission_denial',
      tool_name: sdkCompatToolName(tool.name),
      tool_use_id: toolUseID,
      tool_input: input,
    })
  }

  return result
}
```

这段很经典，属于“装饰器式包装”：

- 真正的权限判断，仍然交给外部传入的 `canUseTool`
- `submitMessage()` 只是顺手把被拒绝的工具调用记下来

这层包装和原始 `canUseTool` 的职责划分是：

1. `canUseTool` 的职责应该是“决策”，不是“结果汇总”
2. `QueryEngine` 才知道最终的 SDK `result` 需要什么格式的权限拒绝信息
3. 这样不会污染底层权限判断逻辑

换句话说：

- `canUseTool` 负责回答“能不能用”
- `wrappedCanUseTool` 负责回答“如果不能用，我要怎样把这件事记账并上报”

---

## 8. `submitMessage()` 第三段：确定模型、thinking、system prompt

源码位置：`src/QueryEngine.ts:276-328`

### 8.1 先决定主模型

```ts
const initialAppState = getAppState()
const initialMainLoopModel = userSpecifiedModel
  ? parseUserSpecifiedModel(userSpecifiedModel)
  : getMainLoopModel()
```

这一步在做：

- `getAppState()` 要尽早取一次快照，因为本轮很多逻辑都要基于“turn 开始时”的全局状态
- 用户显式指定模型时，优先尊重用户
- 否则走系统默认模型选择逻辑

这里是“先决策一个起始模型”，后面仍可能因为 slash command 或 fallback 改变。

### 8.2 再决定 thinking 配置

```ts
const initialThinkingConfig: ThinkingConfig = thinkingConfig
  ? thinkingConfig
  : shouldEnableThinkingByDefault() !== false
    ? { type: 'adaptive' }
    : { type: 'disabled' }
```

这段三级分支的作用：

1. 如果外部明确传了 thinkingConfig，就不要替用户再猜
2. 如果没传，再走默认策略
3. 默认策略是开 `adaptive` 还是关掉，由全局设置决定

### 8.3 拉系统提示的组成部分

```ts
const {
  defaultSystemPrompt,
  userContext: baseUserContext,
  systemContext,
} = await fetchSystemPromptParts({
  tools,
  mainLoopModel: initialMainLoopModel,
  additionalWorkingDirectories: Array.from(
    initialAppState.toolPermissionContext.additionalWorkingDirectories.keys(),
  ),
  mcpClients,
  customSystemPrompt: customPrompt,
})
```

这次单独调 `fetchSystemPromptParts()`，是在做：

- 系统提示不是一个纯字符串，而是多块拼出来的
- 其中有些部分依赖当前模型、工具列表、MCP 状态、附加工作目录
- 单独封成函数，可以把“怎么拼上下文”从 `submitMessage()` 主流程里剥出去

### 8.4 补 coordinator / memory prompt / append prompt

```ts
const userContext = {
  ...baseUserContext,
  ...getCoordinatorUserContext(...),
}

const memoryMechanicsPrompt =
  customPrompt !== undefined && hasAutoMemPathOverride()
    ? await loadMemoryPrompt()
    : null

const systemPrompt = asSystemPrompt([
  ...(customPrompt !== undefined ? [customPrompt] : defaultSystemPrompt),
  ...(memoryMechanicsPrompt ? [memoryMechanicsPrompt] : []),
  ...(appendSystemPrompt ? [appendSystemPrompt] : []),
])
```

这一段在组装：

- `baseUserContext` 是基础用户上下文
- coordinator 模式有额外上下文，要叠加进去
- `memoryMechanicsPrompt` 只有在“外部显式接管 custom prompt 且启用了 memory path override”时才注入，因为这时 Claude 需要知道 memory 目录怎样用
- `appendSystemPrompt` 放最后，是因为它语义上就是“追加补丁”

顺序也有意义：

1. 基础系统提示
2. memory 使用机制补充
3. 最后再追加用户/调用方自定义补充

---

## 9. `submitMessage()` 第四段：构建第一版 `processUserInputContext`

源码位置：`src/QueryEngine.ts:338-398`

这一段很长，但本质上是在做一件事：

“先构造一份足够完整的上下文对象，好让 `processUserInput()` 能正确处理输入。”

最值得看的不是每个字段名，而是这份“第一版 context”覆盖了哪些输入阶段能力。

关键代码：

```ts
let processUserInputContext: ProcessUserInputContext = {
  messages: this.mutableMessages,
  setMessages: fn => {
    this.mutableMessages = fn(this.mutableMessages)
  },
  handleElicitation: this.config.handleElicitation,
  options: {
    commands,
    debug: false,
    tools,
    verbose,
    mainLoopModel: initialMainLoopModel,
    thinkingConfig: initialThinkingConfig,
    mcpClients,
    mcpResources: {},
    ideInstallationStatus: null,
    isNonInteractiveSession: true,
    customSystemPrompt,
    appendSystemPrompt,
    agentDefinitions: { activeAgents: agents, allAgents: [] },
    theme: resolveThemeSetting(getGlobalConfig().theme),
    maxBudgetUsd,
  },
  getAppState,
  setAppState,
  abortController: this.abortController,
  readFileState: this.readFileState,
  nestedMemoryAttachmentTriggers: new Set<string>(),
  loadedNestedMemoryPaths: this.loadedNestedMemoryPaths,
  dynamicSkillDirTriggers: new Set<string>(),
  discoveredSkillNames: this.discoveredSkillNames,
  setInProgressToolUseIDs: () => {},
  setResponseLength: () => {},
  updateFileHistoryState: ...,
  updateAttributionState: ...,
  setSDKStatus,
}
```

这份 context 里几组关键字段的用途：

| 字段组 | 用途 |
|---|---|
| `messages` / `setMessages` | slash command 有可能直接改消息数组 |
| `options.commands` | 输入以 `/` 开头时要解析命令 |
| `options.tools` | 附件解析、技能发现、某些输入处理依赖工具信息 |
| `mainLoopModel` / `thinkingConfig` | 输入阶段就可能决定后面模型行为 |
| `getAppState` / `setAppState` | 输入处理过程中可能更新权限、文件历史等全局状态 |
| `abortController` | 某些异步输入处理也要响应中断 |
| `readFileState` | 处理附件 / memory 时要去重 |
| `discoveredSkillNames` 等集合 | 输入阶段的技能发现和 memory 加载要有去重集合 |

这里所谓“第一版”，意思是：

因为此时：

- 用户输入还没真正处理完
- slash command 可能会修改消息、模型、allowedTools

所以等 `processUserInput()` 跑完以后，`submitMessage()` 还会重建一版 context。

---

## 10. `submitMessage()` 第五段：处理 orphaned permission

源码位置：`src/QueryEngine.ts:400-411`

```ts
if (orphanedPermission && !this.hasHandledOrphanedPermission) {
  this.hasHandledOrphanedPermission = true
  for await (const message of handleOrphanedPermission(
    orphanedPermission,
    tools,
    this.mutableMessages,
    processUserInputContext,
  )) {
    yield message
  }
}
```

它放在输入处理前面的作用：

- orphaned permission 是一种“之前遗留、现在需要补处理”的权限状态
- 它本质上也是 turn 开始时的前置修复动作
- 必须在新用户输入正式进入 query 前先清掉

`hasHandledOrphanedPermission` 的作用：

- 这是 engine 生命周期里的一次性补偿
- 不能每次 `submitMessage()` 都重复处理同一个遗留权限

---

## 11. `submitMessage()` 第六段：`processUserInput()` 把原始输入转成内部消息

源码位置：`src/QueryEngine.ts:413-431`

```ts
const {
  messages: messagesFromUserInput,
  shouldQuery,
  allowedTools,
  model: modelFromUserInput,
  resultText,
} = await processUserInput({
  input: prompt,
  mode: 'prompt',
  setToolJSX: () => {},
  context: {
    ...processUserInputContext,
    messages: this.mutableMessages,
  },
  messages: this.mutableMessages,
  uuid: options?.uuid,
  isMeta: options?.isMeta,
  querySource: 'sdk',
})
```

这一步要彻底理解，因为很多初学者会以为 `prompt` 会直接丢给模型。实际不是。

### 11.1 `processUserInput()` 到底解决什么问题

它负责把“用户输入原始形态”整理成“系统内部消息形态”。

原始输入可能是：

- 普通文本字符串
- 一组 content blocks
- slash command
- 带图片粘贴
- 带附件
- `isMeta` 系统消息

这几种输入不能统一直接进模型，所以必须先标准化。

### 11.2 普通文本最后怎么落地

普通文本最终会走到 `processTextPrompt()`，源码在 `src/utils/processUserInput/processTextPrompt.ts:19`：

```ts
const userMessage = createUserMessage({
  content: input,
  uuid,
  permissionMode,
  isMeta: isMeta || undefined,
})

return {
  messages: [userMessage, ...attachmentMessages],
  shouldQuery: true,
}
```

这里返回的是 `messages[]`，不是单个 `message`：

- 因为一条用户输入可能伴随若干 attachment message
- 输入阶段就可能生成多条内部消息

### 11.3 `shouldQuery` 的作用

`processUserInput()` 不只是“转消息”，还负责判断：

- 这次输入需不需要真正问模型？

比如：

- 本地 slash command 可能直接执行
- 某些 remote bridge 场景可能只需要本地返回结果

所以 `submitMessage()` 后面会有一条很重要的快速路径：

```ts
if (!shouldQuery) {
  // 不走 query()，直接返回本地结果
}
```

---

## 12. `submitMessage()` 第七段：把用户输入正式写进会话历史

源码位置：`src/QueryEngine.ts:433-438`

```ts
this.mutableMessages.push(...messagesFromUserInput)
const messages = [...this.mutableMessages]
```

这两行很短，但很关键。

### 12.1 先写 `mutableMessages`

因为 `mutableMessages` 是本会话的“长期历史”。

如果这次用户输入不先写进去：

- 后面 transcript 不完整
- 后面 `query()` 看到的历史也不完整
- 下一轮 turn 更会断上下文

### 12.2 再复制出一个 `messages`

因为这里开始分成两层状态：

| 变量 | 作用 |
|---|---|
| `this.mutableMessages` | 引擎内部持续演化的会话历史 |
| `messages` | 本轮提交时的局部快照，后面会用于 transcript、query、结果提取 |

把两层数组分开用的目的：

- 局部快照更适合本轮运算
- 后面 `query()` 里还会产生新的 message stream，局部数组更方便做 turn 级推导

---

## 13. `submitMessage()` 第八段：先把用户消息写进 transcript

源码位置：`src/QueryEngine.ts:439-466`

```ts
if (persistSession && messagesFromUserInput.length > 0) {
  const transcriptPromise = recordTranscript(messages)
  if (isBareMode()) {
    void transcriptPromise
  } else {
    await transcriptPromise
    if (isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
        isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)) {
      await flushSessionStorage()
    }
  }
}
```

这段注释在源码里已经写得很重了，因为它解决的是“用户刚发出去的消息，如果模型还没回，进程就死了怎么办”。

这一步主要避免：

如果不先写，会出现这种情况：

1. 用户消息已经被接受
2. 还没拿到模型响应
3. 进程被 kill
4. transcript 里只有队列记录，没有真正的用户消息
5. `--resume` 时找不到可恢复对话

所以这里的设计原则是：

- 先把“用户消息已被接受”这个事实 durable 化
- 模型后续有没有回应，是下一阶段的事

bare mode 的处理方式：

- 脚本模式通常不依赖中途 kill 后再 resume
- 这里可以换一点延迟收益

---

## 14. `submitMessage()` 第九段：处理 replay / ack / allowed tools / 重建 context

源码位置：`src/QueryEngine.ts:468-530`

这一段不是最难，但很容易在阅读时跳过去。其实它在做“输入处理后的收尾同步”。

### 14.1 选出哪些消息后面需要 replay ack

```ts
const replayableMessages = messagesFromUserInput.filter(...)
const messagesToAck = replayUserMessages ? replayableMessages : []
```

单独筛一遍的作用：

- 不是所有输入阶段生成的消息都适合回放给 SDK/UI
- 某些 synthetic message、tool result、不可选中消息不该当成“用户原始输入回放”

### 14.2 更新 alwaysAllowRules

```ts
setAppState(prev => ({
  ...prev,
  toolPermissionContext: {
    ...prev.toolPermissionContext,
    alwaysAllowRules: {
      ...prev.toolPermissionContext.alwaysAllowRules,
      command: allowedTools,
    },
  },
}))
```

这一段放在 `processUserInput()` 之后，是因为：

- 因为 `allowedTools` 正是输入阶段解析 slash command 时才知道的
- 比如某些命令可能会修改“这一轮允许哪些工具免审批”

### 14.3 允许输入阶段改模型

```ts
const mainLoopModel = modelFromUserInput ?? initialMainLoopModel
```

这里允许输入阶段改模型：

- slash command 或某些输入变体可能显式指定本轮模型
- 所以不能死守 turn 开始时的 `initialMainLoopModel`

### 14.4 重建第二版 `processUserInputContext`

```ts
processUserInputContext = {
  messages,
  setMessages: () => {},
  ...
  options: {
    ...
    mainLoopModel,
    ...
  },
  ...
}
```

这一步非常关键。

重建后的变化点：

1. `messages` 已经变了，用户输入现在已经正式进历史
2. 模型可能变了
3. 第一版 context 的 `setMessages` 只服务于输入处理阶段，后面不再需要可变写回

所以这里是在说：

“前面那份 context 是给 `processUserInput()` 用的；现在输入处理结束了，我要为后面的 query 阶段生成一份新的、状态一致的上下文。”

---

## 15. `submitMessage()` 第十段：加载技能/插件并先 `yield system/init`

源码位置：`src/QueryEngine.ts:532-557`

```ts
const [skills, { enabled: enabledPlugins }] = await Promise.all([
  getSlashCommandToolSkills(getCwd()),
  loadAllPluginsCacheOnly(),
])

yield buildSystemInitMessage({
  tools,
  mcpClients,
  model: mainLoopModel,
  permissionMode: initialAppState.toolPermissionContext.mode as PermissionMode,
  commands,
  agents,
  skills,
  plugins: enabledPlugins,
  fastMode: initialAppState.fastMode,
})
```

先 `yield` 一个 `system/init` 的作用：

- SDK / print / remote clients 需要先知道这轮会话的元信息
- 包括模型、工具、命令、插件、session_id、权限模式
- 这样 UI 可以在真正 assistant 内容到来前先把外层壳子搭起来

技能和插件在这里加载，是因为：

- `system/init` 里要带它们的信息
- 这比在更深层的 `query()` 里再临时收集更合理，因为它们属于“本轮环境元数据”

---

## 16. `submitMessage()` 第十一段：`shouldQuery === false` 的快速路径

源码位置：`src/QueryEngine.ts:559-643`

```ts
if (!shouldQuery) {
  // 1. 把本地命令输出转成 SDKMessage
  // 2. 记录 transcript
  // 3. yield 一个最终 result
  return
}
```

这条分支的作用：

- `submitMessage()` 是“一次 turn 的总编排器”，不是“模型请求函数”
- 输入阶段就可能知道“这次不需要问模型”

典型场景：

- 本地 slash command
- 某些仅本地回显的命令输出
- 某些 compact boundary 类控制消息

这条分支的意义是：

- 少走一整层 query 模型循环
- 但对外仍然保持统一的消息协议

也就是说，即使根本没打 API，外部仍然会收到：

1. `system/init`
2. 若干本地输出消息
3. `result`

协议是一致的，这样调用方好处理。

---

## 17. `submitMessage()` 第十二段：进入真正的 `query()` 循环

源码位置：`src/QueryEngine.ts:679-690`

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
  ...
}
```

这一句就是整条链路最重要的分水岭：

- 这之前都还是 turn 准备阶段
- 从这句开始，才正式进入模型循环

这里传的是 `messages`，表示：

- `query()` 需要的是“当前 turn 的一份消息视图”
- 让 `query()` 直接拿可变全局数组，边界会更混乱

这里传 `wrappedCanUseTool`，表示：

- 因为从现在开始，任何工具执行都可能触发权限判断
- 这时候就要顺便把拒绝记录进 `permissionDenials`

---

## 18. `query()` 本身只是一个薄包装

源码位置：`src/query.ts:222`

```ts
export async function* query(params) {
  const consumedCommandUuids: string[] = []
  const langfuseTrace = ...

  let terminal: Terminal | undefined
  try {
    terminal = yield* queryLoop(paramsWithTrace, consumedCommandUuids)
  } finally {
    if (ownsTrace) {
      endTrace(...)
    }
  }

  for (const uuid of consumedCommandUuids) {
    notifyCommandLifecycle(uuid, 'completed')
  }
  return terminal!
}
```

它的职责比较薄：

- 它主要负责 trace 生命周期和命令生命周期收尾
- 真正的 while(true) 模型/工具循环，在 `queryLoop()`

所以阅读重点还是要落在 `queryLoop()`。

---

## 19. `queryLoop()` 是怎么接住 `submitMessage()` 传进来的状态的

源码位置：`src/query.ts:281`

`queryLoop()` 一上来会把参数拆成两类：

1. 不太会变的“本轮配置”
2. 会在 while(true) 迭代间不断变化的“循环状态”

关键代码：

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
```

`state` 对象的用途：

- `queryLoop()` 有很多 `continue` 分支
- 如果把状态分散成 9 个局部变量，每个 continue 点都要手工维护，非常容易漏
- 用一个 `State` 对象，就可以在每次 continue 时整体构造“下一轮状态”

这也是这个文件最重要的设计模式之一：

- while(true)
- 每次根据当前结果构造一个新的 `state`
- 用 `continue` 进入下一轮

---

## 20. 真正的模型调用发生在 `deps.callModel(...)`

源码位置：`src/query.ts:699`

```ts
for await (const message of deps.callModel({
  messages: prependUserContext(messagesForQuery, userContext),
  systemPrompt: fullSystemPrompt,
  thinkingConfig: toolUseContext.options.thinkingConfig,
  tools: toolUseContext.options.tools,
  signal: toolUseContext.abortController.signal,
  options: {
    model: currentModel,
    fallbackModel,
    querySource,
    ...
  },
})) {
  ...
}
```

这就是“真正打模型 API”的那一层。

这里先走 `deps.callModel` 这一层，是因为：

- `queryLoop()` 依赖的是抽象依赖 `deps.callModel`
- 默认实现由 `productionDeps()` 提供
- 这样测试时可以替换依赖，不必真的打 API

`prependUserContext(messagesForQuery, userContext)` 的作用：

- 模型真正看到的消息不是单纯历史数组
- 还要把 user context 注入进去

`signal` 的作用：

- 如果用户中断，本轮 streaming 和工具执行都应该尽快停下来

---

## 21. `queryLoop()` 怎样判断本轮是否要继续下一轮

当模型流式返回 assistant 消息时，`queryLoop()` 会边收边看有没有 `tool_use`。

关键代码在 `src/query.ts:869-888`：

```ts
if (message.type === 'assistant') {
  const assistantMessage = message as AssistantMessage
  assistantMessages.push(assistantMessage)

  const msgToolUseBlocks = ...filter(content => content.type === 'tool_use')
  if (msgToolUseBlocks.length > 0) {
    toolUseBlocks.push(...msgToolUseBlocks)
    needsFollowUp = true
  }

  if (streamingToolExecutor && !toolUseContext.abortController.signal.aborted) {
    for (const toolBlock of msgToolUseBlocks) {
      streamingToolExecutor.addTool(toolBlock, assistantMessage)
    }
  }
}
```

`needsFollowUp` 的作用：

- 这不是看 `stop_reason === 'tool_use'`
- 注释里明确写了：`stop_reason === 'tool_use'` 不可靠
- 所以更稳妥的做法是直接扫描 assistant 内容块里有没有 `tool_use`

`assistantMessages` 数组的作用：

- 后面执行工具时，工具结果要知道自己对应的是哪条 assistant tool_use
- 如果后续出错，还可能需要补发 synthetic tool_result 防止链断掉

---

## 22. 如果模型没有工具调用，`queryLoop()` 怎样结束

源码位置：`src/query.ts:1106-1401`

在最核心的判断里：

```ts
if (!needsFollowUp) {
  const lastMessage = assistantMessages.at(-1)

  // 先处理可恢复错误：prompt too long / media / max_output_tokens
  // 再处理 stop hooks
  // 再处理 token budget

  return { reason: 'completed' }
}
```

这里不会在 assistant 一出来就直接返回：

- 因为最后一条 assistant 可能其实是一个“暂扣的可恢复错误”
- 也可能还要经过 stop hook 检查
- 也可能触发 token budget continuation

所以“没有 tool_use”只代表“这轮不需要跑工具”，不代表“整个 queryLoop 立刻成功结束”。

---

## 23. 如果模型有工具调用，`queryLoop()` 怎么执行工具并续下一轮

源码位置：`src/query.ts:1407-1771`

核心结构是：

```ts
const toolUpdates = streamingToolExecutor
  ? streamingToolExecutor.getRemainingResults()
  : runTools(toolUseBlocks, assistantMessages, canUseTool, toolUseContext)

for await (const update of toolUpdates) {
  if (update.message) {
    yield update.message
    toolResults.push(
      ...normalizeMessagesForAPI([update.message], toolUseContext.options.tools)
        .filter(_ => _.type === 'user'),
    )
  }
  if (update.newContext) {
    updatedToolUseContext = {
      ...update.newContext,
      queryTracking,
    }
  }
}

state = {
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
continue
```

这里的状态拼接顺序表示：

```ts
[...messagesForQuery, ...assistantMessages, ...toolResults]
```

因为下一轮模型必须看到完整因果链：

1. 之前的上下文 `messagesForQuery`
2. 这一轮 assistant 发出的工具请求 `assistantMessages`
3. 工具执行后的结果 `toolResults`

如果少了中间任何一段，下一轮模型都无法理解“这些 tool_result 是谁请求出来的”。

---

## 24. 回到 `submitMessage()`：它是怎样消费 `query()` 返回的内部消息的

源码位置：`src/QueryEngine.ts:691-1074`

可以把这一大段看成：

“把 `query()` 的内部消息，转成 SDK 层能理解的消息，并顺便维护会话历史和统计。”

最重要的几种 message type 如下。

### 24.1 `assistant`

```ts
case 'assistant': {
  const msg = message as Message
  const stopReason = msg.message?.stop_reason as string | null | undefined
  if (stopReason != null) {
    lastStopReason = stopReason
  }
  this.mutableMessages.push(msg)
  yield* normalizeMessage(msg)
  break
}
```

这里先 `push` 再 `yield`：

- `mutableMessages` 是会话真历史，必须先更新
- 这样即使后面外层消费逻辑出问题，内部状态也先是一致的

`lastStopReason` 在这里的用途：

- 最后的 `result.stop_reason` 要靠它
- 流式消息里 stop reason 有时晚于 assistant block 本体到达

### 24.2 `progress`

```ts
case 'progress': {
  const msg = message as Message
  this.mutableMessages.push(msg)
  if (persistSession) {
    messages.push(msg)
    void recordTranscript(messages)
  }
  yield* normalizeMessage(msg)
  break
}
```

progress 也要写进历史，作用是：

- 注释里说得很清楚：否则下次 `ask()` 做 dedup 时会因为缺这段中间进度消息而把链对错
- 这不只是“UI 展示”，还影响 resume 和去重逻辑

### 24.3 `user`

```ts
case 'user': {
  const msg = message as Message
  this.mutableMessages.push(msg)
  yield* normalizeMessage(msg)
  break
}
```

这里的 `user` 很多时候不是“人真的又发了一句话”，而是工具结果消息。

工具结果继续使用 user message，是因为协议本身就是这样：

- Claude 的工具调用协议里，tool_result 本来就作为 user role 回传给模型
- 所以下一轮模型继续推理时，看到的是 `user(tool_result)` 而不是一个特殊自定义 role

### 24.4 `stream_event`

```ts
case 'stream_event': {
  if (event.type === 'message_start') {
    currentMessageUsage = EMPTY_USAGE
    currentMessageUsage = updateUsage(currentMessageUsage, event.message.usage)
  }
  if (event.type === 'message_delta') {
    currentMessageUsage = updateUsage(currentMessageUsage, event.usage)
    if (delta.stop_reason != null) {
      lastStopReason = delta.stop_reason
    }
  }
  if (event.type === 'message_stop') {
    this.totalUsage = accumulateUsage(this.totalUsage, currentMessageUsage)
  }
  if (includePartialMessages) {
    yield { type: 'stream_event', ... }
  }
  break
}
```

usage 统计放在这里，是因为：

- usage 是随着流式事件增量到达的
- 不是等整个 assistant message 完成后一次性拿到完整值

`lastStopReason` 也在 `message_delta` 更新，因为：

- 有些 stop reason 是在 delta 阶段才真正到达
- 不能只看 assistant 消息本体

### 24.5 `attachment`

这类消息用来承载一些“不是普通 assistant/user 文本”的信号。

最重要的几个 attachment type：

- `structured_output`
- `max_turns_reached`
- `queued_command`

其中 `max_turns_reached` 会直接被转成一个最终错误结果：

```ts
yield {
  type: 'result',
  subtype: 'error_max_turns',
  ...
}
return
```

attachment 能直接触发最终 return，表示：

- 因为这类 attachment 本身就是 query 层发出的终止信号
- `submitMessage()` 只负责把它翻译成对外结果协议

### 24.6 `system`

这里最重要的是 `compact_boundary`。

```ts
if (msg.subtype === 'compact_boundary' && msg.compactMetadata) {
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
    subtype: 'compact_boundary',
    ...
  }
}
```

compact boundary 到来时裁掉旧消息，作用是：

- 这是 headless/SDK 模式，没有 UI 滚动历史的需求
- 继续保留所有 pre-compact 消息只会导致内存不断膨胀
- boundary 之后，后续 query 已经只需要紧凑后的历史

所以这里其实是在做一种“消息 GC”。

---

## 25. `normalizeMessage()` 的作用

源码位置：`src/utils/queryHelpers.ts:111`

最核心的直觉是：

内部 `Message` 不等于外部 `SDKMessage`。

`normalizeMessage()` 负责把内部消息翻译成外部流。

再往下看 `normalizeMessages()`，在 `src/utils/messages.ts:745`，你会发现它会把多 block 消息拆开。

例如一条内部 assistant 消息可能长这样：

```ts
{
  type: 'assistant',
  message: {
    content: [
      { type: 'text', text: '我先读取文件' },
      { type: 'tool_use', id: 'toolu_1', name: 'ReadFile', input: {...} }
    ]
  }
}
```

`normalizeMessages()` 会把它拆成两条归一化消息，这样外部 UI/SDK 更容易按块流式消费。

这里不一开始就只用“单 block 消息”，主要因为：

- 内部 message 结构要兼容模型 API 语义
- 模型返回的一条 assistant 天然可能带多个 content block
- 对外层消费友好，是另一个层面的需求

所以这里必须有一层“内部协议 -> 外部协议”的适配。

---

## 26. `submitMessage()` 最后一段：怎样产出最终 `result`

源码位置：`src/QueryEngine.ts:1076-1180`

### 26.1 先找这轮最后一条核心消息

```ts
const result = messages.findLast(
  m => m.type === 'assistant' || m.type === 'user',
)
```

这里只看 assistant/user：

- progress、attachment、system 不是“最终答复主体”
- 最终结果一定是由 assistant 或 tool_result user 消息体现

### 26.2 再判断是否算成功

```ts
if (!isResultSuccessful(result, lastStopReason)) {
  yield {
    type: 'result',
    subtype: 'error_during_execution',
    ...
  }
  return
}
```

`isResultSuccessful()` 在 `src/utils/queryHelpers.ts:64`。

这里不是只做“最后一条是不是 assistant text”的简单判断，而是：

- 有些合法结束态是 user tool_result
- 有些合法结束态是 `stop_reason === 'end_turn'` 但零内容

所以这里要做更细的判定。

### 26.3 提取文本结果

```ts
let textResult = ''
let isApiError = false

if (result.type === 'assistant') {
  const lastContent = last(result.message!.content)
  if (lastContent?.type === 'text' &&
      !SYNTHETIC_MESSAGES.has(lastContent.text)) {
    textResult = lastContent.text
  }
  isApiError = Boolean(result.isApiErrorMessage)
}
```

这里只提取最后一个 text block：

- `result.result` 这个字段是给外部“取最终可读文本”的
- 对普通问答来说，最有代表性的是最后一个文本块

排除 `SYNTHETIC_MESSAGES`：

- 有些文本只是系统注入的占位/恢复/控制性消息
- 不应该被当成真正的业务输出

### 26.4 最终统一 `yield result`

```ts
yield {
  type: 'result',
  subtype: 'success',
  is_error: isApiError,
  duration_ms: Date.now() - startTime,
  duration_api_ms: getTotalAPIDuration(),
  num_turns: turnCount,
  result: textResult,
  stop_reason: lastStopReason,
  session_id: getSessionId(),
  total_cost_usd: getTotalCost(),
  usage: this.totalUsage,
  modelUsage: getModelUsage(),
  permission_denials: this.permissionDenials,
  structured_output: structuredOutputFromTool,
  fast_mode_state: getFastModeState(...),
  uuid: randomUUID(),
}
```

最终统一汇聚成一条 `result`，作用是：

- 外部调用方需要一个明确的“终局信号”
- 不能靠“流停止了”去猜测是否完成、是否报错

所以协议上明确约定：

- 中间是流式消息
- 最后一条是 `type: 'result'`

---

## 27. 内部状态怎么流：一次“无工具”场景

假设输入：

```text
你好，介绍一下你自己
```

### 27.1 入口状态

```ts
mutableMessages = []
readFileCache = {}
permissionDenials = []
totalUsage = EMPTY_USAGE
```

### 27.2 `processUserInput()` 后

```ts
messagesFromUserInput = [
  user("你好，介绍一下你自己")
]
shouldQuery = true
```

### 27.3 写入会话历史

```ts
this.mutableMessages = [
  user("你好，介绍一下你自己")
]

messages = [
  user("你好，介绍一下你自己")
]
```

### 27.4 进入 `query()`

`queryLoop()` 发模型请求，模型返回一条普通 assistant 文本，没有 `tool_use`：

```ts
assistantMessages = [
  assistant("你好，我是 ...")
]
needsFollowUp = false
```

### 27.5 `submitMessage()` 消费流

收到 assistant 后：

```ts
this.mutableMessages = [
  user("你好，介绍一下你自己"),
  assistant("你好，我是 ...")
]
```

然后：

- `yield assistant`
- 统计 usage
- 最后 `yield result`

### 27.6 外部看到的消息顺序

```text
system/init
assistant
result
```

---

## 28. 内部状态怎么流：一次“有工具”场景

假设输入：

```text
读取 README.md 的前 20 行，并总结一下
```

### 28.1 输入阶段

```ts
messagesFromUserInput = [
  user("读取 README.md 的前 20 行，并总结一下")
]
```

### 28.2 第一轮模型响应

模型先不直接回答，而是发 tool_use：

```ts
assistantMessages = [
  assistant([
    text("我先读取 README.md"),
    tool_use({
      id: "toolu_1",
      name: "ReadFile",
      input: { file_path: "README.md", limit: 20 }
    })
  ])
]

toolUseBlocks = [
  { id: "toolu_1", name: "ReadFile", input: ... }
]

needsFollowUp = true
```

### 28.3 工具执行

```ts
toolResults = [
  user([
    tool_result({
      tool_use_id: "toolu_1",
      content: "README 的前 20 行..."
    })
  ])
]
```

### 28.4 拼成下一轮状态

```ts
state.messages = [
  user("读取 README.md 的前 20 行，并总结一下"),
  assistant(tool_use ...),
  user(tool_result ...)
]
turnCount = 2
```

### 28.5 第二轮模型响应

这次模型已经看到工具结果，于是给出最终文本：

```ts
assistant("README 主要讲了 ...")
needsFollowUp = false
```

### 28.6 外部看到的大致顺序

```text
system/init
assistant(text: 我先读取 README.md)
assistant(tool_use: ReadFile)
user(tool_result: README 内容)
assistant(text: README 主要讲了 ...)
result
```

注意：真实输出经过 `normalizeMessage()` 后，assistant 多 block 可能会被拆成多条。

---

## 29. 读这段源码时最容易混淆的 3 组概念

### 29.1 `prompt` vs `messagesFromUserInput`

| 名称 | 含义 |
|---|---|
| `prompt` | 调用方传进来的原始输入 |
| `messagesFromUserInput` | 经过 `processUserInput()` 标准化后的内部消息数组 |

不要把“用户输入原始字符串”和“系统内部消息对象”混为一谈。

### 29.2 `this.mutableMessages` vs `messages` vs `messagesForQuery`

| 名称 | 所在层 | 含义 |
|---|---|---|
| `this.mutableMessages` | `QueryEngine` | 会话长期历史 |
| `messages` | `submitMessage()` | 当前 turn 的局部快照 |
| `messagesForQuery` | `queryLoop()` | 这一次真正送给模型的消息视图，可能已经 compact/collapse 过 |

### 29.3 `Message` vs `SDKMessage`

| 类型 | 面向谁 |
|---|---|
| 内部 `Message` | query / tool / transcript / resume 逻辑 |
| 外部 `SDKMessage` | SDK / print / remote client |

`normalizeMessage()` 的存在就是为了跨过这层边界。

---

## 30. 这段代码用到了哪些初学者最容易卡住的语法

### 30.1 `async function*`

它同时具备两种能力：

1. 可以 `await`
2. 可以 `yield`

也就是说，它适合“异步地、分多次产出值”的场景。

### 30.2 `for await (const x of y)`

如果 `y` 是一个异步可迭代对象，就可以这样一条条消费：

```ts
for await (const msg of ask(...)) {
  // 每次只处理一条
}
```

### 30.3 `yield*`

表示“把另一个 generator 的全部输出直接接力转发”。

```ts
yield* engine.submitMessage(...)
```

等价于：

```ts
for await (const msg of engine.submitMessage(...)) {
  yield msg
}
```

### 30.4 对象解构

```ts
const { tools, commands, cwd } = this.config
```

等价于：

```ts
const tools = this.config.tools
const commands = this.config.commands
const cwd = this.config.cwd
```

### 30.5 `??` 和 `?:`

```ts
config.initialMessages ?? []
```

意思是：

- 左边不是 `null/undefined`，就用左边
- 否则用右边

```ts
userSpecifiedModel ? parseUserSpecifiedModel(userSpecifiedModel) : getMainLoopModel()
```

意思是：

- 条件成立用前者
- 否则用后者

---

## 31. 调试这条链路时建议下的断点

如果你准备边跑边看，这几个点最值钱：

1. `src/cli/print.ts:2145`
   看外层到底传了什么参数给 `ask()`

2. `src/QueryEngine.ts:1274`
   看 `new QueryEngine({...})` 时有哪些初始状态

3. `src/QueryEngine.ts:413`
   看 `processUserInput()` 产出了什么

4. `src/QueryEngine.ts:543`
   看 `system/init` 是怎样构造的

5. `src/QueryEngine.ts:679`
   看 `submitMessage()` 什么时候正式进入 `query()`

6. `src/query.ts:699`
   看真正的模型请求参数长什么样

7. `src/query.ts:869`
   看 assistant 里怎样识别 `tool_use`

8. `src/query.ts:1428`
   看工具结果怎样回流成 `toolResults`

9. `src/QueryEngine.ts:1160`
   看最终 `result` 怎么拼出来

---

## 32. 最后总结成一句最重要的话

`ask()` 不负责“智能”，它负责“包装”。

`submitMessage()` 不直接“跑模型循环”，它负责“一次 turn 的编排和收尾”。

`queryLoop()` 才真正负责：

1. 把消息送给模型
2. 识别工具调用
3. 执行工具
4. 把工具结果喂回模型
5. 直到没有 follow-up 为止

所以阅读顺序应该是：

1. 先用这篇文档看懂 `ask()` 和 `submitMessage()` 的职责边界
2. 再读 `phase-4-query-loop.md`，继续往下钻 `queryLoop()`
   这篇现在已经补到了 `QueryEngine -> query() -> queryLoop() -> queryModelWithStreaming() -> queryModel() -> runTools() -> runToolUse()` 的完整主链
3. 最后再去看 `claude.ts` 的底层流式事件转换

这样不容易在第一步就被 3000 行 API 客户端细节淹没。
