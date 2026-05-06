# `processUserInputBase()` 逐段拆解

> 目标：
>
> 1. 不开调试器，也能看懂 `processUserInputBase()` 在做什么
> 2. 知道每个关键变量里装的是什么数据
> 3. 知道一条输入会在哪一步被分流成普通文本、slash command、bash 命令
> 4. 知道图片、附件、桥接输入是怎么处理的

配套源码：

- `src/utils/processUserInput/processUserInput.ts:281` `processUserInputBase()`
- `src/utils/processUserInput/processTextPrompt.ts:19` `processTextPrompt()`

---

## 1. 先用一句话抓住它

`processUserInputBase()` 不是“问模型”的函数。

它是“输入整理器”。

它接收用户刚输入的原始内容，然后回答两个问题：

1. 这条输入到底是什么类型？
2. 这条输入应该被整理成哪些内部消息？

你可以先把它理解成一个分流器：

```text
原始输入
  -> 整理文本 / 图片 / pasted 内容
  -> 判断 slash command / bash / 普通 prompt
  -> 补附件消息
  -> 返回 messages + shouldQuery
```

---

## 2. 它的输入和输出

函数签名在 [processUserInput.ts](/home/zhangxuan/project/ai/claude-code/src/utils/processUserInput/processUserInput.ts#L281)。

先别被长参数列表吓到，最常用的输入你只要先记这些：

| 参数 | 先把它理解成什么 |
|---|---|
| `input` | 用户刚输入的内容。可能是字符串，也可能是内容块数组 |
| `mode` | 当前输入模式。常见的是 `prompt`，也可能是 `bash` |
| `context` | 当前对话的运行上下文 |
| `messages` | 之前这段会话已有的消息历史 |
| `uuid` | 这条输入自己的 id |
| `skipSlashCommands` | 是否把 `/xxx` 当普通文本处理 |
| `bridgeOrigin` | 这条输入是不是从远程桥接过来的 |
| `isMeta` | 这条输入是不是“对模型可见、对用户隐藏”的系统消息 |

它返回的是：

```ts
{
  messages: [...],
  shouldQuery: true | false,
  ...
}
```

最重要的还是两个字段：

- `messages`
  这条输入整理后得到的内部消息数组

- `shouldQuery`
  后面要不要真的进 `query()` 去问模型

---

## 3. 先看骨架

把 `processUserInputBase()` 压缩成最核心的骨架，大概是这样：

```ts
async function processUserInputBase(...) {
  // 1. 先把 input 整理成统一形态
  // 2. 处理 pasted 图片
  // 3. 处理 bridge slash command 特例
  // 4. 处理 ultraplan 特例
  // 5. 提取 attachmentMessages
  // 6. 如果是 bash 模式，走 processBashCommand()
  // 7. 如果是 slash command，走 processSlashCommand()
  // 8. 否则走普通文本 processTextPrompt()
  // 9. 最后补 image metadata 消息
}
```

所以读这个函数时，不要把它当成一条直线。

它更像一条岔路很多的流程图。

---

## 4. 第一批局部变量到底装什么

源码在 [processUserInput.ts](/home/zhangxuan/project/ai/claude-code/src/utils/processUserInput/processUserInput.ts#L300)：

```ts
let inputString: string | null = null
let precedingInputBlocks: ContentBlockParam[] = []
const imageMetadataTexts: string[] = []
let normalizedInput: string | ContentBlockParam[] = input
```

这四个变量是整个函数最重要的入门变量。

### 4.1 `inputString`

作用：

- 尽量提取出“主文本输入”

它不是永远都有值。

比如：

- 如果 `input` 是 `"hello"`，那 `inputString = "hello"`
- 如果 `input` 是一个数组，最后一个 block 是 text，也会把那段 text 提出来
- 如果根本没有 text block，可能就是 `null`

你可以把它理解成：

- “我后面要判断 slash command / bash / prompt 时，最方便拿来判断的那段文本”

### 4.2 `precedingInputBlocks`

作用：

- 记录主文本前面的那些内容块

例如：

```ts
input = [
  { type: 'image', ... },
  { type: 'text', text: '帮我看这张图' }
]
```

那最后：

- `inputString = '帮我看这张图'`
- `precedingInputBlocks = [{ type: 'image', ... }]`

所以它的意思是：

- “主文本前面还带了哪些块”

### 4.3 `imageMetadataTexts`

作用：

- 暂存图片说明文字

例如：

- 图片尺寸
- 图片来源路径

这些文字最后不会直接放进普通用户消息里，而是会被包装成 `isMeta: true` 的补充消息。

### 4.4 `normalizedInput`

作用：

- 保存“整理后的输入”

最开始它等于原始 `input`。

后面如果图片被缩放、字段被规范化，它就会被更新成处理后的版本。

所以你可以把它理解成：

- “最后真正送进普通文本路径的 input”

---

## 5. 第一段：先把 `input` 变成统一形态

源码在 [processUserInput.ts](/home/zhangxuan/project/ai/claude-code/src/utils/processUserInput/processUserInput.ts#L314)：

```ts
if (typeof input === 'string') {
  inputString = input
} else if (input.length > 0) {
  const processedBlocks: ContentBlockParam[] = []
  for (const block of input) {
    if (block.type === 'image') {
      const resized = await maybeResizeAndDownsampleImageBlock(block)
      if (resized.dimensions) {
        const metadataText = createImageMetadataText(resized.dimensions)
        if (metadataText) {
          imageMetadataTexts.push(metadataText)
        }
      }
      processedBlocks.push(resized.block)
    } else {
      processedBlocks.push(block)
    }
  }
  normalizedInput = processedBlocks

  const lastBlock = processedBlocks[processedBlocks.length - 1]
  if (lastBlock?.type === 'text') {
    inputString = lastBlock.text
    precedingInputBlocks = processedBlocks.slice(0, -1)
  } else {
    precedingInputBlocks = processedBlocks
  }
}
```

这段逻辑分成两种情况。

### 情况 A：`input` 本来就是字符串

例如：

```ts
input = "帮我总结 README"
```

跑完后：

```ts
inputString = "帮我总结 README"
precedingInputBlocks = []
normalizedInput = "帮我总结 README"
imageMetadataTexts = []
```

这时最简单。

### 情况 B：`input` 是内容块数组

例如：

```ts
input = [
  { type: 'image', source: {...} },
  { type: 'text', text: '描述这张图' }
]
```

这时会发生 3 件事：

1. 遍历每个 block
2. 遇到图片就缩放
3. 从最后一个 block 里提取主文本

处理后的状态可能是：

```ts
processedBlocks = [
  { type: 'image', source: {...缩放后的图片...} },
  { type: 'text', text: '描述这张图' }
]

normalizedInput = processedBlocks
inputString = '描述这张图'
precedingInputBlocks = [
  { type: 'image', source: {...缩放后的图片...} }
]
imageMetadataTexts = [
  '[Image 1280x720]'
]
```

### 这段最容易误解的点

`inputString` 不等于原始输入。

它更像：

- “从输入里抽出来的主要文本”

而 `normalizedInput` 才更像：

- “真正整理好的完整输入”

---

## 6. 这句报错是什么意思

源码在 [processUserInput.ts](/home/zhangxuan/project/ai/claude-code/src/utils/processUserInput/processUserInput.ts#L347)：

```ts
if (inputString === null && mode !== 'prompt') {
  throw new Error(`Mode: ${mode} requires a string input.`)
}
```

意思很简单：

- 如果当前不是普通 `prompt` 模式
- 比如是 `bash`
- 那就必须有一段文本字符串可供执行

如果 `bash` 模式下给的是纯图片数组，那当然没法执行 shell 命令，所以这里直接报错。

---

## 7. 第二段：处理 `pastedContents`

源码在 [processUserInput.ts](/home/zhangxuan/project/ai/claude-code/src/utils/processUserInput/processUserInput.ts#L351)。

这一段处理的是“额外粘贴进来的图片”，不是前面 `input` 数组里本来就有的图片 block。

先看这几个变量：

```ts
const imageContents = pastedContents
  ? Object.values(pastedContents).filter(isValidImagePaste)
  : []

const imagePasteIds = imageContents.map(img => img.id)

const storedImagePaths = pastedContents
  ? await storeImages(pastedContents)
  : new Map<number, string>()
```

### 7.1 `imageContents`

作用：

- 把 `pastedContents` 里有效的图片挑出来

### 7.2 `imagePasteIds`

作用：

- 记录这些 pasted image 的 id

这些 id 后面会被放进 `createUserMessage(...)`，用于消息存储和关联。

### 7.3 `storedImagePaths`

作用：

- 把 pasted 图片先存到磁盘
- 返回 `图片 id -> 文件路径` 的映射

后面模型和工具就能引用真实路径。

### 7.4 并行缩放 pasted 图片

接着它会并行处理所有 pasted 图片：

```ts
const imageProcessingResults = await Promise.all(
  imageContents.map(async pastedImage => {
    ...
    const resized = await maybeResizeAndDownsampleImageBlock(imageBlock)
    return {
      resized,
      originalDimensions: pastedImage.dimensions,
      sourcePath: pastedImage.sourcePath ?? storedImagePaths.get(pastedImage.id),
    }
  }),
)
```

然后再组装：

```ts
const imageContentBlocks: ContentBlockParam[] = []
```

以及继续往 `imageMetadataTexts` 里追加图片说明。

所以这一整段跑完后，和图片相关的关键变量可能长这样：

```ts
imagePasteIds = [12, 13]

imageContentBlocks = [
  { type: 'image', source: {...} },
  { type: 'image', source: {...} }
]

imageMetadataTexts = [
  '[Image 1024x768, source=/tmp/img-12.png]',
  '[Image 800x600, source=/tmp/img-13.png]'
]
```

---

## 8. 第三段：bridge 输入里的 slash command 特判

源码在 [processUserInput.ts](/home/zhangxuan/project/ai/claude-code/src/utils/processUserInput/processUserInput.ts#L428)。

先看变量：

```ts
let effectiveSkipSlash = skipSlashCommands
```

它的意思是：

- 最终到底要不要跳过 slash command 识别

然后进入这个判断：

```ts
if (bridgeOrigin && inputString !== null && inputString.startsWith('/')) {
  ...
}
```

也就是说，这一段只处理：

- 远程桥接过来的输入
- 而且文本以 `/` 开头

### 8.1 安全命令

如果这个命令是 bridge-safe：

```ts
if (isBridgeSafeCommand(cmd)) {
  effectiveSkipSlash = false
}
```

效果是：

- 虽然原来 `skipSlashCommands` 可能是 `true`
- 但这里把最终值改成 `false`
- 下面的 slash command 分支就能进去了

### 8.2 不安全命令

如果命令存在，但不允许远程执行：

```ts
return {
  messages: [
    createUserMessage({ content: inputString, uuid }),
    createCommandInputMessage(`<local-command-stdout>${msg}</local-command-stdout>`),
  ],
  shouldQuery: false,
  resultText: msg,
}
```

这时不会再往下走了。

直接返回：

- 一条 user message
- 一条本地命令输出消息
- `shouldQuery: false`

### 8.3 模拟一组 bridge 数据

假设：

```ts
bridgeOrigin = true
skipSlashCommands = true
inputString = "/config"
```

如果 `/config` 不允许远程执行，那么这里直接返回：

```ts
{
  messages: [
    user("/config"),
    localCommandStdout("/config isn't available over Remote Control.")
  ],
  shouldQuery: false,
  resultText: "/config isn't available over Remote Control."
}
```

后面就不会进入普通 prompt 了。

---

## 9. 第四段：Ultraplan 关键字改写

源码在 [processUserInput.ts](/home/zhangxuan/project/ai/claude-code/src/utils/processUserInput/processUserInput.ts#L467)。

如果输入满足一串条件，它会把普通文本改写成：

```ts
/ultraplan ...
```

然后直接调用：

```ts
processSlashCommand(...)
```

你可以把这一段理解成：

- “不是用户真的输入了 slash command”
- “而是系统检测到关键字后，自动把普通文本路由成 slash command”

这不是主线逻辑，你先知道它是一个“特殊改写入口”就够了。

---

## 10. 第五段：决定要不要先提附件

源码在 [processUserInput.ts](/home/zhangxuan/project/ai/claude-code/src/utils/processUserInput/processUserInput.ts#L496)：

```ts
const shouldExtractAttachments =
  !skipAttachments &&
  inputString !== null &&
  (mode !== 'prompt' || effectiveSkipSlash || !inputString.startsWith('/'))
```

这一句可以拆成白话：

只有在这些条件都满足时，才会先提附件：

1. 没有显式禁用附件
2. 有文本输入
3. 当前这条输入不是“马上要交给 slash command 自己处理”的那种情况

然后：

```ts
const attachmentMessages = shouldExtractAttachments
  ? await toArray(getAttachmentMessages(...))
  : []
```

### `attachmentMessages` 是什么

它是一个数组。

里面装的不是“用户主消息”，而是系统自动补上的上下文消息。

例如可能有：

- IDE 选区
- 文件上下文
- `@agent-xxx` 提及
- 其他自动附加上下文

### 模拟一个普通 prompt 的附件结果

假设用户输入：

```text
帮我看看这个函数
```

IDE 当前选中了一段代码。

那么这里可能得到：

```ts
attachmentMessages = [
  {
    type: 'attachment',
    attachment: {
      type: 'ide_selection',
      content: 'function foo() { ... }'
    }
  }
]
```

后面普通文本路径会把这条 attachment 一起带上。

---

## 11. 第六段：bash 模式分流

源码在 [processUserInput.ts](/home/zhangxuan/project/ai/claude-code/src/utils/processUserInput/processUserInput.ts#L516)：

```ts
if (inputString !== null && mode === 'bash') {
  const { processBashCommand } = await import('./processBashCommand.js')
  return addImageMetadataMessage(
    await processBashCommand(
      inputString,
      precedingInputBlocks,
      attachmentMessages,
      context,
      setToolJSX,
    ),
    imageMetadataTexts,
  )
}
```

意思是：

- 如果当前是 bash 模式
- 并且已经拿到了文本输入
- 那就直接交给 `processBashCommand()`

这时 `processUserInputBase()` 自己不再继续处理。

### 这一刻变量通常长什么样

例如：

```ts
mode = 'bash'
input = 'ls -la'

inputString = 'ls -la'
precedingInputBlocks = []
attachmentMessages = []
imageMetadataTexts = []
```

这时就直接走 bash 分支。

---

## 12. 第七段：slash command 分流

源码在 [processUserInput.ts](/home/zhangxuan/project/ai/claude-code/src/utils/processUserInput/processUserInput.ts#L531)：

```ts
if (
  inputString !== null &&
  !effectiveSkipSlash &&
  inputString.startsWith('/')
) {
  const { processSlashCommand } = await import('./processSlashCommand.js')
  const slashResult = await processSlashCommand(...)
  return addImageMetadataMessage(slashResult, imageMetadataTexts)
}
```

进入这一段的条件很明确：

1. 有文本输入
2. 没有被要求跳过 slash command
3. 文本以 `/` 开头

### 这时变量一般是什么样

例如：

```ts
input = '/help'
mode = 'prompt'
effectiveSkipSlash = false
attachmentMessages = []
```

那这里就会直接进：

```ts
processSlashCommand('/help', ...)
```

然后返回 slash command 的处理结果。

---

## 13. 第八段：普通文本路径

如果前面所有特殊分支都没进，最后就走普通文本路径。

源码在 [processUserInput.ts](/home/zhangxuan/project/ai/claude-code/src/utils/processUserInput/processUserInput.ts#L576)：

```ts
return addImageMetadataMessage(
  processTextPrompt(
    normalizedInput,
    imageContentBlocks,
    imagePasteIds,
    attachmentMessages,
    uuid,
    permissionMode,
    isMeta,
  ),
  imageMetadataTexts,
)
```

这句话可以拆成两层：

1. `processTextPrompt(...)`
   负责把普通用户输入变成 `UserMessage + attachmentMessages`

2. `addImageMetadataMessage(...)`
   如果前面收集到了图片说明文字，再额外补一条 `isMeta` 消息

---

## 14. `processTextPrompt()` 到底产出什么

源码在 [processTextPrompt.ts](/home/zhangxuan/project/ai/claude-code/src/utils/processUserInput/processTextPrompt.ts#L19)。

### 最普通的情况：纯文本

核心代码：

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

如果输入是：

```ts
input = "帮我总结 README"
attachmentMessages = [
  attachment("IDE 选区 ...")
]
```

那输出大概是：

```ts
{
  messages: [
    user("帮我总结 README"),
    attachment("IDE 选区 ...")
  ],
  shouldQuery: true
}
```

### 有 pasted image 的情况

如果 `imageContentBlocks.length > 0`，它会把文本和图片塞进同一条 user message：

```ts
const userMessage = createUserMessage({
  content: [...textContent, ...imageContentBlocks],
  uuid,
  imagePasteIds: ...,
  permissionMode,
  isMeta: isMeta || undefined,
})
```

例如：

```ts
textContent = [{ type: 'text', text: '描述这张图' }]
imageContentBlocks = [{ type: 'image', ... }]
```

最终 userMessage 的 `content` 会是：

```ts
[
  { type: 'text', text: '描述这张图' },
  { type: 'image', ... }
]
```

---

## 15. 最后一层：`addImageMetadataMessage()`

源码在 [processUserInput.ts](/home/zhangxuan/project/ai/claude-code/src/utils/processUserInput/processUserInput.ts#L591)：

```ts
function addImageMetadataMessage(result, imageMetadataTexts) {
  if (imageMetadataTexts.length > 0) {
    result.messages.push(
      createUserMessage({
        content: imageMetadataTexts.map(text => ({ type: 'text', text })),
        isMeta: true,
      }),
    )
  }
  return result
}
```

这一步很多人第一次看会漏掉。

它的意思是：

- 如果前面收集到了图片说明文字
- 就额外补一条隐藏消息

注意这条消息是：

```ts
isMeta: true
```

也就是说：

- 给模型看
- 但不是普通用户输入文本

### 模拟一下最终结果

假设：

```ts
processTextPrompt(...) 返回：
{
  messages: [
    user([
      { type: 'text', text: '描述这张图' },
      { type: 'image', ... }
    ])
  ],
  shouldQuery: true
}

imageMetadataTexts = [
  '[Image 1024x768, source=/tmp/img.png]'
]
```

那最终会变成：

```ts
{
  messages: [
    user([
      { type: 'text', text: '描述这张图' },
      { type: 'image', ... }
    ]),
    user(
      [{ type: 'text', text: '[Image 1024x768, source=/tmp/img.png]' }],
      isMeta=true
    )
  ],
  shouldQuery: true
}
```

---

## 16. 用 4 组完整模拟数据把它走一遍

下面是最重要的部分。

你如果只想靠阅读就看懂变量流转，重点看这里。

### 场景 A：最普通的纯文本输入

原始输入：

```ts
input = "帮我总结 README"
mode = "prompt"
pastedContents = undefined
skipSlashCommands = false
bridgeOrigin = false
```

变量流转：

```ts
初始:
inputString = null
precedingInputBlocks = []
imageMetadataTexts = []
normalizedInput = input

处理 input 后:
inputString = "帮我总结 README"
precedingInputBlocks = []
normalizedInput = "帮我总结 README"

处理 pastedContents 后:
imageContentBlocks = []
imagePasteIds = []
attachmentMessages = []    // 假设没提到任何附件

分流判断:
不是 bash
不是 slash command

走 processTextPrompt 后:
result = {
  messages: [user("帮我总结 README")],
  shouldQuery: true
}

addImageMetadataMessage 后:
不变
```

最终返回：

```ts
{
  messages: [user("帮我总结 README")],
  shouldQuery: true
}
```

### 场景 B：普通文本 + pasted 图片

原始输入：

```ts
input = "描述这张图"
mode = "prompt"
pastedContents = {
  12: {
    id: 12,
    mediaType: "image/png",
    content: "...base64...",
    dimensions: { width: 1024, height: 768 }
  }
}
```

变量流转：

```ts
处理 input 后:
inputString = "描述这张图"
normalizedInput = "描述这张图"

处理 pastedContents 后:
imagePasteIds = [12]
imageContentBlocks = [
  { type: 'image', source: {...} }
]
imageMetadataTexts = [
  "[Image 1024x768]"
]

分流判断:
不是 bash
不是 slash command

走 processTextPrompt 后:
result = {
  messages: [
    user([
      { type: 'text', text: '描述这张图' },
      { type: 'image', source: {...} }
    ])
  ],
  shouldQuery: true
}

addImageMetadataMessage 后:
result.messages 末尾再加一条 isMeta 消息
```

最终返回：

```ts
{
  messages: [
    user([text("描述这张图"), image(...) ]),
    user([text("[Image 1024x768]")], isMeta=true)
  ],
  shouldQuery: true
}
```

### 场景 C：slash command

原始输入：

```ts
input = "/help"
mode = "prompt"
skipSlashCommands = false
bridgeOrigin = false
```

变量流转：

```ts
inputString = "/help"
effectiveSkipSlash = false
attachmentMessages = []

分流判断:
不是 bash
是 slash command

直接走 processSlashCommand("/help", ...)
```

此时 `processUserInputBase()` 不再继续往普通 prompt 走。

它会直接把 `processSlashCommand()` 的结果返回。

### 场景 D：bridge 远程输入了一个不安全 slash command

原始输入：

```ts
input = "/config"
mode = "prompt"
skipSlashCommands = true
bridgeOrigin = true
```

变量流转：

```ts
inputString = "/config"
effectiveSkipSlash = true

进入 bridge 特判:
解析出 /config
发现它不是 bridge-safe

直接 return {
  messages: [
    user("/config"),
    localCommandStdout("/config isn't available over Remote Control.")
  ],
  shouldQuery: false,
  resultText: "/config isn't available over Remote Control."
}
```

这时不会进 `processSlashCommand()`，也不会进 `processTextPrompt()`。

---

## 17. 把整个函数重新翻译成白话

如果把 `processUserInputBase()` 全部翻译成白话，大概就是：

1. 先看看输入是字符串还是内容块数组
2. 如果里面有图片，先缩放一下，再把文本部分提出来
3. 如果另外贴了 pasted 图片，也先处理掉
4. 如果这是桥接输入，还要检查 `/xxx` 能不能当命令跑
5. 再决定要不要先自动补附件
6. 如果当前模式是 bash，就去 bash 分支
7. 如果输入长得像 slash command，就去 slash command 分支
8. 其他情况都当普通 prompt，走 `processTextPrompt()`
9. 如果前面收集了图片说明，再补一条 `isMeta` 消息

---

## 18. 你读这个函数时最该盯住的变量

如果你下次再读源码，只盯这 8 个变量就够了：

| 变量 | 你应该怎么理解它 |
|---|---|
| `inputString` | 主文本 |
| `precedingInputBlocks` | 主文本前面的内容块 |
| `normalizedInput` | 整理后的完整输入 |
| `imageMetadataTexts` | 图片说明文字 |
| `imageContentBlocks` | 真正给模型看的图片块 |
| `effectiveSkipSlash` | 最终是否跳过 slash command |
| `attachmentMessages` | 系统自动补上的附件消息 |
| `shouldQuery` | 后面还要不要真的问模型 |

只要这 8 个变量你能跟住，`processUserInputBase()` 就不会再像一团乱麻。

---

## 19. 和 `submitMessage()` 的衔接

在 `submitMessage()` 里，它是这样被调用的：

```ts
const {
  messages: messagesFromUserInput,
  shouldQuery,
  allowedTools,
  model: modelFromUserInput,
  resultText,
} = await processUserInput(...)
```

所以 `processUserInputBase()` 最终最关键的使命，就是先替 `submitMessage()` 产出：

```ts
messagesFromUserInput
shouldQuery
```

后面的 `submitMessage()` 才会决定：

- 直接本地返回
- 还是继续进入 `query()`

---

## 20. 最后只记这一句

`processUserInputBase()` 做的不是“回答问题”，而是“把输入整理成系统看得懂的样子，然后决定往哪条路走”。

如果你愿意，我下一篇可以继续按同样方式，把 `processSlashCommand()` 也做成这种“源码 + 变量状态模拟”的文档。
