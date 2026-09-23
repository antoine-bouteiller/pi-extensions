import { fileURLToPath } from 'node:url'

import { BunChildProcessSpawner, BunCrypto, BunFileSystem, BunPath } from '@effect/platform-bun'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asExtensionContext, asResult } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { Effect, Exit, Layer, ManagedRuntime, Scope } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'

import { getOrCreateProcessRuntime } from '@/config/runtime.js'
import { feature as statusPanel } from '@/features/status_panel/index.js'
import { StatusBar, type StatusBarApi, type AppRuntime } from '@/shared/effect/app_services.js'
import { envLayer } from '@/shared/effect/env.js'
import { parseJsonText } from '@/shared/utils/json.js'

const BunPlatformLayer = BunChildProcessSpawner.layer.pipe(Layer.provideMerge(Layer.mergeAll(BunCrypto.layer, BunFileSystem.layer, BunPath.layer)))

describe('process-wide runtime', () => {
  it.effect('does not include MCP when an isolated child builds without the MCP entrypoint', () =>
    Effect.gen(function* () {
      const entrypoint = fileURLToPath(new URL('fixtures/without_mcp_entry.ts', import.meta.url))
      const script = `
        const result = await Bun.build({ entrypoints: ['${entrypoint}'], metafile: true, target: 'bun' });
        if (!result.success) process.exit(1);
        console.log(JSON.stringify(Object.keys(result.metafile.inputs)));
      `
      const child = Bun.spawn([process.execPath, '--eval', script], { stderr: 'pipe', stdout: 'pipe' })
      const [stdout, stderr, exitCode] = yield* Effect.promise(() =>
        Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      )

      expect(exitCode, stderr).toBe(0)
      const inputs = asResult<readonly string[]>(parseJsonText(stdout.trim()))
      const normalizedInputs = inputs.map((input) => input.replaceAll('\\', '/'))
      expect(normalizedInputs).toEqual(
        expect.arrayContaining([
          expect.stringContaining('src/config/runtime.ts'),
          expect.stringContaining('src/features/ask_user/index.ts'),
          expect.stringContaining('src/features/status_panel/index.ts'),
        ])
      )
      expect(normalizedInputs.some((input) => input.includes('src/features/mcp/'))).toBeFalse()
    })
  )

  it.effect('memoises to one instance across repeated lookups', () =>
    Effect.sync(() => {
      expect(getOrCreateProcessRuntime()).toBe(getOrCreateProcessRuntime())
    })
  )

  it.effect('uses the runtime supplied to a feature register function when the session activates', () =>
    Effect.gen(function* () {
      let subscriptions = 0
      const sentinelStatus: StatusBarApi = {
        channel: () => ({ clear: Effect.void, set: () => Effect.void }),
        has: () => false,
        list: () => [],
        subscribe: () => {
          subscriptions += 1
          return () => undefined
        },
      }
      const runtime: AppRuntime = ManagedRuntime.make(
        Layer.mergeAll(BunPlatformLayer, FetchHttpClient.layer, envLayer(process.env), Layer.succeed(StatusBar)(sentinelStatus))
      )
      yield* Effect.gen(function* () {
        const descriptor = statusPanel()
        descriptor.implementation.register(createFakePi().pi, runtime)
        const scope = Scope.makeUnsafe()
        const ctx = asExtensionContext({
          cwd: '/project',
          getContextUsage: () => undefined,
          mode: 'rpc',
          model: { contextWindow: 100_000, id: 'model', provider: 'openai' },
        })
        yield* Effect.promise(() =>
          runtime.runPromise(
            Effect.provideService(descriptor.implementation.activate({ reason: 'startup', type: 'session_start' }, ctx), Scope.Scope, scope)
          )
        )
        expect(subscriptions).toBe(1)
        yield* Effect.promise(() => runtime.runPromise(Scope.close(scope, Exit.void)))
      }).pipe(Effect.ensuring(Effect.promise(() => runtime.dispose())))
    })
  )
})
