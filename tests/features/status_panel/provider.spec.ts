import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asFetch } from '@tests/utils/casts.js'
import { Effect } from 'effect'
import { TestClock } from 'effect/testing'

import { fetchAnthropicQuota, makeQuotaPoller, quotaFromHeaders } from '@/features/status_panel/provider.js'
import { type ProviderQuota } from '@/features/status_panel/state.js'

const deferred = <Value>() => {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

const flushPromises = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

const gatewayResponse = (profiles: unknown) => Promise.resolve(Response.json(profiles, { status: 200 }))

describe('Anthropic quota provider', () => {
  it('passes the abort signal and converts gateway fractions to percentages', async () => {
    const controller = new AbortController()
    let requestedUrl = ''
    let requestedInit: RequestInit | undefined
    const fakeFetch = asFetch((input, init) => {
      requestedUrl = String(input)
      requestedInit = init
      return gatewayResponse({
        activeProfile: 'default',
        profiles: [
          {
            extraUsage: { isEnabled: true, monthlyLimit: 20_000, usedCredits: 3162 },
            id: 'default',
            isActive: true,
            windows: [
              { resetsAt: Date.now() + 90 * 60_000, type: 'five_hour', utilization: 0.375 },
              { resetsAt: Date.now() + 102 * 60 * 60_000, type: 'seven_day', utilization: 0.62 },
              { type: 'seven_day_fable', utilization: 0.02 },
            ],
          },
        ],
      })
    })

    const quota = await fetchAnthropicQuota('http://127.0.0.1:3456', controller.signal, fakeFetch)
    if (!quota) {
      throw new Error('expected a quota')
    }
    const { windows } = quota
    if (!windows) {
      throw new Error('expected quota windows')
    }

    expect(requestedUrl).toBe('http://127.0.0.1:3456/v1/usage/quota/all')
    expect(requestedInit?.signal).toBe(controller.signal)
    expect(quota.label).toBe('anthropic')
    expect(quota.percent).toBe(37.5)
    expect(quota.detail).toContain('1h 30m')
    expect(quota.detail).toContain('Weekly:')
    expect(quota.detail).toContain('62.0%')
    expect(quota.detail).toContain('31.62/200$')
    expect(windows.map((window) => window.label)).toEqual(['Session', 'Weekly'])
    expect(windows[0]?.percent).toBeCloseTo(37.5)
    expect(windows[0]?.resetsIn).toBe('1h 30m')
    expect(windows[1]?.percent).toBeCloseTo(62)
    expect(windows[1]?.resetsIn).toBe('4d 6h')
    expect(windows[1]?.detail).toBe('31.62/200$')
  })

  it('reads the active profile rather than the first one', async () => {
    const fakeFetch = asFetch(() =>
      gatewayResponse({
        activeProfile: 'work',
        profiles: [
          { id: 'other', isActive: false, windows: [{ type: 'five_hour', utilization: 0.1 }] },
          {
            id: 'work',
            isActive: true,
            windows: [
              { type: 'five_hour', utilization: 0.5 },
              { type: 'seven_day', utilization: 0.25 },
            ],
          },
        ],
      })
    )

    const quota = await fetchAnthropicQuota('http://gateway', undefined, fakeFetch)
    expect(quota?.percent).toBe(50)
  })

  it('strips trailing slashes from the configured base URL', async () => {
    let requestedUrl = ''
    const fakeFetch = asFetch((input) => {
      requestedUrl = String(input)
      return gatewayResponse({ profiles: [] })
    })

    await fetchAnthropicQuota('http://127.0.0.1:3456/', undefined, fakeFetch)
    expect(requestedUrl).toBe('http://127.0.0.1:3456/v1/usage/quota/all')
  })

  it('returns null without a base URL, and for unsuccessful or malformed responses', async () => {
    const unusable = asFetch(() => {
      throw new Error('should not be called')
    })
    const unsuccessful = asFetch(() => Promise.resolve(new Response(undefined, { status: 404 })))
    const malformed = asFetch(() =>
      gatewayResponse({
        profiles: [{ isActive: true, windows: [{ type: 'five_hour', utilization: 0.1 }] }],
      })
    )
    const empty = asFetch(() => gatewayResponse({ profiles: [] }))

    expect(await fetchAnthropicQuota('', undefined, unusable)).toBeUndefined()
    expect(await fetchAnthropicQuota('http://gateway', undefined, unsuccessful)).toBeUndefined()
    expect(await fetchAnthropicQuota('http://gateway', undefined, malformed)).toBeUndefined()
    expect(await fetchAnthropicQuota('http://gateway', undefined, empty)).toBeUndefined()
  })

  it('derives Azure quota only from valid token headers', () => {
    expect(
      quotaFromHeaders('azure-openai', {
        'x-ratelimit-limit-tokens': '1000',
        'x-ratelimit-remaining-tokens': '250',
      })
    ).toEqual({ label: 'azure', percent: 75 })
    expect(quotaFromHeaders('anthropic', {})).toBeUndefined()
    expect(
      quotaFromHeaders('azure-openai', {
        'x-ratelimit-limit-tokens': '0',
        'x-ratelimit-remaining-tokens': '0',
      })
    ).toBeUndefined()
  })
})

describe('Anthropic quota polling lifecycle', () => {
  it.effect('does not overlap requests when a timer fires', () =>
    Effect.gen(function* () {
      const requests: ReturnType<typeof deferred<ProviderQuota | undefined>>[] = []
      const poller = yield* makeQuotaPoller(() => undefined, {
        fetchQuota: () => {
          const request = deferred<ProviderQuota | undefined>()
          requests.push(request)
          return request.promise
        },
        refreshMs: 10,
      })

      yield* poller.start('http://gateway')
      expect(requests).toHaveLength(1)

      yield* TestClock.adjust('10 millis')
      expect(requests).toHaveLength(1)

      const [firstRequest] = requests
      if (!firstRequest) {
        throw new Error('expected a pending request')
      }
      firstRequest.resolve({ label: 'anthropic', percent: 10 })
      yield* Effect.promise(flushPromises)
      yield* TestClock.adjust('10 millis')
      expect(requests).toHaveLength(2)

      yield* poller.stop
      yield* TestClock.adjust('60 millis')
      expect(requests).toHaveLength(2)
    })
  )

  it.effect('continues polling when publishing a quota throws', () =>
    Effect.gen(function* () {
      let fetches = 0
      let publications = 0
      const poller = yield* makeQuotaPoller(
        () => {
          publications += 1
          if (publications === 1) {
            throw new Error('render failed')
          }
        },
        {
          fetchQuota: async () => {
            fetches += 1
            return { label: 'anthropic', percent: 10 }
          },
          refreshMs: 10,
        }
      )

      yield* poller.start('http://gateway')
      yield* Effect.yieldNow
      yield* TestClock.adjust('10 millis')
      expect(fetches).toBe(2)
      expect(publications).toBe(2)
      yield* poller.stop
    })
  )

  it.effect('aborts stopped generations and ignores their late results', () =>
    Effect.gen(function* () {
      const requests: {
        baseUrl: string
        signal: AbortSignal
        result: ReturnType<typeof deferred<ProviderQuota | undefined>>
      }[] = []
      const published: (ProviderQuota | undefined)[] = []
      const poller = yield* makeQuotaPoller(
        (quota) => {
          published.push(quota)
        },
        {
          fetchQuota: (baseUrl, signal) => {
            const result = deferred<ProviderQuota | undefined>()
            requests.push({ baseUrl, result, signal })
            return result.promise
          },
          refreshMs: 10,
        }
      )

      yield* poller.start('http://gateway')
      const [first] = requests
      if (!first) {
        throw new Error('expected a pending request')
      }
      yield* poller.start('http://gateway')
      const [, second] = requests
      if (!second) {
        throw new Error('expected a second pending request')
      }
      expect(first.signal.aborted).toBeTrue()
      expect(second.signal.aborted).toBeFalse()

      expect(second.baseUrl).toBe('http://gateway')
      second.result.resolve({ label: 'anthropic', percent: 20 })
      yield* Effect.promise(flushPromises)
      first.result.resolve({ label: 'anthropic', percent: 90 })
      yield* Effect.promise(flushPromises)
      expect(published).toEqual([{ label: 'anthropic', percent: 20 }])

      yield* TestClock.adjust('10 millis')
      const third = requests.at(2)
      if (!third) {
        throw new Error('expected a third pending request')
      }
      yield* poller.stop
      expect(third.signal.aborted).toBeTrue()
      yield* TestClock.adjust('60 millis')
      expect(requests).toHaveLength(3)
    })
  )
})
