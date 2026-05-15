#!/usr/bin/env bun
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'tmp/agent-loop-debug-fixture')

const files: Record<string, string> = {
  'package.json': json({
    name: 'agent-loop-debug-fixture',
    version: '0.0.0',
    type: 'module',
    scripts: { typecheck: 'tsc --noEmit --project tsconfig.json' },
  }),
  'tsconfig.json': json({
    compilerOptions: {
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
    },
    include: ['src/**/*.ts'],
  }),
  'src/slug.ts': `import { readFileSync } from 'node:fs'
import { basename } from 'node:path'                              

export function slugify(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}
`,
  'src/format.ts': `import { randomUUID } from 'node:crypto'
import { inspect } from 'node:util'
import { slugify } from './slug'

export function formatTitle(input: string): string {
  return slugify(input).toUpperCase()
}
`,
  'src/report.ts': `import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { formatTitle } from './format'

export function buildReport(title: string): string {
  return \`Report: \${formatTitle(title)}\`
}
`,
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

async function resetFixture(): Promise<void> {
  await rm(fixture, { recursive: true, force: true })
  for (const [path, content] of Object.entries(files)) {
    const fullPath = join(fixture, path)
    await mkdir(dirname(fullPath), { recursive: true })
    await Bun.write(fullPath, content)
  }
}

await resetFixture()

const prompt =
  '帮我找到 tmp/agent-loop-debug-fixture 项目里所有未使用的导入语句，然后删掉它们。'

const result = Bun.spawnSync(
  [
    'bun',
    'run',
    'dev:inspect',
    '--',
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--max-turns',
    '8',
    '--permission-mode',
    'acceptEdits',
    '--debug-file',
    'tmp/agent-loop-debug.log',
    prompt,
  ],
  {
    cwd: root,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  },
)

process.exit(result.exitCode ?? 0)
