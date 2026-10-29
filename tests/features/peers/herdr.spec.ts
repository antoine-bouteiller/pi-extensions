import { makeAbortController } from '@tests/utils/abort_controller.js'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asExtensionContext } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { Effect } from 'effect'
import { FileSystem } from 'effect/FileSystem'

import { makeHerdrBackend } from '@/features/peers/herdr.js'
import { makePeerHandlers } from '@/features/peers/peers.js'
import { AgentModelSettingsError } from '@/shared/effect/agent_models.js'
import { jsonText } from '@/shared/utils/json.js'

interface Pane {
  agent?: string
  agent_status?: string
  agent_session?: { agent: string; kind: string; value: string }
  cwd?: string
  pane_id: string
  terminal_id: string
  workspace_id: string
}
const parent: Pane = {
  agent: 'pi',
  agent_session: { agent: 'pi', kind: 'path', value: '/sessions/parent.jsonl' },
  agent_status: 'working',
  pane_id: 'w1:p1',
  terminal_id: 'parent-terminal',
  workspace_id: 'w1',
}
const peer: Pane = {
  agent: 'pi',
  agent_session: { agent: 'pi', kind: 'path', value: '/sessions/peer.jsonl' },
  agent_status: 'idle',
  cwd: '/other project',
  pane_id: 'w5:p1',
  terminal_id: 'peer-terminal',
  workspace_id: 'w5',
}
const busy: Pane = { ...peer, agent_session: { agent: 'pi', kind: 'path', value: '/sessions/busy.jsonl' }, agent_status: 'blocked', pane_id: 'w5:p2' }
const shell: Pane = { ...peer, agent: undefined, agent_session: undefined, agent_status: undefined, pane_id: 'w5:p3' }
type CliReply =
  { pane: Pane } | { agent: Pane } | { agents: Pane[] } | { root_pane: Pane } | { workspaces: { label: string; workspace_id: string }[] }
const task = { message: 'Review the diff; do not modify files.', model: 'azure-openai-responses/gpt-6-sol' }
const context = (session = '/sessions/parent.jsonl', models = [task.model], cwd = '/project with spaces') =>
  asExtensionContext({
    cwd,
    isProjectTrusted: () => true,
    modelRegistry: {
      getAvailable: () => models.map((model) => ({ id: model.slice(model.indexOf('/') + 1), provider: model.slice(0, model.indexOf('/')) })),
    },
    sessionManager: { getSessionFile: () => session },
  })

const harness = (allowedModels = [task.model]) => {
  const calls: { args: string[]; command: string; cwd: string | undefined }[] = []
  const state = {
    fail: undefined as string | undefined,
    panes: [parent, peer, busy, shell],
    workspaces: [
      { label: 'project', workspace_id: 'w1' },
      { label: 'other', workspace_id: 'w5' },
    ],
  }
  let next = 2
  const created = (workspaceId: string): Pane => {
    const pane = { pane_id: `${workspaceId}:p${next++}`, terminal_id: `terminal-${next}`, workspace_id: workspaceId }
    state.panes.push(pane)
    return pane
  }
  const pane = (id: string | undefined): Pane => {
    const found = state.panes.find((candidate) => candidate.pane_id === id)
    if (found === undefined) {
      throw new Error(`Missing pane ${id}`)
    }
    return found
  }
  const replies = new Map<string, (args: string[]) => CliReply>([
    ['agent get', (args) => ({ agent: pane(args[2]) })],
    ['agent list', () => ({ agents: state.panes.filter((candidate) => candidate.agent !== undefined) })],
    ['agent prompt', (args) => ({ agent: pane(args[2]) })],
    [
      'agent start',
      (args) => {
        const agent: Pane = { ...pane(args[6]), agent: 'pi', agent_session: { agent: 'pi', kind: 'path', value: '/sessions/opened.jsonl' } }
        state.panes = state.panes.map((candidate) => (candidate.pane_id === agent.pane_id ? agent : candidate))
        return { agent }
      },
    ],
    ['pane current', () => ({ pane: parent })],
    ['tab create', (args) => ({ root_pane: created(args[3] ?? '') })],
    [
      'workspace create',
      (args) => {
        const workspaceId = `w${state.workspaces.length + 10}`
        state.workspaces.push({ label: args[3] ?? '', workspace_id: workspaceId })
        return { root_pane: created(workspaceId) }
      },
    ],
    ['workspace list', () => ({ workspaces: state.workspaces })],
  ])
  const reply = (args: string[]): CliReply => {
    const handler = replies.get(args.slice(0, 2).join(' '))
    if (handler === undefined) {
      throw new Error(`Unexpected CLI command: ${args.join(' ')}`)
    }
    return handler(args)
  }
  const fake = createFakePi({
    exec: (command, args, options) => {
      calls.push({ args, command, cwd: options?.cwd })
      const operation = args.slice(0, 2).join(' ')
      if (state.fail === operation) {
        return Promise.resolve({ code: 1, stderr: 'agent_not_ready: inspect the pane', stdout: '' })
      }
      if (operation === 'agent get' && !state.panes.some((candidate) => candidate.pane_id === args[2])) {
        return Promise.resolve({ code: 1, stderr: jsonText({ error: { code: 'agent_not_found' } }), stdout: '' })
      }
      if (operation === 'tab create' && !state.workspaces.some((workspace) => workspace.workspace_id === args[3])) {
        return Promise.resolve({ code: 1, stderr: jsonText({ error: { code: 'workspace_not_found' } }), stdout: '' })
      }
      return Promise.resolve({ code: 0, stderr: '', stdout: jsonText({ result: reply(args) }) })
    },
  })
  return {
    calls,
    fake,
    handlers: makePeerHandlers(makeHerdrBackend(fake.pi), () => Effect.succeed({ allowedModels, modelNotes: {} })),
    state,
  }
}
const refusal = <Result, Services>(effect: Effect.Effect<Result, { message: string }, Services>) =>
  effect.pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => 'unexpected success' }))
const operations = (calls: ReturnType<typeof harness>['calls']) => calls.map(({ args }) => args.slice(0, 2).join(' '))
const header = `Task from Pi agent in pane ${parent.pane_id} (cwd /project with spaces), started at its user's request. You are an independent agent and your results are not reported back. Reply with message_peer to pane ${parent.pane_id} only if a response is needed:`

describe('Herdr peers', () => {
  it.effect('[VC-16] opens one tab per call in the caller workspace without focus, starts Pi, then submits the framed task', () =>
    Effect.gen(function* () {
      const { calls, handlers } = harness()
      expect(yield* handlers.open({ ...task, name: 'Review', thinking: 'high' }, context())).toEqual({
        model: task.model,
        pane_id: 'w1:p2',
        status: 'opened',
      })
      expect(yield* handlers.open(task, context())).toEqual({ model: task.model, pane_id: 'w1:p3', status: 'opened' })
      const opening = ['pane current', 'pane current', 'tab create', 'agent start', 'agent prompt']
      expect(operations(calls)).toEqual([...opening, ...opening])
      expect(calls.every(({ command, cwd }) => command === 'herdr' && cwd === '/project with spaces')).toBe(true)
      expect(calls[2]?.args).toEqual(['tab', 'create', '--workspace', 'w1', '--label', 'Review', '--cwd', '/project with spaces', '--no-focus'])
      expect(calls[7]?.args).toEqual(['tab', 'create', '--workspace', 'w1', '--label', task.model, '--cwd', '/project with spaces', '--no-focus'])
      const start = calls[3]?.args ?? []
      expect(start.slice(0, 2)).toEqual(['agent', 'start'])
      expect(start[2]).toMatch(/^pi-[0-9a-f]{8}$/)
      expect(start.slice(3, 15)).toEqual([
        '--kind',
        'pi',
        '--pane',
        'w1:p2',
        '--',
        '--provider',
        'azure-openai-responses',
        '--model',
        'gpt-6-sol',
        '--thinking',
        'high',
        '--extension',
      ])
      expect(start.at(-1)).toEndWith('/src/index.ts')
      expect(start).not.toContain('--append-system-prompt')
      expect(calls[4]?.args).toEqual(['agent', 'prompt', 'w1:p2', `${header}\n\n${task.message}`])
      expect(calls.some(({ args }) => args.includes('--focus') || args[1] === 'split')).toBe(false)
    })
  )

  it.scoped('[VC-16] opens another folder in a new workspace, reuses it, and recreates it when gone', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem
      const directory = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
      const { calls, handlers, state } = harness()
      yield* handlers.open({ ...task, cwd: directory }, context())
      yield* handlers.open({ ...task, cwd: directory }, context())
      const creates = calls.filter(({ args }) => args[1] === 'create').map(({ args }) => args)
      expect(creates[0]).toEqual([
        'workspace',
        'create',
        '--label',
        directory.slice(directory.lastIndexOf('/') + 1),
        '--cwd',
        directory,
        '--no-focus',
      ])
      expect(creates[1]).toEqual(['tab', 'create', '--workspace', 'w12', '--label', task.model, '--cwd', directory, '--no-focus'])
      state.workspaces = state.workspaces.filter((workspace) => workspace.workspace_id !== 'w12')
      yield* handlers.open({ ...task, cwd: directory }, context())
      expect(calls.filter(({ args }) => args[1] === 'create').map(({ args }) => args[0])).toEqual(['workspace', 'tab', 'tab', 'workspace'])
    })
  )

  it.effect('reports a tab that stays open when Pi fails to start or the task cannot be submitted', () =>
    Effect.gen(function* () {
      for (const failure of ['agent start', 'agent prompt']) {
        const { calls, handlers, state } = harness()
        state.fail = failure
        const message = yield* refusal(handlers.open(task, context()))
        expect(message).toContain('Pane w1:p2 was created and remains open.')
        expect(message).toContain('agent_not_ready')
        expect(calls.filter(({ args }) => args.slice(0, 2).join(' ') === failure)).toHaveLength(1)
      }
      const { calls, handlers } = harness()
      const controller = makeAbortController()
      controller.abort()
      expect(yield* refusal(handlers.open(task, context(), controller.signal))).toContain('Cancelled')
      expect(calls).toEqual([])
    })
  )

  it.effect('[VC-19] validates the message, model, and allowlist before contacting Herdr', () =>
    Effect.gen(function* () {
      const { calls, handlers } = harness([])
      expect(yield* refusal(handlers.open(task, context()))).toContain('Configure subagents.allowedModels')
      expect(yield* refusal(handlers.open({ ...task, message: ' ' }, context()))).toContain('terminal control')
      expect(yield* refusal(handlers.open({ ...task, model: 'gpt-6-sol' }, context()))).toContain('provider/model-id')
      expect(yield* refusal(handlers.open({ ...task, cwd: '/definitely/missing/folder' }, context()))).toContain('not an existing directory')
      const allowed = harness(['other/model'])
      expect(yield* refusal(allowed.handlers.open(task, context(undefined, [task.model, 'other/model'])))).toContain('Choose one of: other/model')
      const broken = makePeerHandlers(makeHerdrBackend(createFakePi().pi), () =>
        Effect.fail(AgentModelSettingsError.make({ message: 'invalid settings' }))
      )
      expect(yield* refusal(broken.open(task, context()))).toContain('invalid settings')
      expect([...calls, ...allowed.calls]).toEqual([])
    })
  )

  it.effect('refuses a caller whose pane does not hold this session', () =>
    Effect.gen(function* () {
      const { calls, handlers } = harness()
      expect(yield* refusal(handlers.open(task, context('/sessions/other.jsonl')))).toContain('current Pi session')
      expect(yield* refusal(handlers.discover(context('/sessions/other.jsonl')))).toContain('current Pi session')
      expect(operations(calls)).toEqual(['pane current', 'pane current'])
    })
  )

  it.effect('[VC-17] discovers every other Pi with its workspace label and Herdr status', () =>
    Effect.gen(function* () {
      const { handlers } = harness()
      expect(yield* handlers.discover(context())).toEqual({
        agents: [
          { cwd: '/other project', pane_id: peer.pane_id, status: 'idle', workspace: 'other' },
          { cwd: '/other project', pane_id: busy.pane_id, status: 'blocked', workspace: 'other' },
        ],
      })
    })
  )

  it.effect('[VC-17] messages a peer once with the peer header and refuses itself, shells, and unknown panes', () =>
    Effect.gen(function* () {
      const { calls, handlers } = harness()
      expect(yield* handlers.message({ message: 'Which API version?', pane_id: peer.pane_id }, context())).toEqual({
        pane_id: peer.pane_id,
        status: 'sent',
      })
      expect(calls.filter(({ args }) => args[1] === 'prompt').map(({ args }) => args)).toEqual([
        [
          'agent',
          'prompt',
          peer.pane_id,
          `Message from Pi agent in pane ${parent.pane_id} (cwd /project with spaces), not from your user. Reply with message_peer to pane ${parent.pane_id} only if a response is needed:\n\nWhich API version?`,
        ],
      ])
      for (const id of [parent.pane_id, shell.pane_id, 'w5:p99']) {
        expect(yield* refusal(handlers.message({ message: 'hi', pane_id: id }, context()))).toContain('listed by discover_agents')
      }
      expect(yield* refusal(handlers.message({ message: '\u001b[31m', pane_id: peer.pane_id }, context()))).toContain('terminal control')
      expect(calls.filter(({ args }) => args[1] === 'prompt')).toHaveLength(1)
    })
  )
})
