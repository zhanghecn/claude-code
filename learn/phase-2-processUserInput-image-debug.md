# `processUserInputBase()` 图片分支调试手册

这篇不再讲整体原理。

它只解决一个具体问题：

你现在用的这些命令：

- `bun run dev:headless-core:inspect`
- `bun run scripts/dev-headless-core-debug.ts --preset bash_pwd`
- `bun run scripts/dev-headless-core-debug.ts --preset core_loop`
- `bun run scripts/dev-headless-core-debug.ts --preset agent_task`
- `bun run scripts/dev-headless-core-debug.ts --preset permission_probe`
- `bun run scripts/dev-headless-core-debug.ts --preset compact_probe`

为什么都看不到图片相关处理。

以及：

怎样稳定打进 `processUserInputBase()` 里的图片分支。

---

## 1. 先说结论

你原来的 headless preset 之所以看不到图片，不是你断点打错了。

而是那条链路本身就在喂“纯字符串 prompt”。

也就是说，它最多只能把下面这种输入送进去：

```ts
input = "帮我看一下 scripts/dev-headless-core.ts"
```

但图片相关分支真正想看到的是另外两类数据：

### 第一类：`input` 本身就是内容块数组

例如：

```ts
input = [
  { type: "image", source: { ... } },
  { type: "text", text: "请描述这张图" },
]
```

这会命中：

- `typeof input !== "string"`
- 遍历 `input`
- 对 `image block` 做 `maybeResizeAndDownsampleImageBlock()`
- 重新计算 `inputString`
- 填 `precedingInputBlocks`

### 第二类：`pastedContents` 里有图片

例如：

```ts
pastedContents = {
  1: {
    id: 1,
    type: "image",
    content: "<base64>",
    mediaType: "image/png",
    filename: "tiny.png",
  },
}
```

这会命中：

- `imageContents`
- `imagePasteIds`
- `storeImages()`
- `imageProcessingResults`
- `imageContentBlocks`

而你原来的 `dev-headless-core` preset，没有地方帮你构造这两类数据。

所以你当然看不到图片路径。

---

## 2. 现在统一到 `--preset`

入口还是你原来的：

- `bun run dev:headless-core`
- `bun run dev:headless-core:inspect`

只是现在 `--preset` 不只支持普通 headless prompt 预设，
也支持图片专用 preset。

当你指定这些图片 preset 时：

- `image_block`
- `image_only_block`
- `pasted_image`
- `mixed_block_and_paste`

`scripts/dev-headless-core.ts` 不会再单独调用 `processUserInput()`。

它会继续走现有整条 headless 主链：

```text
cli.tsx
  -> main.tsx
  -> print.ts
  -> ask()
  -> QueryEngine.submitMessage()
  -> processUserInput()
  -> processUserInputBase()
  -> query()
```

区别只是：

- 普通 preset 通过命令行参数把纯字符串 prompt 传进去
- 图片 preset 通过 `--input-format stream-json` + stdin，把结构化用户消息传进去

所以你测到的仍然是“从头到尾”的真实链路，不是单独分叉的短路调用。

---

## 3. 怎么跑

这篇的目标是调试，不只是运行。

所以如果你要下断点，默认都应该用：

```bash
bun run dev:headless-core:inspect --preset <name>
```

原因很简单：

- `dev:headless-core` 只是直接开跑
- `dev:headless-core:inspect` 才会让真正执行代码的子 Bun 进程带上 `--inspect-wait`
- 没有 `--inspect-wait`，等你 VS Code attach 上去时，`processUserInputBase()` 往往已经跑过去了

所以：

- 只想看脚本打印结果，可以用不带 `:inspect` 的命令
- 真正想下断点，看局部变量，一律用 `:inspect`

### 真正调试：`input` 直接带图片 block

```bash
bun run dev:headless-core:inspect --preset image_block
```

### 真正调试：只有图片，没有文字

```bash
bun run dev:headless-core:inspect --preset image_only_block
```

### 真正调试：pasted image 这条链

```bash
bun run dev:headless-core:inspect --preset pasted_image
```

### 真正调试：一次同时看两条图片来源

```bash
bun run dev:headless-core:inspect --preset mixed_block_and_paste
```

### 只想看打印结果，不下断点

```bash
bun run dev:headless-core --preset pasted_image
```

然后在 VS Code 里直接复用你现有的 attach 配置即可：

- `Attach to Bun (Headless Core)`

因为还是同一个 debug 入口：

- `ws://localhost:8888/2dc3gzl5xot`

---

## 4. 四个场景各自打到哪

| 场景 | 你最该看的分支 | 想观察什么 |
|---|---|---|
| `image_block` | `input` 是数组的那段 | `normalizedInput`、`inputString`、`precedingInputBlocks` |
| `image_only_block` | 同上 | 没有文字时，`inputString` 为什么还是允许是 `null` |
| `pasted_image` | pasted image 那段 | `imageContents`、`imagePasteIds`、`imageContentBlocks` |
| `mixed_block_and_paste` | 两段都走 | 输入里的图片和 pasted 图片最后怎样一起进入消息 |

---

## 5. 推荐断点

文件：

- `src/utils/processUserInput/processUserInput.ts`

推荐这样下：

### 断点 1：`processUserInputBase()` 开头

你先看最原始的入参：

- `input`
- `mode`
- `pastedContents`
- `skipAttachments`

这是“入口状态”。

### 断点 2：`typeof input !== "string"` 之后

只在 `image_block` / `image_only_block` 会命中。

这时重点看：

- `processedBlocks`
- `normalizedInput`
- `lastBlock`
- `inputString`
- `precedingInputBlocks`

你要在脑子里形成这个映射：

```ts
input = [image, text]
```

处理后会变成：

```ts
normalizedInput = [可能被缩放后的 image, text]
inputString = "text 里的内容"
precedingInputBlocks = [image]
```

### 断点 3：`imageContents` / `imagePasteIds`

只在 `pasted_image` / `mixed_block_and_paste` 会有意思。

你会看到：

```ts
imageContents = Object.values(pastedContents).filter(isValidImagePaste)
imagePasteIds = imageContents.map(img => img.id)
```

也就是说：

- `imageContents` 装的是“真正有效的 pasted 图片对象”
- `imagePasteIds` 装的是“这些图片的 id 列表”

### 断点 4：`imageProcessingResults`

这里是 pasted image 真正被转成 API 图片块的地方。

每一项都大概长这样：

```ts
{
  resized: {
    block: { type: "image", source: { ... } },
    dimensions: { ... }
  },
  originalDimensions: { ... },
  sourcePath: "..."
}
```

你可以把它理解成：

- 原始 pasted image 对象已经不够用了
- 这里开始进入“模型要吃的图片 block 形态”

### 断点 5：`processTextPrompt()`

最后一定要进这里看一眼。

因为这里能帮你看清楚：

- `image block` 是直接留在 `input` 里的
- `pasted image` 是通过 `imageContentBlocks` 追加进去的

这两种来源最后都会进用户消息，但来源并不一样。

---

## 6. 直接模拟一遍：`pasted_image`

假设 runner 构造的是：

```ts
input = "请描述刚粘贴的图片"

pastedContents = {
  1: {
    id: 1,
    type: "image",
    content: "<base64>",
    mediaType: "image/png",
    filename: "tiny-1.png",
    dimensions: {
      originalWidth: 1,
      originalHeight: 1,
      displayWidth: 1,
      displayHeight: 1,
    },
  },
}
```

那么 `processUserInputBase()` 里你可以按这个顺序理解：

### 第一步：先处理 `input`

因为这里的 `input` 是字符串，所以一开始：

```ts
inputString = "请描述刚粘贴的图片"
precedingInputBlocks = []
normalizedInput = "请描述刚粘贴的图片"
```

这一步还没碰图片。

### 第二步：从 `pastedContents` 里筛图片

会得到：

```ts
imageContents = [
  {
    id: 1,
    type: "image",
    content: "<base64>",
    mediaType: "image/png",
    ...
  }
]

imagePasteIds = [1]
```

这时图片还不是模型 block。

它还只是“粘贴板图片记录”。

### 第三步：落盘 + 缩放

然后它会：

1. `storeImages(pastedContents)` 把图片写到磁盘缓存
2. 把 pasted image 转成 `ImageBlockParam`
3. 交给 `maybeResizeAndDownsampleImageBlock()`

于是会得到：

```ts
imageProcessingResults = [
  {
    resized: {
      block: {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "<可能被重新编码后的 base64>",
        },
      },
      dimensions: {
        originalWidth: 1,
        originalHeight: 1,
        displayWidth: 1,
        displayHeight: 1,
      },
    },
    originalDimensions: {
      originalWidth: 1,
      originalHeight: 1,
      displayWidth: 1,
      displayHeight: 1,
    },
    sourcePath: "/.../image-cache/.../1.png",
  },
]
```

### 第四步：收集成 `imageContentBlocks`

接着会整理出：

```ts
imageContentBlocks = [
  {
    type: "image",
    source: {
      type: "base64",
      media_type: "image/png",
      data: "...",
    },
  },
]
```

这已经是后面要交给 `processTextPrompt()` 的“模型输入图片 block”了。

### 第五步：进入普通 prompt 路径

因为它不是 bash，也不是 slash command。

所以最后会走：

```ts
processTextPrompt(
  normalizedInput,
  imageContentBlocks,
  imagePasteIds,
  attachmentMessages,
  ...
)
```

代入当前场景后就是：

```ts
processTextPrompt(
  "请描述刚粘贴的图片",
  [imageBlock],
  [1],
  [],
  ...
)
```

### 第六步：生成最终 user message

因为 `imageContentBlocks.length > 0`，所以 `processTextPrompt()` 会走“文本 + 图片拼成一个 user message”的那条逻辑。

于是最后用户消息大概会长这样：

```ts
{
  type: "user",
  message: {
    role: "user",
    content: [
      { type: "text", text: "请描述刚粘贴的图片" },
      { type: "image", source: { ... } },
    ],
  },
  imagePasteIds: [1],
}
```

这就解释了一个很关键的事实：

- pasted image 最开始并不在 `input` 里
- 它是后面单独加工出来，再追加到最终 user message 里的

---

## 7. 再对比一下：`image_block`

这个场景的原始输入不是字符串，而是：

```ts
input = [
  { type: "image", source: { ... } },
  { type: "text", text: "请描述这张图" },
]
```

这时你在函数里看到的状态就不一样了：

```ts
normalizedInput = [
  { type: "image", source: { ...可能被缩放后的数据... } },
  { type: "text", text: "请描述这张图" },
]

inputString = "请描述这张图"
precedingInputBlocks = [
  { type: "image", source: { ... } },
]

imageContentBlocks = []
imagePasteIds = []
```

注意差别：

- 这里的图片一直活在 `normalizedInput` / `precedingInputBlocks` 这条线上
- 它不是从 `pastedContents` 后补出来的

所以最后进 `processTextPrompt()` 时，图片已经在 `input` 里了。

---

## 8. 你现在可以怎么学

我建议你这样走：

1. 先跑 `bun run dev:headless-core:inspect --preset image_block`
2. 只盯 `normalizedInput`、`inputString`、`precedingInputBlocks`
3. 再跑 `bun run dev:headless-core:inspect --preset pasted_image`
4. 只盯 `imageContents`、`imagePasteIds`、`imageContentBlocks`
5. 最后跑 `mixed_block_and_paste`
6. 对照最终 `result.messages`，看两种图片来源怎么合流

这样你就能不靠盲猜，直接把“图片从哪里来、在哪一步变形、最后怎么进消息”看清楚。
