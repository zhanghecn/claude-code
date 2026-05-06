# 学习文档索引

这份索引用来解决两个问题：

```text
1. 现在应该先看哪篇
2. 哪些文档只是补充或旧版总览，不需要重复细读
```

如果你只想理解 headless 模式下一次请求如何从输入走到模型、工具、再回到下一轮，按“主线必读”读就够。

## 主线必读

### 1. 先建立整条链路

[phase-3-headless-agent-tool-flow.md](phase-3-headless-agent-tool-flow.md)

先看这篇。它给的是全局地图：

```text
main.tsx
  -> print.ts / runHeadlessStreaming()
  -> ask()
  -> QueryEngine.submitMessage()
  -> query()
  -> queryLoop()
  -> runTools()
  -> runToolUse()
```

这篇不要死抠细节，重点是知道每层负责什么。

### 2. 再确定调试入口

[phase-3-dev-headless-core-usage.md](phase-3-dev-headless-core-usage.md)

这篇解决“怎么跑、怎么下断点、preset 是什么”的问题。

当前建议统一用：

```bash
bun run dev:headless-core:inspect --preset core_loop
```

或者按场景切：

```bash
bun run dev:headless-core:inspect --preset bash_pwd
bun run dev:headless-core:inspect --preset core_loop
bun run dev:headless-core:inspect --preset agent_task
bun run dev:headless-core:inspect --preset permission_probe
bun run dev:headless-core:inspect --preset compact_probe
```

### 3. 看 `ask()` 到 `submitMessage()`

[phase-2-ask-submitMessage-deep-dive.md](phase-2-ask-submitMessage-deep-dive.md)

这篇是从外层进入 `QueryEngine` 的主文档。

你要重点看：

```text
ask() 为什么很薄
QueryEngine 持有哪些状态
submitMessage() 如何处理一轮用户输入
processUserInput() 产出的消息如何进入 messages
systemPrompt / userContext / systemContext 怎么传给 query()
query() 返回的内部消息如何被 submitMessage() 转成 SDK 输出
```

### 4. 单独看输入处理

[phase-2-processUserInputBase-deep-dive.md](phase-2-processUserInputBase-deep-dive.md)

这篇只解决一个问题：

```text
用户输入 input / pastedContents / slash command / 图片
如何被转换成内部 Message[]
```

它适合在你已经看过 `submitMessage()` 第一次调用 `processUserInput()` 后再读。

### 5. 最后看核心 agent 状态机

[phase-4-query-loop.md](phase-4-query-loop.md)

这篇是最重的文档，也是最核心的文档。

不要一开始就看。先把前面几层读顺，再看：

```text
QueryParams 变量词典
State 变量词典
messagesForQuery 如何生成
deps.callModel() 如何进入模型层
assistantMessages / toolUseBlocks / toolResults 如何接力
没有 tool_use 时如何结束
有 tool_use 时如何执行工具并构造下一轮 State
```

## 按问题查

### 图片输入

[phase-2-processUserInput-image-debug.md](phase-2-processUserInput-image-debug.md)

只在你调图片链路时看。它解释：

```text
input 是 image block 时怎么走
pastedContents 里有图片时怎么走
统一 preset 后怎么触发图片场景
断点应该看哪些变量
```

### 调试断点清单

[phase-3-debug-checklist.md](phase-3-debug-checklist.md)

忘记断点或变量时查这篇。它不是学习主文档。

### `runHeadlessStreaming()` 外层编排

[phase-3-runHeadlessStreaming.md](phase-3-runHeadlessStreaming.md)

这篇很长。只有当你想理解 `print.ts` 里的这些内容时再看：

```text
输入事件循环
命令队列
control_request / control_response
interrupt
run() 主执行器
ask() 外层如何消费消息
后台任务和 finally 清理
```

## 旧版总览和可跳读文档

这些文档不删除，但不建议现在细读。

[phase-2-conversation-loop.md](phase-2-conversation-loop.md)

旧版对话循环总览。现在大部分内容已经被 `phase-2-ask-submitMessage-deep-dive.md` 和 `phase-4-query-loop.md` 覆盖。

[phase-2-qa.md](phase-2-qa.md)

早期 Q&A。现在更适合作为历史补充。

[phase-1-startup-flow.md](phase-1-startup-flow.md)

CLI 启动流程。只有当你要理解 `cli.tsx`、`main.tsx`、REPL UI 启动时再看。

[phase-1-qa.md](phase-1-qa.md)

第一阶段 Q&A。按需查。

## 推荐阅读顺序

第一次读：

```text
1. phase-3-headless-agent-tool-flow.md
2. phase-3-dev-headless-core-usage.md
3. phase-2-ask-submitMessage-deep-dive.md
4. phase-2-processUserInputBase-deep-dive.md
5. phase-4-query-loop.md
```

调试时：

```text
1. phase-3-dev-headless-core-usage.md
2. phase-3-debug-checklist.md
3. 当前断点命中的深挖文档
```

看图片时：

```text
1. phase-2-processUserInputBase-deep-dive.md
2. phase-2-processUserInput-image-debug.md
```

看外层 headless 协议时：

```text
1. phase-3-headless-agent-tool-flow.md
2. phase-3-runHeadlessStreaming.md
```

## 当前还缺什么

已经补了两个配套索引：

```text
glossary.md
  高频概念词典

source-map.md
  源码文件地图
```

后面如果继续补，建议只补小主题，不再写大而全文档。

优先级：

```text
1. StreamingToolExecutor 专题
2. toolExecution / permission 专题
3. claude.ts stream event 转换专题
4. prompt cache / dynamic system prompt 专题
```
