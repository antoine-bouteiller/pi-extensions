import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asExtensionContext } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime, runtimeWithEnvironment } from '@tests/utils/runtime.js'
import { Cause, Effect, Exit, Fiber, Scope } from 'effect'
import { TestClock } from 'effect/testing'
import { HttpClient, HttpClientResponse } from 'effect/unstable/http'

import { feature, healthWarning, implementation } from '@/features/meridian_session_affinity/index.js'
import { perInvocation } from '@/shared/effect/runtime.js'
import { statusBar } from '@/shared/state/status_bar.js'

interface ProviderHeaderEvent {
  headers: Record<string, string>
}

const createHarness = (harnessRuntime = runtime) => {
  const fixture = createFakePi()
  implementation.register(fixture.pi, harnessRuntime)
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

const probe = (baseUrl: string, client: HttpClient.HttpClient) =>
  healthWarning({ baseUrl, httpClient: client }).pipe(Effect.provideService(HttpClient.HttpClient, client))

/** Stands in for the coordinator: prepare, then activate inside a session scope with handler services. */
const activateWith = (baseUrl: string, client: HttpClient.HttpClient, until: () => boolean): Effect.Effect<void> =>
  Effect.promise(() =>
    runtime.runPromise(
      Effect.gen(function* () {
        const prepared = yield* feature({ dependencies: { baseUrl, httpClient: client } }).prepare
        const scope = yield* Scope.make()
        const ctx = asExtensionContext({ hasUI: false, ui: { setStatus: () => undefined } })
        yield* (prepared.activate?.({ reason: 'startup', type: 'session_start' }, ctx) ?? Effect.void).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.provide(perInvocation(ctx))
        )
        // The probe is forked into the session scope; give the real event loop a few turns to settle.
        for (let attempt = 0; attempt < 50 && !until(); attempt += 1) {
          yield* Effect.promise(() => Bun.sleep(1))
        }
        yield* Scope.close(scope, Exit.void)
      })
    )
  )

describe('meridian session affinity', () => {
  it.effect('preserves request-scoped lifecycle behavior after background preparation', () =>
    Effect.sync(() => {
      const fixture = createHarness()
      const descriptor = feature()

      expect(descriptor).toMatchObject({
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
      const warning = yield* probe('https://user:secret@meridian.example.test/proxy/?query=private#fragment', client)

      expect(warning).toBeUndefined()
      expect(requests).toEqual([{ method: 'GET', url: 'https://meridian.example.test/health' }])
    })
  )

  it.effect('reports non-2xx and redirect health responses as a redacted warning', () =>
    Effect.gen(function* () {
      expect(yield* probe('https://meridian.example.test', healthClient(503))).toBe('unavailable')
      expect(yield* probe('https://meridian.example.test', healthClient(302))).toBe('unavailable')
    })
  )

  it.effect('warns on malformed and non-HTTP health URLs before dispatching a request', () =>
    Effect.gen(function* () {
      let requests = 0
      const client = healthClient(204, () => {
        requests += 1
      })

      expect(yield* probe('not a URL', client)).toBe('invalid url')
      expect(yield* probe('file:///private/health', client)).toBe('invalid url')
      expect(requests).toBe(0)
    })
  )

  it.effect('redacts defects instead of failing', () =>
    Effect.gen(function* () {
      const defect = HttpClient.make(() => Effect.die('private defect detail'))

      expect(yield* probe('https://meridian.example.test', defect)).toBe('defect')
    })
  )

  it.effect('uses the virtual TestClock timeout and preserves direct interruption', () =>
    Effect.gen(function* () {
      const blocked = HttpClient.make(() => Effect.never)
      const timeout = yield* Effect.forkChild(probe('https://meridian.example.test', blocked))
      yield* TestClock.adjust('3 seconds')
      const timeoutWarning = yield* Fiber.join(timeout)

      const interrupted = yield* Effect.forkChild(probe('https://meridian.example.test', blocked))
      yield* Fiber.interrupt(interrupted)
      const interruptedExit = yield* Fiber.await(interrupted)

      expect(timeoutWarning).toBe('timeout')
      expect(Exit.isFailure(interruptedExit)).toBeTrue()
      if (Exit.isFailure(interruptedExit)) {
        expect(Cause.hasInterruptsOnly(interruptedExit.cause)).toBeTrue()
      }
    })
  )

  it.effect('loads regardless of Meridian health and only publishes a warning status while it is down', () =>
    Effect.gen(function* () {
      yield* activateWith('https://meridian.example.test', healthClient(503), () => statusBar.has('meridian:health'))
      expect(statusBar.list().find((entry) => entry.key === 'meridian:health')).toMatchObject({
        icon: '🧭',
        text: 'meridian: unavailable',
        tone: 'warning',
      })

      yield* activateWith('https://meridian.example.test', healthClient(204), () => !statusBar.has('meridian:health'))
      expect(statusBar.has('meridian:health')).toBeFalse()
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
    Effect.gen(function* () {
      const fixture = createHarness(runtimeWithEnvironment({ ...process.env, MERIDIAN_BASE_URL: 'https://meridian.example.test/proxy/' }))
      const event: ProviderHeaderEvent = { headers: {} }

      yield* Effect.promise(() => fixture.emit('before_provider_headers', event, context('session-b', 'https://meridian.example.test/proxy')))

      expect(event.headers['x-session-affinity']).toBe('session-b')
    })
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
