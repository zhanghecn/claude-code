# `dev-headless-core-debug` 使用手册

> 目标：把 `scripts/dev-headless-core-debug.ts` 这套可断点调试脚本怎么用、怎么切提示词、该打哪些断点，全部记成一份可直接照抄的手册。

这篇不是源码原理文档。

这篇只回答 4 个问题：

```text
1. 这个脚本现在到底怎么用？
2. 我怎么切换提示词，不用记环境变量？
3. 每个预设会大概触发什么功能？
4. 我切换提示词后，应该去看哪些源码位置？
```

---

## 1. 先记最重要的一句

如果你的目标是：

```text
在 VS Code 里下断点调试 headless 核心链路
```

那你真正应该跑的是：

```bash
bun run scripts/dev-headless-core-debug.ts
```

然后再用 VS Code 的这个配置附加进去：

- [launch.json](/home/zhangxuan/project/ai/claude-code/.vscode/launch.json)
  - `Attach to Bun (Headless Core)`

也就是说，调试链路应该记成：

```text
scripts/dev-headless-core-debug.ts
  -> 设置 BUN_INSPECT
  -> import("./dev-headless-core.ts")
  -> 启动 headless CLI
  -> VS Code attach 到固定 ws 地址
```

现在你**不需要**通过 bash 环境变量切换提示词了。

最常用的写法只有两种：

```bash
bun run scripts/dev-headless-core-debug.ts --preset <预设名>
```

或者：

```bash
bun run scripts/dev-headless-core-debug.ts --prompt "你的自定义提示词"
```

如果你什么都不写：

```bash
bun run scripts/dev-headless-core-debug.ts
```

默认会走：

```text
--preset core_loop
```

---

## 2. 这个脚本做了什么

脚本位置：

- [`scripts/dev-headless-core.ts`](/home/zhangxuan/project/ai/claude-code/scripts/dev-headless-core.ts)

它做的事情很简单：

1. 注入 Bun 的 `define` 和一批默认 `feature`
2. 组装一套适合 headless 调试的默认 CLI 参数
3. 启动真正的 Claude CLI 入口：
   - [`src/entrypoints/cli.tsx`](/home/zhangxuan/project/ai/claude-code/src/entrypoints/cli.tsx)

默认参数大意是：

```text
--bare
--print
--output-format stream-json
--verbose
--permission-mode default
--max-turns 5
--allowedTools *
-- "某条默认提示词"
```

所以它本质上是一个：

```text
专门给 headless / stream-json / 调试断点准备的启动包装器
```

---

## 3. 现在最推荐的使用方式

### 3.1 最短调试命令

如果你要配合 VS Code 断点：

先在终端里运行：

```bash
bun run scripts/dev-headless-core-debug.ts --preset core_loop
```

然后在 VS Code 里选择：

- `Attach to Bun (Headless Core)`

这时断点会附加到由下面这个脚本启动的进程上：

- [`scripts/dev-headless-core-debug.ts`](/home/zhangxuan/project/ai/claude-code/scripts/dev-headless-core-debug.ts)

它本身非常简单，只做两件事：

1. 设置：

```text
process.env.BUN_INSPECT = "localhost:8888/2dc3gzl5xot"
```

2. 再加载：

- [`scripts/dev-headless-core.ts`](/home/zhangxuan/project/ai/claude-code/scripts/dev-headless-core.ts)

所以：

```text
真正决定“提示词是什么、默认参数是什么”的仍然是 dev-headless-core.ts
真正决定“VS Code 能不能 attach 成功”的是 dev-headless-core-debug.ts
```

---

### 3.2 切换内置预设

当前支持这些预设：

- `bash_pwd`
- `core_loop`
- `agent_task`
- `permission_probe`
- `compact_probe`

```bash
bun run scripts/dev-headless-core-debug.ts --preset bash_pwd
bun run scripts/dev-headless-core-debug.ts --preset core_loop
bun run scripts/dev-headless-core-debug.ts --preset agent_task
bun run scripts/dev-headless-core-debug.ts --preset permission_probe
bun run scripts/dev-headless-core-debug.ts --preset compact_probe
```

你只需要记住：

```text
--preset 预设名
```

---

### 3.3 直接写自定义提示词

写法：

```bash
bun run scripts/dev-headless-core-debug.ts --prompt "你必须真实调用 Bash 执行 pwd，然后只输出目录路径。"
```

再举一个例子：

```bash
bun run scripts/dev-headless-core-debug.ts --prompt "不要用 Bash 读取文件，必须使用 Read 工具读取 scripts/dev-headless-core.ts，并总结默认参数。"
```

你只需要记住：

```text
--prompt "你的提示词"
```

---

### 3.4 顺手改最大轮数 / 权限模式 / 允许工具

```bash
bun run scripts/dev-headless-core-debug.ts --preset compact_probe --max-turns 6
```

```bash
bun run scripts/dev-headless-core-debug.ts --preset permission_probe --permission-mode default
```

支持的包装参数：

- `--preset <name>`
- `--prompt "<text>"`
- `--max-turns <n>`
- `--permission-mode <mode>`
- `--allowed-tools <value>`

---

### 3.5 如果你真的想完全自己透传到底层 CLI

只有这种情况下才用 `--raw`：

```bash
bun run scripts/dev-headless-core-debug.ts --raw --bare --print --output-format stream-json --verbose --permission-mode default --max-turns 5 --allowedTools "*" -- "你必须真实调用 Bash 执行 pwd。"
```

建议：

```text
平时不要先用 --raw。
先用 --preset 和 --prompt。
```

---

## 4. VS Code 调试到底该怎么按

最推荐的操作顺序就是下面这 4 步：

### 第一步：终端启动可附加调试的 headless 进程

例如：

```bash
bun run scripts/dev-headless-core-debug.ts --preset core_loop
```

或者：

```bash
bun run scripts/dev-headless-core-debug.ts
```

### 第二步：打开 VS Code

打开：

- [launch.json](/home/zhangxuan/project/ai/claude-code/.vscode/launch.json)

你会看到两个 Bun attach 配置，其中 headless 相关的是：

- `Attach to Bun (Headless Core)`

### 第三步：按 F5 或手动选择附加配置

选择：

- `Attach to Bun (Headless Core)`

它会连接到：

```text
ws://localhost:8888/2dc3gzl5xot
```

这个地址正是：

- [`scripts/dev-headless-core-debug.ts`](/home/zhangxuan/project/ai/claude-code/scripts/dev-headless-core-debug.ts)

里提前写死的那个地址。

### 第四步：让 prompt 自己跑，断点自动命中

不要一开始就从入口一路 step into（单步进入）到最深处。

更好的方式是：

1. 先在关键位置下断点
2. 用预设 prompt 触发对应链路
3. 等断点自己命中

---

## 5. 每个预设是干什么的

下面不是“保证 100% 触发”的承诺。

更准确地说，它们是：

```text
尽量把模型推向某类核心链路
方便你打断点观察
```

---

### 5.1 `bash_pwd`

命令：

```bash
bun run scripts/dev-headless-core-debug.ts --preset bash_pwd
```

目的：

```text
验证最短链路：
runHeadlessStreaming -> drainCommandQueue -> ask -> queryLoop -> Bash -> result
```

更适合调：

- [`src/cli/print.ts`](/home/zhangxuan/project/ai/claude-code/src/cli/print.ts)
- [`src/QueryEngine.ts`](/home/zhangxuan/project/ai/claude-code/src/QueryEngine.ts)
- [`src/query.ts`](/home/zhangxuan/project/ai/claude-code/src/query.ts)

推荐断点：

- [`src/cli/print.ts:2145`](/home/zhangxuan/project/ai/claude-code/src/cli/print.ts#L2145)
- [`src/QueryEngine.ts:679`](/home/zhangxuan/project/ai/claude-code/src/QueryEngine.ts#L679)
- [`src/query.ts:699`](/home/zhangxuan/project/ai/claude-code/src/query.ts#L699)

---

### 5.2 `core_loop`

命令：

```bash
bun run scripts/dev-headless-core-debug.ts --preset core_loop
```

目的：

```text
尽量覆盖：
Bash + Read + Write/Edit + 最终 result
```

这是当前最推荐的默认预设。

更适合调：

- 命令如何进入 `ask()`
- 读文件缓存 `readFileState`
- 工具结果 `tool_result`
- 一轮结束后 `result` 如何生成

推荐断点：

- [`src/cli/print.ts:1931`](/home/zhangxuan/project/ai/claude-code/src/cli/print.ts#L1931)
- [`src/QueryEngine.ts:413`](/home/zhangxuan/project/ai/claude-code/src/QueryEngine.ts#L413)
- [`src/query.ts:1424`](/home/zhangxuan/project/ai/claude-code/src/query.ts#L1424)
- [`src/QueryEngine.ts:1160`](/home/zhangxuan/project/ai/claude-code/src/QueryEngine.ts#L1160)

---

### 5.3 `agent_task`

命令：

```bash
bun run scripts/dev-headless-core-debug.ts --preset agent_task
```

目的：

```text
尽量触发 Agent 工具（子 agent）
并观察后台任务完成后，task-notification 如何回流到主线程
```

更适合调：

- 后台 agent
- `task-notification`（任务通知）
- `waitingForAgents`（等待后台任务）

推荐断点：

- [`src/cli/print.ts:2013`](/home/zhangxuan/project/ai/claude-code/src/cli/print.ts#L2013)
- [`src/cli/print.ts:2370`](/home/zhangxuan/project/ai/claude-code/src/cli/print.ts#L2370)
- [`src/query.ts:1614`](/home/zhangxuan/project/ai/claude-code/src/query.ts#L1614)

注意：

```text
这个预设不是每次都保证模型一定选 AgentTool。
它只是把模型强烈往那个方向推。
```

---

### 5.4 `permission_probe`

命令：

```bash
bun run scripts/dev-headless-core-debug.ts --preset permission_probe --permission-mode default
```

目的：

```text
观察权限链路：
能不能修改文件
工具权限是 allow / deny / ask 哪种结果
```

更适合调：

- `canUseTool`
- `permission denial`（权限拒绝）
- orphaned permission（孤儿权限响应）

推荐断点：

- [`src/cli/print.ts:4280`](/home/zhangxuan/project/ai/claude-code/src/cli/print.ts#L4280)
- [`src/QueryEngine.ts:245`](/home/zhangxuan/project/ai/claude-code/src/QueryEngine.ts#L245)
- [`src/QueryEngine.ts:400`](/home/zhangxuan/project/ai/claude-code/src/QueryEngine.ts#L400)

---

### 5.5 `compact_probe`

命令：

```bash
bun run scripts/dev-headless-core-debug.ts --preset compact_probe --max-turns 6
```

目的：

```text
尽量进入更长的多轮回路，
观察 messagesForQuery、tool_result 拼接和后续递归。
```

更适合调：

- `queryLoop()` 多轮循环
- `messagesForQuery`
- `next state`
- 更长上下文下的结果流

推荐断点：

- [`src/query.ts:405`](/home/zhangxuan/project/ai/claude-code/src/query.ts#L405)
- [`src/query.ts:699`](/home/zhangxuan/project/ai/claude-code/src/query.ts#L699)
- [`src/query.ts:1758`](/home/zhangxuan/project/ai/claude-code/src/query.ts#L1758)

注意：

```text
这个预设更容易进入多轮，
但不保证一定触发 compact（压缩）。
compact 是否发生，还取决于上下文长度和当前阈值。
```

---

## 6. 我最推荐你直接复制的命令

如果你不想记概念，就按这个顺序跑：

### 6.1 先看最短 Bash 链

```bash
bun run scripts/dev-headless-core-debug.ts --preset bash_pwd
```

### 6.2 再看核心工具链

```bash
bun run scripts/dev-headless-core-debug.ts --preset core_loop
```

### 6.3 再看后台 agent / 任务通知

```bash
bun run scripts/dev-headless-core-debug.ts --preset agent_task
```

### 6.4 再看权限链路

```bash
bun run scripts/dev-headless-core-debug.ts --preset permission_probe --permission-mode default
```

### 6.5 最后看更长一点的多轮行为

```bash
bun run scripts/dev-headless-core-debug.ts --preset compact_probe --max-turns 6
```

---

## 7. 如果你就想自己临时写 prompt

下面这些可以直接复制。

### Bash 最短链

```bash
bun run scripts/dev-headless-core-debug.ts --prompt "你必须真实调用 Bash 执行 pwd，然后只输出目录路径。"
```

### 读文件链路

```bash
bun run scripts/dev-headless-core-debug.ts --prompt "不要用 Bash 读取文件，必须使用 Read 工具读取 scripts/dev-headless-core.ts，并总结默认参数。"
```

### 写文件链路

```bash
bun run scripts/dev-headless-core-debug.ts --prompt "不要用 Bash 写文件，必须使用 Write/Edit 工具把 debug-ok 写入 /tmp/claude-code-debug.txt，然后只输出文件路径。"
```

### 子 agent 链路

```bash
bun run scripts/dev-headless-core-debug.ts --prompt "请使用 Agent 工具把“总结 scripts/dev-headless-core.ts 默认行为”交给子 agent，主线程等待它完成后再汇总。"
```

---

## 8. 你最容易踩的坑

### 坑 1：以为“一个默认 prompt 能触发所有功能”

不能这么想。

因为有些功能天然依赖：

- 权限模式
- MCP 配置
- 后台 agent 是否真的被模型选中
- 当前上下文长度
- provider / 模型行为

所以更合理的目标是：

```text
用一组短 prompt，分别覆盖几个关键链路
```

---

### 坑 2：把运行脚本和调试脚本搞混

先分清：

- 运行脚本：
  - [`scripts/dev-headless-core.ts`](/home/zhangxuan/project/ai/claude-code/scripts/dev-headless-core.ts)
- 调试脚本：
  - [`scripts/dev-headless-core-debug.ts`](/home/zhangxuan/project/ai/claude-code/scripts/dev-headless-core-debug.ts)

关系是：

```text
debug 脚本
  = 先设置 inspector 地址
  + 再 import 运行脚本
```

所以：

```text
你想看日志直接跑：
dev-headless-core.ts

你想配合 VS Code 断点：
dev-headless-core-debug.ts + launch.json
```

---

### 坑 3：一上来就用 `--raw`

这会让你每次都得重打一长串参数。

建议：

```text
平时先用：
--preset
--prompt
--max-turns
--permission-mode
```

只有真的要完全自定义底层 CLI 参数时，再用：

```text
--raw
```

---

### 坑 4：看不到预期功能，就以为脚本坏了

先分清是“脚本没启动对”，还是“模型没走你想要的分支”。

最短检查顺序：

1. 先跑：

```bash
bun run scripts/dev-headless-core-debug.ts --preset bash_pwd
```

2. 看是否真正进了：

- [`src/cli/print.ts:2145`](/home/zhangxuan/project/ai/claude-code/src/cli/print.ts#L2145)
- [`src/query.ts:699`](/home/zhangxuan/project/ai/claude-code/src/query.ts#L699)

3. 如果连这条最短链都没进去，再回头查启动参数和 provider 配置。

---

## 9. 一句话总结

如果你要配合 VS Code 调试：

```bash
bun run scripts/dev-headless-core-debug.ts --preset <预设名>
```

然后在：

- [launch.json](/home/zhangxuan/project/ai/claude-code/.vscode/launch.json)

里选择：

- `Attach to Bun (Headless Core)`

附加进去。

不要先记环境变量，也不要先记 `--raw`。

先把这两种用顺，再往下调源码。
