import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { withProcessEnv } from '@tests/utils/process_env.js'
import { runtime } from '@tests/utils/runtime.js'
import { Cause, Effect, Exit, Fiber } from 'effect'
import { TestClock } from 'effect/testing'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'

import { implementation, makeFeature } from '@/features/meridian_session_affinity/index.js'

interface ProviderHeaderEvent {
  headers: Record<string, string>
}

const createHarness = () => {
  const fixture = createFakePi()
  implementation.register(fixture.pi, runtime)
  return fixture
}

const context = (sessionId: string, baseUrl = 'https://api.anthropic.com', headers: Record<string, string> = {}) => ({
  model: { baseUrl, headers },
  sessionManager: {
    getSessionId: () => sessionId,
  },
})

const healthClient = (status: number, observe: (request: { method: string; url: string }) => void = () => undefined) =>
  HttpClient.make((request) => {
    observe({ method: request.method, url: request.url })
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response('health', { status })))
  })

const preparedWith = (baseUrl: string, client: HttpClient.HttpClient) =>
  makeFeature({ baseUrl, httpClient: client }).prepare.pipe(Effect.provideService(HttpClient.HttpClient, client))

describe('meridian session affinity', () => {
  it.effect('preserves request-scoped lifecycle behavior after background preparation', () =>
    Effect.sync(() => {
      const fixture = createHarness()
      const feature = makeFeature()

      expect(feature).toMatchObject({
        bootstrap: 'background',
        id: 'meridian-session-affinity',
        status: { icon: '🧭', name: 'meridian' },
      })
      expect([...fixture.state.handlers.keys()]).toEqual(['before_agent_start', 'before_provider_headers'])
      expect(fixture.state.commands.size).toBe(0)
    })
  )

  it.effect('normalizes health checks to an exact credential-free GET endpoint', () =>
    Effect.gen(function* () {
      const requests: { method: string; url: string }[] = []
      const client = healthClient(204, (request) => requests.push(request))
      const prepared = yield* preparedWith('https://user:secret@meridian.example.test/proxy/?query=private#fragment', client)

      expect(prepared).toBe(implementation)
      expect(requests).toEqual([{ method: 'GET', url: 'https://meridian.example.test/health' }])
    })
  )

  it.effect('rejects non-2xx health responses with a redacted preflight failure', () =>
    Effect.gen(function* () {
      const client = healthClient(503)
      const failure = yield* Effect.flip(preparedWith('https://meridian.example.test', client))

      expect(failure).toEqual({ _tag: 'MeridianHealthUnavailable' })
    })
  )

  it.effect('rejects redirects rather than following them', () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(preparedWith('https://meridian.example.test', healthClient(302)))

      expect(failure).toEqual({ _tag: 'MeridianHealthUnavailable' })
    })
  )

  it.effect('rejects malformed and non-HTTP health URLs before dispatching a request', () =>
    Effect.gen(function* () {
      let requests = 0
      const client = healthClient(204, () => {
        requests += 1
      })

      const malformed = yield* Effect.flip(preparedWith('not a URL', client))
      const protocol = yield* Effect.flip(preparedWith('file:///private/health', client))

      expect(malformed).toEqual({ _tag: 'MeridianHealthInvalidUrl' })
      expect(protocol).toEqual({ _tag: 'MeridianHealthInvalidUrl' })
      expect(requests).toBe(0)
    })
  )

  it.effect('redacts defects and permits the same descriptor to retry', () =>
    Effect.gen(function* () {
      const defect = HttpClient.make(() => Effect.die('private defect detail'))
      const retryClient = healthClient(204)
      const descriptor = makeFeature({ baseUrl: 'https://meridian.example.test', httpClient: retryClient })

      const defectFailure = yield* Effect.flip(preparedWith('https://meridian.example.test', defect))
      const first = yield* descriptor.prepare.pipe(Effect.provideService(HttpClient.HttpClient, retryClient))
      const second = yield* descriptor.prepare.pipe(Effect.provideService(HttpClient.HttpClient, retryClient))

      expect(defectFailure).toEqual({ _tag: 'MeridianHealthDefect' })
      expect(first).toBe(implementation)
      expect(second).toBe(implementation)
    })
  )

  it.effect('uses the virtual TestClock timeout and preserves direct interruption', () =>
    Effect.gen(function* () {
      const blocked = HttpClient.make(() => Effect.never)
      const timeout = yield* Effect.forkChild(Effect.flip(preparedWith('https://meridian.example.test', blocked)))
      yield* TestClock.adjust('3 seconds')
      const timeoutFailure = yield* Fiber.join(timeout)

      const interrupted = yield* Effect.forkChild(preparedWith('https://meridian.example.test', blocked))
      yield* Fiber.interrupt(interrupted)
      const interruptedExit = yield* Fiber.await(interrupted)

      expect(timeoutFailure).toEqual({ _tag: 'MeridianHealthTimeout' })
      expect(Exit.isFailure(interruptedExit)).toBeTrue()
      if (Exit.isFailure(interruptedExit)) {
        expect(Cause.hasInterruptsOnly(interruptedExit.cause)).toBeTrue()
      }
    })
  )

  it.effect('scrubs Pi fingerprints from the system prompt before an agent starts', () =>
    Effect.gen(function* () {
      const fixture = createHarness()
      const systemPrompt = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
- read: Read files

Pi documentation (read only when the user asks about pi itself):
- Main documentation: /home/user/pi-coding-agent/README.md
Current date: 7/10/2026
Current working directory: /repo`

      const results = yield* Effect.promise(() => fixture.emit('before_agent_start', { systemPrompt }, context('session-a', 'http://127.0.0.1:3456')))

      expect(results).toEqual([
        {
          systemPrompt: `You are an expert coding assistant. You help users by reading files, executing commands, editing code, and writing new files.
Available tools:
- read: Read files

Current date: 7/10/2026
Current working directory: /repo`,
        },
      ])
    })
  )

  it.effect('recognizes a Meridian header configured on the model when scrubbing', () =>
    Effect.gen(function* () {
      const fixture = createHarness()
      const systemPrompt =
        'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.\n'

      const results = yield* Effect.promise(() =>
        fixture.emit('before_agent_start', { systemPrompt }, context('session-a', 'https://api.anthropic.com', { 'X-Meridian-Agent': 'pi' }))
      )

      expect(results).toEqual([
        {
          systemPrompt:
            'You are an expert coding assistant. You help users by reading files, executing commands, editing code, and writing new files.',
        },
      ])
    })
  )

  it.effect('does not scrub system prompts sent directly to non-Meridian providers', () =>
    Effect.gen(function* () {
      const fixture = createHarness()
      const systemPrompt = 'You are an expert coding assistant operating inside pi, a coding agent harness. Keep this direct-provider prompt.\n'

      const results = yield* Effect.promise(() => fixture.emit('before_agent_start', { systemPrompt }, context('session-a')))

      expect(results).toEqual([undefined])
    })
  )

  it.effect('adds the Pi session id to requests identified by the Meridian agent header', () =>
    Effect.gen(function* () {
      const fixture = createHarness()
      const event: ProviderHeaderEvent = {
        headers: {
          authorization: 'Bearer x',
          'x-meridian-agent': 'pi',
        },
      }

      yield* Effect.promise(() => fixture.emit('before_provider_headers', event, context('session-a')))

      expect(event.headers).toEqual({
        authorization: 'Bearer x',
        'x-meridian-agent': 'pi',
        'x-session-affinity': 'session-a',
      })
    })
  )

  it.effect('recognizes the configured Meridian base URL without relying on static headers', () =>
    withProcessEnv('MERIDIAN_BASE_URL', 'https://meridian.example.test/proxy/', () =>
      Effect.gen(function* () {
        const fixture = createHarness()
        const event: ProviderHeaderEvent = { headers: {} }

        yield* Effect.promise(() => fixture.emit('before_provider_headers', event, context('session-b', 'https://meridian.example.test/proxy')))

        expect(event.headers['x-session-affinity']).toBe('session-b')
      })
    )
  )

  it.effect('does not leak session affinity to non-Meridian providers', () =>
    Effect.gen(function* () {
      const fixture = createHarness()
      const event: ProviderHeaderEvent = {
        headers: { authorization: 'Bearer direct-anthropic-key' },
      }

      yield* Effect.promise(() => fixture.emit('before_provider_headers', event, context('private-session', 'https://api.anthropic.com')))

      expect(event.headers['x-session-affinity']).toBeUndefined()
    })
  )

  it.effect('uses stable, distinct affinity ids for subagent sessions', () =>
    Effect.gen(function* () {
      const fixture = createHarness()
      const firstEvent: ProviderHeaderEvent = {
        headers: {
          'X-Meridian-Agent': 'pi',
          'X-Session-Affinity': 'stale',
        },
      }
      const firstFollowup: ProviderHeaderEvent = {
        headers: { 'x-meridian-agent': 'pi' },
      }
      const secondEvent: ProviderHeaderEvent = {
        headers: { 'x-meridian-agent': 'pi' },
      }

      yield* Effect.promise(() => fixture.emit('before_provider_headers', firstEvent, context('subagent-one')))
      yield* Effect.promise(() => fixture.emit('before_provider_headers', firstFollowup, context('subagent-one')))
      yield* Effect.promise(() => fixture.emit('before_provider_headers', secondEvent, context('subagent-two')))

      expect(firstEvent.headers['X-Session-Affinity']).toBeUndefined()
      expect(firstEvent.headers['x-session-affinity']).toBe('subagent-one')
      expect(firstFollowup.headers['x-session-affinity']).toBe(firstEvent.headers['x-session-affinity'])
      expect(secondEvent.headers['x-session-affinity']).toBe('subagent-two')
      expect(secondEvent.headers['x-session-affinity']).not.toBe(firstEvent.headers['x-session-affinity'])
    })
  )
})
