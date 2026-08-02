import { describe, expect, it } from 'bun:test'

import { Context, Effect, Fiber, Layer, ManagedRuntime } from 'effect'

import { asError, asExtensionContext } from '#test-utils/casts'

import { ToolFailure } from '../errors.js'
import { makeEventHandler, makeToolExecutor, perInvocation, withAbortSignal } from '../runtime.js'
import { PiCtx, Ui } from '../services.js'

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
        if (opts?.signal) {
          await new Promise<void>((resolve) => {
            opts.signal?.addEventListener('abort', () => {
              entry.aborted = true
              resolve()
            })
            if (overrides.confirm !== undefined) {
              resolve()
            }
          })
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

describe('tool executor boundary', () => {
  it('rejects with the exact Error message a ToolFailure carries', async () => {
    const runtime = emptyRuntime()
    const execute = makeToolExecutor(runtime)(() => Effect.fail(new ToolFailure({ message: 'path is outside the workspace' })))

    const rejection = await execute('call-1', {}, undefined, undefined, fakeContext().ctx).then(
      () => undefined,
      (error: unknown) => error
    )

    expect(rejection).toBeInstanceOf(Error)
    expect(asError(rejection).message).toBe('path is outside the workspace')
    await runtime.dispose()
  })

  it('propagates a rejected promise from inside the effect', async () => {
    const runtime = emptyRuntime()
    const execute = makeToolExecutor(runtime)(() =>
      withAbortSignal(async () => {
        throw new Error('network exploded')
      }).pipe(Effect.map(() => 'unreachable'))
    )

    const rejection = await execute('call-2', {}, undefined, undefined, fakeContext().ctx).then(
      () => undefined,
      (error: unknown) => error
    )

    expect(rejection).toBeDefined()
    await runtime.dispose()
  })

  it('interrupts the fiber when the inbound AbortSignal fires', async () => {
    const runtime = emptyRuntime()
    const controller = new AbortController()
    const execute = makeToolExecutor(runtime)(() => Effect.sleep('30 seconds').pipe(Effect.map(() => 'never')))

    const pending = execute('call-3', {}, controller.signal, undefined, fakeContext().ctx).then(
      () => 'resolved',
      () => 'rejected'
    )
    controller.abort()

    expect(await pending).toBe('rejected')
    await runtime.dispose()
  })

  it('gives concurrent invocations their own context', async () => {
    const runtime = emptyRuntime()
    const execute = makeToolExecutor(runtime)(() =>
      Effect.gen(function* () {
        const ctx = yield* PiCtx
        yield* Effect.sleep('5 millis')
        return ctx.cwd
      })
    )

    const [first, second] = await Promise.all([
      execute('a', {}, undefined, undefined, fakeContext({ cwd: '/one' }).ctx),
      execute('b', {}, undefined, undefined, fakeContext({ cwd: '/two' }).ctx),
    ])

    expect([first, second]).toEqual(['/one', '/two'])
    await runtime.dispose()
  })
})

describe('event handler boundary', () => {
  it('keeps the error channel intact so a failing handler rejects', async () => {
    const runtime = emptyRuntime()
    const handler = makeEventHandler(runtime)(() => Effect.fail(new Error('discovery failed')))

    const rejection = await handler({}, fakeContext().ctx).then(
      () => undefined,
      (error: unknown) => error
    )

    expect(asError(rejection).message).toBe('discovery failed')
    await runtime.dispose()
  })

  it('passes the live event and context through', async () => {
    const runtime = emptyRuntime()
    const handler = makeEventHandler(runtime)((event: { id: string }, ctx) => Effect.succeed(`${event.id}@${ctx.cwd}`))

    expect(await handler({ id: 'evt' }, fakeContext({ cwd: '/here' }).ctx)).toBe('evt@/here')
    await runtime.dispose()
  })
})

const runUi = <Value>(ctx: ReturnType<typeof fakeContext>['ctx'], body: Effect.Effect<Value, never, Ui>) =>
  Effect.runPromise(body.pipe(Effect.provide(perInvocation(ctx))))

describe('ui service', () => {
  it('forwards notify and setStatus, and reports hasUI', async () => {
    const { calls, ctx } = fakeContext({ hasUI: false })

    const visible = await runUi(
      ctx,
      Effect.gen(function* () {
        const ui = yield* Ui
        yield* ui.notify('heads up', 'warning')
        yield* ui.setStatus('mcp', 'connected')
        yield* ui.setStatus('mcp', undefined)
        return yield* ui.hasUI
      })
    )

    expect(visible).toBe(false)
    expect(calls.notifications).toEqual([{ level: 'warning', message: 'heads up' }])
    expect(calls.statuses).toEqual([
      { key: 'mcp', text: 'connected' },
      { key: 'mcp', text: undefined },
    ])
  })

  it('dismisses the confirm dialog when the fiber is interrupted', async () => {
    const { calls, ctx } = fakeContext()

    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const ui = yield* Ui
        return yield* ui.confirm('Delete?', 'This cannot be undone')
      }).pipe(Effect.provide(perInvocation(ctx)))
    )
    await Effect.runPromise(Effect.sleep('10 millis'))
    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(calls.confirms).toHaveLength(1)
    expect(calls.confirms[0]?.aborted).toBe(true)
  })
})

describe('runtime disposal', () => {
  it('runs layer finalizers exactly once', async () => {
    class Tracked extends Context.Service<Tracked, { readonly id: string }>()('@test/Tracked') {}
    let acquired = 0
    let released = 0

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

    await runtime.runPromise(Tracked.pipe(Effect.map((tracked) => tracked.id)))
    await runtime.runPromise(Tracked.pipe(Effect.map((tracked) => tracked.id)))
    expect([acquired, released]).toEqual([1, 0])

    await runtime.dispose()
    expect([acquired, released]).toEqual([1, 1])
  })
})
