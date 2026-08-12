// oxlint-disable-next-line effecttsgo/node-builtin-import -- Synchronous atomic handoff (temp write, chmod, rename) read from a store whose API is synchronous by contract.
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'

import { Function } from 'effect'

import { nodePath } from '@/shared/effect/node_path.js'

import { createObservableStore } from './store.js'

const { join } = nodePath

const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const quotaDir = () => join(process.env.PI_SUBAGENT_TEMP_DIR || tmpdir(), 'pi-codex-subagents', userInfo().username, 'quota')
const quotaPath = (token: string) => join(quotaDir(), `${token}.json`)

export const azureQuota = createObservableStore<number | undefined>(undefined)

export const writeSubagentAzureQuota: {
  (percent: number): (token: string) => void
  (token: string, percent: number): void
} = Function.dual(2, (token: string, percent: number): void => {
  if (!TOKEN_PATTERN.test(token) || !Number.isFinite(percent)) {
    return
  }
  const target = quotaPath(token)
  const temporary = `${target}.${process.pid}.tmp`
  try {
    const directory = quotaDir()
    mkdirSync(directory, { mode: 0o700, recursive: true })
    if (process.platform !== 'win32') {
      chmodSync(directory, 0o700)
    }
    writeFileSync(temporary, JSON.stringify(percent), { mode: 0o600 })
    renameSync(temporary, target)
  } catch {
    try {
      unlinkSync(temporary)
    } catch {
      // Best effort; quota telemetry must not break a provider response.
    }
  }
})

export const consumeSubagentAzureQuota = (token: string): number | undefined => {
  if (!TOKEN_PATTERN.test(token)) {
    return undefined
  }
  const target = quotaPath(token)
  try {
    const percent: unknown = JSON.parse(readFileSync(target, 'utf8'))
    return typeof percent === 'number' && Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : undefined
  } catch {
    return undefined
  } finally {
    try {
      unlinkSync(target)
    } catch {
      // Missing or concurrently consumed handoffs need no cleanup.
    }
  }
}
