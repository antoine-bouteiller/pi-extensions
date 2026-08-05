import { describe, expect, test } from 'bun:test'

import { asExtensionContext } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime } from '@tests/utils/runtime.js'

import { register as registerAutoCompact } from '@/features/auto_compact/feature.js'

interface CompactOptions {
  onComplete?: () => void
  onError?: (error: Error) => void
}

const createHarness = () => {
  const fixture = createFakePi()
  registerAutoCompact(fixture.pi, runtime)

  let tokens: number | undefined
  let throwOnCompact = false
  const compactions: CompactOptions[] = []
  const ctx = asExtensionContext({
    compact: (options: CompactOptions) => {
      if (throwOnCompact) {
        throw new Error('compaction failed')
      }
      compactions.push(options)
    },
    getContextUsage: () => (tokens === undefined ? undefined : { contextWindow: 400_000, percent: undefined, tokens }),
  })

  return {
    compactions,
    emitAgentSettled: async () => fixture.emit('agent_settled', {}, ctx),
    fixture,
    setTokens: (value: number | undefined) => {
      tokens = value
    },
    throwOnCompact: (value: boolean) => {
      throwOnCompact = value
    },
  }
}

describe('auto compact', () => {
  test('registers settled-agent compaction and session reset handlers only', () => {
    const harness = createHarness()

    expect([...harness.fixture.state.handlers.keys()].toSorted()).toEqual(['agent_settled', 'session_start'])
    expect(harness.fixture.state.commands.size).toBe(0)
    expect(harness.fixture.state.tools.size).toBe(0)
  })

  test('compacts once when usage reaches the 300,000-token threshold', async () => {
    const harness = createHarness()
    harness.setTokens(300_000)

    await harness.emitAgentSettled()

    expect(harness.compactions).toHaveLength(1)
  })

  test('does not compact below the threshold or when usage is unavailable', async () => {
    const harness = createHarness()

    harness.setTokens(299_999)
    await harness.emitAgentSettled()
    harness.setTokens(undefined)
    await harness.emitAgentSettled()

    expect(harness.compactions).toHaveLength(0)
  })

  test('does not overlap or repeat compaction while usage remains above the threshold', async () => {
    const harness = createHarness()
    harness.setTokens(300_001)

    await harness.emitAgentSettled()
    await harness.emitAgentSettled()
    harness.compactions[0]?.onComplete?.()
    await harness.emitAgentSettled()

    expect(harness.compactions).toHaveLength(1)
  })

  test('re-arms after usage falls below the threshold', async () => {
    const harness = createHarness()
    harness.setTokens(300_000)
    await harness.emitAgentSettled()
    harness.compactions[0]?.onComplete?.()

    harness.setTokens(299_999)
    await harness.emitAgentSettled()
    harness.setTokens(300_000)
    await harness.emitAgentSettled()

    expect(harness.compactions).toHaveLength(2)
  })

  test('re-arms after compaction failure', async () => {
    const harness = createHarness()
    harness.setTokens(300_000)
    await harness.emitAgentSettled()
    harness.compactions[0]?.onError?.(new Error('failed'))
    await harness.emitAgentSettled()

    expect(harness.compactions).toHaveLength(2)
  })

  test('re-arms after a synchronous compaction failure', async () => {
    const harness = createHarness()
    harness.setTokens(300_000)
    harness.throwOnCompact(true)
    await harness.emitAgentSettled()
    harness.throwOnCompact(false)
    await harness.emitAgentSettled()

    expect(harness.compactions).toHaveLength(1)
  })

  test('resets state for each session and ignores stale compaction callbacks', async () => {
    const harness = createHarness()
    harness.setTokens(300_000)
    await harness.emitAgentSettled()
    const [firstCompaction] = harness.compactions

    await harness.fixture.emit('session_start', {})
    await harness.emitAgentSettled()
    firstCompaction?.onError?.(new Error('stale failure'))
    await harness.emitAgentSettled()

    expect(harness.compactions).toHaveLength(2)
  })
})
