import { Data, DateTime, Duration, Effect, Fiber, Ref } from 'effect'
import { Type, type Static } from 'typebox'
import { Check } from 'typebox/value'

import { isEmptyString, isTrue } from '@/shared/utils/predicates.js'

import { progressBar } from './render.js'
import { type ProviderQuota, type QuotaWindow } from './state.js'

class FetchQuotaError extends Data.TaggedError('FetchQuotaError')<{ readonly cause: unknown }> {}

export type QuotaFetcher = (baseUrl: string, signal: AbortSignal) => Promise<ProviderQuota | undefined>

export interface QuotaPoller {
  readonly start: (baseUrl: string) => Effect.Effect<void>
  readonly stop: Effect.Effect<void>
}

export interface QuotaPollerOptions {
  readonly refreshMs: number
  readonly fetchQuota?: QuotaFetcher
}

/**
 * Polls one request at a time and prevents a stopped generation's result from being published.
 * The polling cadence ticks independently of how long any single request takes -- each tick forks
 * its own `refresh` attempt rather than awaiting the previous one -- so the in-flight guard below
 * is load-bearing, not redundant: without it, a slow gateway would let requests overlap.
 */
export const makeQuotaPoller = (onQuota: (quota: ProviderQuota | undefined) => void, options: QuotaPollerOptions): Effect.Effect<QuotaPoller> =>
  Effect.gen(function* () {
    const fetchQuota = options.fetchQuota ?? ((baseUrl, signal) => fetchAnthropicQuota(baseUrl, signal))
    const generationRef = yield* Ref.make(0)
    const inFlightRef = yield* Ref.make(false)
    const fiberRef = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined)

    const refresh = (generation: number, baseUrl: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const currentGeneration = yield* Ref.get(generationRef)
        if (generation !== currentGeneration || (yield* Ref.get(inFlightRef))) {
          return
        }
        yield* Ref.set(inFlightRef, true)
        yield* Effect.gen(function* () {
          /*
           * The signal comes from this fiber, so `stop` interrupting the poll loop is what cancels
           * the request the gateway is still holding open.
           */
          const outcome = yield* Effect.result(
            Effect.tryPromise({ catch: (cause) => new FetchQuotaError({ cause }), try: (signal) => fetchQuota(baseUrl, signal) })
          )
          if (outcome._tag === 'Success' && (yield* Ref.get(generationRef)) === generation) {
            yield* Effect.sync(() => onQuota(outcome.success)).pipe(Effect.ignoreCause)
          }
        }).pipe(Effect.ensuring(Ref.set(inFlightRef, false)))
      })

    const pollLoop = (generation: number, baseUrl: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        while (true) {
          yield* Effect.forkChild(refresh(generation, baseUrl), { startImmediately: true })
          yield* Effect.sleep(Duration.millis(options.refreshMs))
        }
      })

    const stop: Effect.Effect<void> = Effect.gen(function* () {
      yield* Ref.update(generationRef, (value) => value + 1)
      const fiber = yield* Ref.getAndSet(fiberRef, undefined)
      if (fiber !== undefined) {
        yield* Fiber.interrupt(fiber)
      }
    })

    const start = (baseUrl: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* stop
        const generation = yield* Ref.get(generationRef)
        const fiber = yield* Effect.forkDetach(pollLoop(generation, baseUrl), { startImmediately: true })
        yield* Ref.set(fiberRef, fiber)
      })

    return { start, stop }
  })

/** One usage window as reported by the gateway, with `utilization` as a 0..1 fraction. */
const GatewayQuotaWindowSchema = Type.Object({
  resetsAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  type: Type.Optional(Type.String()),
  utilization: Type.Optional(Type.Number()),
})

const GatewayExtraUsageSchema = Type.Object({
  isEnabled: Type.Optional(Type.Boolean()),
  monthlyLimit: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  usedCredits: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
})

const GatewayQuotaProfileSchema = Type.Object({
  extraUsage: Type.Optional(Type.Union([GatewayExtraUsageSchema, Type.Null()])),
  id: Type.Optional(Type.String()),
  isActive: Type.Optional(Type.Boolean()),
  windows: Type.Optional(Type.Array(GatewayQuotaWindowSchema)),
})

const GatewayQuotaResponseSchema = Type.Object({
  activeProfile: Type.Optional(Type.String()),
  profiles: Type.Optional(Type.Array(GatewayQuotaProfileSchema)),
})

type GatewayQuotaProfile = Static<typeof GatewayQuotaProfileSchema>
type GatewayQuotaResponse = Static<typeof GatewayQuotaResponseSchema>

const activeProfile = (usage: GatewayQuotaResponse): GatewayQuotaProfile | undefined => {
  const profiles = usage.profiles ?? []
  return profiles.find((profile) => profile.isActive) ?? profiles.find((profile) => profile.id === usage.activeProfile) ?? profiles[0]
}

const formatReset = (resetsAt: number | null | undefined): string => {
  if (typeof resetsAt !== 'number') {
    return ''
  }
  const minutes = Math.max(0, Math.round((resetsAt - DateTime.toEpochMillis(DateTime.nowUnsafe())) / 60_000))
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ${minutes % 60}m`
  }
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

const quotaWindow = (label: string, percent: number, resetsAt: number | null | undefined): QuotaWindow => {
  const resetsIn = formatReset(resetsAt)
  return isEmptyString(resetsIn) ? { label, percent } : { label, percent, resetsIn }
}

const formatDollars = (cents: number): string => String(Number((cents / 100).toFixed(2)))

const extraUsageDetail = (profile: GatewayQuotaProfile): string => {
  const { extraUsage } = profile
  if (!isTrue(extraUsage?.isEnabled) || typeof extraUsage.usedCredits !== 'number' || typeof extraUsage.monthlyLimit !== 'number') {
    return ''
  }
  return `${formatDollars(extraUsage.usedCredits)}/${formatDollars(extraUsage.monthlyLimit)}$`
}

/**
 * Reads quota from the gateway the anthropic provider is pointed at, which owns the
 * subscription credentials. Upstream `/api/oauth/usage` is not reachable through it.
 */
// oxlint-disable-next-line effecttsgo/async-function -- This is the `QuotaFetcher` seam callers inject: it must stay assignable to the promise-returning fetch contract used by `panel` and the tests.
export const fetchAnthropicQuota = async (
  baseUrl: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<ProviderQuota | undefined> => {
  if (isEmptyString(baseUrl)) {
    return undefined
  }
  try {
    const endpoint = `${baseUrl.replace(/\/+$/, '')}/v1/usage/quota/all`
    const response = await fetchImpl(endpoint, { signal })
    if (!response.ok) {
      return undefined
    }
    const payload: unknown = await response.json()
    if (!Check(GatewayQuotaResponseSchema, payload)) {
      return undefined
    }
    const profile = activeProfile(payload)
    if (profile === undefined) {
      return undefined
    }
    const windows = profile.windows ?? []
    const session = windows.find((window) => window.type === 'five_hour')
    const weekly = windows.find((window) => window.type === 'seven_day')
    if (typeof session?.utilization !== 'number' || typeof weekly?.utilization !== 'number') {
      return undefined
    }
    const sessionPercent = session.utilization * 100
    const weeklyPercent = weekly.utilization * 100
    const extraUsage = extraUsageDetail(profile)
    const weeklyDetail = isEmptyString(extraUsage) ? '' : ` ${extraUsage}`
    return {
      detail: `${formatReset(session.resetsAt)}  Weekly: ${progressBar(weeklyPercent, 10)} ${weeklyPercent.toFixed(1)}%${weeklyDetail}`,
      label: 'anthropic',
      percent: sessionPercent,
      windows: [
        quotaWindow('Session', sessionPercent, session.resetsAt),
        { ...quotaWindow('Weekly', weeklyPercent, weekly.resetsAt), ...(isEmptyString(extraUsage) ? {} : { detail: extraUsage }) },
      ],
    }
  } catch {
    return undefined
  }
}

export const quotaFromHeaders = (provider: string, headers: Record<string, string>): ProviderQuota | undefined => {
  if (!provider.startsWith('azure')) {
    return undefined
  }
  const limit = Number(headers['x-ratelimit-limit-tokens'])
  const remaining = Number(headers['x-ratelimit-remaining-tokens'])
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining)) {
    return undefined
  }
  return { label: 'azure', percent: Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100)) }
}
