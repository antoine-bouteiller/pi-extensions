import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asError, asExtensionContext } from '@tests/utils/casts.js'
import { Context, Effect, Fiber, Layer, ManagedRuntime } from 'effect'

import { ToolFailure } from '@/shared/effect/errors.js'
import { PiCtx, Ui } from '@/shared/effect/pi_services.js'
import { makeEventHandler, makeToolExecutor, perInvocation, withAbortSignal } from '@/shared/effect/runtime.js'

interface UiCalls {
  confirms: { title: string; message: string; aborted: boolean }[]
  notifications: { message: string; level: string }[]
  statuses: { key: string; text: string | undefined }[]
}

const fakeContext = (overrides: { cwd?: string; hasUI?: boolean; confirm?: boolean } = {}) => {
  const calls: UiCalls = { confirms: [], notifications: [], statuses: [] }
  const ctx = asExtensionContext({
    cwd: overrides.cwd ?? '/repo',
    hasUI: overrides.hasUI ?? true,
    ui: {
      confirm: async (title: string, message: string, opts?: { signal?: AbortSignal }) => {
        const entry = { aborted: false, message, title }
        calls.confirms.push(entry)
        if (opts?.signal !== undefined) {
          await Effect.runPromise(
            Effect.callback<void>((resume) => {
              opts.signal?.addEventListener('abort', () => {
                entry.aborted = true
                resume(Effect.void)
              })
              if (overrides.confirm !== undefined) {
                resume(Effect.void)
              }
            })
          )
        }
        return overrides.confirm ?? false
      },
      notify: (message: string, level: string) => {
        calls.notifications.push({ level, message })
      },
      setStatus: (key: string, text: string | undefined) => {
        calls.statuses.push({ key, text })
      },
    },
  })
  return { calls, ctx }
}

const emptyRuntime = () => ManagedRuntime.make(Layer.empty)
const scopedEmptyRuntime = Effect.acquireRelease(Effect.sync(emptyRuntime), (runtime) => Effect.promise(() => runtime.dispose()))

describe('tool executor boundary', () => {
  it.scoped('rejects with the tagged ToolFailure and its exact message', () =>
    Effect.gen(function* () {
      const runtime = yield* scopedEmptyRuntime
      const execute = makeToolExecutor(runtime)(() => Effect.fail(ToolFailure.make({ message: 'path is outside the workspace' })))

      const rejection = yield* Effect.promise(() =>
        execute('call-1', {}, undefined, undefined, fakeContext().ctx).then(
          () => undefined,
          (error: unknown) => error
        )
      )

      expect(rejection).toBeInstanceOf(ToolFailure)
      expect(asError(rejection).message).toBe('path is outside the workspace')
      yield* Effect.promise(() => runtime.dispose())
    })
  )

  it.effect('keeps a promise rejection recoverable rather than turning it into a defect', () =>
    Effect.gen(function* () {
      const recovered = yield* withAbortSignal(async () => {
        throw new Error('network exploded')
      }).pipe(Effect.catch((error) => Effect.succeed(asError(error.cause).message)))

      expect(recovered).toBe('network exploded')
    })
  )

  it.scoped('lets a tool map a rejected promise onto its own failure message', () =>
    Effect.gen(function* () {
      const runtime = yield* scopedEmptyRuntime
      const execute = makeToolExecutor(runtime)(() =>
        withAbortSignal(async () => {
          throw new Error('network exploded')
        }).pipe(
          Effect.map(() => 'unreachable'),
          Effect.mapError((error) => ToolFailure.make({ message: `fetch failed: ${asError(error.cause).message}` }))
        )
      )

      const rejection = yield* Effect.promise(() =>
        execute('call-2', {}, undefined, undefined, fakeContext().ctx).then(
          () => undefined,
          (error: unknown) => error
        )
      )

      expect(asError(rejection).message).toBe('fetch failed: network exploded')
      yield* Effect.promise(() => runtime.dispose())
    })
  )

  it.scoped('never runs the body when the signal is already aborted', () =>
    Effect.gen(function* () {
      const runtime = yield* scopedEmptyRuntime
      // oxlint-disable-next-line effecttsgo/abort-controller-in-effect -- This test must control the exact external AbortSignal and its timing.
      const controller = new AbortController()
      controller.abort()
      let bodyRan = false

      const execute = makeToolExecutor(runtime)(() => {
        bodyRan = true
        return Effect.succeed('should not happen')
      })

      const outcome = yield* Effect.promise(() =>
        execute('call-pre-abort', {}, controller.signal, undefined, fakeContext().ctx).then(
          () => 'resolved',
          () => 'rejected'
        )
      )

      expect([outcome, bodyRan]).toEqual(['rejected', false])
      yield* Effect.promise(() => runtime.dispose())
    })
  )

  it.scoped('interrupts the fiber when the inbound AbortSignal fires', () =>
    Effect.gen(function* () {
      const runtime = yield* scopedEmptyRuntime
      // oxlint-disable-next-line effecttsgo/abort-controller-in-effect -- This test must control the exact external AbortSignal and its timing.
      const controller = new AbortController()
      const execute = makeToolExecutor(runtime)(() => Effect.sleep('30 seconds').pipe(Effect.map(() => 'never')))

      const pending = execute('call-3', {}, controller.signal, undefined, fakeContext().ctx).then(
        () => 'resolved',
        () => 'rejected'
      )
      controller.abort()

      expect(yield* Effect.promise(() => pending)).toBe('rejected')
      yield* Effect.promise(() => runtime.dispose())
    })
  )

  it.scoped('gives concurrent invocations their own context', () =>
    Effect.gen(function* () {
      const runtime = yield* scopedEmptyRuntime
      const execute = makeToolExecutor(runtime)(() =>
        Effect.gen(function* () {
          const ctx = yield* PiCtx
          yield* Effect.sleep('5 millis')
          return ctx.cwd
        })
      )

      const [first, second] = yield* Effect.promise(() =>
        Promise.all([
          execute('a', {}, undefined, undefined, fakeContext({ cwd: '/one' }).ctx),
          execute('b', {}, undefined, undefined, fakeContext({ cwd: '/two' }).ctx),
        ])
      )

      expect([first, second]).toEqual(['/one', '/two'])
      yield* Effect.promise(() => runtime.dispose())
    })
  )
})

describe('event handler boundary', () => {
  it.scoped('keeps the error channel intact so a failing handler rejects', () =>
    Effect.gen(function* () {
      const runtime = yield* scopedEmptyRuntime
      const handler = makeEventHandler(runtime)(() => Effect.fail(ToolFailure.make({ message: 'discovery failed' })))

      const rejection = yield* Effect.promise(() =>
        handler({}, fakeContext().ctx).then(
          () => undefined,
          (error: unknown) => error
        )
      )

      expect(asError(rejection).message).toBe('discovery failed')
      yield* Effect.promise(() => runtime.dispose())
    })
  )

  it.scoped('passes the live event and context through', () =>
    Effect.gen(function* () {
      const runtime = yield* scopedEmptyRuntime
      const handler = makeEventHandler(runtime)((event: { id: string }, ctx) => Effect.succeed(`${event.id}@${ctx.cwd}`))

      expect(yield* Effect.promise(() => handler({ id: 'evt' }, fakeContext({ cwd: '/here' }).ctx))).toBe('evt@/here')
      yield* Effect.promise(() => runtime.dispose())
    })
  )
})

const runUi = <Value>(ctx: ReturnType<typeof fakeContext>['ctx'], body: Effect.Effect<Value, never, Ui>) =>
  Effect.runPromise(body.pipe(Effect.provide(perInvocation(ctx))))

describe('ui service', () => {
  it.effect('forwards notify and setStatus, and reports hasUI', () =>
    Effect.gen(function* () {
      const { calls, ctx } = fakeContext({ hasUI: false })

      const visible = yield* Effect.promise(() =>
        runUi(
          ctx,
          Effect.gen(function* () {
            const ui = yield* Ui
            yield* ui.notify('heads up', 'warning')
            yield* ui.setStatus('mcp', 'connected')
            yield* ui.setStatus('mcp', undefined)
            return yield* ui.hasUI
          })
        )
      )

      expect(visible).toBe(false)
      expect(calls.notifications).toEqual([{ level: 'warning', message: 'heads up' }])
      expect(calls.statuses).toEqual([
        { key: 'mcp', text: 'connected' },
        { key: 'mcp', text: undefined },
      ])
    })
  )

  it.effect('dismisses the confirm dialog when the fiber is interrupted', () =>
    Effect.gen(function* () {
      const { calls, ctx } = fakeContext()

      // oxlint-disable-next-line effecttsgo/run-effect-inside-effect -- This Promise-shaped fake or managed runtime intentionally runs outside the ambient test Effect.
      const fiber = Effect.runFork(
        Effect.gen(function* () {
          const ui = yield* Ui
          return yield* ui.confirm('Delete?', 'This cannot be undone')
        }).pipe(Effect.provide(perInvocation(ctx)))
      )
      // oxlint-disable-next-line effecttsgo/run-effect-inside-effect -- This Promise-shaped fake or managed runtime intentionally runs outside the ambient test Effect.
      yield* Effect.promise(() => Effect.runPromise(Effect.sleep('10 millis')))
      // oxlint-disable-next-line effecttsgo/run-effect-inside-effect -- This Promise-shaped fake or managed runtime intentionally runs outside the ambient test Effect.
      yield* Effect.promise(() => Effect.runPromise(Fiber.interrupt(fiber)))

      expect(calls.confirms).toHaveLength(1)
      expect(calls.confirms[0]?.aborted).toBe(true)
    })
  )
})

describe('runtime disposal', () => {
  it.effect('runs layer finalizers exactly once', () =>
    Effect.gen(function* () {
      class Tracked extends Context.Service<Tracked, { readonly id: string }>()('pi-extensions/tests/shared/effect/runtime.spec/Tracked') {}
      let acquired = 0
      let released = 0

      const duringScope = yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = ManagedRuntime.make(
            Layer.effect(Tracked)(
              Effect.acquireRelease(
                Effect.sync(() => {
                  acquired += 1
                  return { id: 'tracked' }
                }),
                () =>
                  Effect.sync(() => {
                    released += 1
                  })
              )
            )
          )
          yield* Effect.addFinalizer(() => Effect.promise(() => runtime.dispose()))
          yield* Effect.promise(() => runtime.runPromise(Tracked.pipe(Effect.map((tracked) => tracked.id))))
          yield* Effect.promise(() => runtime.runPromise(Tracked.pipe(Effect.map((tracked) => tracked.id))))
          return [acquired, released]
        })
      )

      expect(duringScope).toEqual([1, 0])
      expect([acquired, released]).toEqual([1, 1])
    })
  )

  it.scoped('interrupts an in-flight fiber on disposal, and a replacement runtime still works', () =>
    Effect.gen(function* () {
      class Counter extends Context.Service<Counter, { readonly id: string }>()('pi-extensions/tests/shared/effect/runtime.spec/Counter') {}
      let released = 0
      const layer = Layer.effect(Counter)(
        Effect.acquireRelease(Effect.succeed({ id: 'counter' }), () =>
          Effect.sync(() => {
            released += 1
          })
        )
      )

      const runtime = ManagedRuntime.make(layer)
      yield* Effect.addFinalizer(() => Effect.promise(() => runtime.dispose()))
      let interrupted = false
      const pending = runtime.runPromise(Effect.sleep('1 hour').pipe(Effect.onInterrupt(() => Effect.sync(() => (interrupted = true))))).then(
        () => 'resolved',
        () => 'rejected'
      )
      yield* Effect.promise(() => runtime.runPromise(Counter.pipe(Effect.map((counter) => counter.id))))

      yield* Effect.promise(() => runtime.dispose())

      expect(yield* Effect.promise(() => pending)).toBe('rejected')
      expect([interrupted, released]).toEqual([true, 1])

      const replacement = ManagedRuntime.make(layer)
      yield* Effect.addFinalizer(() => Effect.promise(() => replacement.dispose()))
      expect(yield* Effect.promise(() => replacement.runPromise(Counter.pipe(Effect.map((counter) => counter.id))))).toBe('counter')
      yield* Effect.promise(() => replacement.dispose())
      expect(released).toBe(2)
    })
  )
})
