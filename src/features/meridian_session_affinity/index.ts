import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Cause, Effect, Stream } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/unstable/http'

import { type AppRuntime } from '#shared/effect/app_services'
import { type FeaturePlugin, type FeaturePreflightError } from '#shared/effect/feature'
import { makeEventHandler } from '#shared/effect/runtime'

import { applySessionAffinity, scrubbedSystemPrompt } from './affinity.js'

const DEFAULT_MERIDIAN_BASE_URL = 'http://127.0.0.1:3456'

export interface MeridianSessionAffinityDependencies {
  readonly baseUrl?: string
  readonly httpClient?: HttpClient.HttpClient
}

type BackgroundFeaturePlugin = Extract<FeaturePlugin, { readonly bootstrap: 'background' }>

type PreflightFailure = FeaturePreflightError & {
  readonly _tag: 'MeridianHealthInvalidUrl' | 'MeridianHealthUnavailable' | 'MeridianHealthTimeout' | 'MeridianHealthDefect'
}

const preflightFailure = (tag: PreflightFailure['_tag']): PreflightFailure => ({ _tag: tag })

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

export const implementation = {
  register: (pi: ExtensionAPI, runtime: AppRuntime): void => {
    pi.on('before_agent_start', (event, ctx) => scrubbedSystemPrompt({ ctx, event }))
    pi.on('before_provider_headers', makeEventHandler(runtime)(applySessionAffinity))
  },
}

const prepare = (dependencies: MeridianSessionAffinityDependencies) =>
  Effect.suspend(() => {
    const endpoint = healthUrl(dependencies.baseUrl ?? DEFAULT_MERIDIAN_BASE_URL)
    if (endpoint === undefined) {
      return Effect.fail(preflightFailure('MeridianHealthInvalidUrl'))
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
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail(preflightFailure('MeridianHealthUnavailable'))
      }
      return implementation
    }).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { credentials: 'omit', redirect: 'manual' }),
      Effect.timeout('3 seconds'),
      Effect.mapError((error) => preflightFailure(error._tag === 'TimeoutError' ? 'MeridianHealthTimeout' : 'MeridianHealthUnavailable')),
      Effect.catchCauseIf(Cause.hasDies, () => Effect.fail(preflightFailure('MeridianHealthDefect')))
    )
  })

export const makeFeature = (dependencies: MeridianSessionAffinityDependencies = {}) =>
  ({
    bootstrap: 'background',
    id: 'meridian-session-affinity',
    prepare: prepare(dependencies),
    status: { icon: '🧭', name: 'meridian' },
  }) satisfies BackgroundFeaturePlugin

export const feature = makeFeature({ baseUrl: Bun.env.MERIDIAN_BASE_URL ?? DEFAULT_MERIDIAN_BASE_URL })
