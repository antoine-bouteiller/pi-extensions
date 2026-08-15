import { tmpdir } from 'node:os'

import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asExtensionContext, asNarrowed } from '@tests/utils/casts.js'
import { Effect, FileSystem, Option, Path } from 'effect'

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

const contextWith = (cwd: string, rewritten = 'Clearer prose', reject = false) =>
  asExtensionContext({
    cwd,
    modelRegistry: {
      complete: () =>
        reject
          ? Promise.reject(new Error('offline'))
          : Promise.resolve(asNarrowed<object, object>({ content: [{ text: rewritten, type: 'text' }], stopReason: 'stop' })),
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
