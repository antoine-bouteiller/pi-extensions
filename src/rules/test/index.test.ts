import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { type ToolResultEvent } from '@earendil-works/pi-coding-agent'

import { asResult } from '#test-utils/casts'
import { createFakePi } from '#test-utils/fake_pi'

import rulesExtension, { extractToolPaths, parseRuleFrontmatter } from '../index'

interface PromptResult {
  systemPrompt: string
}

interface ToolResult {
  content: { type: string; text: string }[]
}

const fixtureRoots = new Set<string>()

afterEach(async () => {
  await Promise.all([...fixtureRoots].map((root) => rm(root, { force: true, recursive: true })))
  fixtureRoots.clear()
})

const writeFixture = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

const createFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-rules-test-'))
  fixtureRoots.add(root)
  const homeDirectory = join(root, 'home')
  const projectDirectory = join(root, 'project')
  await Promise.all([mkdir(homeDirectory, { recursive: true }), mkdir(projectDirectory, { recursive: true })])

  const fakePi = createFakePi()
  rulesExtension(fakePi.pi, { homeDirectory })
  const context = (trusted: boolean) => ({
    cwd: projectDirectory,
    isProjectTrusted: () => trusted,
  })
  const invoke = async <Result>(name: string, event: unknown, trusted = true) => {
    const results = await fakePi.emit(name, event, context(trusted))
    return asResult<Result | undefined>(results[0])
  }

  return { fakePi, homeDirectory, invoke, projectDirectory }
}

const readEvent = (path: string): ToolResultEvent => ({
  content: [{ text: 'file contents', type: 'text' }],
  details: undefined,
  input: { path },
  isError: false,
  toolCallId: 'call-1',
  toolName: 'read',
  type: 'tool_result',
})

describe('rule parsing', () => {
  test('parses Claude paths, generic globs, comments, CRLF, and alwaysApply', () => {
    expect(
      parseRuleFrontmatter('\uFEFF---\r\npaths: ["src/a,b.ts", src/**] # comment\r\nglobs:\r\n  - "test/**"\r\nalwaysApply: true\r\n---\r\nRule')
    ).toEqual({
      alwaysApply: true,
      body: 'Rule',
      paths: ['src/a,b.ts', 'src/**', 'test/**'],
    })
  })

  test('keeps plain rules and diagnoses malformed frontmatter', () => {
    expect(parseRuleFrontmatter('Always test changes.')).toEqual({
      alwaysApply: false,
      body: 'Always test changes.',
      paths: [],
    })
    expect(parseRuleFrontmatter('---\npaths: [src/**\n---\nRule').diagnostic).toContain('Malformed frontmatter')
    expect(parseRuleFrontmatter('---\npaths: src/**').diagnostic).toContain('Missing closing frontmatter')
  })
})

describe('rule loading', () => {
  test('loads always-on .claude and .agents rules globally and locally', async () => {
    const fixture = await createFixture()
    await Promise.all([
      writeFixture(join(fixture.homeDirectory, '.claude/rules/global.md'), 'Global Claude'),
      writeFixture(join(fixture.homeDirectory, '.agents/rules/nested/global.mdc'), 'Global agents'),
      writeFixture(join(fixture.projectDirectory, '.claude/rules/project.md'), 'Project Claude'),
      writeFixture(join(fixture.projectDirectory, '.agents/rules/project.md'), 'Project agents'),
    ])

    const untrusted = await fixture.invoke<PromptResult>('before_agent_start', { systemPrompt: 'Base' }, false)
    expect(untrusted?.systemPrompt).toContain('Global Claude')
    expect(untrusted?.systemPrompt).toContain('Global agents')
    expect(untrusted?.systemPrompt).not.toContain('Project Claude')
    expect(untrusted?.systemPrompt).not.toContain('Project agents')

    const trusted = await fixture.invoke<PromptResult>('before_agent_start', {
      systemPrompt: 'Base',
    })
    expect(trusted?.systemPrompt).toContain('~/.claude/rules/global.md')
    expect(trusted?.systemPrompt).toContain('~/.agents/rules/nested/global.mdc')
    expect(trusted?.systemPrompt).toContain('.claude/rules/project.md')
    expect(trusted?.systemPrompt).toContain('.agents/rules/project.md')
    const trustedPrompt = trusted?.systemPrompt ?? ''
    expect(trustedPrompt.indexOf('Global Claude')).toBeLessThan(trustedPrompt.indexOf('Project Claude'))
  })

  test('skips malformed, escaping, and duplicate symlinked rules without following cycles', async () => {
    const fixture = await createFixture()
    const rulesDirectory = join(fixture.projectDirectory, '.agents/rules')
    const outside = join(fixture.projectDirectory, '..', 'outside.md')
    const outsideDirectory = join(fixture.projectDirectory, '..', 'outside-rules')
    await Promise.all([
      writeFixture(join(rulesDirectory, 'safe.md'), 'Safe rule'),
      writeFixture(join(rulesDirectory, 'malformed.md'), '---\npaths: [src/**\n---\nUnsafe'),
      writeFixture(outside, 'Escaped rule'),
      writeFixture(join(outsideDirectory, 'directory-escape.md'), 'Directory escaped rule'),
    ])
    await Promise.all([
      symlink(join(rulesDirectory, 'safe.md'), join(rulesDirectory, 'alias.md')),
      symlink(rulesDirectory, join(rulesDirectory, 'cycle')),
      symlink(outside, join(rulesDirectory, 'escape.md')),
      symlink(outsideDirectory, join(rulesDirectory, 'escape-directory')),
    ])

    const result = await fixture.invoke<PromptResult>('before_agent_start', {
      systemPrompt: 'Base',
    })
    expect(result?.systemPrompt.match(/Safe rule/g)).toHaveLength(1)
    expect(result?.systemPrompt).not.toContain('Unsafe')
    expect(result?.systemPrompt).not.toContain('Escaped rule')
    expect(result?.systemPrompt).not.toContain('Directory escaped rule')
  })

  test('truncates oversized rules with a pointer to the source', async () => {
    const fixture = await createFixture()
    await writeFixture(join(fixture.projectDirectory, '.agents/rules/large.md'), 'x'.repeat(13_000))

    const result = await fixture.invoke<PromptResult>('before_agent_start', {
      systemPrompt: 'Base',
    })
    expect(result?.systemPrompt).toContain('[Rule truncated. Read full rule: .agents/rules/large.md]')
    expect(result?.systemPrompt.length).toBeLessThan(13_000)
  })
})

describe('path-scoped injection', () => {
  test('injects matching scoped rules after file tools and deduplicates by target and content', async () => {
    const fixture = await createFixture()
    const rulePath = join(fixture.projectDirectory, '.agents/rules/typescript.md')
    await writeFixture(rulePath, "---\npaths: [src/**/*.ts, '!src/generated/**']\n---\nUse strict TypeScript.")

    const prompt = await fixture.invoke<PromptResult>('before_agent_start', {
      systemPrompt: 'Base',
    })
    expect(prompt?.systemPrompt).toContain('- .agents/rules/typescript.md — applies to: src/**/*.ts, !src/generated/**')
    expect(prompt?.systemPrompt).not.toContain('Use strict TypeScript.')
    const matched = await fixture.invoke<ToolResult>('tool_result', readEvent('src/lib/main.ts'))
    expect(matched?.content.at(-1)?.text).toContain('Use strict TypeScript.')
    expect(matched?.content.at(-1)?.text).toContain('matched for src/lib/main.ts')

    expect(await fixture.invoke<ToolResult>('tool_result', readEvent('src/lib/main.ts'))).toBeUndefined()
    await fixture.invoke('session_tree', {})
    const afterTreeNavigation = await fixture.invoke<ToolResult>('tool_result', readEvent('src/lib/main.ts'))
    expect(afterTreeNavigation?.content.at(-1)?.text).toContain('Use strict TypeScript.')
    expect(await fixture.invoke<ToolResult>('tool_result', readEvent('src/generated/types.ts'))).toBeUndefined()
    expect(await fixture.invoke<ToolResult>('tool_result', readEvent('README.md'))).toBeUndefined()

    await writeFixture(rulePath, '---\npaths: src/**/*.ts\n---\nUse even stricter TypeScript.')
    const changed = await fixture.invoke<ToolResult>('tool_result', readEvent('src/lib/main.ts'))
    expect(changed?.content.at(-1)?.text).toContain('Use even stricter TypeScript.')
  })

  test('atomically deduplicates concurrent matching tool results', async () => {
    const fixture = await createFixture()
    await writeFixture(join(fixture.projectDirectory, '.agents/rules/concurrent.md'), '---\npaths: src/**\n---\nConcurrent rule.')

    const results = await Promise.all([
      fixture.invoke<ToolResult>('tool_result', readEvent('src/main.ts')),
      fixture.invoke<ToolResult>('tool_result', readEvent('src/main.ts')),
    ])

    expect(results.filter((result) => result !== undefined)).toHaveLength(1)
  })

  test('does not suppress matching rules omitted by the injection budget', async () => {
    const fixture = await createFixture()
    await Promise.all(
      [1, 2, 3, 4, 5].map((number) =>
        writeFixture(join(fixture.projectDirectory, `.agents/rules/${number}.md`), `---\npaths: src/**\n---\nRule ${number}: ${'x'.repeat(11_900)}`)
      )
    )

    const first = await fixture.invoke<ToolResult>('tool_result', readEvent('src/main.ts'))
    expect(first?.content.at(-1)?.text).not.toContain('Rule 5:')

    const second = await fixture.invoke<ToolResult>('tool_result', readEvent('src/main.ts'))
    expect(second?.content.at(-1)?.text).toContain('Rule 5:')
  })

  test('keeps local scoped rules out of untrusted projects but applies global scoped rules', async () => {
    const fixture = await createFixture()
    await Promise.all([
      writeFixture(join(fixture.homeDirectory, '.claude/rules/global.md'), '---\npaths: src/**\n---\nGlobal scope'),
      writeFixture(join(fixture.projectDirectory, '.claude/rules/local.md'), '---\npaths: src/**\n---\nLocal scope'),
    ])

    const result = await fixture.invoke<ToolResult>('tool_result', readEvent('src/main.ts'), false)
    expect(result?.content.at(-1)?.text).toContain('Global scope')
    expect(result?.content.at(-1)?.text).not.toContain('Local scope')
  })

  test('extracts built-in and hashline file paths', () => {
    expect(extractToolPaths(readEvent('src/main.ts'), '/project')).toEqual(['/project/src/main.ts'])
    expect(
      extractToolPaths(
        {
          content: [],
          details: {
            sections: [{ moveDest: 'src/moved.ts', path: 'src/main.ts' }],
          },
          input: { patch: '[src/main.ts#ABCD]\nPUT 1.=1:\n+next' },
          isError: false,
          toolCallId: 'call-2',
          toolName: 'hashline_write',
          type: 'tool_result',
        },
        '/project'
      )
    ).toEqual(['/project/src/main.ts', '/project/src/moved.ts'])
    expect(
      extractToolPaths(
        {
          content: [],
          details: {},
          input: {
            patch: '[src/one.ts#ABCD]\nPUT 1.=1:\n+one\n[src/two.ts#EFGH]\nPUT 1.=1:\n+two',
          },
          isError: false,
          toolCallId: 'call-3',
          toolName: 'hashline_write',
          type: 'tool_result',
        },
        '/project'
      )
    ).toEqual(['/project/src/one.ts', '/project/src/two.ts'])
  })
})
