import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Effect } from 'effect'

import { turnMetrics } from '@/features/status_panel/state.js'

const usage = { cacheRead: 800, cacheWrite: 100, input: 100, output: 250 }

describe('turnMetrics', () => {
  it.effect('derives cache hit share and output tokens per second', () =>
    Effect.sync(() => {
      expect(turnMetrics({ timestamp: 1000, usage }, 6000)).toEqual({ cacheHitPercent: 80, tokensPerSecond: 50 })
    })
  )

  it.effect('leaves metrics undefined without prompt tokens or elapsed time', () =>
    Effect.sync(() => {
      expect(turnMetrics({ timestamp: 1000, usage: { ...usage, cacheRead: 0, cacheWrite: 0, input: 0 } }, 1000)).toEqual({
        cacheHitPercent: undefined,
        tokensPerSecond: undefined,
      })
    })
  )
})
