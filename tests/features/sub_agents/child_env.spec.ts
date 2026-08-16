import { Effect } from 'effect'

import { buildChildEnv } from '#features/sub_agents/child_env'
import { describe, expect, it } from '#tests/utils/effect'

const identity = { childToken: 'token-1', isReadonly: true, profile: 'scout' }

describe('child environment', () => {
  it.effect('inherits the parent environment', () =>
    Effect.sync(() => {
      const childEnv = buildChildEnv(identity, undefined, {
        ANTHROPIC_API_KEY: 'provider',
        DATABASE_URL: 'postgres://secret',
        HOME: '/home/dev',
        PATH: '/usr/bin',
      })

      expect(childEnv).toMatchObject({
        ANTHROPIC_API_KEY: 'provider',
        DATABASE_URL: 'postgres://secret',
        HOME: '/home/dev',
        PATH: '/usr/bin',
      })
    })
  )

  it.effect('strips the parent-owned Pi session and model variables while stamping child identity', () =>
    Effect.sync(() => {
      const childEnv = buildChildEnv(identity, undefined, {
        PI_MODEL: 'parent-model',
        PI_PROVIDER: 'parent-provider',
        PI_REASONING_LEVEL: 'high',
        PI_SESSION_FILE: '/tmp/parent.jsonl',
        PI_SESSION_ID: 'parent-session',
        PI_SUBAGENT_TEMP_DIR: '/tmp/keep',
      })

      expect(childEnv).toEqual({
        PI_SUBAGENT_OWNER_TOKEN: 'token-1',
        PI_SUBAGENT_PROFILE: 'scout',
        PI_SUBAGENT_READONLY: '1',
        PI_SUBAGENT_TEMP_DIR: '/tmp/keep',
      })
    })
  )

  it.effect('lets explicit caller overrides win over the inherited value', () =>
    Effect.sync(() => {
      const childEnv = buildChildEnv(identity, { CUSTOM_BASE_URL: 'caller' }, { CUSTOM_BASE_URL: 'parent' })

      expect(childEnv.CUSTOM_BASE_URL).toBe('caller')
    })
  )

  it.effect('never lets a caller override reintroduce a parent-owned name', () =>
    Effect.sync(() => {
      const childEnv = buildChildEnv(identity, { PI_SESSION_ID: 'caller-session' }, {})

      expect(childEnv.PI_SESSION_ID).toBeUndefined()
    })
  )
})
