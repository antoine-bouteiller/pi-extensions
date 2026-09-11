import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Cause, Effect, Scope, Stream } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http'

import { type AppRuntime, StatusBar } from '#shared/effect/app_services'
import { processEnvironment } from '#shared/effect/env'
import { type FeatureImplementation, type FeatureOptions, type FeaturePlugin } from '#shared/effect/feature'
import { makeEventHandler } from '#shared/effect/runtime'

import { applySessionAffinity, scrubbedSystemPrompt } from './affinity.js'

const DEFAULT_MERIDIAN_BASE_URL = 'http://127.0.0.1:3456'
const HEALTH_STATUS_KEY = 'meridian:health'

export interface MeridianSessionAffinityDependencies {
  readonly baseUrl?: string
  readonly httpClient?: HttpClient.HttpClient
}

export type MeridianHealthWarning = 'invalid url' | 'unavailable' | 'timeout' | 'defect'

const healthUrl = (baseUrl: string): string | undefined => {
  try {
    const url = new URL(baseUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return undefined
    }
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    url.pathname = '/health'
    return url.toString()
  } catch {
    return undefined
  }
}

/** Probes Meridian's `/health`; never fails, resolves to a redacted warning when it is not reachable. */
export const healthWarning = (
  dependencies: MeridianSessionAffinityDependencies
): Effect.Effect<MeridianHealthWarning | undefined, never, HttpClient.HttpClient> =>
  Effect.suspend(() => {
    const endpoint = healthUrl(dependencies.baseUrl ?? DEFAULT_MERIDIAN_BASE_URL)
    if (endpoint === undefined) {
      return Effect.succeed<MeridianHealthWarning | undefined>('invalid url')
    }

    return Effect.gen(function* () {
      const client = dependencies.httpClient ?? (yield* HttpClient.HttpClient)
      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const healthResponse = yield* HttpClient.withScope(client).execute(HttpClientRequest.get(endpoint))
          yield* healthResponse.stream.pipe(Stream.runDrain, Effect.ignore)
          return healthResponse
        })
      )
      return response.status >= 200 && response.status < 300 ? undefined : 'unavailable'
    }).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { credentials: 'omit', redirect: 'manual' }),
      Effect.timeout('3 seconds'),
      Effect.catch((error) => Effect.succeed<MeridianHealthWarning | undefined>(error._tag === 'TimeoutError' ? 'timeout' : 'unavailable')),
      Effect.catchCauseIf(Cause.hasDies, () => Effect.succeed<MeridianHealthWarning | undefined>('defect'))
    )
  })

export const implementation = {
  register: (pi: ExtensionAPI, runtime: AppRuntime): void => {
    pi.on('before_agent_start', (event, ctx) => scrubbedSystemPrompt({ ctx, event }))
    pi.on('before_provider_headers', makeEventHandler(runtime)(applySessionAffinity))
  },
}

/** The probe is forked into the session scope so a slow or absent Meridian never delays activation. */
const makeImplementation = (dependencies: MeridianSessionAffinityDependencies): FeatureImplementation => ({
  activate: () =>
    Effect.gen(function* () {
      const channel = (yield* StatusBar).channel(HEALTH_STATUS_KEY, { icon: '🧭', tone: 'warning' })
      const publish = healthWarning(dependencies).pipe(
        Effect.flatMap((warning) => (warning === undefined ? channel.clear : channel.set({ text: `meridian: ${warning}` })))
      )
      yield* Effect.forkIn(publish, yield* Scope.Scope)
    }),
  register: implementation.register,
})

/**
 * Eager on purpose: sub-agent workers call `prompt()` right after `session_start`, so a background
 * (forked) registration misses the first `before_agent_start` and the unscrubbed pi harness line
 * reaches Meridian, where Anthropic meters it as Extra Usage. The only asynchronous work, the health
 * probe, already runs inside `activate`.
 */
export const feature = ((options: FeatureOptions<MeridianSessionAffinityDependencies> = {}) => {
  const environment = options.environment ?? processEnvironment
  const dependencies = options.dependencies ?? { baseUrl: environment.get('MERIDIAN_BASE_URL') ?? DEFAULT_MERIDIAN_BASE_URL }
  return {
    bootstrap: 'eager',
    id: 'meridian-session-affinity',
    implementation: makeImplementation(dependencies),
    status: { icon: '🧭', name: 'meridian' },
  }
}) satisfies FeaturePlugin<MeridianSessionAffinityDependencies>
