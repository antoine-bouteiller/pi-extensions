import { randomUUID } from 'node:crypto'
import { tmpdir, userInfo } from 'node:os'

import { Effect, Path } from 'effect'
import { FileSystem } from 'effect/FileSystem'
import { type Path as PathService } from 'effect/Path'

import { jsonText, parseJsonText } from '#shared/utils/json'

import { createObservableStore } from './store.js'

const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const quotaDir = (path: PathService) => path.join(process.env.PI_SUBAGENT_TEMP_DIR || tmpdir(), 'pi-codex-subagents', userInfo().username, 'quota')
const quotaPath = (path: PathService, token: string) => path.join(quotaDir(path), `${token}.json`)

export const azureQuota = createObservableStore<number | undefined>(undefined)

export const writeSubagentAzureQuota = (token: string, percent: number): Effect.Effect<void, never, FileSystem | PathService> => {
  if (!TOKEN_PATTERN.test(token) || !Number.isFinite(percent)) {
    return Effect.void
  }
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem
    const path = yield* Path.Path
    const target = quotaPath(path, token)
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    const directory = quotaDir(path)
    /*
     * Mode at creation as well as after: a later chmod alone leaves a umask-width window during
     * which the handoff directory is world-readable in shared tmp.
     */
    yield* Effect.gen(function* () {
      yield* fileSystem.makeDirectory(directory, { mode: 0o700, recursive: true })
      if (process.platform !== 'win32') {
        yield* fileSystem.chmod(directory, 0o700)
      }
      yield* fileSystem.writeFileString(temporary, jsonText(percent), { mode: 0o600 })
      yield* fileSystem.rename(temporary, target)
    }).pipe(Effect.ensuring(fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)))
  }).pipe(Effect.ignore)
}

export const consumeSubagentAzureQuota = (token: string): Effect.Effect<number | undefined, never, FileSystem | PathService> => {
  if (!TOKEN_PATTERN.test(token)) {
    // `effecttsgo/effect-succeed-with-void` rejects `Effect.succeed(undefined)`, so widen `Effect.void` instead.
    return Effect.void.pipe(Effect.as<number | undefined>(undefined))
  }
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem
    const path = yield* Path.Path
    const target = quotaPath(path, token)
    const claimed = `${target}.${process.pid}.${randomUUID()}.consume`
    return yield* Effect.gen(function* () {
      yield* fileSystem.rename(target, claimed)
      const text = yield* fileSystem.readFileString(claimed)
      const percent = yield* Effect.try(() => parseJsonText(text))
      return typeof percent === 'number' && Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : undefined
    }).pipe(
      Effect.orElseSucceed(() => undefined),
      Effect.ensuring(fileSystem.remove(claimed, { force: true }).pipe(Effect.ignore))
    )
  })
}
