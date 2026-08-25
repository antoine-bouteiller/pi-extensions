import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Effect } from 'effect'

import {
  type FeatureActivationError,
  type FeatureIdentity,
  type FeaturePlugin,
  type FeaturePreflightError,
  type FeatureStatusMetadata,
} from '@/shared/effect/feature.js'

describe('FeaturePlugin', () => {
  it.effect('discriminates eager and background descriptors', () =>
    Effect.sync(() => {
      const eager = {
        bootstrap: 'eager' as const,
        id: 'eager',
        implementation: { register: () => undefined },
        status: { icon: '✓', name: 'eager' },
      } satisfies FeaturePlugin
      const background = {
        bootstrap: 'background' as const,
        id: 'comment-checker',
        prepare: Effect.succeed({ register: () => undefined }),
        status: { icon: '💬', name: 'comment-checker' },
      } satisfies FeaturePlugin
      const identity: FeatureIdentity = eager
      const status: FeatureStatusMetadata = identity.status
      const preflight: FeaturePreflightError = { _tag: 'Preflight' }
      const activation: FeatureActivationError = { _tag: 'Activation' }
      const hasImplementation = 'implementation' in background
      expect([eager.bootstrap, background.bootstrap, status.name, preflight._tag, activation._tag, hasImplementation]).toEqual([
        'eager',
        'background',
        'eager',
        'Preflight',
        'Activation',
        false,
      ])
    })
  )
})
