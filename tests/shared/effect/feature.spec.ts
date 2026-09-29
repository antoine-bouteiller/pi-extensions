import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Effect } from 'effect'

import { type FeatureActivationError, type FeatureIdentity, type FeatureDescriptor, type FeatureStatusMetadata } from '@/shared/effect/feature.js'

describe('FeatureDescriptor', () => {
  it.effect('pairs identity metadata with an implementation', () =>
    Effect.sync(() => {
      const descriptor = {
        id: 'eager',
        implementation: { register: () => undefined },
        status: { icon: '✓', name: 'eager' },
      } satisfies FeatureDescriptor
      const identity: FeatureIdentity = descriptor
      const status: FeatureStatusMetadata = identity.status
      const activation: FeatureActivationError = { _tag: 'Activation' }
      expect([status.name, activation._tag]).toEqual(['eager', 'Activation'])
    })
  )
})
