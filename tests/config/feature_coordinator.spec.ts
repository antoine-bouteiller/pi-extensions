import { afterEach } from 'bun:test'

import { type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asExtensionContext, asResult } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime } from '@tests/utils/runtime.js'
import { Deferred, Effect, Fiber, Scope } from 'effect'

import { type FeatureHealth, makeFeatureCoordinator, registerFeatures } from '@/config/feature_coordinator.js'
import { type FeatureImplementation, type FeaturePlugin, type FeaturePreflightError } from '@/shared/effect/feature.js'
import { publishStatus, statusBar } from '@/shared/state/status_bar.js'

const eager = (id: string, implementation: FeatureImplementation): FeaturePlugin => ({
  bootstrap: 'eager',
  id,
  implementation,
  status: { icon: '✓', name: id },
})
const background = (prepare: Effect.Effect<FeatureImplementation, FeaturePreflightError>, id = 'comment-checker'): FeaturePlugin => ({
  bootstrap: 'background',
  id,
  prepare,
  status: { icon: '✓', name: id },
})

const context = (key: string, hasUI = true, onSetStatus?: (statusKey: string, text: string | undefined) => void, onGetSessionId?: () => void) => {
  const statuses: { key: string; text: string | undefined }[] = []
  return {
    ctx: asExtensionContext({
      cwd: '/repo',
      hasUI,
      sessionManager: {
        getSessionId: () => {
          onGetSessionId?.()
          return key
        },
      },
      ui: {
        setStatus: (statusKey: string, text: string | undefined) => {
          statuses.push({ key: statusKey, text })
          onSetStatus?.(statusKey, text)
        },
      },
    }),
    statuses,
  }
}
const emit = (fixture: ReturnType<typeof createFakePi>, name: string, ctx: ExtensionContext) => Effect.promise(() => fixture.emit(name, {}, ctx))

describe('feature coordinator', () => {
  afterEach(() => {
    for (const id of [
      'same',
      'id',
      'first',
      'bad',
      'last',
      'one',
      'two',
      'three',
      'comment-checker',
      'meridian-session-affinity',
      'eager',
      'typed',
      'defect',
      'typed-stop',
      'defect-stop',
      'sibling',
    ]) {
      publishStatus(`feature:${id}`, undefined)
    }
  })

  it.effect('rejects malformed descriptors before mutating Pi', () =>
    Effect.sync(() => {
      const health: FeatureHealth = { _tag: 'healthy' }
      expect([health._tag, typeof registerFeatures]).toEqual(['healthy', 'function'])
      const descriptor = eager('id', { register: () => undefined })
      const cases: unknown[][] = [
        [new URLSearchParams('feature').get('missing')],
        [undefined],
        ['feature'],
        [descriptor, descriptor],
        [eager('same', { register: () => undefined }), eager('same', { register: () => undefined })],
        [{ ...descriptor, bootstrap: 'later' }],
        [{ ...descriptor, id: undefined }],
        [{ ...descriptor, id: 1 }],
        [{ ...descriptor, status: undefined }],
        [{ ...descriptor, status: { icon: 1, name: 'name' } }],
        [{ ...descriptor, status: { icon: '✓', name: 1 } }],
        [{ ...descriptor, status: { icon: '', name: 'name' } }],
        [{ ...descriptor, status: { icon: '✓', name: ' ' } }],
        [{ ...descriptor, implementation: undefined }],
        [{ ...descriptor, implementation: {} }],
        [{ ...descriptor, implementation: { register: 1 } }],
        [{ ...descriptor, implementation: { activate: 1, register: () => undefined } }],
        [{ ...descriptor, implementation: { deactivate: 1, register: () => undefined } }],
        [{ ...descriptor, prepare: Effect.void }],
        [{ bootstrap: 'background', id: 'comment-checker', prepare: {}, status: { icon: '✓', name: 'x' } }],
        [
          {
            bootstrap: 'background',
            id: 'comment-checker',
            implementation: { register: () => undefined },
            prepare: Effect.void,
            status: { icon: '✓', name: 'x' },
          },
        ],
        [{ bootstrap: 'background', id: 'not-approved', prepare: Effect.void, status: { icon: '✓', name: 'x' } }],
      ]
      for (const features of cases) {
        const fixture = createFakePi()
        expect(() => makeFeatureCoordinator({ features: asResult<FeaturePlugin[]>(features), pi: fixture.pi, runtime })).toThrow()
        expect([fixture.state.handlers.size, fixture.state.tools.size]).toEqual([0, 0])
      }
    })
  )

  it.effect('rejects inherited eager callbacks that are not functions before mutating Pi', () =>
    Effect.sync(() => {
      const fixture = createFakePi()
      const implementation = Object.assign(Object.create({ activate: 1, deactivate: 1 }), { register: () => undefined })
      expect(() => makeFeatureCoordinator({ features: [eager('eager', implementation)], pi: fixture.pi, runtime })).toThrow()
      expect([fixture.state.handlers.size, fixture.state.tools.size]).toEqual([0, 0])
    })
  )

  it.effect('registers eager implementations in order, isolates poison, and installs only lifecycle listeners afterwards', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      const calls: string[] = []
      makeFeatureCoordinator({
        features: [
          eager('first', { register: () => calls.push(`first:${fixture.state.handlers.size}`) }),
          eager('bad', {
            register: () => {
              calls.push('bad')
              throw new Error('broken')
            },
          }),
          eager('last', { register: () => calls.push(`last:${fixture.state.handlers.size}`) }),
        ],
        pi: fixture.pi,
        runtime,
      }).install()
      expect(calls).toEqual(['first:0', 'bad', 'last:0'])
      expect([...fixture.state.handlers.entries()].map(([name, handlers]) => [name, handlers.length])).toEqual([
        ['session_start', 1],
        ['session_shutdown', 1],
      ])
      const ctx = context('poison')
      yield* emit(fixture, 'session_start', ctx.ctx)
      expect(ctx.statuses.some(({ text }) => text === '✓ bad: registration failed; restart required')).toBeTrue()
    })
  )

  it.effect('makes installation idempotent', () =>
    Effect.sync(() => {
      const fixture = createFakePi()
      let registrations = 0
      const coordinator = makeFeatureCoordinator({ features: [eager('eager', { register: () => registrations++ })], pi: fixture.pi, runtime })
      coordinator.install()
      coordinator.install()
      expect(registrations).toBe(1)
      expect([...fixture.state.handlers.entries()].map(([name, handlers]) => [name, handlers.length])).toEqual([
        ['session_start', 1],
        ['session_shutdown', 1],
      ])
    })
  )

  it.effect('awaits registered activation in registry order and makes no-activation features healthy', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      const calls: string[] = []
      makeFeatureCoordinator({
        features: [
          eager('one', { activate: () => Effect.sync(() => calls.push('one')), register: () => undefined }),
          eager('two', { activate: () => Effect.sync(() => calls.push('two')), register: () => undefined }),
          eager('three', { register: () => undefined }),
        ],
        pi: fixture.pi,
        runtime,
      }).install()
      const fixtureContext = context('ordered')
      yield* emit(fixture, 'session_start', fixtureContext.ctx)
      expect(calls).toEqual(['one', 'two'])
      expect(fixtureContext.statuses.filter(({ text }) => text?.endsWith(': checking')).length).toBe(3)
      expect(fixtureContext.statuses.filter(({ text }) => text === '✓ three').length).toBe(1)
    })
  )

  it.scoped('forks background preparation without delaying start, then registers and activates it once', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      const gate = yield* Deferred.make<void>()
      const calls: string[] = []
      const completed = yield* Deferred.make<void>()
      const implementation: FeatureImplementation = {
        activate: () => Effect.sync(() => calls.push('activate')).pipe(Effect.andThen(Deferred.succeed(completed, undefined))),
        register: () => calls.push('register'),
      }
      makeFeatureCoordinator({ features: [background(Deferred.await(gate).pipe(Effect.as(implementation)))], pi: fixture.pi, runtime }).install()
      const fixtureContext = context('background')
      yield* emit(fixture, 'session_start', fixtureContext.ctx)
      expect(calls).toEqual([])
      yield* Deferred.succeed(gate, undefined)
      yield* Deferred.await(completed)
      yield* Effect.yieldNow
      expect(calls).toEqual(['register', 'activate'])
      expect(fixtureContext.statuses.at(-1)?.text).toBe('✓ comment-checker')
    })
  )

  it.effect('activates a previously prepared feature in a later session instead of preparing it again', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      let prepared = 0
      let activated = 0
      const preparedOnce = yield* Deferred.make<void>()
      const activatedOnce = yield* Deferred.make<void>()
      const implementation: FeatureImplementation = {
        activate: () =>
          Effect.sync(() => {
            activated++
          }).pipe(Effect.andThen(Deferred.succeed(activatedOnce, undefined))),
        register: () => undefined,
      }
      makeFeatureCoordinator({
        features: [
          background(
            Effect.sync(() => {
              prepared++
              return implementation
            }).pipe(Effect.tap(() => Deferred.succeed(preparedOnce, undefined)))
          ),
        ],
        pi: fixture.pi,
        runtime,
      }).install()
      const first = context('first')
      yield* emit(fixture, 'session_start', first.ctx)
      yield* Deferred.await(preparedOnce)
      yield* Deferred.await(activatedOnce)
      yield* emit(fixture, 'session_shutdown', first.ctx)
      const second = context('second')
      yield* emit(fixture, 'session_start', second.ctx)
      expect([prepared, activated]).toEqual([1, 2])
    })
  )

  it.scoped('ignores stale shutdown keys and interrupts preparation before matching shutdown teardown', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      const begun = yield* Deferred.make<void>()
      const never = yield* Deferred.make<void>()
      const calls: string[] = []
      makeFeatureCoordinator({
        features: [
          eager('eager', { deactivate: (_ctx, why) => Effect.sync(() => calls.push(`deactivate:${why}`)), register: () => undefined }),
          background(Deferred.succeed(begun, undefined).pipe(Effect.andThen(Deferred.await(never)), Effect.as({ register: () => undefined }))),
        ],
        pi: fixture.pi,
        runtime,
      }).install()
      const current = context('current')
      yield* emit(fixture, 'session_start', current.ctx)
      yield* Deferred.await(begun)
      yield* emit(fixture, 'session_shutdown', context('stale').ctx)
      expect(calls).toEqual([])
      yield* emit(fixture, 'session_shutdown', current.ctx)
      expect(calls).toEqual(['deactivate:shutdown'])
    })
  )

  it.scoped('replaces sessions only after interrupting tracked preparation and deactivates with replaced', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      const entered = yield* Deferred.make<void>()
      const released = yield* Deferred.make<void>()
      const order: string[] = []
      makeFeatureCoordinator({
        features: [
          eager('eager', { deactivate: (_ctx, why) => Effect.sync(() => order.push(`deactivate:${why}`)), register: () => undefined }),
          background(
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never.pipe(Effect.as({ register: () => undefined }))),
              Effect.onInterrupt(() => Deferred.succeed(released, undefined).pipe(Effect.asVoid))
            )
          ),
        ],
        pi: fixture.pi,
        runtime,
      }).install()
      const first = context('one')
      yield* emit(fixture, 'session_start', first.ctx)
      yield* Deferred.await(entered)
      const replacement = yield* Effect.forkChild(emit(fixture, 'session_start', context('two').ctx))
      yield* Deferred.await(released)
      yield* Fiber.join(replacement)
      expect(order).toEqual(['deactivate:replaced'])
    })
  )

  it.effect('isolates typed failures and defects, maps health safely, and retries failed preparation', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      let attempts = 0
      const firstPrepared = yield* Deferred.make<void>()
      const secondPrepared = yield* Deferred.make<void>()
      makeFeatureCoordinator({
        features: [
          eager('typed', { activate: () => Effect.fail({ _tag: 'Activation' }), register: () => undefined }),
          eager('defect', { activate: () => Effect.die('boom'), register: () => undefined }),
          background(
            Effect.suspend(() => {
              attempts++
              return (attempts === 1 ? Effect.fail({ _tag: 'Preflight' }) : Effect.succeed({ register: () => undefined })).pipe(
                Effect.ensuring(Deferred.succeed(attempts === 1 ? firstPrepared : secondPrepared, undefined))
              )
            })
          ),
        ],
        pi: fixture.pi,
        runtime,
      }).install()
      const first = context('fail-one')
      yield* emit(fixture, 'session_start', first.ctx)
      yield* Deferred.await(firstPrepared)
      yield* Effect.yieldNow
      expect(first.statuses.map(({ text }) => text)).toContain('✓ typed: activation failed')
      expect(first.statuses.map(({ text }) => text)).toContain('✓ defect: activation defect')
      expect(first.statuses.map(({ text }) => text)).toContain('✓ comment-checker: preflight failed')
      yield* emit(fixture, 'session_shutdown', first.ctx)
      const second = context('fail-two')
      yield* emit(fixture, 'session_start', second.ctx)
      yield* Deferred.await(secondPrepared)
      yield* Effect.yieldNow
      expect([attempts, second.statuses.at(-1)?.text]).toEqual([2, '✓ comment-checker'])
    })
  )

  it.effect('treats malformed prepared implementations as retryable preflight defects without registering them', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      let attempts = 0
      let registrations = 0
      const firstPrepared = yield* Deferred.make<void>()
      const secondPrepared = yield* Deferred.make<void>()
      makeFeatureCoordinator({
        features: [
          background(
            Effect.suspend(() => {
              attempts++
              return (
                attempts === 1
                  ? asResult<Effect.Effect<FeatureImplementation, FeaturePreflightError>>(Effect.succeed({ activate: 1, deactivate: 1, register: 1 }))
                  : Effect.succeed({ register: () => registrations++ })
              ).pipe(Effect.ensuring(Deferred.succeed(attempts === 1 ? firstPrepared : secondPrepared, undefined)))
            })
          ),
        ],
        pi: fixture.pi,
        runtime,
      }).install()
      const first = context('invalid-preflight-one')
      yield* emit(fixture, 'session_start', first.ctx)
      yield* Deferred.await(firstPrepared)
      yield* Effect.yieldNow
      expect([registrations, first.statuses.at(-1)?.text]).toEqual([0, '✓ comment-checker: preflight defect'])
      yield* emit(fixture, 'session_shutdown', first.ctx)
      const second = context('invalid-preflight-two')
      yield* emit(fixture, 'session_start', second.ctx)
      yield* Deferred.await(secondPrepared)
      yield* Effect.yieldNow
      expect([attempts, registrations, second.statuses.at(-1)?.text]).toEqual([2, 1, '✓ comment-checker'])
    })
  )

  it.scoped('interrupts and awaits activation before deactivation, then closes session scope resources', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      const started = yield* Deferred.make<void>()
      const order: string[] = []
      makeFeatureCoordinator({
        features: [
          eager('eager', {
            activate: () =>
              Effect.gen(function* () {
                const scope = yield* Scope.Scope
                yield* Scope.addFinalizer(
                  scope,
                  Effect.sync(() => order.push('finalizer'))
                )
                yield* Deferred.succeed(started, undefined)
                return yield* Effect.never
              }).pipe(Effect.onInterrupt(() => Effect.sync(() => order.push('activation-interrupted')))),
            deactivate: () => Effect.sync(() => order.push('deactivate')),
            register: () => undefined,
          }),
        ],
        pi: fixture.pi,
        runtime,
      }).install()
      const fixtureContext = context('teardown-order')
      const start = yield* Effect.forkChild(emit(fixture, 'session_start', fixtureContext.ctx))
      yield* Deferred.await(started)
      yield* emit(fixture, 'session_shutdown', fixtureContext.ctx)
      yield* Fiber.join(start)
      expect(order).toEqual(['activation-interrupted', 'deactivate', 'finalizer'])
    })
  )

  it.scoped('keeps shared status when real UI publication fails and retries on the next transition', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let attempts = 0
      makeFeatureCoordinator({
        features: [
          eager('eager', {
            activate: () =>
              Effect.gen(function* () {
                attempts++
                if (attempts === 1) {
                  yield* Deferred.succeed(entered, undefined)
                  yield* Deferred.await(release)
                } else {
                  return yield* Effect.fail({ _tag: 'Activation' })
                }
                return undefined
              }),
            register: () => undefined,
          }),
        ],
        pi: fixture.pi,
        runtime,
      }).install()
      let rejectHealthy = true
      const first = context('publisher-one', true, (_key, text) => {
        if (text === '✓ eager' && rejectHealthy) {
          rejectHealthy = false
          throw new Error('status unavailable')
        }
      })
      const starting = yield* Effect.forkChild(emit(fixture, 'session_start', first.ctx))
      yield* Deferred.await(entered)
      expect(statusBar.list().find(({ key }) => key === 'feature:eager')).toMatchObject({ icon: '✓', text: 'eager: checking', tone: 'muted' })
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(starting)
      expect(statusBar.list().find(({ key }) => key === 'feature:eager')).toMatchObject({ icon: '✓', text: 'eager', tone: 'success' })
      yield* emit(fixture, 'session_shutdown', first.ctx)
      const second = context('publisher-two')
      yield* emit(fixture, 'session_start', second.ctx)
      expect(statusBar.list().find(({ key }) => key === 'feature:eager')).toMatchObject({
        icon: '✓',
        text: 'eager: activation failed',
        tone: 'error',
      })
      expect(second.statuses.map(({ text }) => text)).toEqual(['✓ eager: checking', '✓ eager: activation failed'])
    })
  )

  it.effect('maps preparation defects safely and retries them in the next session', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      let attempts = 0
      const firstPrepared = yield* Deferred.make<void>()
      const secondPrepared = yield* Deferred.make<void>()
      makeFeatureCoordinator({
        features: [
          background(
            Effect.suspend(() => {
              attempts++
              return (attempts === 1 ? Effect.die('broken preflight') : Effect.succeed({ register: () => undefined })).pipe(
                Effect.ensuring(Deferred.succeed(attempts === 1 ? firstPrepared : secondPrepared, undefined))
              )
            })
          ),
        ],
        pi: fixture.pi,
        runtime,
      }).install()
      const first = context('defect-preflight-one')
      yield* emit(fixture, 'session_start', first.ctx)
      yield* Deferred.await(firstPrepared)
      yield* Effect.yieldNow
      expect(first.statuses.map(({ text }) => text)).toContain('✓ comment-checker: preflight defect')
      yield* emit(fixture, 'session_shutdown', first.ctx)
      const second = context('defect-preflight-two')
      yield* emit(fixture, 'session_start', second.ctx)
      yield* Deferred.await(secondPrepared)
      yield* Effect.yieldNow
      expect([attempts, second.statuses.at(-1)?.text]).toEqual([2, '✓ comment-checker'])
    })
  )

  it.scoped('publishes no preparation interruption and retries it in the replacement session', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      const entered = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const retried = yield* Deferred.make<void>()
      let attempts = 0
      makeFeatureCoordinator({
        features: [
          background(
            Effect.suspend(() => {
              attempts++
              return attempts === 1
                ? Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid)),
                    Effect.as({ register: () => undefined })
                  )
                : Deferred.succeed(retried, undefined).pipe(Effect.as({ register: () => undefined }))
            })
          ),
        ],
        pi: fixture.pi,
        runtime,
      }).install()
      const first = context('interrupted-preflight-one')
      yield* emit(fixture, 'session_start', first.ctx)
      yield* Deferred.await(entered)
      yield* emit(fixture, 'session_shutdown', first.ctx)
      yield* Deferred.await(interrupted)
      expect(first.statuses.map(({ text }) => text)).not.toContain('✓ comment-checker: preflight defect')
      const second = context('interrupted-preflight-two')
      yield* emit(fixture, 'session_start', second.ctx)
      yield* Deferred.await(retried)
      yield* Effect.yieldNow
      expect([attempts, second.statuses.at(-1)?.text]).toEqual([2, '✓ comment-checker'])
    })
  )

  it.scoped('guards stale prepared completion across a start-stop race', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      const gate = yield* Deferred.make<void>()
      const stopping = yield* Deferred.make<void>()
      const calls: string[] = []
      makeFeatureCoordinator({
        features: [
          background(
            Effect.uninterruptible(Deferred.await(gate)).pipe(
              Effect.as({ activate: () => Effect.sync(() => calls.push('activate')), register: () => calls.push('register') })
            )
          ),
          background(
            Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(stopping, undefined).pipe(Effect.asVoid))),
            'meridian-session-affinity'
          ),
        ],
        pi: fixture.pi,
        runtime,
      }).install()
      const current = context('stop-race')
      yield* emit(fixture, 'session_start', current.ctx)
      const shutdown = yield* Effect.forkChild(emit(fixture, 'session_shutdown', current.ctx))
      yield* Deferred.await(stopping)
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(shutdown)
      expect(calls).toEqual([])
      expect(current.statuses.map(({ text }) => text)).toContain('✓ comment-checker: checking')
    })
  )

  it.scoped('guards a replaced generation completion and lets the replacement own registration', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      const oldGate = yield* Deferred.make<void>()
      const stopping = yield* Deferred.make<void>()
      const calls: string[] = []
      const replacementReady = yield* Deferred.make<void>()
      let attempts = 0
      makeFeatureCoordinator({
        features: [
          background(
            Effect.suspend(() => {
              attempts++
              return attempts === 1
                ? Effect.uninterruptible(Deferred.await(oldGate)).pipe(Effect.as({ register: () => calls.push('old-register') }))
                : Effect.succeed({
                    activate: () => Effect.sync(() => calls.push('new-activate')).pipe(Effect.andThen(Deferred.succeed(replacementReady, undefined))),
                    register: () => calls.push('new-register'),
                  })
            })
          ),
          background(
            Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(stopping, undefined).pipe(Effect.asVoid))),
            'meridian-session-affinity'
          ),
        ],
        pi: fixture.pi,
        runtime,
      }).install()
      const first = context('replace-race-one')
      yield* emit(fixture, 'session_start', first.ctx)
      const second = context('replace-race-two')
      const replacement = yield* Effect.forkChild(emit(fixture, 'session_start', second.ctx))
      yield* Deferred.await(stopping)
      yield* Deferred.succeed(oldGate, undefined)
      yield* Fiber.join(replacement)
      yield* Deferred.await(replacementReady)
      yield* Effect.yieldNow
      expect(calls).toEqual(['new-register', 'new-activate'])
      expect(second.statuses.map(({ text }) => text)).toContain('✓ comment-checker')
    })
  )

  it.scoped('publishes deactivation errors only for the still-current stopping session', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      makeFeatureCoordinator({
        features: [
          eager('eager', {
            deactivate: () =>
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(Effect.fail({ _tag: 'Activation' }))),
            register: () => undefined,
          }),
        ],
        pi: fixture.pi,
        runtime,
      }).install()
      const first = context('stopping-current')
      yield* emit(fixture, 'session_start', first.ctx)
      const shutdown = yield* Effect.forkChild(emit(fixture, 'session_shutdown', first.ctx))
      yield* Deferred.await(entered)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(shutdown)
      expect(first.statuses.at(-1)?.text).toBe('✓ eager: deactivation failed')
    })
  )

  it.scoped('invalidates an older queued start while old teardown holds the permit', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      const oldStopping = yield* Deferred.make<void>()
      const releaseOld = yield* Deferred.make<void>()
      const installedB = yield* Deferred.make<void>()
      const order: string[] = []
      makeFeatureCoordinator({
        features: [
          eager('eager', {
            activate: (_event, ctx) =>
              Effect.gen(function* () {
                const scope = yield* Scope.Scope
                const key = ctx.sessionManager.getSessionId()
                yield* Scope.addFinalizer(
                  scope,
                  Effect.sync(() => order.push(`close:${key}`))
                )
                if (key === 'B') {
                  yield* Deferred.succeed(installedB, undefined)
                }
              }),
            deactivate: (ctx, why) => {
              const key = ctx.sessionManager.getSessionId()
              order.push(`deactivate:${key}:${why}`)
              return key === 'old' ? Deferred.succeed(oldStopping, undefined).pipe(Effect.andThen(Deferred.await(releaseOld))) : Effect.void
            },
            register: () => undefined,
          }),
        ],
        pi: fixture.pi,
        runtime,
      }).install()
      const old = context('old')
      yield* emit(fixture, 'session_start', old.ctx)
      const startA = yield* Effect.forkChild(emit(fixture, 'session_start', context('A').ctx))
      yield* Deferred.await(oldStopping)
      const bRequested = Deferred.makeUnsafe<void>()
      const bContext = context('B', true, undefined, () => queueMicrotask(() => Deferred.doneUnsafe(bRequested, Effect.void)))
      const startB = yield* Effect.forkChild(emit(fixture, 'session_start', bContext.ctx))
      yield* Deferred.await(bRequested)
      yield* Deferred.succeed(releaseOld, undefined)
      yield* Deferred.await(installedB)
      yield* Fiber.join(startA)
      yield* Fiber.join(startB)
      yield* emit(fixture, 'session_shutdown', context('B').ctx)
      expect(order).toEqual(['deactivate:old:replaced', 'close:old', 'deactivate:B:shutdown', 'close:B'])
    })
  )

  it.scoped('does not let a stale queued start tear down the latest session', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      const bInstalled = yield* Deferred.make<void>()
      const order: string[] = []
      let startedB = false
      const bContext = context('B')
      const aContext = context('A', true, (_statusKey, text) => {
        if (text === '✓ eager: checking' && !startedB) {
          startedB = true
          void fixture.emit('session_start', {}, bContext.ctx)
        }
      })
      makeFeatureCoordinator({
        features: [
          eager('eager', {
            activate: (_event, ctx) =>
              Effect.gen(function* () {
                const scope = yield* Scope.Scope
                const key = ctx.sessionManager.getSessionId()
                yield* Scope.addFinalizer(
                  scope,
                  Effect.sync(() => order.push(`close:${key}`))
                )
                if (key === 'B') {
                  yield* Deferred.succeed(bInstalled, undefined)
                }
              }),
            deactivate: (ctx, why) => Effect.sync(() => order.push(`deactivate:${ctx.sessionManager.getSessionId()}:${why}`)),
            register: () => undefined,
          }),
        ],
        pi: fixture.pi,
        runtime,
      }).install()
      const startA = yield* Effect.forkChild(emit(fixture, 'session_start', aContext.ctx))
      yield* Deferred.await(bInstalled)
      yield* Fiber.join(startA)
      yield* emit(fixture, 'session_shutdown', bContext.ctx)
      expect(order).toEqual(['deactivate:A:replaced', 'deactivate:B:shutdown', 'close:B'])
    })
  )

  it.scoped('interrupts a blocked replacement activation when a newer start arrives', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      const aEntered = yield* Deferred.make<void>()
      const aInterrupted = yield* Deferred.make<void>()
      const bActive = yield* Deferred.make<void>()
      const order: string[] = []
      makeFeatureCoordinator({
        features: [
          eager('eager', {
            activate: (_event, ctx) => {
              const key = ctx.sessionManager.getSessionId()
              return Effect.gen(function* () {
                const scope = yield* Scope.Scope
                yield* Scope.addFinalizer(
                  scope,
                  Effect.sync(() => order.push(`close:${key}`))
                )
                order.push(`activate:${key}`)
                if (key === 'A') {
                  yield* Deferred.succeed(aEntered, undefined)
                  return yield* Effect.never
                }
                if (key === 'B') {
                  yield* Deferred.succeed(bActive, undefined)
                }
                return undefined
              }).pipe(Effect.onInterrupt(() => (key === 'A' ? Deferred.succeed(aInterrupted, undefined).pipe(Effect.asVoid) : Effect.void)))
            },
            deactivate: (ctx, why) => Effect.sync(() => order.push(`deactivate:${ctx.sessionManager.getSessionId()}:${why}`)),
            register: () => undefined,
          }),
        ],
        pi: fixture.pi,
        runtime,
      }).install()
      const old = context('old')
      yield* emit(fixture, 'session_start', old.ctx)
      const startA = yield* Effect.forkChild(emit(fixture, 'session_start', context('A').ctx))
      yield* Deferred.await(aEntered)
      const startB = yield* Effect.forkChild(emit(fixture, 'session_start', context('B').ctx))
      yield* Deferred.await(aInterrupted)
      yield* Deferred.await(bActive)
      yield* Fiber.join(startA)
      yield* Fiber.join(startB)
      yield* emit(fixture, 'session_shutdown', context('B').ctx)
      expect(order).toEqual([
        'activate:old',
        'deactivate:old:replaced',
        'close:old',
        'activate:A',
        'deactivate:A:replaced',
        'close:A',
        'activate:B',
        'deactivate:B:shutdown',
        'close:B',
      ])
    })
  )

  it.effect('clears a session after a defective scope finalizer so it cannot deactivate twice', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      let deactivations = 0
      makeFeatureCoordinator({
        features: [
          eager('eager', {
            activate: () =>
              Effect.gen(function* () {
                const scope = yield* Scope.Scope
                yield* Scope.addFinalizer(scope, Effect.die('finalizer defect'))
              }),
            deactivate: () => Effect.sync(() => deactivations++),
            register: () => undefined,
          }),
        ],
        pi: fixture.pi,
        runtime,
      }).install()
      const old = context('defective-finalizer')
      yield* emit(fixture, 'session_start', old.ctx)
      yield* emit(fixture, 'session_shutdown', old.ctx)
      yield* emit(fixture, 'session_start', context('next').ctx)
      expect(deactivations).toBe(1)
    })
  )

  it.scoped('finishes teardown when its lifecycle callback is interrupted', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const finished = yield* Deferred.make<void>()
      const closed = yield* Deferred.make<void>()
      let deactivations = 0
      makeFeatureCoordinator({
        features: [
          eager('eager', {
            activate: () =>
              Effect.gen(function* () {
                const scope = yield* Scope.Scope
                yield* Scope.addFinalizer(scope, Deferred.succeed(closed, undefined))
              }),
            deactivate: () =>
              Effect.sync(() => deactivations++).pipe(
                Effect.andThen(Deferred.succeed(entered, undefined)),
                Effect.andThen(Deferred.await(release)),
                Effect.ensuring(Deferred.succeed(finished, undefined))
              ),
            register: () => undefined,
          }),
        ],
        pi: fixture.pi,
        runtime,
      }).install()
      const current = context('interrupted-shutdown')
      yield* emit(fixture, 'session_start', current.ctx)
      const shutdown = yield* Effect.forkChild(emit(fixture, 'session_shutdown', current.ctx))
      yield* Deferred.await(entered)
      yield* Effect.forkChild(Fiber.interrupt(shutdown))
      yield* Deferred.succeed(release, undefined)
      yield* Deferred.await(finished)
      yield* Deferred.await(closed)
      yield* emit(fixture, 'session_start', context('after-interrupted-shutdown').ctx)
      expect(deactivations).toBe(1)
      expect(current.statuses.map(({ text }) => text)).not.toContain('✓ eager: deactivation defect')
    })
  )

  it.effect('maps teardown typed failures and defects without preventing sibling teardown or headless status publication', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      const calls: string[] = []
      makeFeatureCoordinator({
        features: [
          eager('typed-stop', { deactivate: () => Effect.fail({ _tag: 'Activation' }), register: () => undefined }),
          eager('defect-stop', { deactivate: () => Effect.die('boom'), register: () => undefined }),
          eager('sibling', { deactivate: () => Effect.sync(() => calls.push('sibling')), register: () => undefined }),
        ],
        pi: fixture.pi,
        runtime,
      }).install()
      const fixtureContext = context('headless', false)
      yield* emit(fixture, 'session_start', fixtureContext.ctx)
      yield* emit(fixture, 'session_shutdown', fixtureContext.ctx)
      expect(calls).toEqual(['sibling'])
      expect(fixtureContext.statuses).toEqual([])
      expect(statusBar.list().find(({ key }) => key === 'feature:typed-stop')).toMatchObject({
        text: 'typed-stop: deactivation failed',
        tone: 'error',
      })
    })
  )
})
