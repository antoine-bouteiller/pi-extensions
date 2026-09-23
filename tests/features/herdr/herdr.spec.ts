import { makeAbortController } from '@tests/utils/abort_controller.js'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asExtensionContext } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { Effect } from 'effect'

import { makeHerdrHandlers } from '@/features/herdr/herdr.js'
import { makeEnvironment } from '@/shared/effect/env.js'
import { jsonText } from '@/shared/utils/json.js'

interface Pane {
  agent?: string
  agent_session?: { agent: string; kind: string; value: string }
  pane_id: string
  terminal_id: string
}
const parent: Pane = {
  agent: 'pi',
  agent_session: { agent: 'pi', kind: 'path', value: '/sessions/parent.jsonl' },
  pane_id: 'w1:p1',
  terminal_id: 'parent-terminal',
}
const child: Pane = {
  agent: 'pi',
  agent_session: { agent: 'pi', kind: 'path', value: '/sessions/child.jsonl' },
  pane_id: 'w1:p2',
  terminal_id: 'child-terminal',
}
const context = (session = '/sessions/parent.jsonl') =>
  asExtensionContext({ cwd: '/project with spaces', sessionManager: { getSessionFile: () => session } })
const task = { message: 'Review the diff; do not modify files.', model: 'azure-openai-responses/gpt-6-sol' }

interface CliState {
  current: Pane
  parent: Pane
  child: Pane
  width: number
  height: number
  fail?: string
  stdout?: string
  afterCommand?: (operation: string) => void
}
type CliReply =
  | { pane: Pane }
  | { agent: Pane }
  | { type: 'ok' }
  | { layout: { panes: { pane_id: string; rect: { height: number; width: number } }[] } }

const harness = (environment: Record<string, string> = { HERDR_ENV: '1' }) => {
  const calls: { args: string[]; command: string; cwd: string | undefined; timeout: number | undefined }[] = []
  const state: CliState = { child: { pane_id: child.pane_id, terminal_id: child.terminal_id }, current: parent, height: 40, parent, width: 160 }
  const fake = createFakePi({
    exec: (command, args, options) => {
      calls.push({ args, command, cwd: options?.cwd, timeout: options?.timeout })
      const operation = args.slice(0, 2).join(' ')
      if (state.fail === operation) {
        return Promise.resolve({ code: 1, stderr: 'agent_not_ready: inspect the pane', stdout: '' })
      }
      let result: CliReply
      switch (operation) {
        case 'pane current': {
          result = { pane: state.current }
          break
        }
        case 'pane layout': {
          result = { layout: { panes: [{ pane_id: state.current.pane_id, rect: { height: state.height, width: state.width } }] } }
          break
        }
        case 'pane split': {
          result = { pane: state.child }
          break
        }
        case 'agent start': {
          state.child = child
          result = { agent: child }
          break
        }
        case 'pane get': {
          result = { pane: args[2] === parent.pane_id ? state.parent : state.child }
          break
        }
        case 'agent prompt': {
          result = { agent: args[2] === parent.pane_id ? state.parent : state.child }
          break
        }
        case 'pane close': {
          result = { type: 'ok' }
          break
        }
        default: {
          throw new Error(`Unexpected CLI command: ${args.join(' ')}`)
        }
      }
      state.afterCommand?.(operation)
      return Promise.resolve({ code: 0, stderr: '', stdout: state.stdout ?? jsonText({ result }) })
    },
  })
  return { calls, handlers: makeHerdrHandlers(fake.pi, makeEnvironment(environment)), state }
}
const refusal = <Result, Services>(effect: Effect.Effect<Result, { message: string }, Services>) =>
  effect.pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => 'unexpected success' }))
const mutations = (calls: ReturnType<typeof harness>['calls']) => calls.filter(({ args }) => ['prompt', 'close'].includes(args[1] ?? ''))

describe('Herdr delegation', () => {
  it.effect('starts Pi with explicit model, parent route and initial message, preserving cwd/focus', () =>
    Effect.gen(function* () {
      const { handlers, calls } = harness()
      expect(yield* handlers.spawn(task, context())).toEqual({ model: task.model, pane_id: child.pane_id, status: 'started' })
      expect(calls.map(({ args }) => args.slice(0, 2).join(' '))).toEqual([
        'pane current',
        'pane layout',
        'pane split',
        'agent start',
        'agent prompt',
      ])
      expect(calls.every(({ command, cwd, timeout }) => command === 'herdr' && cwd === '/project with spaces' && timeout === 40_000)).toBe(true)
      expect(calls[2]?.args).toEqual([
        'pane',
        'split',
        '--pane',
        parent.pane_id,
        '--direction',
        'right',
        '--cwd',
        '/project with spaces',
        '--no-focus',
        '--env',
        `PI_HERDR_PARENT=${jsonText({ pane_id: parent.pane_id, session_file: '/sessions/parent.jsonl', terminal_id: parent.terminal_id })}`,
      ])
      const start = calls[3]?.args ?? []
      expect(start.slice(3, 12)).toEqual([
        '--kind',
        'pi',
        '--pane',
        child.pane_id,
        '--',
        '--provider',
        'azure-openai-responses',
        '--model',
        'gpt-6-sol',
      ])
      expect(start[start.indexOf('--extension') + 1]).toEndWith('/src/index.ts')
      expect(start[start.indexOf('--append-system-prompt') + 1]).toContain(`send_message with pane_id ${parent.pane_id}`)
      expect(calls[4]?.args).toEqual(['agent', 'prompt', child.pane_id, `Message from Pi pane ${parent.pane_id}:\n\n${task.message}`])
      expect(calls.flatMap(({ args }) => args)).not.toContain('--wait')
    })
  )

  it.effect('splits narrow panes down and prefixes command-like messages as plain text', () =>
    Effect.gen(function* () {
      const { handlers, calls, state } = harness()
      state.width = 60
      yield* handlers.spawn({ ...task, message: '/quit\n!echo unsafe\n$(touch /tmp/no)' }, context())
      expect(calls[2]?.args).toContain('down')
      expect(calls[4]?.args[3]).toBe(`Message from Pi pane ${parent.pane_id}:\n\n/quit\n!echo unsafe\n$(touch /tmp/no)`)
    })
  )

  it.effect('refuses invalid models, empty messages and terminal controls without spawning', () =>
    Effect.gen(function* () {
      const { handlers, calls } = harness()
      for (const model of ['gpt-6-sol', '/model', 'provider/', 'provider/--help', 'provider/model with space', 'provider/model\u0000']) {
        expect(yield* refusal(handlers.spawn({ ...task, model }, context()))).toContain('provider/model-id')
      }
      for (const message of [' ', '\u001b[31mhello', 'hello\rworld', 'hello\u0000']) {
        expect(yield* refusal(handlers.spawn({ ...task, message }, context()))).toContain('terminal control')
      }
      expect(calls).toEqual([])
    })
  )

  it.effect('refuses outside Herdr, cancelled calls, mismatched caller sessions and malformed CLI responses', () =>
    Effect.gen(function* () {
      const outside = harness({})
      expect(yield* refusal(outside.handlers.spawn(task, context()))).toContain('inside Herdr')
      expect(outside.calls).toEqual([])
      const aborted = harness()
      const controller = makeAbortController()
      controller.abort()
      expect(yield* refusal(aborted.handlers.spawn(task, context(), controller.signal))).toContain('Cancelled')
      expect(aborted.calls).toEqual([])
      const mismatch = harness()
      expect(yield* refusal(mismatch.handlers.spawn(task, context('/sessions/other.jsonl')))).toContain('current Pi session')
      expect(mismatch.calls).toHaveLength(1)
      const malformed = harness()
      malformed.state.stdout = '{"result":{}}'
      expect(yield* refusal(malformed.handlers.spawn(task, context()))).toContain('unexpected response')
      expect(malformed.calls).toHaveLength(1)
    })
  )

  it.effect('sends to and closes an owned child, but refuses unrelated panes and repeated close', () =>
    Effect.gen(function* () {
      const { handlers, calls } = harness()
      yield* handlers.spawn(task, context())
      expect(yield* handlers.send({ message: 'Follow up', pane_id: child.pane_id }, context())).toEqual({ pane_id: child.pane_id, status: 'sent' })
      expect(yield* refusal(handlers.send({ message: 'oops', pane_id: 'w1:p99' }, context()))).toContain('only')
      expect(yield* refusal(handlers.close({ pane_id: parent.pane_id }, context()))).toContain('Only panes')
      expect(yield* handlers.close({ pane_id: child.pane_id }, context())).toEqual({ pane_id: child.pane_id, status: 'closed' })
      expect(yield* refusal(handlers.close({ pane_id: child.pane_id }, context()))).toContain('Only panes')
      expect(mutations(calls).map(({ args }) => args[1])).toEqual(['prompt', 'prompt', 'close'])
    })
  )

  it.effect('refuses a replaced terminal, a changed Pi session and a child that exited to a shell', () =>
    Effect.gen(function* () {
      const fixture = harness()
      yield* fixture.handlers.spawn(task, context())
      for (const replacement of [
        { ...child, terminal_id: 'replacement' },
        { ...child, agent_session: { agent: 'pi', kind: 'path', value: '/sessions/replaced.jsonl' } },
        { pane_id: child.pane_id, terminal_id: child.terminal_id },
      ]) {
        fixture.state.child = replacement
        expect(yield* refusal(fixture.handlers.send({ message: 'no', pane_id: child.pane_id }, context()))).toContain('original session')
        expect(yield* refusal(fixture.handlers.close({ pane_id: child.pane_id }, context()))).toContain('original session')
      }
      expect(mutations(fixture.calls)).toHaveLength(1)
    })
  )

  it.effect('limits child callbacks to the original parent and original child session', () =>
    Effect.gen(function* () {
      const fixture = harness({
        HERDR_ENV: '1',
        PI_HERDR_PARENT: jsonText({ pane_id: parent.pane_id, session_file: '/sessions/parent.jsonl', terminal_id: parent.terminal_id }),
      })
      fixture.state.current = child
      const childContext = context('/sessions/child.jsonl')
      yield* fixture.handlers.startSession(childContext)
      expect(yield* fixture.handlers.send({ message: 'Review done. No findings.', pane_id: parent.pane_id }, childContext)).toEqual({
        pane_id: parent.pane_id,
        status: 'sent',
      })
      expect(yield* refusal(fixture.handlers.close({ pane_id: parent.pane_id }, childContext))).toContain('Only panes')
      fixture.state.parent = { ...parent, agent_session: { agent: 'pi', kind: 'path', value: '/sessions/new-parent.jsonl' } }
      expect(yield* refusal(fixture.handlers.send({ message: 'late', pane_id: parent.pane_id }, childContext))).toContain('original session')
      fixture.state.current = { ...child, agent_session: { agent: 'pi', kind: 'path', value: '/sessions/new-child.jsonl' } }
      const nextContext = context('/sessions/new-child.jsonl')
      yield* fixture.handlers.startSession(nextContext)
      expect(yield* refusal(fixture.handlers.send({ message: 'late', pane_id: parent.pane_id }, nextContext))).toContain('only')
      expect(mutations(fixture.calls)).toHaveLength(1)
    })
  )

  it.effect('retains known panes on failed startup or submission, without retrying or closing automatically', () =>
    Effect.gen(function* () {
      for (const failure of ['agent start', 'agent prompt']) {
        const fixture = harness()
        fixture.state.fail = failure
        const message = yield* refusal(fixture.handlers.spawn(task, context()))
        expect(message).toContain(`Pane ${child.pane_id} was created and remains open`)
        expect(message).toContain('agent_not_ready')
        expect(fixture.calls.filter(({ args }) => args.slice(0, 2).join(' ') === failure)).toHaveLength(1)
        expect(fixture.calls.some(({ args }) => args[1] === 'close')).toBe(false)
        fixture.state.fail = undefined
        expect(yield* fixture.handlers.close({ pane_id: child.pane_id }, context())).toEqual({ pane_id: child.pane_id, status: 'closed' })
      }
    })
  )

  it.effect('does not mutate after cancellation during a preflight read', () =>
    Effect.gen(function* () {
      const spawning = harness()
      const beforeSplit = makeAbortController()
      spawning.state.afterCommand = (operation) => {
        if (operation === 'pane layout') {
          beforeSplit.abort()
        }
      }
      expect(yield* refusal(spawning.handlers.spawn(task, context(), beforeSplit.signal))).toContain('Cancelled before creating')
      expect(spawning.calls.some(({ args }) => args[1] === 'split')).toBe(false)
      for (const action of ['send', 'close']) {
        const fixture = harness()
        yield* fixture.handlers.spawn(task, context())
        const controller = makeAbortController()
        fixture.state.afterCommand = (operation) => {
          if (operation === 'pane get') {
            controller.abort()
          }
        }
        const operation =
          action === 'send'
            ? refusal(fixture.handlers.send({ message: 'follow up', pane_id: child.pane_id }, context(), controller.signal))
            : refusal(fixture.handlers.close({ pane_id: child.pane_id }, context(), controller.signal))
        expect(yield* operation).toContain('Cancelled before')
        expect(mutations(fixture.calls)).toHaveLength(1)
      }
    })
  )

  it.effect('reports the created pane on mid-spawn cancellation and permits explicit cleanup', () =>
    Effect.gen(function* () {
      const fixture = harness()
      const controller = makeAbortController()
      fixture.state.afterCommand = (operation) => {
        if (operation === 'pane split') {
          controller.abort()
        }
      }
      expect(yield* refusal(fixture.handlers.spawn(task, context(), controller.signal))).toContain(`Pane ${child.pane_id} was created`)
      expect(fixture.calls.some(({ args }) => args[1] === 'start')).toBe(false)
      expect(yield* fixture.handlers.close({ pane_id: child.pane_id }, context())).toEqual({ pane_id: child.pane_id, status: 'closed' })
    })
  )
})
