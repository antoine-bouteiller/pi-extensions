import { tmpdir, userInfo } from 'node:os'

import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asNarrowed } from '@tests/utils/casts.js'
import { Effect, FileSystem, Layer, Path } from 'effect'
import { systemError } from 'effect/PlatformError'

import { consumeSubagentAzureQuota, writeSubagentAzureQuota } from '@/shared/state/azure_quota.js'

const token = '11111111-1111-4111-8111-111111111111'

const quotaDirectory = [process.env.PI_SUBAGENT_TEMP_DIR || tmpdir(), 'pi-codex-subagents', userInfo().username, 'quota'].join('/')
const quotaFile = `${quotaDirectory}/${token}.json`
const temporaryFile = (suffix: 'tmp' | 'consume') =>
  new RegExp(`^${quotaFile.replaceAll('.', String.raw`\.`)}${String.raw`\.`}${process.pid}\\.[0-9a-f-]+\\.${suffix}$`, 'i')

const fileSystemFailure = (method: string, path: string) =>
  systemError({
    _tag: 'Unknown',
    cause: Object.assign(new Error('EIO'), { code: 'EIO' }),
    method,
    module: 'FileSystem',
    pathOrDescriptor: path,
  })

const path = asNarrowed<Path.Path, object>({
  join: (...parts: string[]) => parts.join('/'),
})

const provideFakeFileSystem = (fileSystem: FileSystem.FileSystem) =>
  Layer.merge(Layer.succeed(FileSystem.FileSystem)(fileSystem), Layer.succeed(Path.Path)(path))

describe('Azure subagent quota filesystem failures', () => {
  it.effect('removes a partially written temporary quota file when writing fails', () =>
    Effect.gen(function* () {
      const calls: { file?: string; method: string; options?: { force?: boolean } }[] = []
      const fileSystem = asNarrowed<FileSystem.FileSystem, object>({
        chmod: (directory: string) => Effect.sync(() => calls.push({ file: directory, method: 'chmod' })),
        makeDirectory: (directory: string) => Effect.sync(() => calls.push({ file: directory, method: 'makeDirectory' })),
        remove: (file: string, options: { force?: boolean }) => Effect.sync(() => calls.push({ file, method: 'remove', options })),
        writeFileString: (file: string) =>
          Effect.sync(() => calls.push({ file, method: 'writeFileString' })).pipe(Effect.andThen(Effect.fail(fileSystemFailure('writeFile', file)))),
      })

      yield* writeSubagentAzureQuota(token, 25).pipe(Effect.provide(provideFakeFileSystem(fileSystem)))

      expect(calls.map(({ method }) => method)).toEqual([
        'makeDirectory',
        ...(process.platform === 'win32' ? [] : ['chmod']),
        'writeFileString',
        'remove',
      ])
      const temporary = calls.find(({ method }) => method === 'writeFileString')?.file
      expect(temporary).toMatch(temporaryFile('tmp'))
      expect(calls.at(-1)).toEqual({ file: temporary, method: 'remove', options: { force: true } })
    })
  )

  it.effect('removes the temporary quota file when publishing it fails', () =>
    Effect.gen(function* () {
      const calls: { file?: string; method: string; options?: { force?: boolean }; target?: string }[] = []
      const fileSystem = asNarrowed<FileSystem.FileSystem, object>({
        chmod: (directory: string) => Effect.sync(() => calls.push({ file: directory, method: 'chmod' })),
        makeDirectory: (directory: string) => Effect.sync(() => calls.push({ file: directory, method: 'makeDirectory' })),
        remove: (file: string, options: { force?: boolean }) => Effect.sync(() => calls.push({ file, method: 'remove', options })),
        rename: (from: string, to: string) =>
          Effect.sync(() => calls.push({ file: from, method: 'rename', target: to })).pipe(
            Effect.andThen(Effect.fail(fileSystemFailure('rename', from)))
          ),
        writeFileString: (file: string) => Effect.sync(() => calls.push({ file, method: 'writeFileString' })),
      })

      yield* writeSubagentAzureQuota(token, 25).pipe(Effect.provide(provideFakeFileSystem(fileSystem)))

      expect(calls.map(({ method }) => method)).toEqual([
        'makeDirectory',
        ...(process.platform === 'win32' ? [] : ['chmod']),
        'writeFileString',
        'rename',
        'remove',
      ])
      const temporary = calls.find(({ method }) => method === 'writeFileString')?.file
      expect(temporary).toMatch(temporaryFile('tmp'))
      expect(calls.find(({ method }) => method === 'rename')).toEqual({ file: temporary, method: 'rename', target: quotaFile })
      expect(calls.at(-1)).toEqual({ file: temporary, method: 'remove', options: { force: true } })
    })
  )

  it.effect('cleans up the generated temporary path when creating the handoff directory fails', () =>
    Effect.gen(function* () {
      const calls: { file: string; method: string; options?: { force?: boolean } }[] = []
      const fileSystem = asNarrowed<FileSystem.FileSystem, object>({
        makeDirectory: (directory: string) =>
          Effect.sync(() => calls.push({ file: directory, method: 'makeDirectory' })).pipe(
            Effect.andThen(Effect.fail(fileSystemFailure('makeDirectory', directory)))
          ),
        remove: (file: string, options: { force?: boolean }) => Effect.sync(() => calls.push({ file, method: 'remove', options })),
      })

      yield* writeSubagentAzureQuota(token, 25).pipe(Effect.provide(provideFakeFileSystem(fileSystem)))

      expect(calls.map(({ method }) => method)).toEqual(['makeDirectory', 'remove'])
      expect(calls[0]).toEqual({ file: quotaDirectory, method: 'makeDirectory' })
      expect(calls[1]).toEqual(expect.objectContaining({ method: 'remove', options: { force: true } }))
      expect(calls[1]?.file).toMatch(temporaryFile('tmp'))
    })
  )

  it.effect('returns undefined and preserves the quota file when claiming it fails', () =>
    Effect.gen(function* () {
      const files = new Map([[quotaFile, '25']])
      const calls: { file: string; method: string; options?: { force?: boolean }; target?: string }[] = []
      const fileSystem = asNarrowed<FileSystem.FileSystem, object>({
        remove: (file: string, options: { force?: boolean }) =>
          Effect.sync(() => {
            calls.push({ file, method: 'remove', options })
            files.delete(file)
          }),
        rename: (from: string, to: string) =>
          Effect.sync(() => calls.push({ file: from, method: 'rename', target: to })).pipe(
            Effect.andThen(Effect.fail(fileSystemFailure('rename', from)))
          ),
      })

      const result = yield* consumeSubagentAzureQuota(token).pipe(Effect.provide(provideFakeFileSystem(fileSystem)))

      expect(result).toBeUndefined()
      expect(calls[0]).toEqual(expect.objectContaining({ file: quotaFile, method: 'rename' }))
      const claimed = calls[0]?.target
      if (claimed === undefined) {
        throw new Error('expected a generated claim path')
      }
      expect(claimed).toMatch(temporaryFile('consume'))
      expect(calls[1]).toEqual({ file: claimed, method: 'remove', options: { force: true } })
      expect(files).toEqual(new Map([[quotaFile, '25']]))
    })
  )
})
