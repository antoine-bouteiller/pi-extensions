import { tmpdir } from 'node:os'

import { describe, expect, it, promiseFromEffect } from '@tests/utils/bun_effect.js'
import { asExtensionContext, asNarrowed } from '@tests/utils/casts.js'
import { Deferred, Effect, Fiber, FileSystem, Option, Path } from 'effect'

import { loadConfig, type PlainEnglishConfig } from '@/features/plain_english/config.js'
import { makeMarkdownCommand } from '@/features/plain_english/markdown.js'
import { PiCtx, Ui, type UiShape } from '@/shared/effect/pi_services.js'

const marker = '<!-- plain-english:rewritten -->'
const modelRef = { modelId: 'rewriter', provider: 'test' }

const config = (overrides: Partial<PlainEnglishConfig> = {}): PlainEnglishConfig => ({
  ...loadConfig({ PI_PLAIN_ENGLISH_MODEL: 'test/rewriter' }),
  mdTimeoutMs: 1000,
  minChars: 1,
  ...overrides,
})

const workspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fs.makeTempDirectory({ directory: tmpdir(), prefix: 'plain-english-markdown-' })
  yield* Effect.addFinalizer(() =>
    fs.remove(directory, { force: true, recursive: true }).pipe(
      Effect.match({
        onFailure: () => undefined,
        onSuccess: () => undefined,
      })
    )
  )
  return { directory, fs, path }
})

const contextWith = (cwd: string, rewritten = 'Clearer prose', reject = false, stopReason: 'stop' | 'error' | 'aborted' = 'stop') =>
  asExtensionContext({
    cwd,
    modelRegistry: {
      complete: () =>
        reject
          ? Promise.reject(new Error('offline'))
          : Promise.resolve(asNarrowed<object, object>({ content: [{ text: rewritten, type: 'text' }], stopReason })),
      find: (provider: string, modelId: string) =>
        provider === modelRef.provider && modelId === modelRef.modelId ? asNarrowed<object, object>({}) : undefined,
    },
  })

const notifications = (): { readonly messages: { message: string; level: string }[]; readonly ui: UiShape } => {
  const messages: { message: string; level: string }[] = []
  return {
    messages,
    ui: {
      confirm: () => Effect.succeed(false),
      hasUI: Effect.succeed(true),
      notify: (message, level) => Effect.sync(() => messages.push({ level, message })),
      setStatus: () => Effect.void,
    },
  }
}

const run = (args: string, ctx: ReturnType<typeof contextWith>, ui: UiShape, command = makeMarkdownCommand({ config: config() })) =>
  command(args, ctx).pipe(Effect.provideService(PiCtx, ctx), Effect.provideService(Ui, ui))

describe('plain_english markdown command', () => {
  it.scoped('writes a sibling Markdown file, retaining frontmatter and source bytes', () =>
    Effect.gen(function* () {
      const { directory, fs, path } = yield* workspace
      const source = path.join(directory, 'guide.md')
      const input = '---\ntitle: Guide\ntags: [docs]\n---\nDense prose.'
      yield* fs.writeFileString(source, input)
      const { messages, ui } = notifications()

      yield* run('guide.md', contextWith(directory), ui)

      expect(yield* fs.readFileString(source)).toBe(input)
      expect(yield* fs.readFileString(path.join(directory, 'guide.plain.md'))).toBe('---\ntitle: Guide\ntags: [docs]\n---\nClearer prose')
      expect(yield* fs.readDirectory(directory)).toEqual(['guide.md', 'guide.plain.md'])
      expect(messages).toEqual([{ level: 'info', message: expect.stringContaining('guide.plain.md') }])
    })
  )

  it.scoped('overwrites once with a marker and skips a second pass', () =>
    Effect.gen(function* () {
      const { directory, fs, path } = yield* workspace
      const source = path.join(directory, 'guide.md')
      yield* fs.writeFileString(source, '---\ntitle: Guide\n---\nThis original body is above the minimum length.')
      const command = makeMarkdownCommand({ config: config({ minChars: 10 }) })
      const first = notifications()

      yield* run('guide.md --overwrite', contextWith(directory, 'Short'), first.ui, command)
      const output = yield* fs.readFileString(source)
      expect(output).toBe('---\ntitle: Guide\n---\n<!-- plain-english:rewritten -->\nShort')
      expect(yield* fs.readDirectory(directory)).toEqual(['guide.md'])
      expect(output.split(marker)).toHaveLength(2)

      const second = notifications()
      yield* run('guide.md --overwrite', contextWith(directory), second.ui, command)
      expect(yield* fs.readFileString(source)).toBe(output)
      expect(yield* fs.readDirectory(directory)).toEqual(['guide.md'])
      expect(second.messages).toEqual([{ level: 'warning', message: expect.stringContaining('already rewritten') }])
    })
  )

  it.scoped('preserves a 0600 source mode for sibling and overwrite output', () =>
    Effect.gen(function* () {
      const { directory, fs, path } = yield* workspace
      const sibling = path.join(directory, 'sibling.md')
      const overwrite = path.join(directory, 'overwrite.md')
      yield* fs.writeFileString(sibling, 'Private sibling source.')
      yield* fs.writeFileString(overwrite, 'Private overwrite source.')
      yield* fs.chmod(sibling, 0o600)
      yield* fs.chmod(overwrite, 0o600)

      yield* run('sibling.md', contextWith(directory), notifications().ui)
      yield* run('overwrite.md --overwrite', contextWith(directory), notifications().ui)

      expect((yield* fs.stat(path.join(directory, 'sibling.plain.md'))).mode & 0o777).toBe(0o600)
      expect((yield* fs.stat(overwrite)).mode & 0o777).toBe(0o600)
    })
  )

  it.scoped('does not write output for resolved error or aborted completions', () =>
    Effect.gen(function* () {
      const { directory, fs, path } = yield* workspace
      for (const stopReason of ['error', 'aborted'] as const) {
        const source = path.join(directory, `${stopReason}.md`)
        const input = 'Dense prose that must not be replaced.'
        yield* fs.writeFileString(source, input)
        const { messages, ui } = notifications()

        yield* run(`${stopReason}.md`, contextWith(directory, 'must not be written', false, stopReason), ui)

        expect(yield* fs.readFileString(source)).toBe(input)
        expect(yield* fs.exists(path.join(directory, `${stopReason}.plain.md`))).toBe(false)
        expect(messages).toEqual([{ level: 'warning', message: expect.stringContaining('rewrite failed') }])
      }
    })
  )

  it.scoped('aborts an overwrite when the source changes while the rewrite is pending', () =>
    Effect.gen(function* () {
      const { directory, fs, path } = yield* workspace
      const source = path.join(directory, 'guide.md')
      yield* fs.writeFileString(source, 'Original prose that will be edited while waiting.')
      const started = Deferred.makeUnsafe<void>()
      const release = Deferred.makeUnsafe<object>()
      const ctx = asExtensionContext({
        cwd: directory,
        modelRegistry: {
          complete: () => promiseFromEffect(Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)))),
          find: () => asNarrowed<object, object>({}),
        },
      })
      const { messages, ui } = notifications()
      const fiber = yield* Effect.forkChild(run('guide.md --overwrite', ctx, ui))
      yield* Deferred.await(started)
      yield* fs.writeFileString(source, 'Newer user edit.')
      yield* Deferred.succeed(release, asNarrowed<object, object>({ content: [{ text: 'Stale rewrite', type: 'text' }], stopReason: 'stop' }))
      yield* Fiber.join(fiber)

      expect(yield* fs.readFileString(source)).toBe('Newer user edit.')
      expect(messages).toEqual([{ level: 'warning', message: expect.stringContaining('changed') }])
    })
  )

  it.scoped('rejects invalid, short, and unconfigured requests without writing', () =>
    Effect.gen(function* () {
      const { directory, fs, path } = yield* workspace
      const source = path.join(directory, 'short.md')
      const input = 'Short'
      yield* fs.writeFileString(source, input)
      const cases: readonly { readonly args: string; readonly command?: ReturnType<typeof makeMarkdownCommand>; readonly reason: string }[] = [
        { args: 'missing.md', reason: 'not found' },
        { args: 'notes.txt', reason: '.md' },
        { args: 'short.plain.md', reason: '.plain.md' },
        { args: 'short.md', command: makeMarkdownCommand({ config: config({ minChars: 10 }) }), reason: 'too short' },
        { args: 'short.md', command: makeMarkdownCommand({ config: config({ model: Option.none() }) }), reason: 'model' },
      ]

      for (const testCase of cases) {
        const { messages, ui } = notifications()
        yield* run(testCase.args, contextWith(directory), ui, testCase.command)
        expect(messages).toEqual([{ level: 'warning', message: expect.stringContaining(testCase.reason) }])
        expect(yield* fs.readFileString(source)).toBe(input)
      }
      expect(yield* fs.readDirectory(directory)).toEqual(['short.md'])
    })
  )

  it.scoped('reports rewrite failures without modifying the source or writing output', () =>
    Effect.gen(function* () {
      const { directory, fs, path } = yield* workspace
      const source = path.join(directory, 'guide.md')
      const input = 'Dense prose that should remain unchanged when the provider fails.'
      yield* fs.writeFileString(source, input)
      const { messages, ui } = notifications()

      yield* run('guide.md', contextWith(directory, 'unused', true), ui)

      expect(yield* fs.readFileString(source)).toBe(input)
      expect(yield* fs.readDirectory(directory)).toEqual(['guide.md'])
      expect(messages).toEqual([{ level: 'warning', message: expect.stringContaining('rewrite failed') }])
    })
  )
})
