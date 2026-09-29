import { afterEach } from 'bun:test'

import { type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asExtensionContext, asResult } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime } from '@tests/utils/runtime.js'
import { Deferred, Effect, Fiber, Scope } from 'effect'

import { type FeatureHealth, makeFeatureCoordinator, registerFeatures } from '@/config/feature_coordinator.js'
import { type FeatureImplementation, type FeatureDescriptor } from '@/shared/effect/feature.js'
import { publishStatus, statusBar } from '@/shared/state/status_bar.js'

const eager = (id: string, implementation: FeatureImplementation): FeatureDescriptor => ({
  id,
  implementation,
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
      'eager',
      'typed',
      'defect',
      'typed-stop',
      'defect-stop',
      'sibling',
      'subset-included',
      'subset-omitted',
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
      ]
      for (const features of cases) {
        const fixture = createFakePi()
        expect(() => makeFeatureCoordinator({ features: asResult<FeatureDescriptor[]>(features), pi: fixture.pi, runtime })).toThrow()
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

  it.effect('registers and publishes only descriptors included in a subset registry', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      const registrations: string[] = []
      const included = eager('subset-included', {
        register: (pi) => {
          registrations.push('included')
          pi.on('agent_start', () => undefined)
        },
      })
      const omitted = eager('subset-omitted', {
        register: () => registrations.push('omitted'),
      })

      makeFeatureCoordinator({ features: [included], pi: fixture.pi, runtime }).install()
      const fixtureContext = context('subset')
      yield* emit(fixture, 'session_start', fixtureContext.ctx)

      expect(registrations).toEqual(['included'])
      expect([...fixture.state.handlers.keys()]).toEqual(['agent_start', 'session_start', 'session_shutdown'])
      expect(fixtureContext.statuses.map(({ key, text }) => [key, text])).toEqual([
        ['feature:subset-included', undefined],
        ['feature:subset-included', undefined],
      ])
      expect(omitted.id).toBe('subset-omitted')
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
      expect(fixtureContext.statuses.filter(({ text }) => text !== undefined)).toEqual([])
      expect(statusBar.has('feature:three')).toBeFalse()
    })
  )

  it.effect('ignores stale shutdown keys before matching shutdown teardown', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      const calls: string[] = []
      makeFeatureCoordinator({
        features: [eager('eager', { deactivate: (_ctx, why) => Effect.sync(() => calls.push(`deactivate:${why}`)), register: () => undefined })],
        pi: fixture.pi,
        runtime,
      }).install()
      const current = context('current')
      yield* emit(fixture, 'session_start', current.ctx)
      yield* emit(fixture, 'session_shutdown', context('stale').ctx)
      expect(calls).toEqual([])
      yield* emit(fixture, 'session_shutdown', current.ctx)
      expect(calls).toEqual(['deactivate:shutdown'])
    })
  )

  it.effect('isolates typed activation failures and defects and maps health safely', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      makeFeatureCoordinator({
        features: [
          eager('typed', { activate: () => Effect.fail({ _tag: 'Activation' }), register: () => undefined }),
          eager('defect', { activate: () => Effect.die('boom'), register: () => undefined }),
        ],
        pi: fixture.pi,
        runtime,
      }).install()
      const first = context('fail-one')
      yield* emit(fixture, 'session_start', first.ctx)
      expect(first.statuses.map(({ text }) => text)).toContain('✓ typed: activation failed')
      expect(first.statuses.map(({ text }) => text)).toContain('✓ defect: activation defect')
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
      let rejectFirst = true
      const first = context('publisher-one', true, () => {
        if (rejectFirst) {
          rejectFirst = false
          throw new Error('status unavailable')
        }
      })
      const starting = yield* Effect.forkChild(emit(fixture, 'session_start', first.ctx))
      yield* Deferred.await(entered)
      expect(statusBar.has('feature:eager')).toBeFalse()
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(starting)
      expect(statusBar.has('feature:eager')).toBeFalse()
      yield* emit(fixture, 'session_shutdown', first.ctx)
      const second = context('publisher-two')
      yield* emit(fixture, 'session_start', second.ctx)
      expect(statusBar.list().find(({ key }) => key === 'feature:eager')).toMatchObject({
        icon: '✓',
        text: 'eager: activation failed',
        tone: 'error',
      })
      expect(second.statuses.map(({ text }) => text)).toEqual([undefined, '✓ eager: activation failed'])
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
        if (text === undefined && !startedB) {
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
