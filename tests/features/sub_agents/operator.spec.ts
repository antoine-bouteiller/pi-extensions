import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asExtensionContext, asResult } from '@tests/utils/casts.js'
import { Effect, FileSystem } from 'effect'

import { join } from '#shared/utils/path'
import { type PersistedResolvedProfile } from '@/features/sub_agents/model.js'
import { createActivityProjection, createPanicEditor, createSubagentsOperator } from '@/features/sub_agents/operator.js'
import { type SubagentRecord, type SubagentStoreApi } from '@/features/sub_agents/store.js'

const frozenMtime = 1_700_000_000_000
const profile: PersistedResolvedProfile = {
  contextCeiling: 1,
  key: 'scout',
  model: 'model',
  prompt: 'prompt',
  provider: 'provider',
  tools: [],
}
const settled = (session: string, taskName: string, sessionPath: string): SubagentRecord => ({
  logPath: 'worker.log',
  profile,
  session,
  sessionPath,
  settledAt: 1,
  status: 'completed',
  taskName,
  turns: [],
})
const store = (records: readonly { readonly agentId: string; readonly record: SubagentRecord }[]): SubagentStoreApi => ({
  artifactPath: (_agentId, name) => Effect.succeed(name),
  createLease: () => Effect.void,
  createLog: () => Effect.succeed('worker.log'),
  createSession: () => Effect.succeed({ runDirectory: '/run', sessionPath: '/run/session.json' }),
  delete: () => Effect.void,
  initialize: Effect.void,
  listLeases: Effect.succeed([]),
  listRecords: Effect.succeed(records),
  prune: () => Effect.void,
  readArtifact: () => Effect.succeed(new Uint8Array()),
  readRecord: (agentId) => Effect.succeed(records.find((entry) => entry.agentId === agentId)?.record),
  removeLease: () => Effect.void,
  removeLog: () => Effect.void,
  replaceRecord: () => Effect.void,
  writeFullResult: () => Effect.succeed('result'),
})

interface InputHandler {
  handleInput: (data: string) => void
}

type EditorFactory = (tui: unknown, theme: unknown, keybindings: unknown) => InputHandler

const panicEditorFixture = ({
  idle = true,
  live = true,
  previous,
}: { readonly idle?: boolean; readonly live?: boolean; readonly previous?: EditorFactory } = {}) => {
  let editor = previous
  let terminalInputRegistrations = 0
  const interrupted: string[] = []
  const ctx = asExtensionContext({
    isIdle: () => idle,
    ui: {
      getEditorComponent: () => editor,
      onTerminalInput: () => {
        terminalInputRegistrations += 1
        return () => undefined
      },
      setEditorComponent: (next: EditorFactory | undefined) => {
        editor = next
      },
    },
  })
  const panic = createPanicEditor({
    ctx,
    hasLiveCurrentSession: () => live,
    interruptAll: () => {
      interrupted.push('all')
      return Promise.resolve()
    },
  })
  return {
    editor: () => editor,
    interrupted,
    panic,
    setEditor: (next: EditorFactory | undefined) => {
      editor = next
    },
    terminalInputRegistrations: () => terminalInputRegistrations,
  }
}

const later: EditorFactory = () => ({ handleInput: () => undefined })

describe('sub-agent panic editor', () => {
  it('composes the prior factory and delegates ordinary input on its returned editor', () => {
    const inputs: string[] = []
    const priorEditor: InputHandler = { handleInput: (data) => inputs.push(data) }
    let factoryCalls = 0
    const previous: EditorFactory = () => {
      factoryCalls += 1
      return priorEditor
    }
    const fixture = panicEditorFixture({ previous })

    fixture.panic.install()
    const installed = asResult<EditorFactory>(fixture.editor())
    expect(installed({}, {}, {})).toBe(priorEditor)
    installed({}, {}, {}).handleInput('x')

    expect(factoryCalls).toBe(2)
    expect(inputs).toEqual(['x'])
    expect(fixture.terminalInputRegistrations()).toBe(0)
  })

  it('consumes only idle Escape with live children and otherwise delegates', () => {
    for (const [idle, live, expectedInterrupts] of [
      [true, true, 1],
      [false, true, 0],
      [true, false, 0],
    ] as const) {
      const inputs: string[] = []
      const fixture = panicEditorFixture({ idle, live, previous: () => ({ handleInput: (data) => inputs.push(data) }) })
      fixture.panic.install()
      asResult<EditorFactory>(fixture.editor())({}, {}, {}).handleInput('\u001b')

      expect(fixture.interrupted).toHaveLength(expectedInterrupts)
      expect(inputs).toEqual(expectedInterrupts === 0 ? ['\u001b'] : [])
    }
  })

  it('installs and disposes idempotently, restores its own prior factory, and deactivates stale wrappers', () => {
    const inputs: string[] = []
    const previous: EditorFactory = () => ({ handleInput: (data) => inputs.push(data) })
    const fixture = panicEditorFixture({ previous })

    fixture.panic.install()
    const installed = asResult<EditorFactory>(fixture.editor())
    const wrapped = installed({}, {}, {})
    fixture.panic.install()
    fixture.panic.dispose()
    fixture.panic.dispose()
    wrapped.handleInput('\u001b')

    expect(fixture.editor()).toBe(previous)
    expect(fixture.interrupted).toEqual([])
    expect(inputs).toEqual(['\u001b'])
  })

  it('deactivates editors built by a disposed factory invoked later', () => {
    const inputs: string[] = []
    const previous: EditorFactory = () => ({ handleInput: (data) => inputs.push(data) })
    const fixture = panicEditorFixture({ previous })

    fixture.panic.install()
    const installed = asResult<EditorFactory>(fixture.editor())
    fixture.panic.dispose()
    installed({}, {}, {}).handleInput('\u001b')

    expect(fixture.interrupted).toEqual([])
    expect(inputs).toEqual(['\u001b'])
  })

  it('does not overwrite a later editor factory during teardown', () => {
    const fixture = panicEditorFixture()

    fixture.panic.install()
    fixture.setEditor(later)
    fixture.panic.dispose()

    expect(fixture.editor()).toBe(later)
  })
})

describe('sub-agent operator activity projection', () => {
  it.effect('publishes one ready agent, updates verified activity, and removes settled or closed agents', () =>
    Effect.gen(function* () {
      const snapshots: string[][] = []
      const projection = createActivityProjection({
        publish: (agents) =>
          Effect.sync(() => {
            snapshots.push(agents.map((agent) => agent.agentId ?? ''))
          }),
      })
      const scout = {
        agentId: 'scout',
        color: 'thinkingLow' as const,
        lastActivityAt: 1,
        name: 'find-files',
        sessionId: 'one',
        state: 'running' as const,
      }

      yield* projection.publishReady(scout)
      yield* projection.publishReady(scout)
      yield* projection.updateActivity('scout', 2)
      yield* projection.closeSession('other')
      yield* projection.closeSession('one')

      expect(snapshots).toEqual([['scout'], ['scout'], ['scout'], []])
      expect(projection.list()).toEqual([])
    })
  )

  it.scoped('refreshes growing transcripts, retains the last content after removal, then marks it unavailable', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectory({ prefix: 'operator-transcript-' })
      const path = join(root, 'session.json')
      yield* fs.writeFileString(path, '{"event":1}\n')
      yield* fs.chmod(path, 0o600)
      const operator = createSubagentsOperator({
        activity: () => [],
        sessionId: 'current',
        store: store([{ agentId: 'one', record: settled('current', 'task', path) }]),
      })
      const transcript = operator.open('one')
      yield* transcript.refresh
      expect(transcript.content().entries).toEqual([{ event: 1 }])
      yield* fs.writeFileString(path, '{"event":1}\n{"event":2}\n')
      yield* transcript.refresh
      expect(transcript.content().entries).toEqual([{ event: 1 }, { event: 2 }])
      yield* fs.remove(path)
      yield* transcript.refresh
      expect(transcript.content()).toEqual({ entries: [{ event: 1 }, { event: 2 }], turns: [], unavailable: true })
    })
  )

  it.scoped('reparses the transcript only when the session file changed', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectory({ prefix: 'operator-transcript-stamp-' })
      const path = join(root, 'session.json')
      yield* fs.writeFileString(path, '{"event":1}\n')
      yield* fs.chmod(path, 0o600)
      const operator = createSubagentsOperator({
        activity: () => [],
        sessionId: 'current',
        store: store([{ agentId: 'one', record: settled('current', 'task', path) }]),
      })
      yield* fs.utimes(path, frozenMtime, frozenMtime)
      const transcript = operator.open('one')
      yield* transcript.refresh
      expect(transcript.content().entries).toEqual([{ event: 1 }])

      yield* fs.writeFileString(path, '{"event":2}\n')
      yield* fs.utimes(path, frozenMtime, frozenMtime)
      yield* transcript.refresh
      expect(transcript.content().entries).toEqual([{ event: 1 }])

      yield* fs.writeFileString(path, '{"event":2}\n{"event":3}\n')
      yield* transcript.refresh
      expect(transcript.content().entries).toEqual([{ event: 2 }, { event: 3 }])
    })
  )

  it.effect('lists durable current-session records and decorates only their ready-running activity', () =>
    Effect.gen(function* () {
      const records = [
        { agentId: 'settled', record: settled('current', 'settled-task', '/run/settled.json') },
        {
          agentId: 'running',
          record: {
            identity: { birthMarker: 'birth', pid: 1 },
            logPath: 'running.log',
            profile,
            session: 'current',
            sessionPath: '/run/running.json',
            status: 'running' as const,
            taskName: 'running-task',
            turns: [],
          },
        },
      ]
      const operator = createSubagentsOperator({
        activity: () => [
          { agentId: 'ghost', color: 'muted', lastActivityAt: 8, name: 'ghost', sessionId: 'current', state: 'running' },
          { agentId: 'running', color: 'thinkingLow', lastActivityAt: 9, name: 'running-task', sessionId: 'current', state: 'running' },
          { agentId: 'settled', color: 'thinkingLow', lastActivityAt: 10, name: 'settled-task', sessionId: 'other', state: 'running' },
        ],
        sessionId: 'current',
        store: store(records),
      })
      expect(yield* operator.list).toEqual([
        { agentId: 'settled', lastActivityAt: undefined, profile: 'scout', status: 'completed', taskName: 'settled-task' },
        { agentId: 'running', lastActivityAt: 9, profile: 'scout', status: 'running', taskName: 'running-task' },
      ])
    })
  )
})
