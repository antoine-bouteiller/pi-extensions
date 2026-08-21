import { randomUUID } from 'node:crypto'
import { tmpdir, userInfo } from 'node:os'

import { Effect } from 'effect'

import { bunFileSystem, bunPath } from '#shared/effect/bun_services'
import { jsonText, parseJsonText } from '#shared/utils/json'

import { createObservableStore } from './store.js'

const { join } = bunPath

const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const quotaDir = () => join(process.env.PI_SUBAGENT_TEMP_DIR || tmpdir(), 'pi-codex-subagents', userInfo().username, 'quota')
const quotaPath = (token: string) => join(quotaDir(), `${token}.json`)

export const azureQuota = createObservableStore<number | undefined>(undefined)

export const writeSubagentAzureQuota = (token: string, percent: number): Effect.Effect<void> => {
  if (!TOKEN_PATTERN.test(token) || !Number.isFinite(percent)) {
    return Effect.void
  }
  const target = quotaPath(token)
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  return Effect.gen(function* () {
    const directory = quotaDir()
    /*
     * Mode at creation as well as after: a later chmod alone leaves a umask-width window during
     * which the handoff directory is world-readable in shared tmp.
     */
    yield* bunFileSystem.makeDirectory(directory, { mode: 0o700, recursive: true })
    if (process.platform !== 'win32') {
      yield* bunFileSystem.chmod(directory, 0o700)
    }
    yield* bunFileSystem.writeFileString(temporary, jsonText(percent), { mode: 0o600 })
    yield* bunFileSystem.rename(temporary, target)
  }).pipe(Effect.ensuring(bunFileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)), Effect.ignore)
}

export const consumeSubagentAzureQuota = (token: string): Effect.Effect<number | undefined> => {
  if (!TOKEN_PATTERN.test(token)) {
    // `effecttsgo/effect-succeed-with-void` rejects `Effect.succeed(undefined)`, so widen `Effect.void` instead.
    return Effect.void.pipe(Effect.as<number | undefined>(undefined))
  }
  const target = quotaPath(token)
  const claimed = `${target}.${process.pid}.${randomUUID()}.consume`
  return Effect.gen(function* () {
    yield* bunFileSystem.rename(target, claimed)
    const text = yield* bunFileSystem.readFileString(claimed)
    const percent = yield* Effect.try(() => parseJsonText(text))
    return typeof percent === 'number' && Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : undefined
  }).pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.ensuring(bunFileSystem.remove(claimed, { force: true }).pipe(Effect.ignore))
  )
}
