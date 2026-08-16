import { tmpdir } from 'node:os'

import { type ToolResultEvent } from '@earendil-works/pi-coding-agent'
import { Effect, FileSystem, Path } from 'effect'
import picomatch from 'picomatch'
import { afterEach } from 'vitest'

import { register as registerRules } from '#features/rules/index'
import { asResult } from '#tests/utils/casts'
import { describe, expect, it, promiseFromEffect } from '#tests/utils/effect'
import { createFakePi } from '#tests/utils/fake_pi'
import { runtime } from '#tests/utils/runtime'

const globParityCases: readonly (readonly [pattern: string, candidate: string, expected: boolean])[] = [
  ['*', '.foo', true],
  ['*.ts', '.hidden.ts', true],
  ['**', '.hidden', true],
  ['src/**', 'src/.foo', true],
  ['src/**', 'src/nested/file.ts', true],
  ['**/*.ts', 'a/.b.ts', true],
  ['**/*.ts', 'main.ts', true],
  ['src/*.ts', 'src/main.ts', true],
  ['src/*.ts', 'src/lib/main.ts', false],
  ['src/?ain.ts', 'src/main.ts', true],
  ['src/?ain.ts', 'src/.ain.ts', true],
  ['src/?ain.ts', 'src/xxain.ts', false],
  ['src/{a,b}.ts', 'src/a.ts', true],
  ['src/{a,b}.ts', 'src/b.ts', true],
  ['src/{a,b}.ts', 'src/c.ts', false],
  ['*.md', 'README.md', true],
  ['*.md', 'docs/README.md', false],
  ['!src/generated/**', 'src/generated/output.ts', true],
  ['!*.md', '.notes.md', true],
  ['/config/**', 'config/settings.ts', true],
  ['src/**', 'test/main.ts', false],
]

const matchGlob = (pattern: string, candidate: string): boolean => picomatch(pattern, { dot: true })(candidate)

const preparedPattern = (pattern: string): string => {
  const withoutNegation = pattern.startsWith('!') ? pattern.slice(1) : pattern
  return pattern.startsWith('!') ? withoutNegation : withoutNegation.replace(/^\//, '')
}

const fixtureRoots = new Set<string>()

afterEach(() =>
  runtime
    .runPromise(
      Effect.forEach(fixtureRoots, (root) => FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.remove(root, { force: true, recursive: true }))), {
        concurrency: 'unbounded',
      })
    )
    .finally(() => fixtureRoots.clear())
)

interface ToolResult {
  content: { type: string; text: string }[]
}

const createFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectory({ directory: tmpdir(), prefix: 'pi-glob-parity-' })
  fixtureRoots.add(root)
  const homeDirectory = path.join(root, 'home')
  const projectDirectory = path.join(root, 'project')
  yield* Effect.all([fs.makeDirectory(homeDirectory, { recursive: true }), fs.makeDirectory(projectDirectory, { recursive: true })])

  const fakePi = createFakePi()
  registerRules(fakePi.pi, runtime, { homeDirectory })
  const invoke = (event: ToolResultEvent): Promise<ToolResult | undefined> =>
    promiseFromEffect(
      Effect.promise(() => fakePi.emit('tool_result', event, { cwd: projectDirectory, isProjectTrusted: () => true })).pipe(
        Effect.map((results) => asResult<ToolResult | undefined>(results[0]))
      )
    )

  return { fs, invoke, path, projectDirectory }
})

const readEvent = (path: string): ToolResultEvent => ({
  content: [{ text: 'file contents', type: 'text' }],
  details: undefined,
  input: { path },
  isError: false,
  toolCallId: 'glob-parity',
  toolName: 'read',
  type: 'tool_result',
})

describe('rule-path matcher parity', () => {
  it('records current matcher behavior', () => {
    for (const [pattern, candidate, expected] of globParityCases) {
      expect(matchGlob(preparedPattern(pattern), candidate)).toBe(expected)
    }
  })

  it.effect('preserves rule negation, basename, and leading-slash behavior end to end', () =>
    Effect.gen(function* () {
      const fixture = yield* createFixture
      const rulesDirectory = fixture.path.join(fixture.projectDirectory, '.agents/rules')
      yield* fixture.fs.makeDirectory(rulesDirectory, { recursive: true })
      yield* Effect.all([
        fixture.fs.writeFileString(fixture.path.join(rulesDirectory, 'basename.md'), '---\npaths: [*.md]\n---\nBasename rule'),
        fixture.fs.writeFileString(fixture.path.join(rulesDirectory, 'negated.md'), '---\npaths: [src/**, !src/generated/**]\n---\nNegated rule'),
        fixture.fs.writeFileString(fixture.path.join(rulesDirectory, 'rooted.md'), '---\npaths: [/config/**]\n---\nRooted rule'),
      ])

      const basename = yield* Effect.promise(() => fixture.invoke(readEvent('docs/guide.md')))
      expect(basename?.content.at(-1)?.text).toContain('Basename rule')

      const included = yield* Effect.promise(() => fixture.invoke(readEvent('src/main.ts')))
      expect(included?.content.at(-1)?.text).toContain('Negated rule')

      const excluded = yield* Effect.promise(() => fixture.invoke(readEvent('src/generated/main.ts')))
      expect(excluded).toBeUndefined()

      const rooted = yield* Effect.promise(() => fixture.invoke(readEvent('config/settings.ts')))
      expect(rooted?.content.at(-1)?.text).toContain('Rooted rule')

      yield* Effect.all([
        fixture.fs.writeFileString(fixture.path.join(rulesDirectory, 'dotfile-basename.md'), '---\npaths: [*.ts]\n---\nDotfile basename rule'),
        fixture.fs.writeFileString(fixture.path.join(rulesDirectory, 'dotfile-nested.md'), '---\npaths: [src/**]\n---\nDotfile nested rule'),
      ])

      const dotfileBasename = yield* Effect.promise(() => fixture.invoke(readEvent('.hidden.ts')))
      expect(dotfileBasename?.content.at(-1)?.text).toContain('Dotfile basename rule')

      const dotfileNested = yield* Effect.promise(() => fixture.invoke(readEvent('src/.hidden.ts')))
      expect(dotfileNested?.content.at(-1)?.text).toContain('Dotfile nested rule')
    })
  )
})
