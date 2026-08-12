import { expect } from 'bun:test'

import { describe, it } from '@tests/utils/bun_effect.js'
import { asExtensionApi } from '@tests/utils/casts.js'
import { deferred } from '@tests/utils/deferred.js'
import { runtime } from '@tests/utils/runtime.js'
import { Effect, Fiber } from 'effect'
import { TestClock } from 'effect/testing'

import { register as backgroundPoll } from '@/features/background_poll/index.js'
import { formatPollOutput, runPollLoop } from '@/features/background_poll/poll.js'

interface ToolResult {
  content: { text: string; type: string }[]
  terminate?: boolean
  details?: Record<string, unknown>
}

interface Tool {
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: Record<string, unknown>
  ) => Promise<ToolResult>
}

type Handler = (event: unknown, ctx: Record<string, unknown>) => Promise<void> | void

type Exec = (
  command: string,
  args: string[],
  options: { signal?: AbortSignal; timeout?: number }
) => Promise<{ stdout: string; stderr: string; code: number }>

const setup = (exec: Exec) => {
  let tool: Tool | undefined
  const handlers = new Map<string, Handler>()
  const messages: { message: Record<string, unknown>; options: Record<string, unknown> }[] = []
  const notifications: { message: string; level: string }[] = []
  const statuses: unknown[] = []
  const messageSent = deferred<void>()

  backgroundPoll(
    asExtensionApi({
      exec,
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      registerTool: (definition: Tool) => {
        tool = definition
      },
      sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) => {
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

  return { ctx, handlers, messages, notifications, sent: messageSent.promise, statuses, tool }
}

const startSession = async (fixture: ReturnType<typeof setup>): Promise<void> => {
  await fixture.handlers.get('session_start')?.({}, fixture.ctx)
}

const rejectionMessage = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
    throw new Error('Expected promise to reject')
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe('background poll', () => {
  it('returns immediately, bounds command time, publishes status, and wakes the agent', async () => {
    const commandTimeouts: number[] = []
    const longOutput = `${Array.from({ length: 2100 }, (_unused, index) => `line-${index}`).join('\n')}\nready-at-tail`
    const fixture = setup(async (_command, _args, options) => {
      commandTimeouts.push(options.timeout ?? -1)
      return { code: 0, stderr: '', stdout: longOutput }
    })
    await startSession(fixture)

    const result = await fixture.tool.execute(
      'call-1',
      { command: 'check-status', interval_seconds: 1, label: 'deployment', timeout_seconds: 10 },
      undefined,
      undefined,
      fixture.ctx
    )

    expect(result.terminate).toBeTrue()
    expect(result.content[0].text).toContain('Stop now')
    expect(fixture.statuses).toContain('⏳ 1 background poll')

    await fixture.sent
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

  it('reports command failures as error outcomes', async () => {
    const fixture = setup(async () => {
      throw new Error('checker exploded')
    })
    await startSession(fixture)

    await fixture.tool.execute('error', { command: 'fail' }, undefined, undefined, fixture.ctx)
    await fixture.sent

    expect(fixture.messages[0].message.content).toContain('Background poll failed: fail')
    expect(fixture.messages[0].message.content).toContain('checker exploded')
    expect(fixture.notifications[0]?.level).toBe('warning')
  })

  it('rejects registration with a tagged failure when no session is active', async () => {
    const fixture = setup(async () => ({ code: 0, stderr: '', stdout: 'ready' }))

    const rejection = await fixture.tool.execute('inactive', { command: 'check' }, undefined, undefined, fixture.ctx).then(
      () => undefined,
      (error: unknown) => error
    )

    expect(rejection).toMatchObject({
      _tag: 'ToolFailure',
      message: 'Cannot register a background poll without an active session',
    })
  })

  it('replaces the session scope and accepts registrations in the new session', async () => {
    const fixture = setup((_command, args, options) => {
      if (args[1] === 'new-check') {
        return Promise.resolve({ code: 0, stderr: '', stdout: 'new session ready' })
      }
      return Effect.runPromise(
        Effect.callback<{ stdout: string; stderr: string; code: number }>((resume) => {
          options.signal?.addEventListener('abort', () => resume(Effect.succeed({ code: 1, stderr: 'stopped', stdout: '' })), { once: true })
        })
      )
    })
    await startSession(fixture)
    await fixture.tool.execute('old', { command: 'old-check' }, undefined, undefined, fixture.ctx)

    await startSession(fixture)
    await fixture.tool.execute('new', { command: 'new-check' }, undefined, undefined, fixture.ctx)
    await fixture.sent

    expect(fixture.messages).toHaveLength(1)
    expect(fixture.messages[0].message.content).toContain('new session ready')
  })

  it('suppresses completion and clears status when the session shuts down', async () => {
    const fixture = setup((_command, _args, options) =>
      Effect.runPromise(
        Effect.callback<{ stdout: string; stderr: string; code: number }>((resume) => {
          options.signal?.addEventListener('abort', () => resume(Effect.succeed({ code: 1, stderr: 'stopped', stdout: '' })), { once: true })
        })
      )
    )
    await startSession(fixture)

    await fixture.tool.execute('call-2', { command: 'check-status', interval_seconds: 60, timeout_seconds: 120 }, undefined, undefined, fixture.ctx)
    await fixture.handlers.get('session_shutdown')?.({}, fixture.ctx)

    expect(fixture.messages).toHaveLength(0)
    expect(fixture.statuses.at(-1)).toBeUndefined()
    expect(await rejectionMessage(fixture.tool.execute('late', { command: 'check-status' }, undefined, undefined, fixture.ctx))).toBe(
      'Cannot register a background poll during shutdown'
    )
  })

  it.effect('uses virtual time and stops retrying at the deadline', () =>
    Effect.gen(function* () {
      let attempts = 0
      const fiber = yield* Effect.forkChild(
        runPollLoop({
          command: 'check',
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

  it('keeps the tail when output is truncated', () => {
    const output = formatPollOutput(`${'head\n'.repeat(3000)}tail`, '')

    expect(output).toContain('tail')
    expect(output).toContain('showing the last')
  })
})
