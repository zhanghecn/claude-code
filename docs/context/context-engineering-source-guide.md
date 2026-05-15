# 上下文工程与提示词工程源码导读

本文档用于从源码角度学习 Claude Code 的上下文工程和提示词工程。目标不是背 API, 而是把这条链路融会贯通:

```
用户输入
  -> 消息队列 / slash command
  -> System Prompt 组装
  -> CLAUDE.md / git / date / env 上下文注入
  -> 工具 schema 注入
  -> prompt cache 分块
  -> Anthropic API 请求
  -> 流式响应
  -> 工具调用
  -> 工具结果回灌
  -> 上下文压缩 / 缓存编辑
  -> 下一轮
```

如果你现在很迷糊, 先不要问"这个函数干什么", 而是按本文的学习路线从上到下走一遍。每一章都告诉你:

- 看哪些文件
- 这些文件的依赖关系
- 真实提示词数据从哪里来
- 上下文如何注入
- 缓存为什么这样切
- 源码中的关键语法和设计意图

注意: 文中写成"结构"、"形态"、"大概是这样"的块是解释用示意, 不保证能逐字搜索到。写成"源码原文"或"可搜索片段"的块来自当前源码, 可以直接用 `rg` 搜。

## 0. 先建立总图

核心文件地图:

```
src/entrypoints/cli.tsx
  CLI 入口, 处理 --version / daemon / bridge / 默认加载 main.tsx

src/main.tsx
  Commander 命令定义, 进入交互模式或 headless/SDK 模式

src/QueryEngine.ts
  SDK/headless 的高层编排器, 调用 fetchSystemPromptParts() 和 query()

src/screens/REPL.tsx
  交互式终端 UI, 最终也会进入 query()

src/utils/queryContext.ts
  统一抓取三块前缀材料:
  - defaultSystemPrompt
  - userContext
  - systemContext

src/constants/prompts.ts
  默认 System Prompt 的主工厂, 返回 string[]

src/constants/systemPromptSections.ts
  动态提示词 section 的缓存注册表

src/context.ts
  git status / CLAUDE.md / currentDate 等上下文采集

src/utils/claudemd.ts
  CLAUDE.md / .claude/rules / @include / frontmatter 的发现与合并

src/utils/systemPrompt.ts
  buildEffectiveSystemPrompt(), 处理 override / agent / custom / default 优先级

src/utils/api.ts
  prependUserContext(), appendSystemContext(), splitSysPromptPrefix()

src/services/api/claude.ts
  最终请求组装: system blocks, tools, messages, betas, cache_control, stream

src/query.ts
  Agentic loop: 压缩, 调模型, 收工具调用, 执行工具, 回灌结果, 继续循环
```

最小心智模型:

```
System Prompt = "模型应该如何做事"
User Context  = "用户/项目/当前日期等可参考事实"
System Context = "系统级事实, 如 git status, cache breaker"
Tools = "模型可调用动作的 schema 和说明"
Messages = "真实对话历史 + 工具结果"
Cache = "尽量让前缀字节稳定, 让 API 复用前缀"
Compact = "上下文快满时把旧消息压成摘要或清理工具结果"
```

## 1. 第一条主线: 从 QueryEngine 到 API 请求

先看 `src/QueryEngine.ts`。它适合学习 headless/SDK 路径, 因为少了 Ink UI 噪音。

关键调用:

```ts
// src/QueryEngine.ts
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

const systemPrompt = asSystemPrompt([
  ...(customPrompt !== undefined ? [customPrompt] : defaultSystemPrompt),
  ...(memoryMechanicsPrompt ? [memoryMechanicsPrompt] : []),
  ...(appendSystemPrompt ? [appendSystemPrompt] : []),
])

for await (const message of query({
  messages,
  systemPrompt,
  userContext,
  systemContext,
  canUseTool: wrappedCanUseTool,
  toolUseContext: processUserInputContext,
  querySource: 'sdk',
})) {
  // query() 会不断 yield assistant/user/system 消息
}
```

加中文注释后可以这样理解:

```ts
// 1. 先收集三块"API 前缀材料"
//    defaultSystemPrompt: 默认系统提示词数组
//    userContext: CLAUDE.md/currentDate 等, 后面会作为 meta user message 注入
//    systemContext: git status/cache breaker 等, 后面追加到 system prompt
const parts = await fetchSystemPromptParts(...)

// 2. 再决定最终 systemPrompt:
//    - 如果用户传了 customPrompt, 用 customPrompt 替换默认提示词
//    - 否则使用 defaultSystemPrompt
//    - memoryMechanicsPrompt 是 SDK 特定记忆机制说明
//    - appendSystemPrompt 永远追加在最后
const systemPrompt = asSystemPrompt([...])

// 3. 进入 query() 主循环:
//    query() 不只调一次模型, 它会:
//    - 调模型
//    - 如果模型要用工具, 执行工具
//    - 把工具结果作为 user message 回灌
//    - 继续调模型
//    - 直到没有 tool_use 或达到 maxTurns
for await (const message of query(...)) {}
```

## 2. 三块前缀材料: fetchSystemPromptParts()

文件: `src/utils/queryContext.ts`

这个函数非常重要, 它定义了上下文工程的三分法:

```ts
export async function fetchSystemPromptParts({
  tools,
  mainLoopModel,
  additionalWorkingDirectories,
  mcpClients,
  customSystemPrompt,
}): Promise<{
  defaultSystemPrompt: string[]
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
}> {
  const [defaultSystemPrompt, userContext, systemContext] = await Promise.all([
    customSystemPrompt !== undefined
      ? Promise.resolve([])
      : getSystemPrompt(tools, mainLoopModel, additionalWorkingDirectories, mcpClients),
    getUserContext(),
    customSystemPrompt !== undefined ? Promise.resolve({}) : getSystemContext(),
  ])
  return { defaultSystemPrompt, userContext, systemContext }
}
```

中文注释版:

```ts
// 同时并发计算三类上下文, 因为它们互不依赖:
const [defaultSystemPrompt, userContext, systemContext] = await Promise.all([
  // 如果用户传了 --system-prompt/customSystemPrompt:
  // 默认系统提示词被替换, 所以不再计算 getSystemPrompt()
  customSystemPrompt !== undefined
    ? Promise.resolve([])
    : getSystemPrompt(...),

  // 无论有没有 customSystemPrompt, 都要读取用户上下文:
  // CLAUDE.md/currentDate 仍然对用户任务有意义
  getUserContext(),

  // 如果用户传了 customSystemPrompt:
  // systemContext 也不追加, 避免把默认体系的 git/cache 信息塞进自定义提示词
  customSystemPrompt !== undefined
    ? Promise.resolve({})
    : getSystemContext(),
])
```

这里的设计含义:

- `customSystemPrompt` 是强覆盖, 它让默认 system prompt 和 system context 都消失。
- `userContext` 不消失, 因为 CLAUDE.md/currentDate 是项目事实, 不属于默认 system prompt。
- `Promise.all` 是为了减少启动延迟。

## 3. 默认 System Prompt 是一个 string[] 数组

文件: `src/constants/prompts.ts`

核心函数:

```ts
export async function getSystemPrompt(
  tools: Tools,
  model: string,
  additionalWorkingDirectories?: string[],
  mcpClients?: MCPServerConnection[],
): Promise<string[]> {
  ...
}
```

它不是返回一大坨字符串, 而是返回数组。数组的每一项是一个提示词块。

为什么不用单字符串?

```
string[] 的好处
  |
  +-- 可以按 section 缓存
  +-- 可以插入 SYSTEM_PROMPT_DYNAMIC_BOUNDARY
  +-- 可以分开拼成 API system text blocks
  +-- 可以把静态区和动态区拆开做 prompt cache
```

### 3.1 真实提示词骨架

`getSystemPrompt()` 最后返回的结构大致如下:

```ts
return [
  // 静态区: 尽量跨用户/跨会话不变, 适合缓存
  getSimpleIntroSection(outputStyleConfig),
  getSimpleSystemSection(),
  outputStyleConfig === null || outputStyleConfig.keepCodingInstructions === true
    ? getSimpleDoingTasksSection()
    : null,
  getActionsSection(),
  getUsingYourToolsSection(enabledTools),
  getOutputEfficiencySection(),

  // 分界线: 只有 firstParty + 实验 beta 可用时插入
  ...(shouldUseGlobalCacheScope() ? [SYSTEM_PROMPT_DYNAMIC_BOUNDARY] : []),

  // 动态区: 用户/会话/环境/工具/MCP 相关, 不适合跨组织全局缓存
  ...resolvedDynamicSections,
].filter(s => s !== null)
```

ASCII 图:

```
SystemPrompt string[]
|
+====================================================================+
| STATIC CACHE AREA                                                   |
| 目标: 字节尽量稳定, 让 prompt cache 命中                            |
| 来源: getSystemPrompt() 返回数组中 boundary 之前的 section           |
+====================================================================+
|
+-- [0] Intro
|     "You are an interactive agent..."
|
+-- [1] System
|     工具权限, 工具分类, prompt injection 防御, hooks, 自动压缩提醒
|
+-- [2] Doing tasks
|     软件工程任务默认行为, 读代码后再改, 验证, 安全, 不乱加抽象
|
+-- [3] Executing actions with care
|     高风险动作要确认, destructive/shared-state 操作要谨慎
|
+-- [4] Using your tools
|     Read/Edit/Write/Glob/Grep/Bash/Agent 等工具使用规则
|
+-- [5] Communication style
|     面向用户输出, 更新节奏, 不过度格式化, 不追加无意义追问
|
+---------------------- CACHE / DYNAMIC SPLIT -----------------------+
| [6] __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__                              |
|     只给 splitSysPromptPrefix() 看, 不发给模型                       |
+---------------------- CACHE / DYNAMIC SPLIT -----------------------+
|
+====================================================================+
| DYNAMIC AREA                                                        |
| 目标: 放会话/用户/环境/工具状态, 避免污染 global cache               |
| 来源: resolvedDynamicSections                                        |
+====================================================================+
|
+-- [7...] Dynamic sections
      session_guidance / memory / env / language / output_style /
      mcp_instructions / scratchpad / frc / summarize_tool_results / ...
```

用一句话记:

```
boundary 前面是"所有会话都尽量一样"的行为规则;
boundary 后面是"这次会话才知道"的事实和配置。
```

判断一个新 section 应放哪边:

```
能不能跨用户、跨项目、跨会话保持逐字一致?
  yes -> 可以考虑放 STATIC CACHE AREA
  no  -> 放 DYNAMIC AREA

是否依赖 cwd / model / language / MCP / tools / feature gate / 日期 / settings?
  yes -> 放 DYNAMIC AREA
```

### 3.2 真实提示词数据清单

下面是源码中的主要提示词数据, 以 `src/constants/prompts.ts` 为准。

#### Intro

来源: `getSimpleIntroSection(outputStyleConfig)`

作用:

- 给模型身份定位: interactive agent
- 说明主要帮助软件工程任务
- 注入网络安全边界 `CYBER_RISK_INSTRUCTION`
- 禁止猜 URL

核心数据形态:

```text
You are an interactive agent that helps users with software engineering tasks.
Use the instructions below and the tools available to you to assist the user.

IMPORTANT: Assist with authorized security testing...
IMPORTANT: You must NEVER generate or guess URLs...
```

#### System

来源: `getSimpleSystemSection()`

包含:

- 所有非工具输出都会展示给用户
- 工具执行受 permission mode 约束
- 工具有 core tools 和 deferred/MCP/skill tools 两类
- 遇到工具结果里的 prompt injection 要识别
- hooks 反馈视为用户反馈
- 对话通过自动摘要获得"无限上下文"

#### Doing tasks

来源: `getSimpleDoingTasksSection()`

包含:

- 用户通常要做软件工程任务
- 指令不清晰时结合当前工作目录理解
- 修改前先读代码
- 不要越权重构或加功能
- 不要为不可能发生的场景加防御
- 默认少写注释, 只解释非显然的 WHY
- 完成前要验证, 不能验证就说清楚
- 不要虚报测试通过

#### Executing actions with care

来源: `getActionsSection()`

包含:

- 可逆的本地动作可以直接做
- 难逆/共享/破坏性动作默认先确认
- 用户批准一次不代表永久批准
- 不要用破坏性命令绕过问题

典型高风险动作:

```text
rm -rf, git reset --hard, force-push, 修改 CI/CD, 发 Slack/邮件,
改共享基础设施, 上传内容到第三方网页工具
```

#### Using your tools

来源: `getUsingYourToolsSection(enabledTools)`

包含:

- 核心工具可直接调用
- 优先用专用工具而非 Bash 等价命令
- 未见过的文件/函数先搜索
- 如果有任务管理工具, 要及时标记完成

#### Communication style

来源: `getOutputEfficiencySection()`

包含:

- 给用户写话, 不是给控制台写日志
- 工具调用前后给关键进展
- 不要描述内部工具名
- 简单答案用自然段, 不滥用列表
- 完成后报告结果, 不追加 "还有什么需要吗"

#### Session-specific guidance

来源: `getSessionSpecificGuidanceSection(enabledTools, skillToolCommands)`

这是动态区, 因为它依赖:

- 当前启用工具集合
- 是否 non-interactive
- Agent/Fork/ExplorePlan 是否启用
- Skill/DiscoverSkills 是否可用
- Verification Agent feature 状态

它必须放在 boundary 之后, 否则会制造大量缓存变体。

#### Memory

来源: `systemPromptSection('memory', () => loadMemoryPrompt())`

这是自动记忆系统的提示词, 来自 `src/memdir/memdir.ts`。注意它和 CLAUDE.md 不是同一条链:

```
自动记忆 MEMORY.md -> system prompt dynamic section
项目 CLAUDE.md -> userContext -> meta user message
```

#### Env

来源: `computeSimpleEnvInfo(model, additionalWorkingDirectories)`

输出结构示意。需要核对真实字符串模板时, 看附录 [prompt-source-index.md](/home/zhangxuan/project/ai/claude-code/docs/context/prompt-source-index.md):

```text
# Environment
You have been invoked in the following environment:
 - Primary working directory: ...
 - Is a git repository: ...
 - Additional working directories:
   - ...
 - Platform: ...
 - Shell: ...
 - OS Version: ...
 - You are powered by the model ...
 - Assistant knowledge cutoff is ...
```

#### MCP instructions

来源: `getMcpInstructionsSection(mcpClients)`

只有 MCP server 自带 instructions 时才出现:

```text
# MCP Server Instructions

The following MCP servers have provided instructions for how to use their tools and resources:

## server-name
server instructions...
```

#### Scratchpad

来源: `getScratchpadInstructions()`

只有 scratchpad 开启时出现, 告诉模型临时文件应写到 session scratchpad 目录, 不要写 `/tmp`。

#### Function Result Clearing

来源: `getFunctionResultClearingSection(model)`

只有 `CACHED_MICROCOMPACT` 等条件满足时出现, 告诉模型旧工具结果会被清理, 要主动记下重要信息。

#### Summarize tool results

来源: `SUMMARIZE_TOOL_RESULTS_SECTION`

真实提示词:

```text
When working with tool results, write down any important information you might need later in your response, as the original tool result may be cleared later.
```

### 3.3 先保持主线, 原文放到附录

这里不要停下来逐段背提示词。先把顺序记住: 静态行为规则在前, boundary 分割, 动态事实在后。等你需要核对"源码里到底写了哪句英文"时, 再打开 [prompt-source-index.md](/home/zhangxuan/project/ai/claude-code/docs/context/prompt-source-index.md), 那里按 section 列了可搜索片段和源码位置。

## 4. 动态 section 注册表: 为什么有缓存和危险缓存

文件: `src/constants/systemPromptSections.ts`

源码:

```ts
export function systemPromptSection(
  name: string,
  compute: ComputeFn,
): SystemPromptSection {
  return { name, compute, cacheBreak: false }
}

export function DANGEROUS_uncachedSystemPromptSection(
  name: string,
  compute: ComputeFn,
  _reason: string,
): SystemPromptSection {
  return { name, compute, cacheBreak: true }
}

export async function resolveSystemPromptSections(
  sections: SystemPromptSection[],
): Promise<(string | null)[]> {
  const cache = getSystemPromptSectionCache()

  return Promise.all(
    sections.map(async s => {
      if (!s.cacheBreak && cache.has(s.name)) {
        return cache.get(s.name) ?? null
      }
      const value = await s.compute()
      setSystemPromptSectionCacheEntry(s.name, value)
      return value
    }),
  )
}
```

中文注释版:

```ts
// 普通 section:
// 适合"会话中基本不变"的内容, 如 memory/env/language。
// 第一次算完后放到 bootstrap state 的 Map 里。
systemPromptSection('env_info_simple', () => computeSimpleEnvInfo(...))

// 危险 section:
// 每轮都重新算, 因为它确实可能变化。
// 变化会让 prompt cache 失效, 所以命名里写了 DANGEROUS。
DANGEROUS_uncachedSystemPromptSection(
  'mcp_instructions',
  () => getMcpInstructionsSection(mcpClients),
  'MCP servers connect/disconnect between turns',
)

// 解析阶段:
// - cacheBreak=false 且缓存命中: 直接复用旧字符串
// - 否则重新 compute()
// - 结果写回缓存
```

设计要点:

```
缓存目标不是"少算一点函数"
缓存目标是"让发给 API 的字节保持一致"
因为 prompt cache 是字节级前缀缓存, 一个空格变化都可能 miss
```

清理时机:

- `/clear`
- `/compact`
- `clearSystemPromptSections()`

## 5. CLAUDE.md 是如何注入的

文件:

- `src/context.ts`
- `src/utils/claudemd.ts`
- `src/utils/api.ts`

### 5.1 发现顺序

`src/utils/claudemd.ts` 文件头已经写出真实规则:

```
1. Managed memory
   /etc/claude-code/CLAUDE.md 等全局托管指令

2. User memory
   ~/.claude/CLAUDE.md 私人全局指令

3. Project memory
   CLAUDE.md
   .claude/CLAUDE.md
   .claude/rules/*.md

4. Local memory
   CLAUDE.local.md 私人项目指令
```

加载顺序是"低优先级先加载, 高优先级后加载":

```
Managed -> User -> 上层 Project -> 下层 Project -> Local
```

后出现的内容更靠近 prompt 尾部, 模型更容易重视。

### 5.2 @include 语法

CLAUDE.md 里可以写:

```md
@./docs/rules.md
@~/global-rule.md
@/absolute/path/to/file.md
@relative-file.md
```

源码规则:

- 只在 markdown 文本节点里解析
- code block / inline code 里的 `@path` 不解析
- HTML 注释里的路径不解析
- 最大 include 深度 `MAX_INCLUDE_DEPTH = 5`
- 只允许文本类扩展名, 防止把图片/PDF 注入上下文
- 循环引用通过 `processedPaths` 去重

### 5.3 frontmatter paths 语法

`.claude/rules/*.md` 可以带 frontmatter:

```md
---
paths:
  - "src/services/api/**"
  - "packages/builtin-tools/**"
---

这些规则只在目标路径匹配时才相关。
```

源码中 `parseFrontmatterPaths()` 会把 `/**` 后缀裁掉, 并把 `**` 视为"全局规则"。

### 5.4 getUserContext()

文件: `src/context.ts`

```ts
export const getUserContext = memoize(async () => {
  const shouldDisableClaudeMd =
    isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS) ||
    (isBareMode() && getAdditionalDirectoriesForClaudeMd().length === 0)

  const claudeMd = shouldDisableClaudeMd
    ? null
    : getClaudeMds(filterInjectedMemoryFiles(await getMemoryFiles()))

  setCachedClaudeMdContent(claudeMd || null)

  return {
    ...(claudeMd && { claudeMd }),
    currentDate: `Today's date is ${getLocalISODate()}.`,
  }
})
```

中文注释版:

```ts
// getUserContext() 是 memoize 的:
// 同一会话里默认只读一次 CLAUDE.md/currentDate。
// 这也是为了保持 prompt cache 稳定。
export const getUserContext = memoize(async () => {
  // 关闭 CLAUDE.md 的两种方式:
  // 1. CLAUDE_CODE_DISABLE_CLAUDE_MDS=1
  // 2. --bare 且没有显式 --add-dir
  const shouldDisableClaudeMd = ...

  // 如果没有关闭, 就读取所有 memory files, 过滤后合并成 claudeMd 字符串
  const claudeMd = shouldDisableClaudeMd
    ? null
    : getClaudeMds(filterInjectedMemoryFiles(await getMemoryFiles()))

  // 缓存给 auto-mode classifier 用, 避免模块循环依赖
  setCachedClaudeMdContent(claudeMd || null)

  // userContext 最终只有两个常见 key:
  // - claudeMd
  // - currentDate
  return {
    ...(claudeMd && { claudeMd }),
    currentDate: `Today's date is ${getLocalISODate()}.`,
  }
})
```

### 5.5 CLAUDE.md 最终不是 system prompt, 而是 meta user message

文件: `src/utils/api.ts`

```ts
export function prependUserContext(
  messages: Message[],
  context: { [k: string]: string },
): Message[] {
  const { claudeMd, ...rest } = context
  const result: Message[] = []

  if (claudeMd) {
    result.push(
      createUserMessage({
        content: `<project-instructions>\n${claudeMd}\n</project-instructions>\n`,
        isMeta: true,
      }),
    )
  }

  const restEntries = Object.entries(rest)
  if (restEntries.length > 0) {
    result.push(
      createUserMessage({
        content: `<system-reminder>\nAs you answer the user's questions, you can use the following context:\n${...}\n</system-reminder>\n`,
        isMeta: true,
      }),
    )
  }

  return [...result, ...messages]
}
```

中文注释版:

```ts
// userContext 会被插到 messages 最前面, 而不是追加到 system prompt。
// 这意味着 CLAUDE.md 在 API 里属于 user role 的 meta message。
export function prependUserContext(messages, context) {
  // claudeMd 单独拿出来, 因为项目指令权重更高,
  // 不想埋在"may or may not be relevant"的普通 system-reminder 里。
  const { claudeMd, ...rest } = context

  if (claudeMd) {
    result.push(createUserMessage({
      content: `<project-instructions>\n${claudeMd}\n</project-instructions>\n`,
      isMeta: true,
    }))
  }

  // currentDate 等其他上下文放进普通 system-reminder。
  // 这里明确告诉模型: 这些上下文可能相关, 不要无关时主动回应。
  if (restEntries.length > 0) {
    result.push(createUserMessage({
      content: `<system-reminder> ... </system-reminder>`,
      isMeta: true,
    }))
  }

  // 最后把真实对话历史接在后面。
  return [...result, ...messages]
}
```

最终消息形态:

```
messages sent to API
|
+-- user(meta): <project-instructions> CLAUDE.md 合并内容 </project-instructions>
+-- user(meta): <system-reminder> currentDate/git? 等普通上下文 </system-reminder>
+-- user: 用户真实输入
+-- assistant: 模型回复
+-- user: tool_result
+-- assistant: 下一步回复
```

## 6. systemContext: git status 如何追加

文件: `src/context.ts` 和 `src/utils/api.ts`

`getSystemContext()` 返回:

```ts
return {
  ...(gitStatus && { gitStatus }),
  ...(feature('BREAK_CACHE_COMMAND') && injection
    ? { cacheBreaker: `[CACHE_BREAKER: ${injection}]` }
    : {}),
}
```

然后在 `query.ts` 里:

```ts
const fullSystemPrompt = asSystemPrompt(
  appendSystemContext(systemPrompt, systemContext),
)
```

`appendSystemContext()`:

```ts
export function appendSystemContext(
  systemPrompt: SystemPrompt,
  context: { [k: string]: string },
): string[] {
  return [
    ...systemPrompt,
    Object.entries(context)
      .map(([key, value]) => `${key}: ${value}`)
      .join('\n'),
  ].filter(Boolean)
}
```

含义:

```
systemPrompt 原本:
  [Intro, System, Doing tasks, ..., Env]

appendSystemContext 后:
  [Intro, System, Doing tasks, ..., Env, "gitStatus: ...\ncacheBreaker: ..."]
```

为什么 git status 放 systemContext, 而 CLAUDE.md 放 userContext?

```
CLAUDE.md 是用户/项目指令, 需要高权重且与用户任务直接相关
git status 是系统采集的环境快照, 适合当系统上下文追加
```

## 7. effective system prompt 的优先级

文件: `src/utils/systemPrompt.ts`

`buildEffectiveSystemPrompt()` 的优先级:

```
overrideSystemPrompt
  最高, 完全替换所有提示词

coordinator mode
  使用 coordinator 专用提示词

mainThreadAgentDefinition
  如果主线程 agent 存在:
  - proactive 模式: agent prompt 追加到默认提示词
  - 普通模式: agent prompt 替换默认提示词

customSystemPrompt
  用户通过 --system-prompt 传入, 替换默认提示词

defaultSystemPrompt
  正常 Claude Code 默认提示词

appendSystemPrompt
  除 override 外, 总是追加到最后
```

ASCII:

```
                  +----------------------+
                  | overrideSystemPrompt? |
                  +----------+-----------+
                             |
                         yes v
                      [override only]
                             |
                            no
                             v
                 +---------------------+
                 | coordinator mode?   |
                 +---------+-----------+
                           |
                       yes v
                 [coordinator + append]
                           |
                          no
                           v
             +----------------------------+
             | mainThreadAgentDefinition? |
             +-------------+--------------+
                           |
                       yes v
           [agent replaces default, except proactive appends]
                           |
                          no
                           v
            customSystemPrompt ? [custom] : [default]
                           |
                           v
                 append appendSystemPrompt
```

## 8. 最终 API 请求如何组装

文件: `src/services/api/claude.ts`

### 8.1 query() 先调用模型

文件: `src/query.ts`

关键片段:

```ts
for await (const message of deps.callModel({
  messages: prependUserContext(messagesForQuery, userContext),
  systemPrompt: fullSystemPrompt,
  thinkingConfig: toolUseContext.options.thinkingConfig,
  tools: toolUseContext.options.tools,
  signal: toolUseContext.abortController.signal,
  options: {
    model: currentModel,
    querySource,
    agents: toolUseContext.options.agentDefinitions.activeAgents,
    mcpTools: appState.mcp.tools,
    agentId: toolUseContext.agentId,
  },
})) {
  ...
}
```

中文注释版:

```ts
// query() 在每次 API 调用前做两件关键事:
// 1. prependUserContext(): 把 CLAUDE.md/currentDate 插到 messages 前面
// 2. fullSystemPrompt: 把 systemContext 追加进 system prompt 数组
deps.callModel({
  messages: prependUserContext(messagesForQuery, userContext),
  systemPrompt: fullSystemPrompt,
  tools: 当前可用工具,
})
```

### 8.2 claude.ts 再补 attribution header 和 CLI prefix

文件: `src/services/api/claude.ts`

```ts
systemPrompt = asSystemPrompt(
  [
    getAttributionHeader(fingerprint),
    getCLISyspromptPrefix({
      isNonInteractive: options.isNonInteractiveSession,
      hasAppendSystemPrompt: options.hasAppendSystemPrompt,
    }),
    ...systemPrompt,
    ...(advisorModel ? [ADVISOR_TOOL_INSTRUCTIONS] : []),
    ...(injectChromeHere ? [CHROME_SEARCH_EXTRA_TOOLS_INSTRUCTIONS] : []),
  ].filter(Boolean),
)
```

含义:

```
最终 system prompt 数组:

[0] x-anthropic-billing-header: cc_version=...
[1] You are Claude Code, Anthropic's official CLI for Claude.
[2] Intro
[3] System
[4] Doing tasks
...
[N] dynamic sections
[N+1] gitStatus/cacheBreaker
[N+2] advisor/chrome addendum, if any
```

注意:

- `getAttributionHeader()` 是计费/追踪用 header 字符串, 也作为 system block 发送。
- `getCLISyspromptPrefix()` 是 API 侧识别 Claude Code/Agent SDK 的前缀。
- 这两块会被 `splitSysPromptPrefix()` 特殊识别。

## 9. Prompt Cache 的核心: splitSysPromptPrefix()

文件: `src/utils/api.ts`

系统把 `systemPrompt: string[]` 拆成 API 的 `system: TextBlockParam[]`。

核心目标:

```
把稳定的大块文本放进 cache_control
把动态小块留在后面
让下一轮请求尽可能复用前缀
```

### 9.1 Boundary 标记

文件: `src/constants/prompts.ts`

```ts
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY =
  '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'
```

它的意义:

```
systemPrompt string[]

  STATIC CACHE AREA
  boundary 之前: 静态提示词, firstParty 默认可拆成 cacheScope='global'

  ------------------ __SYSTEM_PROMPT_DYNAMIC_BOUNDARY__ ------------------
  boundary 本身: 只给本地 splitSysPromptPrefix() 用, 不发给模型

  DYNAMIC AREA
  boundary 之后: 动态提示词, 不做 global cache
```

注意 `boundary` 分割的是 `src/constants/prompts.ts` 里 `getSystemPrompt()` 返回的数组。进入 API 前, `src/services/api/claude.ts` 还会在数组最前面加:

```
[attribution header]
[CLI sysprompt prefix]
```

所以 API 分块时看到的是:

```
final systemPrompt before buildSystemPromptBlocks()
|
+-- attribution header                      cacheScope=null
+-- CLI sysprompt prefix                    cacheScope=null
+-- STATIC CACHE AREA from getSystemPrompt  cacheScope='global'
+-- DYNAMIC AREA from getSystemPrompt       cacheScope=null
```

### 9.2 三种缓存模式

#### 模式 A: firstParty + global cache + boundary 存在

```
systemPrompt array
  |
  +-- attribution header
  +-- CLI prefix
  +-- static blocks before boundary
  +-- boundary marker
  +-- dynamic blocks after boundary

split result
  |
  +-- block 1: attribution header, cacheScope=null
  +-- block 2: CLI prefix, cacheScope=null
  +-- block 3: static joined, cacheScope='global'
  +-- block 4: dynamic joined, cacheScope=null
```

#### 模式 B: 有 MCP 工具, 需要 tool-based cache marker

```
split result
  |
  +-- attribution header, cacheScope=null
  +-- CLI prefix, cacheScope='org'
  +-- rest, cacheScope='org'
```

为什么降级?

```
MCP tool schema/指令可能随连接状态变化
跨组织 global cache 不再安全或稳定
所以使用 org cache
```

#### 模式 C: 默认 3P provider 或无 boundary

```
split result
  |
  +-- attribution header, cacheScope=null
  +-- CLI prefix, cacheScope='org'
  +-- rest, cacheScope='org'
```

### 9.3 buildSystemPromptBlocks()

文件: `src/services/api/claude.ts`

```ts
export function buildSystemPromptBlocks(
  systemPrompt: SystemPrompt,
  enablePromptCaching: boolean,
  options?: {
    skipGlobalCacheForSystemPrompt?: boolean
    querySource?: QuerySource
  },
): TextBlockParam[] {
  return splitSysPromptPrefix(systemPrompt, {
    skipGlobalCacheForSystemPrompt: options?.skipGlobalCacheForSystemPrompt,
  }).map(block => {
    return {
      type: 'text' as const,
      text: block.text,
      ...(enablePromptCaching &&
        block.cacheScope !== null && {
          cache_control: getCacheControl({
            scope: block.cacheScope,
            querySource: options?.querySource,
          }),
        }),
    }
  })
}
```

中文注释版:

```ts
// 1. 先把 systemPrompt 数组拆成几个语义块
// 2. 对每个块生成 API TextBlockParam
// 3. 只有 cacheScope !== null 的块才打 cache_control
// 4. cache_control 里可能有:
//    - type: 'ephemeral'
//    - scope: 'global'
//    - ttl: '1h'
```

最终 API system 形态:

```json
[
  {
    "type": "text",
    "text": "x-anthropic-billing-header: ..."
  },
  {
    "type": "text",
    "text": "You are Claude Code, Anthropic's official CLI for Claude."
  },
  {
    "type": "text",
    "text": "# System\n ... large static prompt ...",
    "cache_control": {
      "type": "ephemeral",
      "scope": "global"
    }
  },
  {
    "type": "text",
    "text": "# Environment\n ... dynamic prompt ..."
  }
]
```

## 10. 消息级 cache_control: addCacheBreakpoints()

文件: `src/services/api/claude.ts`

System prompt 有缓存标记, messages 也有缓存标记。

```ts
export function addCacheBreakpoints(
  messages: (UserMessage | AssistantMessage)[],
  enablePromptCaching: boolean,
  querySource?: QuerySource,
  useCachedMC = false,
  newCacheEdits?: CachedMCEditsBlock | null,
  pinnedEdits?: CachedMCPinnedEdits[],
  skipCacheWrite = false,
): MessageParam[] {
  const markerIndex = skipCacheWrite ? messages.length - 2 : messages.length - 1
  const result = messages.map((msg, index) => {
    const addCache = index === markerIndex
    if (msg.type === 'user') {
      return userMessageToMessageParam(msg, addCache, enablePromptCaching, querySource)
    }
    return assistantMessageToMessageParam(msg, addCache, enablePromptCaching, querySource)
  })
  ...
  return result
}
```

中文注释版:

```ts
// 每次请求只放一个 message-level cache_control marker。
// 默认放在最后一条消息上, 表示缓存到当前对话尾部。
// skipCacheWrite 用于 fork/子任务, marker 放到倒数第二条,
// 避免 fork 自己的尾巴污染主线程缓存。
const markerIndex = skipCacheWrite ? messages.length - 2 : messages.length - 1

// user/assistant 消息转换成 Anthropic API message param。
// addCache=true 时, cache_control 会加到该消息最后一个 content block 上。
```

为什么只能一个 marker?

源码注释说明: 多个 marker 会让本地/服务端 KV 页释放策略更复杂, 甚至让不需要继续复用的位置被保护, 浪费缓存。

## 11. 最终 paramsFromContext()

文件: `src/services/api/claude.ts`

最终 API 请求参数在 `paramsFromContext()` 里返回:

```ts
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
  tool_choice: options.toolChoice,
  ...(useBetas && { betas: filteredBetas }),
  metadata: getAPIMetadata(),
  max_tokens: maxOutputTokens,
  thinking,
  ...(temperature !== undefined && { temperature }),
  ...(contextManagement && { context_management: contextManagement }),
  ...extraBodyParams,
  ...(Object.keys(outputConfig).length > 0 && {
    output_config: outputConfig,
  }),
  ...(speed !== undefined && { speed }),
}
```

拆开看:

```
API request
|
+-- model
+-- system: TextBlockParam[]
|     system prompt + cache_control
|
+-- messages: MessageParam[]
|     CLAUDE.md meta message + currentDate reminder + conversation + tool results
|
+-- tools: BetaToolUnion[]
|     core tools + MCP tools + advisor 等 server tools
|
+-- betas
|     prompt caching scope, context 1m, context management, effort, fast mode...
|
+-- thinking
|     disabled / adaptive / enabled with budget_tokens
|
+-- output_config
|     structured output, effort, task budget
|
+-- metadata
      user_id JSON, session_id, device_id 等
```

## 12. 工具 schema 也是提示词的一部分

文件: `src/utils/api.ts`

`toolToAPISchema()` 会把本地 `Tool` 转成 API tool schema:

```ts
base = {
  name: tool.name,
  description: await tool.prompt({
    getToolPermissionContext: options.getToolPermissionContext,
    tools: options.tools,
    agents: options.agents,
    allowedAgentTypes: options.allowedAgentTypes,
  }),
  input_schema,
}
```

重要点:

```
tool.prompt() 返回工具描述
input_schema 来自 Zod 或 tool.inputJSONSchema
description + schema 会进入 API tools 字段
所以工具说明本质上也是提示词
```

工具 schema 也做缓存:

```ts
const cache = getToolSchemaCache()
let base = cache.get(cacheKey)
if (!base) {
  ...
  cache.set(cacheKey, base)
}
```

原因仍然是保持字节稳定:

- GrowthBook 中途变化不能让工具描述突然变
- MCP schema 要稳定
- structured output 不同 schema 要包含在 cache key 里

## 13. query.ts 的 agentic loop

文件: `src/query.ts`

高层流程:

```
query(params)
  |
  +-- 准备 messagesForQuery
  |
  +-- snip / microcompact / context collapse
  |
  +-- appendSystemContext(systemPrompt, systemContext)
  |
  +-- autocompact if needed
  |
  +-- deps.callModel(...)
  |     |
  |     +-- services/api/claude.ts queryModel()
  |
  +-- 收 assistant stream
  |
  +-- 如果 assistant 产生 tool_use
  |     |
  |     +-- runTools()
  |     +-- tool results 变成 user messages
  |     +-- messagesForQuery 更新
  |     +-- 回到 callModel()
  |
  +-- 如果没有 tool_use
        |
        +-- stop hooks
        +-- return completed
```

这解释了为什么 "上下文" 会持续增长:

```
用户消息 + assistant 回复 + tool_use + tool_result + assistant 回复 + ...
```

每一轮工具调用都会把工具结果塞回 messages, 所以后续模型能看到刚才工具输出。

## 14. 上下文压缩与缓存编辑

相关文件:

- `src/query.ts`
- `src/services/compact/autoCompact.ts`
- `src/services/compact/compact.ts`
- `src/services/compact/microCompact.ts`
- `src/services/contextCollapse/index.ts`
- `src/services/compact/microCompact.ts`

在 `query.ts` 中, API 调用前先做:

```ts
const microcompactResult = await deps.microcompact(
  messagesForQuery,
  toolUseContext,
  querySource,
)
messagesForQuery = microcompactResult.messages
```

然后可能做:

```ts
const { compactionResult } = await deps.autocompact(
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

压缩种类:

```
MicroCompact
  清旧工具结果, 不一定调用模型

AutoCompact
  快到上下文上限时自动摘要

ReactiveCompact
  API 返回 prompt-too-long 后补救

ContextCollapse
  把旧消息投影成 collapsed view, 保存 commit log

Cached MicroCompact
  利用 cache_edits/cache_reference 删除缓存内旧工具结果
```

与提示词的关系:

```
SUMMARIZE_TOOL_RESULTS_SECTION 告诉模型:
  工具结果可能被清, 重要信息要写进回复或后续上下文

Function Result Clearing section 告诉模型:
  旧工具结果会自动从上下文移除
```

## 15. 一次真实请求的完整数据形态

把上面所有内容合起来, 一次请求大概是这样:

```json
{
  "model": "claude-sonnet-4-6",
  "system": [
    {
      "type": "text",
      "text": "x-anthropic-billing-header: cc_version=..."
    },
    {
      "type": "text",
      "text": "You are Claude Code, Anthropic's official CLI for Claude."
    },
    {
      "type": "text",
      "text": "You are an interactive agent...\n\n# System\n...\n\n# Doing tasks\n...",
      "cache_control": {
        "type": "ephemeral",
        "scope": "global"
      }
    },
    {
      "type": "text",
      "text": "# Session-specific guidance\n...\n\n# Environment\n...\n\ngitStatus: ..."
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "<project-instructions>\nCodebase and user instructions are shown below...\nContents of /repo/CLAUDE.md...\n</project-instructions>"
        }
      ]
    },
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "<system-reminder>\n# currentDate\nToday's date is 2026-05-14.\n...</system-reminder>"
        }
      ]
    },
    {
      "role": "user",
      "content": "用户真实问题"
    }
  ],
  "tools": [
    {
      "name": "Read",
      "description": "Reads a file from the local filesystem...",
      "input_schema": {
        "type": "object",
        "properties": {
          "file_path": { "type": "string" }
        }
      },
      "cache_control": {
        "type": "ephemeral"
      }
    }
  ],
  "max_tokens": 8000,
  "thinking": {
    "type": "adaptive"
  },
  "metadata": {
    "user_id": "{\"device_id\":\"...\",\"session_id\":\"...\"}"
  }
}
```

注意这不是固定 JSON, 只是帮助你理解字段关系。真实字段由模型、provider、feature flag、MCP、工具、模式共同决定。

## 16. 学源码时应该怎么问

你现在不知道怎么提问, 可以按下面模板问自己或问 AI:

### 16.1 找入口

```
这个数据从哪里第一次产生?
这个数据在哪个函数第一次被加入 messages/system/tools?
这个函数的调用者是谁?
```

命令:

```bash
rg -n "getSystemPrompt\\(|prependUserContext\\(|buildSystemPromptBlocks\\(" src
```

### 16.2 看数据结构

```
这个函数返回的是 string, string[], Message[], 还是 API param?
它是修改原数组, 还是返回新数组?
有没有 brand type, 如 SystemPrompt?
```

### 16.3 看缓存

```
这个字符串会影响 prompt cache key 吗?
它是否在 boundary 前?
它有没有 session-stable latch?
它是否通过 memoize 或 systemPromptSection 缓存?
```

### 16.4 看注入位置

```
这是 system prompt?
这是 user meta message?
这是 tool schema description?
这是 tool result?
这是 beta header 或 extra body?
```

### 16.5 看变更风险

```
我改这个提示词会不会让所有请求 cache miss?
我改这个 section 顺序会不会破坏 splitSysPromptPrefix?
我改 CLAUDE.md 注入方式会不会降低项目指令权重?
我改 tool schema cache key 会不会拿到旧 schema?
```

## 17. 推荐学习顺序

按这个顺序读源码, 每一步只解决一个问题。

### 第 1 步: 看数据如何进入 query()

文件:

- `src/QueryEngine.ts`
- `src/utils/queryContext.ts`
- `src/query.ts`

你要回答:

```
query() 的入参有哪些?
systemPrompt/userContext/systemContext/messages/tools 分别是什么?
```

### 第 2 步: 看默认提示词怎么生成

文件:

- `src/constants/prompts.ts`
- `src/constants/systemPromptSections.ts`
- `src/utils/systemPrompt.ts`

你要回答:

```
默认提示词有哪些 section?
哪些 section 是静态区?
哪些 section 是动态区?
custom/agent/override 如何影响默认提示词?
```

### 第 3 步: 看 CLAUDE.md 怎么读

文件:

- `src/context.ts`
- `src/utils/claudemd.ts`

你要回答:

```
CLAUDE.md 搜索顺序是什么?
@include 如何解析?
frontmatter paths 如何工作?
为什么 CLAUDE.md 最后是 project-instructions user message?
```

### 第 4 步: 看 API 请求怎么分块缓存

文件:

- `src/utils/api.ts`
- `src/services/api/claude.ts`
- `src/constants/system.ts`

你要回答:

```
SYSTEM_PROMPT_DYNAMIC_BOUNDARY 有什么用?
splitSysPromptPrefix 三种模式是什么?
cache_control 加在哪些 block 上?
messages 的 cache marker 加在哪条消息上?
```

### 第 5 步: 看上下文如何循环增长

文件:

- `src/query.ts`
- `src/services/tools/toolOrchestration.ts`
- `src/utils/messages.ts`

你要回答:

```
tool_use 如何变成 tool_result?
tool_result 如何回灌成 user message?
什么时候停止继续调用模型?
```

### 第 6 步: 看上下文如何缩小

文件:

- `src/services/compact/autoCompact.ts`
- `src/services/compact/compact.ts`
- `src/services/compact/microCompact.ts`
- `src/query.ts`

你要回答:

```
什么时候 microcompact?
什么时候 autocompact?
压缩后 messages 变成什么?
为什么需要 compact boundary?
```

## 18. 修改提示词时的安全规则

不要直接凭感觉改 `prompts.ts`。先过这张检查表:

```
[ ] 这段内容是所有用户都相同吗?
    yes -> 可以考虑放 boundary 前
    no  -> 必须放 boundary 后

[ ] 这段内容是否依赖当前工具/MCP/语言/模型/日期/工作目录?
    yes -> dynamic section

[ ] 这段内容是否每轮都可能变化?
    yes -> DANGEROUS_uncachedSystemPromptSection, 并写明 reason

[ ] 这段内容是否项目/用户指令?
    yes -> 更可能属于 CLAUDE.md/userContext, 不一定该进 system prompt

[ ] 这段内容是否工具使用说明?
    yes -> 优先放 tool.prompt()/工具 description, 而不是全局 system prompt

[ ] 改动后是否需要跑:
    bun run typecheck
    bun test 相关测试
```

## 19. 快速定位命令

```bash
# 找系统提示词 section
rg -n "getSimple|systemPromptSection|DANGEROUS_uncached|SYSTEM_PROMPT_DYNAMIC_BOUNDARY" src/constants/prompts.ts

# 找 CLAUDE.md 链路
rg -n "getUserContext|getClaudeMds|getMemoryFiles|project-instructions|CLAUDE_CODE_DISABLE_CLAUDE_MDS" src

# 找缓存分块
rg -n "splitSysPromptPrefix|buildSystemPromptBlocks|getCacheControl|cache_control|addCacheBreakpoints" src

# 找最终 API 请求参数
rg -n "paramsFromContext|anthropic.beta.messages.create|messagesForAPI|system," src/services/api/claude.ts

# 找上下文压缩
rg -n "microcompact|autocompact|compact_boundary|contextCollapse|PROMPT_TOO_LONG" src/query.ts src/services/compact src/services/contextCollapse

# 找工具 schema
rg -n "toolToAPISchema|tool.prompt|input_schema|defer_loading|cacheControl" src packages/builtin-tools/src/tools
```

## 20. 一句话总结

Claude Code 的上下文工程不是"拼一个 prompt"。它是一个稳定前缀系统:

```
稳定的系统行为 -> system prompt 静态区 -> global/org prompt cache
会话动态事实 -> dynamic sections -> 尽量 memoize/latch
项目用户指令 -> CLAUDE.md -> project-instructions meta user message
工具能力说明 -> tools schema -> tool schema cache
对话过程事实 -> messages/tool results -> message cache marker
上下文过大 -> microcompact/autocompact/context collapse/cache edits
```

读懂这张图, 再去看任何一个具体函数, 就不容易迷路。
