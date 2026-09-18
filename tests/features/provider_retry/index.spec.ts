import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime, runtimeWithEnvironment } from '@tests/utils/runtime.js'
import { Effect } from 'effect'

import { makeFeatureCoordinator } from '@/config/feature_coordinator.js'
import { feature } from '@/features/provider_retry/index.js'

const errorEvent = { message: { errorMessage: 'Unexpected response', role: 'assistant', stopReason: 'error' }, type: 'message_end' }
const replacement = [{ message: { ...errorEvent.message, errorMessage: 'server error: Unexpected response' } }]
const createHarness = () => {
  const fixture = createFakePi()
  feature().implementation.register(fixture.pi, runtime)
  return fixture
}

describe('provider retry registration', () => {
  it('registers eagerly in both parent and child sessions', () => {
    const descriptor = feature()
    expect(descriptor).toMatchObject({ bootstrap: 'eager', id: 'provider-retry' })
    expect('suppressInChild' in descriptor).toBe(false)
    for (const child of ['0', '1']) {
      const fixture = createFakePi()
      const childRuntime = runtimeWithEnvironment({ PI_SUBAGENT: child })
      makeFeatureCoordinator({ features: [descriptor], pi: fixture.pi, runtime: childRuntime }).install()
      expect([...fixture.state.handlers.keys()]).toEqual([
        'before_provider_request',
        'after_provider_response',
        'message_end',
        'session_start',
        'session_shutdown',
      ])
      expect(fixture.state.tools.size).toBe(0)
      expect(fixture.state.commands.size).toBe(0)
    }
  })

  it.effect('uses the current response status, clearing it for the next request or finalized assistant', () =>
    Effect.gen(function* () {
      const fixture = createHarness()
      yield* Effect.promise(() => fixture.emit('after_provider_response', { status: 401 }))
      yield* Effect.promise(() => fixture.emit('message_end', { message: { role: 'user' } }))
      expect(yield* Effect.promise(() => fixture.emit('message_end', errorEvent))).toEqual([undefined])
      expect(yield* Effect.promise(() => fixture.emit('message_end', errorEvent))).toEqual(replacement)

      yield* Effect.promise(() => fixture.emit('after_provider_response', { status: 403 }))
      expect(yield* Effect.promise(() => fixture.emit('before_provider_request'))).toEqual([undefined])
      expect(yield* Effect.promise(() => fixture.emit('message_end', errorEvent))).toEqual(replacement)

      for (const status of [200, 505]) {
        yield* Effect.promise(() => fixture.emit('after_provider_response', { status }))
        expect(yield* Effect.promise(() => fixture.emit('message_end', errorEvent))).toEqual(replacement)
      }
    })
  )

  it.effect('does not share response status across agent registrations', () =>
    Effect.gen(function* () {
      const parent = createHarness()
      const child = createHarness()
      yield* Effect.promise(() => parent.emit('after_provider_response', { status: 401 }))
      expect(yield* Effect.promise(() => child.emit('message_end', errorEvent))).toEqual(replacement)
      expect(yield* Effect.promise(() => parent.emit('message_end', errorEvent))).toEqual([undefined])
    })
  )
})
