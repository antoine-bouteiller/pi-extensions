import { afterEach } from 'bun:test'
import { tmpdir } from 'node:os'

import { type ToolResultEvent } from '@earendil-works/pi-coding-agent'
import { promiseFromEffect, describe, expect, it } from '@tests/utils/bun_effect.js'
import { asExtensionContext, asResult } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime } from '@tests/utils/runtime.js'
import { Effect, FileSystem, Path } from 'effect'

import { makeFeature } from '@/features/rules/index.js'
import { extractToolPaths, parseRuleFrontmatter } from '@/features/rules/rules.js'

const pathService = runtime.runSync(Path.Path)
const { dirname, join } = pathService
const mkdir = (path: string, options?: { recursive?: boolean }) => FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.makeDirectory(path, options)))
const mkdtemp = (prefix: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectory({ directory: pathService.dirname(prefix), prefix: pathService.basename(prefix) }))
  )
const rm = (path: string, options?: { force?: boolean; recursive?: boolean }) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.remove(path, options)))
const symlink = (fromPath: string, toPath: string) => FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.symlink(fromPath, toPath)))
const writeFile = (path: string, data: string) => FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.writeFileString(path, data)))

interface PromptResult {
  systemPrompt: string
}

interface ToolResult {
  content: { type: string; text: string }[]
}

const fixtureRoots = new Set<string>()

afterEach(() =>
  runtime
    .runPromise(Effect.forEach(fixtureRoots, (root) => rm(root, { force: true, recursive: true }), { concurrency: 'unbounded' }))
    .finally(() => fixtureRoots.clear())
)

const writeFixture = (path: string, content: string) =>
  Effect.gen(function* () {
    yield* mkdir(dirname(path), { recursive: true })
    yield* writeFile(path, content)
  })

const createFixture = Effect.gen(function* () {
  const root = yield* mkdtemp(join(tmpdir(), 'pi-rules-test-'))
  fixtureRoots.add(root)
  const homeDirectory = join(root, 'home')
  const projectDirectory = join(root, 'project')
  yield* Effect.all([mkdir(homeDirectory, { recursive: true }), mkdir(projectDirectory, { recursive: true })], { concurrency: 'unbounded' })

  const fakePi = createFakePi()
  const feature = makeFeature({ homeDirectory })
  feature.implementation.register(fakePi.pi, runtime)
  const context = (trusted: boolean) => ({
    cwd: projectDirectory,
    isProjectTrusted: () => trusted,
  })
  const activate = (trusted = true) =>
    runtime.runPromise(
      feature.implementation.activate?.({ reason: 'startup', type: 'session_start' }, asExtensionContext(context(trusted))) ?? Effect.void
    )
  const invoke = <Result>(name: string, event: unknown, trusted = true): Promise<Result | undefined> =>
    promiseFromEffect(
      Effect.promise(() => fakePi.emit(name, event, context(trusted))).pipe(Effect.map((results) => asResult<Result | undefined>(results[0])))
    )

  return { activate, fakePi, homeDirectory, invoke, projectDirectory }
})

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
  it.effect('parses Claude paths, generic globs, comments, CRLF, and alwaysApply', () =>
    Effect.sync(() => {
      expect(
        parseRuleFrontmatter('\uFEFF---\r\npaths: ["src/a,b.ts", src/**] # comment\r\nglobs:\r\n  - "test/**"\r\nalwaysApply: true\r\n---\r\nRule')
      ).toEqual({
        alwaysApply: true,
        body: 'Rule',
        paths: ['src/a,b.ts', 'src/**', 'test/**'],
      })
    })
  )

  it.effect('keeps plain rules and diagnoses malformed frontmatter', () =>
    Effect.sync(() => {
      expect(parseRuleFrontmatter('Always test changes.')).toEqual({
        alwaysApply: false,
        body: 'Always test changes.',
        paths: [],
      })
      expect(parseRuleFrontmatter('---\npaths: [src/**\n---\nRule').diagnostic).toContain('Malformed frontmatter')
      expect(parseRuleFrontmatter('---\npaths: src/**').diagnostic).toContain('Missing closing frontmatter')
    })
  )
})

describe('rule loading', () => {
  it.effect('loads always-on .claude and .agents rules globally and locally', () =>
    Effect.gen(function* () {
      const fixture = yield* createFixture
      yield* Effect.all(
        [
          writeFixture(join(fixture.homeDirectory, '.claude/rules/global.md'), 'Global Claude'),
          writeFixture(join(fixture.homeDirectory, '.agents/rules/nested/global.mdc'), 'Global agents'),
          writeFixture(join(fixture.projectDirectory, '.claude/rules/project.md'), 'Project Claude'),
          writeFixture(join(fixture.projectDirectory, '.agents/rules/project.md'), 'Project agents'),
        ],
        { concurrency: 'unbounded' }
      )

      const untrusted = yield* Effect.promise(() => fixture.invoke<PromptResult>('before_agent_start', { systemPrompt: 'Base' }, false))
      expect(untrusted?.systemPrompt).toContain('Global Claude')
      expect(untrusted?.systemPrompt).toContain('Global agents')
      expect(untrusted?.systemPrompt).not.toContain('Project Claude')
      expect(untrusted?.systemPrompt).not.toContain('Project agents')

      const trusted = yield* Effect.promise(() =>
        fixture.invoke<PromptResult>('before_agent_start', {
          systemPrompt: 'Base',
        })
      )
      expect(trusted?.systemPrompt).toContain('~/.claude/rules/global.md')
      expect(trusted?.systemPrompt).toContain('~/.agents/rules/nested/global.mdc')
      expect(trusted?.systemPrompt).toContain('.claude/rules/project.md')
      expect(trusted?.systemPrompt).toContain('.agents/rules/project.md')
      const trustedPrompt = trusted?.systemPrompt ?? ''
      expect(trustedPrompt.indexOf('Global Claude')).toBeLessThan(trustedPrompt.indexOf('Project Claude'))
    })
  )

  it.effect('skips malformed, escaping, and duplicate symlinked rules without following cycles', () =>
    Effect.gen(function* () {
      const fixture = yield* createFixture
      const rulesDirectory = join(fixture.projectDirectory, '.agents/rules')
      const outside = join(fixture.projectDirectory, '..', 'outside.md')
      const outsideDirectory = join(fixture.projectDirectory, '..', 'outside-rules')
      yield* Effect.all(
        [
          writeFixture(join(rulesDirectory, 'safe.md'), 'Safe rule'),
          writeFixture(join(rulesDirectory, 'malformed.md'), '---\npaths: [src/**\n---\nUnsafe'),
          writeFixture(outside, 'Escaped rule'),
          writeFixture(join(outsideDirectory, 'directory-escape.md'), 'Directory escaped rule'),
        ],
        { concurrency: 'unbounded' }
      )
      yield* Effect.all(
        [
          symlink(join(rulesDirectory, 'safe.md'), join(rulesDirectory, 'alias.md')),
          symlink(rulesDirectory, join(rulesDirectory, 'cycle')),
          symlink(outside, join(rulesDirectory, 'escape.md')),
          symlink(outsideDirectory, join(rulesDirectory, 'escape-directory')),
        ],
        { concurrency: 'unbounded' }
      )

      const result = yield* Effect.promise(() =>
        fixture.invoke<PromptResult>('before_agent_start', {
          systemPrompt: 'Base',
        })
      )
      expect(result?.systemPrompt.match(/Safe rule/g)).toHaveLength(1)
      expect(result?.systemPrompt).not.toContain('Unsafe')
      expect(result?.systemPrompt).not.toContain('Escaped rule')
      expect(result?.systemPrompt).not.toContain('Directory escaped rule')
    })
  )

  it.effect('truncates oversized rules with a pointer to the source', () =>
    Effect.gen(function* () {
      const fixture = yield* createFixture
      yield* writeFixture(join(fixture.projectDirectory, '.agents/rules/large.md'), 'x'.repeat(13_000))

      const result = yield* Effect.promise(() =>
        fixture.invoke<PromptResult>('before_agent_start', {
          systemPrompt: 'Base',
        })
      )
      expect(result?.systemPrompt).toContain('[Rule truncated. Read full rule: .agents/rules/large.md]')
      expect(result?.systemPrompt.length).toBeLessThan(13_000)
    })
  )
})

describe('path-scoped injection', () => {
  it.effect('injects matching scoped rules after file tools and deduplicates by target and content', () =>
    Effect.gen(function* () {
      const fixture = yield* createFixture
      const rulePath = join(fixture.projectDirectory, '.agents/rules/typescript.md')
      yield* writeFixture(rulePath, "---\npaths: [src/**/*.ts, '!src/generated/**']\n---\nUse strict TypeScript.")

      const prompt = yield* Effect.promise(() =>
        fixture.invoke<PromptResult>('before_agent_start', {
          systemPrompt: 'Base',
        })
      )
      expect(prompt?.systemPrompt).toContain('- .agents/rules/typescript.md — applies to: src/**/*.ts, !src/generated/**')
      expect(prompt?.systemPrompt).not.toContain('Use strict TypeScript.')
      const matched = yield* Effect.promise(() => fixture.invoke<ToolResult>('tool_result', readEvent('src/lib/main.ts')))
      expect(matched?.content.at(-1)?.text).toContain('Use strict TypeScript.')
      expect(matched?.content.at(-1)?.text).toContain('matched for src/lib/main.ts')

      expect(yield* Effect.promise(() => fixture.invoke<ToolResult>('tool_result', readEvent('src/lib/main.ts')))).toBeUndefined()
      yield* Effect.promise(() => fixture.activate())
      const afterTreeNavigation = yield* Effect.promise(() => fixture.invoke<ToolResult>('tool_result', readEvent('src/lib/main.ts')))
      expect(afterTreeNavigation?.content.at(-1)?.text).toContain('Use strict TypeScript.')
      expect(yield* Effect.promise(() => fixture.invoke<ToolResult>('tool_result', readEvent('src/generated/types.ts')))).toBeUndefined()
      expect(yield* Effect.promise(() => fixture.invoke<ToolResult>('tool_result', readEvent('README.md')))).toBeUndefined()

      yield* writeFixture(rulePath, '---\npaths: src/**/*.ts\n---\nUse even stricter TypeScript.')
      const changed = yield* Effect.promise(() => fixture.invoke<ToolResult>('tool_result', readEvent('src/lib/main.ts')))
      expect(changed?.content.at(-1)?.text).toContain('Use even stricter TypeScript.')
    })
  )

  it.effect('atomically deduplicates concurrent matching tool results', () =>
    Effect.gen(function* () {
      const fixture = yield* createFixture
      yield* writeFixture(join(fixture.projectDirectory, '.agents/rules/concurrent.md'), '---\npaths: src/**\n---\nConcurrent rule.')

      const results = yield* Effect.promise(() =>
        Promise.all([
          fixture.invoke<ToolResult>('tool_result', readEvent('src/main.ts')),
          fixture.invoke<ToolResult>('tool_result', readEvent('src/main.ts')),
        ])
      )

      expect(results.filter((result) => result !== undefined)).toHaveLength(1)
    })
  )

  it.effect('does not suppress matching rules omitted by the injection budget', () =>
    Effect.gen(function* () {
      const fixture = yield* createFixture
      yield* Effect.forEach(
        [1, 2, 3, 4, 5],
        (number) =>
          writeFixture(
            join(fixture.projectDirectory, `.agents/rules/${number}.md`),
            `---\npaths: src/**\n---\nRule ${number}: ${'x'.repeat(11_900)}`
          ),
        { concurrency: 'unbounded' }
      )

      const first = yield* Effect.promise(() => fixture.invoke<ToolResult>('tool_result', readEvent('src/main.ts')))
      expect(first?.content.at(-1)?.text).not.toContain('Rule 5:')

      const second = yield* Effect.promise(() => fixture.invoke<ToolResult>('tool_result', readEvent('src/main.ts')))
      expect(second?.content.at(-1)?.text).toContain('Rule 5:')
    })
  )

  it.effect('keeps local scoped rules out of untrusted projects but applies global scoped rules', () =>
    Effect.gen(function* () {
      const fixture = yield* createFixture
      yield* Effect.all(
        [
          writeFixture(join(fixture.homeDirectory, '.claude/rules/global.md'), '---\npaths: src/**\n---\nGlobal scope'),
          writeFixture(join(fixture.projectDirectory, '.claude/rules/local.md'), '---\npaths: src/**\n---\nLocal scope'),
        ],
        { concurrency: 'unbounded' }
      )

      const result = yield* Effect.promise(() => fixture.invoke<ToolResult>('tool_result', readEvent('src/main.ts'), false))
      expect(result?.content.at(-1)?.text).toContain('Global scope')
      expect(result?.content.at(-1)?.text).not.toContain('Local scope')
    })
  )

  it.effect('extracts paths from file tools and hashline write patches', () =>
    Effect.sync(() => {
      expect(extractToolPaths(readEvent('src/main.ts'), '/project', pathService)).toEqual(['/project/src/main.ts'])
      expect(extractToolPaths(readEvent('/outside/main.ts'), '/project', pathService)).toEqual(['/outside/main.ts'])
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
            toolName: 'write',
            type: 'tool_result',
          },
          '/project',
          pathService
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
            toolName: 'write',
            type: 'tool_result',
          },
          '/project',
          pathService
        )
      ).toEqual(['/project/src/one.ts', '/project/src/two.ts'])
    })
  )
})
