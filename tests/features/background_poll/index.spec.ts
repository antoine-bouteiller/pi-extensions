import { initTheme, type Theme } from '@earendil-works/pi-coding-agent'
import { type Component, visibleWidth } from '@earendil-works/pi-tui'
import { promiseFromEffect, tryEffect, tryPromiseEffect, describe, expect, it } from '@tests/utils/bun_effect.js'
import { asExtensionApi, asExtensionContext, asTheme } from '@tests/utils/casts.js'
import { deferred } from '@tests/utils/deferred.js'
import { runtime } from '@tests/utils/runtime.js'
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'

import { feature } from '@/features/background_poll/index.js'
import { formatPollOutput, runPollLoop, type PollExec } from '@/features/background_poll/poll.js'
import { ToolFailure } from '@/shared/effect/errors.js'
import { type JsonObject } from '@/shared/utils/json.js'

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
  renderCall: (args: JsonObject, theme: Theme, context: { expanded: boolean }) => Component
  renderResult: (result: ToolResult, options: { expanded: boolean; isPartial: boolean }, theme: Theme, context: { isError: boolean }) => Component
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

  const descriptor = feature({ dependencies: asPollExec(exec) })
  descriptor.implementation.register(
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
    runtime
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

  const activate = () =>
    runtime.runPromise(descriptor.implementation.activate?.({ reason: 'startup', type: 'session_start' }, asExtensionContext(ctx)) ?? Effect.void)
  const deactivate = () => runtime.runPromise(descriptor.implementation.deactivate?.(asExtensionContext(ctx), 'shutdown') ?? Effect.void)
  return { activate, ctx, deactivate, handlers, messages, notifications, sent: messageSent.promise, statuses, tool }
}

const startSession = (fixture: ReturnType<typeof setup>): Promise<void> => fixture.activate()

const rejectionMessage = (promise: Promise<unknown>): Promise<string> =>
  promiseFromEffect(
    tryPromiseEffect(() => promise).pipe(
      Effect.matchEffect({
        onFailure: (error) => Effect.succeed(error.cause instanceof Error ? error.cause.message : String(error.cause)),
        onSuccess: () => Effect.die(new Error('Expected promise to reject')),
      })
    )
  )

initTheme()
const theme = asTheme({ bold: (text: string) => text, fg: (_color: string, text: string) => text })
const renderText = (component: Component) =>
  component
    .render(160)
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()

describe('background poll', () => {
  it('renders partial calls, labels, and commands with bounded collapsed previews', () => {
    const { tool } = setup(() => Promise.resolve({ code: 0, stderr: '', stdout: '' }))
    expect(renderText(tool.renderCall({}, theme, { expanded: false }))).toBe('background_poll ?')
    const args = { command: 'check-status\ncheck-result', label: ' deployment ' }
    expect(renderText(tool.renderCall(args, theme, { expanded: false }))).toBe('background_poll deployment')
    expect(renderText(tool.renderCall(args, theme, { expanded: true }))).toContain('check-status\ncheck-result')
    expect(renderText(tool.renderCall({ ...args, label: ' ' }, theme, { expanded: false }))).toBe('background_poll check-status check-result')
    const longCommand = `check ${'long-argument '.repeat(100)}`
    const collapsed = tool.renderCall({ command: longCommand }, theme, { expanded: false })
    expect(renderText(collapsed)).toContain('...')
    expect(collapsed.render(20).every((line) => visibleWidth(line) <= 20)).toBeTrue()
    expect(renderText(tool.renderCall({ command: longCommand }, theme, { expanded: true })).replaceAll(/\s+/g, ' ')).toContain(longCommand.trim())
  })

  it('renders registration errors, progress, and results without details', () => {
    const { tool } = setup(() => Promise.resolve({ code: 0, stderr: '', stdout: '' }))
    const result = { content: [{ text: 'Session closed', type: 'text' }] }
    const options = { expanded: false, isPartial: false }
    expect(renderText(tool.renderResult(result, options, theme, { isError: true }))).toBe('✗ Session closed')
    expect(renderText(tool.renderResult({ content: [] }, options, theme, { isError: true }))).toBe('✗ Poll registration failed')
    expect(renderText(tool.renderResult({ content: [] }, { ...options, isPartial: true }, theme, { isError: false }))).toBe(
      'Registering background poll…'
    )
    expect(renderText(tool.renderResult(result, options, theme, { isError: false }))).toBe('Session closed')
    expect(renderText(tool.renderResult({ content: [] }, options, theme, { isError: false }))).toBe('No poll registration details')
  })

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

      expect(result.terminate).toBeTrue()
      expect(result.content[0].text).toContain('Stop now')
      const collapsed = renderText(fixture.tool.renderResult(result, { expanded: false, isPartial: false }, theme, { isError: false }))
      expect(collapsed).toContain('✓ Registered · every 1s · timeout 10s')
      expect(collapsed).toContain('to expand')
      expect(collapsed).not.toContain('Stop now')
      const expanded = renderText(fixture.tool.renderResult(result, { expanded: true, isPartial: false }, theme, { isError: false }))
      expect(expanded).toContain('Task: poll-call-1')
      expect(expanded).toContain('Stop now')
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
      yield* Effect.promise(fixture.deactivate)

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
