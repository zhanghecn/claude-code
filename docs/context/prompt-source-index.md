# 提示词源码原文索引

这个文件只做一件事: 帮你从源码里定位真实提示词。主导读文档保持流程连续, 这里保存可搜索片段、源码位置和少量原文骨架。

很多提示词是模板字符串, 中间夹了变量, 不适合整段复制搜索。优先复制下面的 `rg` 命令。

## Intro

源码位置: `src/constants/prompts.ts:178-186`

```bash
rg -n "You are an interactive agent that helps users" src/constants/prompts.ts
rg -n "You must NEVER generate or guess URLs" src/constants/prompts.ts
```

源码骨架:

```ts
return `
You are an interactive agent that helps users ${outputStyleConfig !== null ? 'according to your "Output Style" below, which describes how you should respond to user queries.' : 'with software engineering tasks.'} Use the instructions below and the tools available to you to assist the user.

${CYBER_RISK_INSTRUCTION}
IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming. You may use URLs provided by the user in their messages or local files.`
```

## System Section

源码位置: `src/constants/prompts.ts:189-201`

```bash
rg -n "All text you output outside of tool use is displayed to the user" src/constants/prompts.ts
rg -n "Your tool list has two categories: core tools" src/constants/prompts.ts
rg -n "The system will automatically compress prior messages" src/constants/prompts.ts
```

## Doing Tasks

源码位置: `src/constants/prompts.ts:204-245`

```bash
rg -n "The user will primarily request you to perform software engineering tasks" src/constants/prompts.ts
rg -n "In general, do not propose changes to code you haven't read" src/constants/prompts.ts
rg -n "Before reporting a task complete, verify it actually works" src/constants/prompts.ts
rg -n "Report outcomes faithfully" src/constants/prompts.ts
```

## Actions

源码位置: `src/constants/prompts.ts:248-260`

```bash
rg -n "Carefully consider the reversibility and blast radius of actions" src/constants/prompts.ts
rg -n "Examples of the kind of risky actions that warrant user confirmation" src/constants/prompts.ts
rg -n "When you encounter an obstacle, do not use destructive actions" src/constants/prompts.ts
```

## Using Tools

源码位置: `src/constants/prompts.ts:262-289`

```bash
rg -n "Core tools \\(Read, Edit, Write, Glob, Grep, Bash" src/constants/prompts.ts
rg -n "Search before saying unknown" src/constants/prompts.ts
rg -n "Break down and manage your work" src/constants/prompts.ts
```

## Session-Specific Guidance

源码位置: `src/constants/prompts.ts:327-377`

```bash
rg -n "Session-specific guidance" src/constants/prompts.ts
rg -n "If you need the user to run a shell command themselves" src/constants/prompts.ts
rg -n "For broader codebase exploration and deep research" src/constants/prompts.ts
rg -n "The contract: when non-trivial implementation happens" src/constants/prompts.ts
```

## Communication Style

源码位置: `src/constants/prompts.ts:382-405`

```bash
rg -n "Write for a person, not a console" src/constants/prompts.ts
rg -n "Don't narrate internal machinery" src/constants/prompts.ts
rg -n "When the task is done, report the result" src/constants/prompts.ts
rg -n "Do not use a colon before tool calls" src/constants/prompts.ts
```

## Environment

源码位置: `src/constants/prompts.ts:603-662`

```bash
rg -n "You have been invoked in the following environment" src/constants/prompts.ts
rg -n "Primary working directory" src/constants/prompts.ts
rg -n "The most recent Claude model family is Claude" src/constants/prompts.ts
```

真实输出由 `envItems` 拼出:

```ts
const envItems = [
  `Primary working directory: ${cwd}`,
  [`Is a git repository: ${isGit}`],
  `Platform: ${env.platform}`,
  getShellInfoLine(),
  `OS Version: ${unameSR}`,
  modelDescription,
  knowledgeCutoffMessage,
]
```

## MCP Instructions

源码位置: `src/constants/prompts.ts:531-556`

```bash
rg -n "The following MCP servers have provided instructions" src/constants/prompts.ts
rg -n "# MCP Server Instructions" src/constants/prompts.ts
```

源码骨架:

```ts
return `# MCP Server Instructions

The following MCP servers have provided instructions for how to use their tools and resources:

${instructionBlocks}`
```

## Scratchpad

源码位置: `src/constants/prompts.ts:751-773`

```bash
rg -n "Always use this scratchpad directory" src/constants/prompts.ts
rg -n 'Only use \\`/tmp\\` if the user explicitly requests it' src/constants/prompts.ts
```

## Function Result Clearing

源码位置: `src/constants/prompts.ts:775-795`

```bash
rg -n "Old tool results will be automatically cleared from context" src/constants/prompts.ts
rg -n "When working with tool results, write down any important information" src/constants/prompts.ts
```

源码骨架:

```ts
return `# Function Result Clearing

Old tool results will be automatically cleared from context to free up space. The ${config.keepRecent} most recent results are always kept.`
```

```ts
const SUMMARIZE_TOOL_RESULTS_SECTION = `When working with tool results, write down any important information you might need later in your response, as the original tool result may be cleared later.`
```

## CLAUDE.md 注入模板

源码位置: `src/utils/api.ts:443-485`

```bash
rg -n "project-instructions" src/utils/api.ts
rg -n "As you answer the user's questions, you can use the following context" src/utils/api.ts
rg -n "this context may or may not be relevant to your tasks" src/utils/api.ts
```

源码骨架:

```ts
content: `<project-instructions>\n${claudeMd}\n</project-instructions>\n`,
```

```ts
content: `<system-reminder>\nAs you answer the user's questions, you can use the following context:\n${restEntries
  .map(([key, value]) => `# ${key}\n${value}`)
  .join('\n')}

      IMPORTANT: this context may or may not be relevant to your tasks. You should not respond to this context unless it is highly relevant to your task.\n</system-reminder>\n`,
```
