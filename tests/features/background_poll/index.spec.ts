import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'

import { register as backgroundPoll } from '#features/background_poll/index'
import { formatPollOutput, runPollLoop, type PollExec } from '#features/background_poll/poll'
import { ToolFailure } from '#shared/effect/errors'
import { type JsonObject } from '#shared/utils/json'
import { asExtensionApi } from '#tests/utils/casts'
import { deferred } from '#tests/utils/deferred'
import { promiseFromEffect, tryEffect, tryPromiseEffect, describe, expect, it } from '#tests/utils/effect'
import { runtime } from '#tests/utils/runtime'

interface ToolResult {
  content: { text: string; type: string }[]
  terminate?: boolean
  details?: JsonObject
}

interface TestContext {
  hasUI: boolean
  ui: {
    notify: (message: string, level: string) => number
    setStatus: (key: string, value: unknown) => number
    theme: { fg: (color: string, value: string) => string }
  }
}

interface Tool {
  execute: (toolCallId: string, params: JsonObject, signal: AbortSignal | undefined, onUpdate: undefined, ctx: TestContext) => Promise<ToolResult>
}

type Handler = (event: JsonObject, ctx: TestContext) => Promise<void> | void

type Exec = (
  command: string,
  args: string[],
  options: { signal?: AbortSignal; timeout?: number }
) => Promise<{ stdout: string; stderr: string; code: number }>

const asPollExec =
  (exec: Exec): PollExec =>
  (command, timeoutMs) =>
    Effect.tryPromise({
      catch: (cause) => ToolFailure.make({ cause, message: cause instanceof Error ? cause.message : String(cause) }),
      try: (signal) => exec('sh', ['-lc', command], { signal, timeout: timeoutMs }),
    })

const setup = (exec: Exec) => {
  let tool: Tool | undefined
  const handlers = new Map<string, Handler>()
  const messages: { message: JsonObject; options: JsonObject }[] = []
  const notifications: { message: string; level: string }[] = []
  const statuses: unknown[] = []
  const messageSent = deferred<void>()

  backgroundPoll(
    asExtensionApi({
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      registerTool: (definition: Tool) => {
        tool = definition
      },
      sendMessage: (message: JsonObject, options: JsonObject) => {
        messages.push({ message, options })
        messageSent.resolve(undefined)
      },
    }),
    runtime,
    asPollExec(exec)
  )

  const ctx = {
    hasUI: true,
    ui: {
      notify: (message: string, level: string) => notifications.push({ level, message }),
      setStatus: (_key: string, value: unknown) => statuses.push(value),
      theme: { fg: (_color: string, value: string) => value },
    },
  }

  if (tool === undefined) {
    throw new Error('background-poll did not register a tool')
  }

  return { ctx, handlers, messages, notifications, sent: messageSent.promise, statuses, tool }
}

const startSession = (fixture: ReturnType<typeof setup>): Promise<void> =>
  promiseFromEffect(Effect.promise(() => Promise.resolve(fixture.handlers.get('session_start')?.({}, fixture.ctx))).pipe(Effect.asVoid))

const rejectionMessage = (promise: Promise<unknown>): Promise<string> =>
  promiseFromEffect(
    tryPromiseEffect(() => promise).pipe(
      Effect.matchEffect({
        onFailure: (error) => Effect.succeed(error.cause instanceof Error ? error.cause.message : String(error.cause)),
        onSuccess: () => Effect.die(new Error('Expected promise to reject')),
      })
    )
  )

describe('background poll', () => {
  it.effect('returns immediately, bounds command time, publishes status, and wakes the agent', () =>
    Effect.gen(function* () {
      const commandTimeouts: number[] = []
      const longOutput = `${Array.from({ length: 2100 }, (_unused, index) => `line-${index}`).join('\n')}\nready-at-tail`
      const fixture = setup((_command, _args, options) =>
        promiseFromEffect(
          Effect.sync(() => {
            commandTimeouts.push(options.timeout ?? -1)
            return { code: 0, stderr: '', stdout: longOutput }
          })
        )
      )
      yield* Effect.promise(() => startSession(fixture))

      const result = yield* Effect.promise(() =>
        fixture.tool.execute(
          'call-1',
          { command: 'check-status', interval_seconds: 1, label: 'deployment', timeout_seconds: 10 },
          undefined,
          undefined,
          fixture.ctx
        )
      )

      expect(result.terminate).toBe(true)
      expect(result.content[0].text).toContain('Stop now')
      expect(fixture.statuses).toContain('⏳ 1 background poll')

      yield* Effect.promise(() => fixture.sent)
      expect(commandTimeouts).toHaveLength(1)
      expect(commandTimeouts[0]).toBeGreaterThan(0)
      expect(commandTimeouts[0]).toBeLessThanOrEqual(10_000)
      expect(fixture.messages).toHaveLength(1)
      expect(fixture.messages[0].message.content).toContain('Background poll completed: deployment')
      expect(fixture.messages[0].message.content).toContain('ready-at-tail')
      expect(fixture.messages[0].message.content).toContain('showing the last')
      expect(fixture.messages[0].options).toEqual({ deliverAs: 'followUp', triggerTurn: true })
      expect(fixture.notifications).toEqual([{ level: 'info', message: 'Background poll completed: deployment' }])
      expect(fixture.statuses.at(-1)).toBeUndefined()
    })
  )

  it.effect('reports command failures as error outcomes', () =>
    Effect.gen(function* () {
      const fixture = setup(() =>
        promiseFromEffect(
          tryEffect(() => {
            throw new Error('checker exploded')
          })
        )
      )
      yield* Effect.promise(() => startSession(fixture))

      yield* Effect.promise(() => fixture.tool.execute('error', { command: 'fail' }, undefined, undefined, fixture.ctx))
      yield* Effect.promise(() => fixture.sent)

      expect(fixture.messages[0].message.content).toContain('Background poll failed: fail')
      expect(fixture.messages[0].message.content).toContain('checker exploded')
      expect(fixture.notifications[0]?.level).toBe('warning')
    })
  )

  it.effect('rejects registration with a tagged failure when no session is active', () =>
    Effect.gen(function* () {
      const fixture = setup(() => promiseFromEffect(Effect.succeed({ code: 0, stderr: '', stdout: 'ready' })))

      const rejection = yield* Effect.promise(() =>
        fixture.tool.execute('inactive', { command: 'check' }, undefined, undefined, fixture.ctx).then(
          () => undefined,
          (error: unknown) => error
        )
      )

      expect(rejection).toMatchObject({
        _tag: 'ToolFailure',
        message: 'Cannot register a background poll without an active session',
      })
    })
  )

  it.effect('replaces the session scope and accepts registrations in the new session', () =>
    Effect.gen(function* () {
      const fixture = setup((_command, args, options) => {
        if (args[1] === 'new-check') {
          return Promise.resolve({ code: 0, stderr: '', stdout: 'new session ready' })
        }
        return promiseFromEffect(
          Effect.callback<{ stdout: string; stderr: string; code: number }>((resume) => {
            options.signal?.addEventListener('abort', () => resume(Effect.succeed({ code: 1, stderr: 'stopped', stdout: '' })), { once: true })
          })
        )
      })
      yield* Effect.promise(() => startSession(fixture))
      yield* Effect.promise(() => fixture.tool.execute('old', { command: 'old-check' }, undefined, undefined, fixture.ctx))

      yield* Effect.promise(() => startSession(fixture))
      yield* Effect.promise(() => fixture.tool.execute('new', { command: 'new-check' }, undefined, undefined, fixture.ctx))
      yield* Effect.promise(() => fixture.sent)

      expect(fixture.messages).toHaveLength(1)
      expect(fixture.messages[0].message.content).toContain('new session ready')
    })
  )

  it.effect('suppresses completion and clears status when the session shuts down', () =>
    Effect.gen(function* () {
      const fixture = setup((_command, _args, options) =>
        promiseFromEffect(
          Effect.callback<{ stdout: string; stderr: string; code: number }>((resume) => {
            options.signal?.addEventListener('abort', () => resume(Effect.succeed({ code: 1, stderr: 'stopped', stdout: '' })), { once: true })
          })
        )
      )
      yield* Effect.promise(() => startSession(fixture))

      yield* Effect.promise(() =>
        fixture.tool.execute('call-2', { command: 'check-status', interval_seconds: 60, timeout_seconds: 120 }, undefined, undefined, fixture.ctx)
      )
      yield* Effect.promise(() => Promise.resolve(fixture.handlers.get('session_shutdown')?.({}, fixture.ctx)))

      expect(fixture.messages).toHaveLength(0)
      expect(fixture.statuses.at(-1)).toBeUndefined()
      expect(
        yield* Effect.promise(() => rejectionMessage(fixture.tool.execute('late', { command: 'check-status' }, undefined, undefined, fixture.ctx)))
      ).toBe('Cannot register a background poll during shutdown')
    })
  )

  it.effect('uses virtual time and stops retrying at the deadline', () =>
    Effect.gen(function* () {
      let attempts = 0
      const fiber = yield* Effect.forkChild(
        runPollLoop({
          command: 'check',
          cwd: undefined,
          exec: () =>
            Effect.sync(() => {
              attempts += 1
              return { code: 1, stderr: 'not ready', stdout: '' }
            }),
          intervalMs: 1000,
          label: 'bounded',
          taskId: 'poll-test',
          timeoutMs: 3000,
        })
      )

      yield* TestClock.adjust('3 seconds')
      const result = yield* Fiber.join(fiber)

      expect(result.details.outcome).toBe('timed-out')
      expect(result.details.elapsedMs).toBe(3000)
      expect(result.details.attempts).toBe(3)
      expect(attempts).toBe(3)
    })
  )

  it.effect('retries an attempt that exceeded its own timeout instead of ending the poll', () =>
    Effect.gen(function* () {
      let attempts = 0
      const fiber = yield* Effect.forkChild(
        runPollLoop({
          command: 'check',
          cwd: undefined,
          exec: () =>
            Effect.sync(() => {
              attempts += 1
              return attempts === 1
                ? { code: 124, stderr: 'Poll command did not finish within 1000ms', stdout: '' }
                : { code: 0, stderr: '', stdout: 'ready' }
            }),
          intervalMs: 1000,
          label: 'slow-start',
          taskId: 'poll-timeout',
          timeoutMs: 30_000,
        })
      )

      yield* TestClock.adjust('1 second')
      const result = yield* Fiber.join(fiber)

      expect(result.details.outcome).toBe('completed')
      expect(result.details.attempts).toBe(2)
      expect(result.output).toContain('ready')
    })
  )

  it.effect('ends the poll only when the command itself fails to run', () =>
    Effect.gen(function* () {
      const result = yield* runPollLoop({
        command: 'check',
        cwd: undefined,
        exec: () => ToolFailure.make({ message: 'spawn sh ENOENT' }),
        intervalMs: 1000,
        label: 'broken',
        taskId: 'poll-broken',
        timeoutMs: 30_000,
      })

      expect(result.details.outcome).toBe('error')
      expect(result.output).toBe('spawn sh ENOENT')
    })
  )

  it.effect('keeps the tail when output is truncated', () =>
    Effect.sync(() => {
      const output = formatPollOutput(`${'head\n'.repeat(3000)}tail`, '')

      expect(output).toContain('tail')
      expect(output).toContain('showing the last')
    })
  )
})
