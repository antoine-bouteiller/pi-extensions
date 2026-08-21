import { afterEach } from 'bun:test'
import { tmpdir } from 'node:os'

import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type Theme, withFileMutationQueue } from '@earendil-works/pi-coding-agent'
import { type Component } from '@earendil-works/pi-tui'
import { makeAbortController } from '@tests/utils/abort_controller.js'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asTheme, asTool } from '@tests/utils/casts.js'
import { deferred } from '@tests/utils/deferred.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime } from '@tests/utils/runtime.js'
import { Effect, FileSystem, Path } from 'effect'

import { register as hashline } from '@/features/hashline/index.js'
import { type JsonObject } from '@/shared/utils/json.js'

const pathService = runtime.runSync(Path.Path)
const { join } = pathService
const mkdtemp = (prefix: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectory({ directory: pathService.dirname(prefix), prefix: pathService.basename(prefix) }))
  )
const readFile = (path: string, _encoding: 'utf8') => FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.readFileString(path)))
const rm = (path: string, options?: { force?: boolean; recursive?: boolean }) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.remove(path, options)))
const symlink = (fromPath: string, toPath: string) => FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.symlink(fromPath, toPath)))
const writeFile = (path: string, data: string) => FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.writeFileString(path, data)))
const writeBytes = (path: string, data: Uint8Array) => FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.writeFile(path, data)))

interface ToolOutput {
  content: { text: string; type: string }[]
  details: JsonObject
}

interface Tool {
  description: string
  promptGuidelines?: string[]
  execute: (id: string, params: JsonObject, signal: AbortSignal | undefined, onUpdate: undefined, ctx: { cwd: string }) => Promise<ToolOutput>
  renderResult: (result: ToolOutput & { isError?: boolean }, options: { expanded: boolean; isPartial: boolean }, theme: Theme) => Component
}

const temporaryDirectories: string[] = []
afterEach(() =>
  runtime.runPromise(
    Effect.forEach(temporaryDirectories.splice(0), (path) => rm(path, { force: true, recursive: true }), { concurrency: 'unbounded' })
  )
)

interface HashlineTools {
  read: Tool
  write: Tool
}

const setup = (): HashlineTools => {
  const { pi, state } = createFakePi()
  hashline(pi, runtime)
  return {
    read: asTool<Tool>(state.tools.get('read')),
    write: asTool<Tool>(state.tools.get('write')),
  }
}

const workspace = Effect.gen(function* () {
  const directory = yield* mkdtemp(join(tmpdir(), 'hashline-test-'))
  temporaryDirectories.push(directory)
  return directory
})

const header = (tool: Tool, cwd: string, path: string): Promise<string> =>
  Effect.runPromise(
    Effect.promise(() => tool.execute('read', { path }, undefined, undefined, { cwd })).pipe(
      Effect.map((output) => output.content[0].text.split('\n', 1)[0])
    )
  )

const put = (headerLine: string, line: number, replacement: string): string => `${headerLine}\nPUT ${line}.=${line}:\n+${replacement}`

describe('hashline extension', () => {
  it.effect('replaces read and write with anchored tools', () =>
    Effect.gen(function* () {
      const tools = setup()
      const directory = yield* workspace
      yield* writeFile(join(directory, 'sample.txt'), 'first\nsecond\n')

      const output = yield* Effect.promise(() => tools.read.execute('call-1', { path: 'sample.txt' }, undefined, undefined, { cwd: directory }))
      expect(output.content[0].text).toMatch(/^\[sample\.txt#[A-F0-9]+\]/)
      expect(output.content[0].text).toContain('1:first')
      expect(output.details.path).toBe('sample.txt')
      const rendered = tools.read.renderResult(
        { ...output, isError: false },
        { expanded: false, isPartial: false },
        asTheme({ fg: (_color: string, text: string) => text })
      )
      expect(rendered.render(80).join('\n').trimEnd()).toBe('sample.txt')
    })
  )

  it.effect('keeps image reads and does not install a context-history rewriter', () =>
    Effect.gen(function* () {
      const { pi, state } = createFakePi()
      hashline(pi, runtime)
      expect([...state.tools.keys()]).toEqual(['read', 'write'])
      expect(state.handlers.has('context')).toBe(false)

      const read = asTool<Tool>(state.tools.get('read'))
      const directory = yield* workspace
      yield* writeBytes(
        join(directory, 'pixel.png'),
        Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
      )

      const output = yield* Effect.promise(() => read.execute('image', { path: 'pixel.png' }, undefined, undefined, { cwd: directory }))
      expect(output.content.some((content) => content.type === 'image')).toBe(true)

      yield* writeFile(join(directory, 'not-an-image.txt'), 'Read image file [image/png]\nplain text\n')
      const textOutput = yield* Effect.promise(() => read.execute('text', { path: 'not-an-image.txt' }, undefined, undefined, { cwd: directory }))
      expect(textOutput.content[0].text).toMatch(/^\[not-an-image\.txt#[A-F0-9]+\]/)
    })
  )

  it.effect('returns requested line ranges with their original anchors', () =>
    Effect.gen(function* () {
      const { read, write } = setup()
      const directory = yield* workspace
      const path = join(directory, 'range.txt')
      yield* writeFile(path, 'one\ntwo\nthree\nfour\nfive\n')

      const output = yield* Effect.promise(() =>
        read.execute('range', { limit: 2, offset: 3, path: 'range.txt' }, undefined, undefined, { cwd: directory })
      )
      const [{ text }] = output.content
      expect(text).toMatch(/^\[range\.txt#[A-F0-9]+\]\n3:three\n4:four$/)
      const [currentHeader] = text.split('\n', 1)

      expect(write.execute('unseen', { patch: put(currentHeader, 1, 'ONE') }, undefined, undefined, { cwd: directory })).rejects.toThrow()
      yield* Effect.promise(() => write.execute('visible', { patch: put(currentHeader, 4, 'FOUR') }, undefined, undefined, { cwd: directory }))
      expect(yield* readFile(path, 'utf8')).toBe('one\ntwo\nthree\nFOUR\nfive\n')
    })
  )

  it.effect('bounds large reads while retaining the full snapshot for visible edits', () =>
    Effect.gen(function* () {
      const { read, write } = setup()
      const directory = yield* workspace
      const path = join(directory, 'large.txt')
      const lines = Array.from({ length: 3000 }, (_value, index) => `line-${index + 1}-${'x'.repeat(40)}`)
      yield* writeFile(path, `${lines.join('\n')}\n`)

      const output = yield* Effect.promise(() => read.execute('large', { path: 'large.txt' }, undefined, undefined, { cwd: directory }))
      const [{ text }] = output.content
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(DEFAULT_MAX_BYTES)
      expect(text.split('\n').length).toBeLessThanOrEqual(DEFAULT_MAX_LINES)
      expect(text).toContain('[Output truncated:')
      expect(output.details.truncated).toBe(true)
      const { endLine } = output.details
      if (typeof endLine !== 'number') {
        throw new Error('Expected at least one visible source line')
      }

      const [currentHeader] = text.split('\n', 1)
      yield* Effect.promise(() =>
        write.execute('large-visible', { patch: put(currentHeader, endLine, 'changed') }, undefined, undefined, { cwd: directory })
      )
      const written = yield* readFile(path, 'utf8')
      const writtenLines = written.split('\n')
      expect(writtenLines.at(endLine - 1)).toBe('changed')
      expect(writtenLines.at(2999)).toBe(lines.at(2999))
    })
  )

  it.effect('preserves tagged hashline failures at the tool boundary', () =>
    Effect.gen(function* () {
      const { read } = setup()
      const directory = yield* workspace
      yield* writeFile(join(directory, 'wide.txt'), 'x'.repeat(DEFAULT_MAX_BYTES))

      const rejection = yield* Effect.promise(() =>
        read.execute('wide', { path: 'wide.txt' }, undefined, undefined, { cwd: directory }).then(
          () => undefined,
          (error: unknown) => error
        )
      )

      expect(rejection).toMatchObject({
        _tag: 'HashlineToolError',
        message: expect.stringContaining('exceeds the hashline output limit'),
      })
    })
  )
  it.effect('applies a current patch and rejects a stale patch without overwriting', () =>
    Effect.gen(function* () {
      const { read, write } = setup()
      const directory = yield* workspace
      const path = join(directory, 'sample.txt')
      yield* writeFile(path, 'first\nsecond\n')
      const currentHeader = yield* Effect.promise(() => header(read, directory, 'sample.txt'))

      const result = yield* Effect.promise(() =>
        write.execute('write-1', { patch: put(currentHeader, 2, 'changed') }, undefined, undefined, { cwd: directory })
      )
      expect(result.content[0].text).toContain('update sample.txt')
      expect(result.details.sections).toEqual([
        { hash: expect.stringMatching(/^[A-F0-9]+$/), op: 'update', path: 'sample.txt', version: expect.stringMatching(/^[a-f0-9]{64}$/) },
      ])
      expect(result.details).not.toHaveProperty('before')
      expect(yield* readFile(path, 'utf8')).toBe('first\nchanged\n')

      expect(
        write.execute('stale', { patch: put(currentHeader, 1, 'stale') }, undefined, undefined, {
          cwd: directory,
        })
      ).rejects.toThrow()
      expect(yield* readFile(path, 'utf8')).toBe('first\nchanged\n')
    })
  )

  it.effect('applies multi-file patches and preflights all files before writing', () =>
    Effect.gen(function* () {
      const { read, write } = setup()
      const directory = yield* workspace
      const firstPath = join(directory, 'first.txt')
      const secondPath = join(directory, 'second.txt')
      yield* writeFile(firstPath, 'one\n')
      yield* writeFile(secondPath, 'two\n')
      const firstHeader = yield* Effect.promise(() => header(read, directory, 'first.txt'))
      const secondHeader = yield* Effect.promise(() => header(read, directory, 'second.txt'))

      yield* Effect.promise(() =>
        write.execute('multi', { patch: `${put(firstHeader, 1, 'ONE')}\n${put(secondHeader, 1, 'TWO')}` }, undefined, undefined, {
          cwd: directory,
        })
      )
      expect(yield* readFile(firstPath, 'utf8')).toBe('ONE\n')
      expect(yield* readFile(secondPath, 'utf8')).toBe('TWO\n')

      const freshFirst = yield* Effect.promise(() => header(read, directory, 'first.txt'))
      const staleSecond = yield* Effect.promise(() => header(read, directory, 'second.txt'))
      yield* writeFile(secondPath, 'external\n')
      expect(
        write.execute('multi-stale', { patch: `${put(freshFirst, 1, 'again')}\n${put(staleSecond, 1, 'bad')}` }, undefined, undefined, {
          cwd: directory,
        })
      ).rejects.toThrow()
      expect(yield* readFile(firstPath, 'utf8')).toBe('ONE\n')
      expect(yield* readFile(secondPath, 'utf8')).toBe('external\n')
    })
  )

  it.effect('serializes concurrent same-file writes so only one current snapshot lands', () =>
    Effect.gen(function* () {
      const { read, write } = setup()
      const directory = yield* workspace
      const path = join(directory, 'shared.txt')
      yield* writeFile(path, 'original\n')
      const currentHeader = yield* Effect.promise(() => header(read, directory, 'shared.txt'))

      const outcomes = yield* Effect.promise(() =>
        Promise.allSettled([
          write.execute('concurrent-a', { patch: put(currentHeader, 1, 'alpha') }, undefined, undefined, { cwd: directory }),
          write.execute('concurrent-b', { patch: put(currentHeader, 1, 'beta') }, undefined, undefined, { cwd: directory }),
        ])
      )

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
      expect(['alpha\n', 'beta\n']).toContain(yield* readFile(path, 'utf8'))
    })
  )

  it.effect('takes multi-file locks in deterministic order for opposite section orders', () =>
    Effect.gen(function* () {
      const { read, write } = setup()
      const directory = yield* workspace
      yield* writeFile(join(directory, 'a.txt'), 'a\n')
      yield* writeFile(join(directory, 'b.txt'), 'b\n')
      const headerA = yield* Effect.promise(() => header(read, directory, 'a.txt'))
      const headerB = yield* Effect.promise(() => header(read, directory, 'b.txt'))

      const outcomes = yield* Effect.promise(() =>
        Promise.allSettled([
          write.execute('ab', { patch: `${put(headerA, 1, 'A1')}\n${put(headerB, 1, 'B1')}` }, undefined, undefined, { cwd: directory }),
          write.execute('reverse-order', { patch: `${put(headerB, 1, 'B2')}\n${put(headerA, 1, 'A2')}` }, undefined, undefined, { cwd: directory }),
        ])
      )

      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
    })
  )

  it.effect('honors cancellation while waiting for a mutation lock', () =>
    Effect.gen(function* () {
      const { read, write } = setup()
      const directory = yield* workspace
      const path = join(directory, 'queued.txt')
      yield* writeFile(path, 'before\n')
      const currentHeader = yield* Effect.promise(() => header(read, directory, 'queued.txt'))
      const gate = deferred<void>()
      const holding = withFileMutationQueue(path, () => gate.promise)
      yield* Effect.promise(() => Bun.sleep(0))

      const controller = makeAbortController()
      const pending = write.execute('cancelled', { patch: put(currentHeader, 1, 'after') }, controller.signal, undefined, { cwd: directory })
      controller.abort()
      gate.resolve(undefined)
      yield* Effect.promise(() => holding)

      expect(pending).rejects.toThrow('aborted')
      expect(yield* readFile(path, 'utf8')).toBe('before\n')
    })
  )

  it.effect('self-enforces protected paths, including leading @ and symlink aliases', () =>
    Effect.gen(function* () {
      const { read, write } = setup()
      const directory = yield* workspace
      const secret = join(directory, '.env')
      yield* writeFile(secret, 'TOKEN=secret\n')
      yield* symlink(secret, join(directory, 'ordinary.txt'))
      const secretImage = join(directory, '.env.png')
      yield* writeBytes(
        secretImage,
        Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
      )
      yield* symlink(secretImage, join(directory, 'image’s.png'))

      for (const path of ['.env', '@.env', 'ordinary.txt']) {
        expect(read.execute('protected-read', { path }, undefined, undefined, { cwd: directory })).rejects.toThrow('protected path')
      }
      expect(read.execute('alternate-name-read', { path: "image's.png" }, undefined, undefined, { cwd: directory })).rejects.toThrow()
      expect(
        write.execute('protected-write', { patch: '[.env#0000]\nPUT 1.=1:\n+TOKEN=changed' }, undefined, undefined, { cwd: directory })
      ).rejects.toThrow('protected path')
      expect(yield* readFile(secret, 'utf8')).toBe('TOKEN=secret\n')
    })
  )

  it.effect('documents native hashline operations instead of unified diffs', () =>
    Effect.sync(() => {
      const tools = setup()
      expect(tools.write.description).toContain('PUT')
      expect(tools.write.promptGuidelines?.join(' ')).toContain('never use unified-diff')
    })
  )
})
