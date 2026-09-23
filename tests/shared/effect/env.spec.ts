import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Effect } from 'effect'

import { ENVIRONMENT_KEYS, envLayer, makeEnvironment, type EnvironmentKey } from '@/shared/effect/env.js'

describe('environment', () => {
  it.effect('snapshots its source for get and all', () =>
    Effect.sync(() => {
      const source = {
        MERIDIAN_BASE_URL: 'http://before',
        NO_COLOR: undefined,
      }
      const key: EnvironmentKey = 'MERIDIAN_BASE_URL'
      const environment = makeEnvironment(source)
      source.MERIDIAN_BASE_URL = 'http://after'
      expect(environment.get(key)).toBe('http://before')
      expect(environment.all.MERIDIAN_BASE_URL).toBe('http://before')
      expect(ENVIRONMENT_KEYS).toContain('MERIDIAN_BASE_URL')
      expect(envLayer(source)).toBeDefined()
    })
  )
})
