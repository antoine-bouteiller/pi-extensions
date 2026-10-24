import { BunChildProcessSpawner, BunCrypto, BunFileSystem, BunPath } from '@effect/platform-bun'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asExtensionContext } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { Effect, Exit, Layer, ManagedRuntime, Scope } from 'effect'
import { FetchHttpClient } from 'effect/http'

import { getOrCreateProcessRuntime } from '@/config/runtime.js'
import { feature as meridian } from '@/features/meridian_session_affinity/index.js'
import { type AppRuntime, StatusBar, type StatusBarApi } from '@/shared/effect/app_services.js'
import { envLayer } from '@/shared/effect/env.js'
import { perInvocation } from '@/shared/effect/runtime.js'

const BunPlatformLayer = BunChildProcessSpawner.layer.pipe(Layer.provideMerge(Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, BunPath.layer)))

describe('process-wide runtime', () => {
  it.effect('memoises to one instance across repeated lookups', () =>
    Effect.sync(() => {
      expect(getOrCreateProcessRuntime()).toBe(getOrCreateProcessRuntime())
    })
  )

  it.effect('uses the runtime supplied to a feature register function when the session activates', () =>
    Effect.gen(function* () {
      let channels = 0
      const sentinelStatus: StatusBarApi = {
        channel: () => {
          channels += 1
          return { clear: Effect.void, set: () => Effect.void }
        },
        has: () => false,
        list: () => [],
        subscribe: () => () => undefined,
      }
      const runtime: AppRuntime = ManagedRuntime.make(
        Layer.mergeAll(BunPlatformLayer, FetchHttpClient.layer, envLayer(process.env), Layer.succeed(StatusBar)(sentinelStatus))
      )
      yield* Effect.gen(function* () {
        const descriptor = meridian({ dependencies: { baseUrl: 'http://127.0.0.1:1', which: () => '/usr/local/bin/claude' } })
        descriptor.implementation.register(createFakePi().pi, runtime)
        const scope = Scope.makeUnsafe()
        const ctx = asExtensionContext({ hasUI: false })
        yield* Effect.promise(() =>
          runtime.runPromise(
            (descriptor.implementation.activate?.({ reason: 'startup', type: 'session_start' }, ctx) ?? Effect.void).pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.provide(perInvocation(ctx))
            )
          )
        )
        expect(channels).toBe(1)
        yield* Effect.promise(() => runtime.runPromise(Scope.close(scope, Exit.void)))
      }).pipe(Effect.ensuring(Effect.promise(() => runtime.dispose())))
    })
  )
})
