import { makeAbortController } from '@tests/utils/abort_controller.js'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtimeWithEnvironment } from '@tests/utils/runtime.js'
import { Effect } from 'effect'

import { implementation } from '@/features/meridian_session_affinity/index.js'

const MERIDIAN = 'http://127.0.0.1:3456'
const REX = { REX_BLOCK: 'block:pi', REX_SESSION: 'session:1' }
const authError = {
  message: {
    errorMessage: 'Claude Code returned an error result: Failed to authenticate: OAuth session expired and could not be refreshed',
    role: 'assistant',
    stopReason: 'error',
  },
}
const retried = [{ message: { ...authError.message, errorMessage: `server error: ${authError.message.errorMessage}` } }]

const context = (signal?: AbortSignal, baseUrl = MERIDIAN) => ({ model: { baseUrl, headers: {} }, signal })

const createHarness = (options: { environment?: Record<string, string>; waitCode?: number; wait?: (signal?: AbortSignal) => Promise<void> } = {}) => {
  const calls: string[][] = []
  const fixture = createFakePi({
    exec: async (_command, args, execOptions) => {
      calls.push(args)
      switch (args[0]) {
        case 'block': {
          return { code: 0, stderr: '', stdout: JSON.stringify({ block: { window_id: 'window:pi' } }) }
        }
        case 'api': {
          return {
            code: 0,
            stderr: '',
            stdout: args[4] === 'session.new_layer' ? JSON.stringify({ block_ids: ['block:login'], layer_id: 'layer:login' }) : '{}',
          }
        }
        default: {
          await options.wait?.(execOptions?.signal)
          return { code: options.waitCode ?? 0, killed: execOptions?.signal?.aborted === true, stderr: '', stdout: '' }
        }
      }
    },
  })
  implementation.register(fixture.pi, runtimeWithEnvironment(options.environment ?? REX))
  return { calls, fixture }
}

describe('meridian login retry', () => {
  it.effect('opens claude auth login in a floating pane over Pi and retries after a successful login', () =>
    Effect.gen(function* () {
      const { calls, fixture } = createHarness()

      const results = yield* Effect.promise(() => fixture.emit('message_end', authError, context()))

      expect(results).toEqual(retried)
      expect(calls[0]).toEqual(['block', 'inspect', '-s', 'session:1', 'block:pi', '--json'])
      expect(calls[1]?.slice(0, 4)).toEqual(['api', 'call', '-s', 'session:1'])
      expect(JSON.parse(calls[1]?.[5] ?? '')).toMatchObject({
        focus: true,
        layout: { block: { options: { command: ['claude', 'auth', 'login'] } } },
        window_id: 'window:pi',
      })
      expect(calls[2]).toEqual(['wait', '-s', 'session:1', 'block:login'])
    })
  )

  it.effect('leaves the error alone after a failed login and offers it again only after the run settles', () =>
    Effect.gen(function* () {
      const { calls, fixture } = createHarness({ waitCode: 1 })

      expect(yield* Effect.promise(() => fixture.emit('message_end', authError, context()))).toEqual([undefined])
      expect(yield* Effect.promise(() => fixture.emit('message_end', authError, context()))).toEqual([undefined])
      expect(calls.filter((args) => args[0] === 'wait')).toHaveLength(1)

      yield* Effect.promise(() => fixture.emit('agent_settled', { aborted: false }))
      yield* Effect.promise(() => fixture.emit('message_end', authError, context()))
      expect(calls.filter((args) => args[0] === 'wait')).toHaveLength(2)
    })
  )

  it.effect('closes the pane without retrying when the run is aborted during login', () =>
    Effect.gen(function* () {
      const controller = makeAbortController()
      const { calls, fixture } = createHarness({
        wait: () => {
          controller.abort()
          return Promise.resolve()
        },
      })

      expect(yield* Effect.promise(() => fixture.emit('message_end', authError, context(controller.signal)))).toEqual([undefined])
      expect(calls.at(-1)).toEqual(['api', 'call', '-s', 'session:1', 'session.close_layer', JSON.stringify({ layer_id: 'layer:login' })])
    })
  )

  it.effect('does nothing outside Rex, for other providers, or for other errors', () =>
    Effect.gen(function* () {
      const outside = createHarness({ environment: {} })
      expect(yield* Effect.promise(() => outside.fixture.emit('message_end', authError, context()))).toEqual([undefined])

      const anthropic = createHarness()
      expect(yield* Effect.promise(() => anthropic.fixture.emit('message_end', authError, context(undefined, 'https://api.anthropic.com')))).toEqual([
        undefined,
      ])
      const otherError = { message: { ...authError.message, errorMessage: '529 overloaded' } }
      expect(yield* Effect.promise(() => anthropic.fixture.emit('message_end', otherError, context()))).toEqual([undefined])

      expect([...outside.calls, ...anthropic.calls]).toEqual([])
    })
  )
})
