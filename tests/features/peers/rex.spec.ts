import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asExtensionContext } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { Effect, Exit, type Fiber, Scope } from 'effect'
import { FileSystem } from 'effect/FileSystem'
import { TestClock } from 'effect/testing'

import { makePeerHandlers } from '@/features/peers/peers.js'
import { makeRexBackend, rexStatus } from '@/features/peers/rex.js'
import { makeEnvironment } from '@/shared/effect/env.js'
import { jsonText, parseJsonText } from '@/shared/utils/json.js'

const CALLER = 'block:caller'
const SESSION = 'session:main'
const OTHER_SESSION = 'session:other'
const DEAD_PID = 999_999_001
const task = { message: 'Review the diff; do not modify files.', model: 'azure-openai-responses/gpt-6-sol' }
const header = `Task from Pi agent in pane ${CALLER} (cwd /project), started at its user's request. You are an independent agent and your results are not reported back. Reply with message_peer to pane ${CALLER} only if a response is needed:`

interface Call {
  readonly args: string[]
  readonly command: string
  /** Files in the PI_REX_INBOX directory when the window was created. */
  readonly inbox?: string[]
}

interface ContextOverrides {
  readonly isIdle?: () => boolean
  readonly mode?: string
}

const context = (overrides: ContextOverrides = {}) =>
  asExtensionContext({
    cwd: '/project',
    isIdle: () => true,
    isProjectTrusted: () => false,
    mode: 'tui',
    modelRegistry: { getAvailable: () => [{ id: 'gpt-6-sol', provider: 'azure-openai-responses' }] },
    sessionManager: { getSessionFile: () => '/sessions/parent.jsonl' },
    ...overrides,
  })

interface PresenceFields {
  readonly cwd?: string
  readonly inbox: string
  readonly pid?: number
  readonly rex_session?: string
}
interface StatusRecord {
  readonly effective_app: string
  readonly id?: string
  readonly state: string
}
interface CliResult {
  readonly code: number
  readonly stderr: string
  readonly stdout: string
}
const notFound = (target: string): CliResult => ({ code: 3, stderr: `Error: ${target} not found`, stdout: '' })
const ok = (value: Parameters<typeof jsonText>[0]): CliResult => ({ code: 0, stderr: '', stdout: jsonText(value) })
const inboxArgument = (args: readonly string[]) => args.find((arg) => arg.startsWith('PI_REX_INBOX='))?.slice('PI_REX_INBOX='.length)

const presenceFile = (agentDir: string, block: string) => `${agentDir}/peers/rex/presence/${block.replaceAll(':', '_')}.json`

const harness = Effect.gen(function* () {
  const fs = yield* FileSystem
  const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: 'rex-peers-' })
  yield* fs.makeDirectory(`${agentDir}/peers/rex/presence`, { recursive: true })
  const calls: Call[] = []
  const blocks = new Map<string, { session: string; records: StatusRecord[] }>([
    [CALLER, { records: [{ effective_app: 'pi', state: 'working' }], session: SESSION }],
  ])
  const sessions = new Map([
    [SESSION, 'pi-extensions'],
    [OTHER_SESSION, 'other'],
  ])
  const state = { appear: true, next: 1 }
  const writePresence = (block: string, data: PresenceFields) =>
    Bun.write(presenceFile(agentDir, block), jsonText({ block_id: block, cwd: '/project', pid: process.pid, rex_session: SESSION, ...data }))
  const created = (session: string) => {
    const block = `block:new-${state.next++}`
    blocks.set(block, { records: [], session })
    return block
  }
  const rename = async (args: string[]) => {
    const window = calls.findLast((call) => call.args[0] === 'new' || call.args[1] === 'new')
    const inbox = window === undefined ? undefined : inboxArgument(window.args)
    if (state.appear && inbox !== undefined) {
      await writePresence(args[4] ?? '', { inbox, rex_session: args[3] ?? '' })
    }
    return ok({})
  }
  const replies = new Map<string, (args: string[]) => CliResult | Promise<CliResult>>([
    ['block call', (args) => ok({ records: blocks.get(args[5] ?? '')?.records ?? [] })],
    [
      'block inspect',
      (args) => (blocks.has(args[4] ?? '') ? ok({ block: { block_id: args[4] }, session_id: args[3] }) : notFound(`block target "${args[4]}"`)),
    ],
    ['block rename', rename],
    ['ls', () => ok({ sessions: [...sessions].map(([session_id, label]) => ({ label, session_id })) })],
    [
      'new',
      (args) => {
        const session = `session:created-${state.next++}`
        sessions.set(session, args[1] ?? '')
        return ok({ initial_windows: [{ block_ids: [created(session)] }], session_id: session })
      },
    ],
    [
      'window new',
      (args) =>
        sessions.has(args[3] ?? '') ? ok({ block_ids: [created(args[3] ?? '')], window_id: 'window:new' }) : notFound(`session target "${args[3]}"`),
    ],
  ])
  const reply = (args: string[]) => {
    const handler = replies.get(args.slice(0, 2).join(' ')) ?? replies.get(args[0] ?? '')
    if (handler === undefined) {
      throw new Error(`Unexpected rex command: ${args.join(' ')}`)
    }
    return handler(args)
  }
  const fake = createFakePi({
    exec: async (command, args) => {
      const inboxArg = inboxArgument(args)
      const scanned = inboxArg === undefined ? undefined : await Array.fromAsync(new Bun.Glob('*.json').scan(inboxArg))
      const inbox = scanned?.toSorted()
      calls.push({ args, command, ...(inbox !== undefined && { inbox }) })
      return reply(args)
    },
  })
  const environment = makeEnvironment({ REX_BIN_DIR: '/opt/rex/bin', REX_BLOCK: CALLER, REX_SESSION: SESSION })
  const backend = makeRexBackend(fake.pi, environment, { agentDir, alive: (pid) => pid !== DEAD_PID })
  const handlers = makePeerHandlers(backend, () => Effect.succeed({ allowedModels: [task.model], modelNotes: {} }))
  return { agentDir, backend, blocks, calls, fake, fs, handlers, sessions, state, writePresence }
})

type Harness = Effect.Success<typeof harness>

const activateCaller = (fixture: Harness, ctx = context()) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    yield* fixture.handlers.activate(ctx).pipe(Scope.provide(scope))
    return scope
  })

const inboxFiles = (fixture: Harness, inbox: string) =>
  Effect.gen(function* () {
    const names = (yield* fixture.fs.readDirectory(inbox)).filter((name) => name.endsWith('.json')).toSorted()
    return yield* Effect.forEach(names, (name) => fixture.fs.readFileString(`${inbox}/${name}`).pipe(Effect.map((text) => parseJsonText(text))))
  })

const refusal = <Result, Services>(effect: Effect.Effect<Result, { message: string }, Services>) =>
  effect.pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => 'unexpected success' }))

/** Steps the test clock until the forked fiber finishes, yielding to real I/O between steps. */
const settle = <Value, Failure>(fiber: Fiber.Fiber<Value, Failure>) =>
  Effect.gen(function* () {
    for (let step = 0; step < 400; step++) {
      const done = fiber.pollUnsafe()
      if (done !== undefined) {
        return done
      }
      yield* Effect.promise(() => Bun.sleep(1))
      yield* TestClock.adjust('250 millis')
    }
    return yield* Effect.die('fiber did not finish')
  })

describe('Rex presence and inbox', () => {
  it.scoped('[CT-3.1] publishes a presence record in TUI mode only and removes it with the session scope', () =>
    Effect.gen(function* () {
      const fixture = yield* harness
      const rpc = yield* activateCaller(fixture, context({ mode: 'rpc' }))
      expect(yield* fixture.fs.exists(presenceFile(fixture.agentDir, CALLER))).toBe(false)
      yield* Scope.close(rpc, Exit.void)
      const scope = yield* activateCaller(fixture)
      const record = parseJsonText(yield* fixture.fs.readFileString(presenceFile(fixture.agentDir, CALLER)))
      expect(record).toEqual({
        block_id: CALLER,
        cwd: '/project',
        inbox: expect.stringMatching(new RegExp(`^${fixture.agentDir}/peers/rex/inbox/${process.pid}-[0-9a-f-]{36}$`)),
        pid: process.pid,
        rex_session: SESSION,
        session_file: '/sessions/parent.jsonl',
      })
      yield* Scope.close(scope, Exit.void)
      expect(yield* fixture.fs.exists(presenceFile(fixture.agentDir, CALLER))).toBe(false)
      expect(fixture.calls).toEqual([])
    })
  )

  it.scoped('[KD-4] delivers inbox messages in name order, as steering while the agent runs', () =>
    Effect.gen(function* () {
      const fixture = yield* harness
      const inbox = `${fixture.agentDir}/opened-inbox`
      yield* fixture.fs.makeDirectory(inbox)
      yield* fixture.fs.writeFileString(`${inbox}/0000000000002-b.json`, jsonText({ text: 'second' }))
      yield* fixture.fs.writeFileString(`${inbox}/0000000000001-a.json`, jsonText({ text: 'first' }))
      yield* fixture.fs.writeFileString(`${inbox}/0000000000003-c.json.tmp`, jsonText({ text: 'partial' }))
      let idle = true
      const backend = makeRexBackend(fixture.fake.pi, makeEnvironment({ PI_REX_INBOX: inbox, REX_BLOCK: CALLER, REX_SESSION: SESSION }), {
        agentDir: fixture.agentDir,
      })
      const scope = yield* Scope.make()
      yield* backend.activate(context({ isIdle: () => idle })).pipe(Scope.provide(scope))
      yield* Effect.promise(() => Bun.sleep(20))
      expect(fixture.fake.state.messages).toEqual([
        { message: 'first', options: undefined },
        { message: 'second', options: undefined },
      ])
      expect(parseJsonText(yield* fixture.fs.readFileString(presenceFile(fixture.agentDir, CALLER)))).toMatchObject({ inbox })
      idle = false
      yield* fixture.fs.writeFileString(`${inbox}/0000000000004-d.json`, jsonText({ text: 'steer me' }))
      yield* TestClock.adjust('1 second')
      yield* Effect.promise(() => Bun.sleep(20))
      expect(fixture.fake.state.messages.at(-1)).toEqual({ message: 'steer me', options: { deliverAs: 'steer' } })
      expect(yield* fixture.fs.readDirectory(inbox)).toEqual(['0000000000003-c.json.tmp'])
      yield* Scope.close(scope, Exit.void)
    })
  )
})

describe('Rex peers', () => {
  it.effect('reports blocked records first, then the Pi root record', () =>
    Effect.sync(() => {
      expect(
        rexStatus([
          { effective_app: 'pi', state: 'working' },
          { effective_app: 'pi', id: 'ask_user/1', state: 'blocked' },
        ])
      ).toBe('blocked')
      expect(rexStatus([{ effective_app: 'pi', state: 'idle' }])).toBe('idle')
      expect(rexStatus([{ effective_app: 'zsh', state: 'working' }])).toBe('unknown')
      expect(rexStatus([])).toBe('unknown')
    })
  )

  it.scoped('[VC-17] discovers exactly the live Pis with their session labels and statuses', () =>
    Effect.gen(function* () {
      const fixture = yield* harness
      yield* activateCaller(fixture)
      fixture.blocks.set('block:a', {
        records: [
          { effective_app: 'pi', id: 'ask_user/1', state: 'blocked' },
          { effective_app: 'pi', state: 'working' },
        ],
        session: SESSION,
      })
      fixture.blocks.set('block:b', { records: [{ effective_app: 'pi', state: 'idle' }], session: OTHER_SESSION })
      fixture.blocks.set('block:stale', { records: [{ effective_app: 'pi', state: 'idle' }], session: SESSION })
      fixture.blocks.set('block:shell', { records: [], session: SESSION })
      yield* Effect.promise(() => fixture.writePresence('block:a', { inbox: `${fixture.agentDir}/a` }))
      yield* Effect.promise(() => fixture.writePresence('block:b', { cwd: '/other', inbox: `${fixture.agentDir}/b`, rex_session: OTHER_SESSION }))
      yield* Effect.promise(() => fixture.writePresence('block:stale', { inbox: `${fixture.agentDir}/stale`, pid: DEAD_PID }))
      yield* Effect.promise(() => fixture.writePresence('block:closed', { inbox: `${fixture.agentDir}/closed` }))
      expect(yield* fixture.handlers.discover(context())).toEqual({
        agents: [
          { cwd: '/project', pane_id: 'block:a', status: 'blocked', workspace: 'pi-extensions' },
          { cwd: '/other', pane_id: 'block:b', status: 'idle', workspace: 'other' },
        ],
      })
      expect(fixture.calls.every(({ command }) => command === '/opt/rex/bin/rex')).toBe(true)
    })
  )

  it.scoped('[VC-17] messages a live Pi through one inbox file and refuses itself, stale records, and non-Pi blocks', () =>
    Effect.gen(function* () {
      const fixture = yield* harness
      yield* activateCaller(fixture)
      const inbox = `${fixture.agentDir}/a`
      yield* fixture.fs.makeDirectory(inbox)
      fixture.blocks.set('block:a', { records: [{ effective_app: 'pi', state: 'idle' }], session: SESSION })
      fixture.blocks.set('block:stale', { records: [], session: SESSION })
      fixture.blocks.set('block:shell', { records: [], session: SESSION })
      yield* Effect.promise(() => fixture.writePresence('block:a', { inbox }))
      yield* Effect.promise(() => fixture.writePresence('block:stale', { inbox, pid: DEAD_PID }))
      expect(yield* fixture.handlers.message({ message: 'Which API version?', pane_id: 'block:a' }, context())).toEqual({
        pane_id: 'block:a',
        status: 'sent',
      })
      expect(yield* inboxFiles(fixture, inbox)).toEqual([
        {
          text: `Message from Pi agent in pane ${CALLER} (cwd /project), not from your user. Reply with message_peer to pane ${CALLER} only if a response is needed:\n\nWhich API version?`,
        },
      ])
      expect((yield* fixture.fs.readDirectory(inbox))[0]).toMatch(/^\d{13}-[0-9a-f-]{36}\.json$/)
      for (const id of [CALLER, 'block:stale', 'block:shell', 'block:missing']) {
        expect(yield* refusal(fixture.handlers.message({ message: 'hi', pane_id: id }, context()))).toContain('listed by discover_agents')
      }
      expect(yield* inboxFiles(fixture, inbox)).toHaveLength(1)
    })
  )

  it.scoped('refuses callers without their own presence record', () =>
    Effect.gen(function* () {
      const fixture = yield* harness
      expect(yield* refusal(fixture.handlers.discover(context()))).toContain('Rex does not identify this block')
      yield* Effect.promise(() => fixture.writePresence(CALLER, { inbox: `${fixture.agentDir}/caller`, pid: DEAD_PID }))
      expect(yield* refusal(fixture.handlers.open(task, context()))).toContain('Rex does not identify this block')
      expect(fixture.calls).toEqual([])
    })
  )

  it.scoped('[VC-16] writes the framed task into the new inbox before opening an unfocused window that starts Pi on it', () =>
    Effect.gen(function* () {
      const fixture = yield* harness
      yield* activateCaller(fixture)
      expect(yield* fixture.handlers.open({ ...task, name: 'Review', thinking: 'high' }, context())).toEqual({
        model: task.model,
        pane_id: 'block:new-1',
        status: 'opened',
      })
      const [window, rename] = fixture.calls
      const inbox = window?.args.find((arg) => arg.startsWith('PI_REX_INBOX='))?.slice('PI_REX_INBOX='.length) ?? ''
      expect(inbox).toMatch(new RegExp(`^${fixture.agentDir}/peers/rex/inbox/open-[0-9a-f-]{36}$`))
      expect(window?.inbox).toHaveLength(1)
      expect(yield* inboxFiles(fixture, inbox)).toEqual([{ text: `${header}\n\n${task.message}` }])
      expect(window?.args.slice(0, 11)).toEqual(['window', 'new', '-s', SESSION, 'Review', '--focus=false', '-c', '/project', '--json', '--', 'env'])
      expect(window?.args.slice(12, 21)).toEqual([
        'pi',
        '--provider',
        'azure-openai-responses',
        '--model',
        'gpt-6-sol',
        '--thinking',
        'high',
        '--extension',
        expect.stringMatching(/\/src\/index\.ts$/),
      ])
      expect(rename?.args).toEqual(['block', 'rename', '-s', SESSION, 'block:new-1', 'Review'])
      yield* fixture.handlers.open(task, context())
      expect(fixture.calls.filter(({ args }) => args[1] === 'new')).toHaveLength(2)
      expect(fixture.calls.at(-2)?.args[4]).toBe(task.model)
    })
  )

  it.scoped('[VC-16] opens another folder in a new Rex session, reuses it, and recreates it when gone', () =>
    Effect.gen(function* () {
      const fixture = yield* harness
      yield* activateCaller(fixture)
      const directory = yield* fixture.fs.realPath(yield* fixture.fs.makeTempDirectoryScoped())
      const name = directory.slice(directory.lastIndexOf('/') + 1)
      const operations = () => fixture.calls.map(({ args }) => args.slice(0, 2).join(' '))
      yield* fixture.handlers.open({ ...task, cwd: directory }, context())
      expect(fixture.calls[0]?.args.slice(0, 9)).toEqual(['new', name, '-c', directory, '--window', task.model, '--json', '--', 'env'])
      yield* fixture.handlers.open({ ...task, cwd: directory }, context())
      expect(fixture.calls[2]?.args.slice(0, 8)).toEqual(['window', 'new', '-s', 'session:created-1', task.model, '--focus=false', '-c', directory])
      fixture.sessions.delete('session:created-1')
      fixture.calls.length = 0
      yield* fixture.handlers.open({ ...task, cwd: directory }, context())
      expect(operations()).toEqual(['window new', `new ${name}`, 'block rename'])
    })
  )

  it.effect('[VC-16] fails with the open tab named when the new Pi never reports itself', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* harness
        yield* activateCaller(fixture)
        fixture.state.appear = false
        const fiber = yield* Effect.forkChild(refusal(fixture.handlers.open(task, context())))
        const exit = yield* settle(fiber)
        expect(exit).toEqual(Exit.succeed('Tab block:new-1 was created and remains open. Pi did not report itself within 30 seconds.'))
      })
    )
  )
})
