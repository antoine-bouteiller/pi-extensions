import { randomUUID } from 'node:crypto'
import { tmpdir, userInfo } from 'node:os'

import { Effect, Function } from 'effect'

import { bunFileSystem, bunPath } from '@/shared/effect/bun_services.js'
import { jsonText, parseJsonText } from '@/shared/utils/json.js'

import { createObservableStore } from './store.js'

const { join } = bunPath

const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const quotaDir = () => join(process.env.PI_SUBAGENT_TEMP_DIR || tmpdir(), 'pi-codex-subagents', userInfo().username, 'quota')
const quotaPath = (token: string) => join(quotaDir(), `${token}.json`)

export const azureQuota = createObservableStore<number | undefined>(undefined)

export const writeSubagentAzureQuota: {
  (percent: number): (token: string) => Effect.Effect<void>
  (token: string, percent: number): Effect.Effect<void>
} = Function.dual(2, (token: string, percent: number): Effect.Effect<void> => {
  if (!TOKEN_PATTERN.test(token) || !Number.isFinite(percent)) {
    return Effect.void
  }
  const target = quotaPath(token)
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  return Effect.gen(function* () {
    const directory = quotaDir()
    yield* bunFileSystem.makeDirectory(directory, { recursive: true })
    if (process.platform !== 'win32') {
      yield* bunFileSystem.chmod(directory, 0o700)
    }
    yield* bunFileSystem.writeFileString(temporary, jsonText(percent), { mode: 0o600 })
    yield* bunFileSystem.rename(temporary, target)
  }).pipe(Effect.catch(() => bunFileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)))
})

export const consumeSubagentAzureQuota = (token: string): Effect.Effect<number | undefined> => {
  if (!TOKEN_PATTERN.test(token)) {
    return Effect.void.pipe(Effect.as<number | undefined>(undefined))
  }
  const target = quotaPath(token)
  const claimed = `${target}.${process.pid}.${randomUUID()}.consume`
  return Effect.gen(function* () {
    yield* bunFileSystem.rename(target, claimed)
    const percent = parseJsonText(yield* bunFileSystem.readFileString(claimed))
    return typeof percent === 'number' && Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : undefined
  }).pipe(
    Effect.orElseSucceed(() => undefined),
    Effect.ensuring(bunFileSystem.remove(claimed, { force: true }).pipe(Effect.ignore))
  )
}
