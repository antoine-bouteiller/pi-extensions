import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Effect } from 'effect'

import { getOrCreateSubagentRuntime } from '@/features/sub_agents/runtime.js'

describe('sub-agent production runtime', () => {
  it.effect('is a process-lifetime singleton', () =>
    Effect.sync(() => {
      expect(getOrCreateSubagentRuntime()).toBe(getOrCreateSubagentRuntime())
    })
  )
})
