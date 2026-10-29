import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'

import { type ExtensionCommandContext, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { type Component } from '@earendil-works/pi-tui'
import { BunChildProcessSpawner, BunCrypto, BunFileSystem, BunPath } from '@effect/platform-bun'
import { describe, expect, it, PromiseEffectError } from '@tests/utils/bun_effect.js'
import { asExtensionContext, asNarrowed, asResult } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { mouseEvent } from '@tests/utils/mouse.js'
import { Effect, Exit, Fiber, Layer, Scope } from 'effect'
import { type SecureRandom } from 'effect/crypto/SecureRandom'
import { FileSystem } from 'effect/FileSystem'
import { type Path } from 'effect/Path'
import { type ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'
import { TestClock } from 'effect/testing'

import { makeSubagentHandlers, RESULT_MESSAGE, SUBAGENT_ENTRY } from '@/features/subagents/subagents.js'
import { openViewer } from '@/features/subagents/viewer.js'
import { makeEnvironment } from '@/shared/effect/env.js'
import { statusBar } from '@/shared/state/status_bar.js'
import { jsonText, parseJsonText } from '@/shared/utils/json.js'

const BIN = fileURLToPath(new URL('fixtures/bin', import.meta.url))
const MODEL = 'azure-openai-responses/gpt-6-sol'
const Platform = Layer.mergeAll(
  BunChildProcessSpawner.layer.pipe(Layer.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer))),
  BunCrypto.layer,
  BunFileSystem.layer,
  BunPath.layer
)

interface DialogCall {
  readonly method: string
  readonly title: string
  readonly detail?: unknown
  readonly signal?: AbortSignal
  readonly timeout?: number
  readonly resolve: (value: unknown) => void
}

type OverlayFactory = (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => Component
const EXPAND = '\u000F'
const overlayTheme = { bg: (_color: string, text: string) => text, bold: (text: string) => text, fg: (_color: string, text: string) => text }
const overlayKeys = {
  getKeys: (id: string) => (id === 'app.tools.expand' ? ['ctrl+o'] : ['ctrl+end']),
  matches: (data: string, id: string) => id === 'app.tools.expand' && data === EXPAND,
}
const wheelUp = mouseEvent('wheel', 'none', 1, 1, -3)

interface StdinRecord {
  readonly type: string
  readonly id?: string
  readonly message?: string
  readonly streamingBehavior?: string
  readonly confirmed?: boolean
  readonly cancelled?: boolean
  readonly value?: string
}

interface SentMessage {
  readonly content: string
  readonly customType: string
  readonly details: unknown
  readonly display: boolean
}

interface DialogOptions {
  readonly signal?: AbortSignal
  readonly timeout?: number
}

const waitUntil = (condition: Effect.Effect<boolean>, label: string) =>
  Effect.promise(() => Bun.sleep(5)).pipe(
    Effect.andThen(condition),
    Effect.flatMap((done) => (done ? Effect.void : Effect.fail(PromiseEffectError.make({ cause: `timed out waiting for ${label}` })))),
    Effect.retry({ times: 600 }),
    Effect.orDie
  )
const waitFor = (check: () => boolean, label: string) => waitUntil(Effect.sync(check), label)

const harness = (options: { readonly hasUI?: boolean } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: 'subagents-' }))
    const project = `${root}/project`
    yield* fs.makeDirectory(project)
    const fake = createFakePi({
      exec: () => {
        throw new Error('must not run a multiplexer command')
      },
    })
    const dialogs: DialogCall[] = []
    const uiCalls: string[] = []
    const statuses: { key: string; text: string | undefined }[] = []
    const notifications: string[] = []
    const overlays: { readonly component: Component; readonly options: unknown }[] = []
    let toolsExpandedWrites = 0
    const dialog =
      (method: string) =>
      (title: string, detail?: unknown, opts?: DialogOptions): Promise<unknown> =>
        new Promise((resolve) => {
          uiCalls.push(method)
          dialogs.push({
            detail,
            method,
            resolve,
            title,
            ...(opts?.signal !== undefined && { signal: opts.signal }),
            ...(opts?.timeout !== undefined && { timeout: opts.timeout }),
          })
        })
    const ui = {
      confirm: dialog('confirm'),
      custom: (factory: OverlayFactory, overlayOptions: unknown) =>
        new Promise((resolve) => {
          const tui = { requestRender: () => undefined, terminal: { columns: 100, rows: 10 } }
          overlays.push({ component: factory(tui, overlayTheme, overlayKeys, resolve), options: overlayOptions })
        }),
      editor: dialog('editor'),
      getToolsExpanded: () => false,
      input: dialog('input'),
      notify: (message: string, level: string) => {
        uiCalls.push('notify')
        notifications.push(`${level}: ${message}`)
      },
      select: dialog('select'),
      setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
      setToolsExpanded: () => {
        toolsExpandedWrites++
      },
    }
    const environment = makeEnvironment({
      ...process.env,
      FAKE_PI_DIR: root,
      HERDR_ENV: '1',
      HERDR_PANE_ID: 'w1:p1',
      PATH: `${BIN}:${process.env.PATH}`,
      REX_BLOCK: 'block:1',
      REX_SESSION: 'session:1',
    })
    const handlers = makeSubagentHandlers(fake.pi, environment, {
      agentDir: `${root}/agent`,
      loadSettings: () => Effect.succeed({ allowedModels: [MODEL], modelNotes: {} }),
    })
    const context = (session = '/sessions/parent.jsonl') =>
      asExtensionContext({
        cwd: project,
        hasUI: options.hasUI ?? true,
        isProjectTrusted: () => false,
        mode: 'tui',
        modelRegistry: { getAvailable: () => [{ id: 'gpt-6-sol', provider: 'azure-openai-responses' }] },
        sessionManager: { getSessionFile: () => session, getSessionId: () => 'parent-session-id' },
        ui,
      })
    const command = () => asNarrowed<ExtensionCommandContext, ExtensionContext>(context())
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
    yield* handlers.activate(context()).pipe(Scope.provide(scope))
    const childDir = (name: string) => `${root}/${name}`
    const readText = (path: string) => fs.readFileString(path).pipe(Effect.orElseSucceed(() => ''))
    const stdin = (name: string) =>
      readText(`${childDir(name)}/stdin.jsonl`).pipe(
        Effect.map((text) =>
          text
            .split('\n')
            .filter((line) => line !== '')
            .map((line) => asResult<StdinRecord>(parseJsonText(line)))
        )
      )
    let control = 0
    const emit = (name: string, ...actions: unknown[]) =>
      fs.writeFileString(`${childDir(name)}/control/${String(++control).padStart(6, '0')}.json`, jsonText(actions))
    const configure = (name: string, config: Record<string, boolean>) =>
      fs
        .makeDirectory(childDir(name), { recursive: true })
        .pipe(Effect.andThen(fs.writeFileString(`${childDir(name)}/config.json`, jsonText(config))))
    const exists = (path: string) => fs.exists(path).pipe(Effect.orElseSucceed(() => false))
    const pidAlive = (name: string) =>
      readText(`${childDir(name)}/pid`).pipe(
        Effect.map((pid) => {
          try {
            process.kill(Number(pid), 0)
            return true
          } catch {
            return false
          }
        })
      )
    return {
      childDir,
      command,
      configure,
      context,
      dialogs,
      emit,
      exists,
      fake,
      fs,
      handlers,
      notifications,
      overlays,
      pidAlive,
      project,
      root,
      scope,
      statuses,
      stdin,
      toolsExpandedWrites: () => toolsExpandedWrites,
      uiCalls,
    }
  })

const messages = (fixture: Effect.Success<ReturnType<typeof harness>>) =>
  fixture.fake.state.messages.map(({ message, options }) => ({ ...asResult<SentMessage>(message), options }))
const refusal = <Result, Services>(effect: Effect.Effect<Result, { message: string }, Services>) =>
  effect.pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => 'unexpected success' }))
const assistant = (text: string, stopReason = 'stop', errorMessage?: string) => ({
  emit: {
    message: { content: [{ text, type: 'text' }], role: 'assistant', stopReason, ...(errorMessage !== undefined && { errorMessage }) },
    type: 'message_end',
  },
})
const settled = { emit: { aborted: false, type: 'agent_settled' } }
type TestServices = Scope.Scope | FileSystem | Path | SecureRandom | ChildProcessSpawner
const live = <Value, Failure>(name: string, body: () => Effect.Effect<Value, Failure, TestServices>, timeout = 15_000) =>
  it.live(name, () => Effect.scoped(body()).pipe(Effect.provide(Platform)), timeout)

describe('sub-agent startup', () => {
  live('[VC-10] starts pi in RPC mode without multiplexer variables and submits the raw task', () =>
    Effect.gen(function* () {
      const fixture = yield* harness()
      const result = yield* fixture.handlers.spawn(
        { message: 'Review the diff.\n/quit', model: MODEL, name: 'Review', thinking: 'high', tools: ['read', 'grep'] },
        fixture.context()
      )
      expect(result).toEqual({ agent_id: expect.stringMatching(/^[0-9a-f]{8}$/), model: MODEL, status: 'started' })
      const argv = asResult<string[]>(parseJsonText(yield* fixture.fs.readFileString(`${fixture.childDir('Review')}/argv.json`)))
      expect(argv.slice(0, 16)).toEqual([
        '--mode',
        'rpc',
        '--provider',
        'azure-openai-responses',
        '--model',
        'gpt-6-sol',
        '--thinking',
        'high',
        '--tools',
        'read,grep',
        '--name',
        'Review',
        '--session-dir',
        `${fixture.root}/agent/subagents/sessions/parent-session-id`,
        '--extension',
        expect.stringMatching(/\/src\/index\.ts$/),
      ])
      expect(argv.slice(16, 17)).toEqual(['--append-system-prompt'])
      expect(argv[17]).toContain('final response is delivered to the parent agent automatically')
      expect(yield* fixture.fs.readFileString(`${fixture.childDir('Review')}/cwd`)).toBe(fixture.project)
      const env = asResult<Record<string, string>>(parseJsonText(yield* fixture.fs.readFileString(`${fixture.childDir('Review')}/env.json`)))
      expect(env.PI_SUBAGENT).toBe('1')
      expect(Object.keys(env).filter((key) => key.startsWith('HERDR_') || key.startsWith('REX_'))).toEqual([])
      expect(env.FAKE_PI_DIR).toBe(fixture.root)
      expect((yield* fixture.stdin('Review')).slice(0, 2)).toEqual([
        { id: expect.any(String), type: 'get_state' },
        { id: expect.any(String), message: 'Review the diff.\n/quit', streamingBehavior: 'steer', type: 'prompt' },
      ])
      expect(fixture.fake.state.entries).toEqual([
        {
          customType: SUBAGENT_ENTRY,
          data: {
            agent_id: result.agent_id,
            cwd: fixture.project,
            model: MODEL,
            name: 'Review',
            session_file: `${fixture.childDir('Review')}/session.jsonl`,
          },
        },
      ])
      expect(yield* fixture.handlers.list(fixture.context())).toEqual({
        agents: [{ agent_id: result.agent_id, awaiting_result: true, model: MODEL, name: 'Review', status: 'working' }],
      })
    })
  )

  live('starts the child in a requested folder and refuses invalid requests before spawning', () =>
    Effect.gen(function* () {
      const fixture = yield* harness()
      const other = `${fixture.root}/other`
      yield* fixture.fs.makeDirectory(other)
      yield* fixture.handlers.spawn({ cwd: '../other', message: 'Go', model: MODEL }, fixture.context())
      expect(yield* fixture.fs.readFileString(`${fixture.childDir('default')}/cwd`)).toBe(other)
      expect(fixture.fake.state.entries[0]?.data).toMatchObject({ cwd: other })
      expect(yield* refusal(fixture.handlers.spawn({ message: 'Go', model: 'other/model' }, fixture.context()))).toContain('Choose one of')
      expect(yield* refusal(fixture.handlers.spawn({ message: '\u001b[2J', model: MODEL }, fixture.context()))).toContain('terminal control')
      expect(yield* refusal(fixture.handlers.spawn({ message: 'Go', model: MODEL, name: '--help' }, fixture.context()))).toContain('name must be')
      expect(yield* refusal(fixture.handlers.spawn({ cwd: 'missing', message: 'Go', model: MODEL }, fixture.context()))).toContain(
        'not an existing directory'
      )
      expect((yield* fixture.handlers.list(fixture.context())).agents).toHaveLength(1)
    })
  )

  live('fails startup when the child rejects its task and leaves no process or entry', () =>
    Effect.gen(function* () {
      const fixture = yield* harness()
      yield* fixture.configure('Rejected', { rejectPrompt: true })
      expect(yield* refusal(fixture.handlers.spawn({ message: 'Go', model: MODEL, name: 'Rejected' }, fixture.context()))).toBe(
        'Could not start the agent: rejected'
      )
      yield* waitUntil(fixture.pidAlive('Rejected').pipe(Effect.map((alive) => !alive)), 'the rejected child to exit')
      expect(fixture.fake.state.entries).toEqual([])
      expect(yield* fixture.handlers.list(fixture.context())).toEqual({ agents: [] })
    })
  )

  live('refuses to spawn before the session starts', () =>
    Effect.gen(function* () {
      const handlers = makeSubagentHandlers(createFakePi().pi, makeEnvironment({}), {
        agentDir: '/unused',
        loadSettings: () => Effect.succeed({ allowedModels: [MODEL], modelNotes: {} }),
      })
      const ctx = asExtensionContext({
        cwd: '/',
        isProjectTrusted: () => false,
        modelRegistry: { getAvailable: () => [{ id: 'gpt-6-sol', provider: 'azure-openai-responses' }] },
        sessionManager: { getSessionFile: () => '/s.jsonl' },
      })
      expect(yield* refusal(handlers.spawn({ message: 'Go', model: MODEL }, ctx))).toContain('until the Pi session has started')
    })
  )

  it.effect('[VC-10] fails after 30 seconds without a get_state answer and kills the child', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* harness()
        yield* fixture.configure('Silent', { ignoreGetState: true })
        const spawning = yield* Effect.forkChild(refusal(fixture.handlers.spawn({ message: 'Go', model: MODEL, name: 'Silent' }, fixture.context())))
        yield* waitUntil(fixture.stdin('Silent').pipe(Effect.map((records) => records.length > 0)), 'get_state')
        expect(yield* fixture.handlers.list(fixture.context())).toEqual({
          agents: [{ agent_id: expect.any(String), awaiting_result: true, model: MODEL, name: 'Silent', status: 'starting' }],
        })
        expect(fixture.handlers.running(fixture.context())).toEqual([
          { agent_id: expect.any(String), cwd: fixture.project, model: MODEL, name: 'Silent', status: 'starting' },
        ])
        yield* TestClock.adjust('30 seconds')
        expect(yield* Fiber.join(spawning)).toBe('Could not start the agent: No response within 30 seconds.')
        expect(yield* fixture.exists(`${fixture.childDir('Silent')}/eof`)).toBe(true)
        yield* waitUntil(fixture.pidAlive('Silent').pipe(Effect.map((alive) => !alive)), 'the silent child to exit')
        expect(fixture.fake.state.entries).toEqual([])
        expect(yield* fixture.handlers.list(fixture.context())).toEqual({ agents: [] })
      })
    ).pipe(Effect.provide(Platform))
  )
})

describe('sub-agent results', () => {
  live('[VC-11] reports each settled run once as a steering subagent-result message', () =>
    Effect.gen(function* () {
      const fixture = yield* harness()
      const { agent_id: id } = yield* fixture.handlers.spawn({ message: 'Review', model: MODEL, name: 'Review' }, fixture.context())
      yield* fixture.emit('Review', { emit: { type: 'agent_start' } }, assistant('Draft'), assistant('No findings.'), settled)
      yield* waitFor(() => fixture.fake.state.messages.length === 1, 'the first result')
      expect(messages(fixture)).toEqual([
        {
          content: `Agent "Review" (${id}) finished (${MODEL}).\n\nNo findings.`,
          customType: RESULT_MESSAGE,
          details: { agent_id: id, model: MODEL, name: 'Review', status: 'done' },
          display: true,
          options: { deliverAs: 'steer', triggerTurn: true },
        },
      ])
      expect(yield* fixture.handlers.list(fixture.context())).toMatchObject({ agents: [{ awaiting_result: false, status: 'idle' }] })

      yield* fixture.handlers.send({ agent_id: id, message: 'Retry' }, fixture.context())
      expect(yield* fixture.handlers.list(fixture.context())).toMatchObject({ agents: [{ awaiting_result: true, status: 'working' }] })
      yield* fixture.emit('Review', assistant('', 'error', 'rate limited'), settled)
      yield* waitFor(() => fixture.fake.state.messages.length === 2, 'the failed result')
      expect(messages(fixture)[1]).toMatchObject({
        content: `Agent "Review" (${id}) failed (${MODEL}).\nError: rate limited\n\n(no final text)`,
        details: { status: 'error' },
      })
      yield* fixture.emit('Review', assistant('Partial', 'aborted'), settled, settled)
      yield* waitFor(() => fixture.fake.state.messages.length === 3, 'the interrupted result')
      expect(messages(fixture)[2]).toMatchObject({
        content: `Agent "Review" (${id}) was interrupted (${MODEL}).\n\nPartial`,
        details: { status: 'aborted' },
      })
      yield* fixture.emit('Review', assistant(`${'x'.repeat(60 * 1024)}\nEND`), settled)
      yield* waitFor(() => fixture.fake.state.messages.length === 4, 'the long result')
      const long = messages(fixture)[3]?.content ?? ''
      expect(long).not.toContain('END')
      expect(long).toMatch(/truncated/i)
      expect(Buffer.byteLength(long)).toBeLessThan(52 * 1024)
      yield* Effect.promise(() => Bun.sleep(50))
      expect(fixture.fake.state.messages).toHaveLength(4)
    })
  )

  live('[VC-14] reports a child that exits while a result is awaited, then forgets it', () =>
    Effect.gen(function* () {
      const fixture = yield* harness()
      const { agent_id: id } = yield* fixture.handlers.spawn({ message: 'Review', model: MODEL }, fixture.context())
      yield* fixture.emit('default', { stderr: 'boom' }, { exit: 3 })
      yield* waitFor(() => fixture.fake.state.messages.length === 1, 'the exited result')
      expect(messages(fixture)).toEqual([
        {
          content: `Agent ${id} exited with code 3 before reporting a result (${MODEL}).\n\nstderr:\nboom`,
          customType: RESULT_MESSAGE,
          details: { agent_id: id, model: MODEL, status: 'exited' },
          display: true,
          options: { deliverAs: 'steer', triggerTurn: true },
        },
      ])
      expect(yield* fixture.handlers.list(fixture.context())).toEqual({ agents: [] })
      expect(yield* refusal(fixture.handlers.send({ agent_id: id, message: 'hi' }, fixture.context()))).toContain('Only running agents')
    })
  )

  live('[VC-14] stays silent when an idle child exits without an awaited result', () =>
    Effect.gen(function* () {
      const fixture = yield* harness()
      yield* fixture.handlers.spawn({ message: 'Review', model: MODEL }, fixture.context())
      yield* fixture.emit('default', assistant('Done'), settled)
      yield* waitFor(() => fixture.fake.state.messages.length === 1, 'the result')
      yield* fixture.emit('default', { exit: 0 })
      yield* waitUntil(fixture.handlers.list(fixture.context()).pipe(Effect.map(({ agents }) => agents.length === 0)), 'the child to be forgotten')
      expect(fixture.fake.state.messages).toHaveLength(1)
    })
  )

  live('[VC-14] stops every child when the session scope closes', () =>
    Effect.gen(function* () {
      const fixture = yield* harness()
      yield* fixture.handlers.spawn({ message: 'One', model: MODEL, name: 'One' }, fixture.context())
      yield* fixture.handlers.spawn({ message: 'Two', model: MODEL, name: 'Two' }, fixture.context())
      expect(yield* fixture.pidAlive('One')).toBe(true)
      yield* Scope.close(fixture.scope, Exit.void)
      expect(yield* fixture.pidAlive('One')).toBe(false)
      expect(yield* fixture.pidAlive('Two')).toBe(false)
      expect(yield* fixture.exists(`${fixture.childDir('One')}/eof`)).toBe(true)
      expect(fixture.fake.state.messages).toEqual([])
      expect(yield* fixture.handlers.list(fixture.context())).toEqual({ agents: [] })
    })
  )

  live(
    '[KD-15] terminates a child that ignores end of input',
    () =>
      Effect.gen(function* () {
        const fixture = yield* harness()
        yield* fixture.configure('Stubborn', { ignoreEof: true })
        const { agent_id: id } = yield* fixture.handlers.spawn({ message: 'Go', model: MODEL, name: 'Stubborn' }, fixture.context())
        expect(yield* fixture.handlers.close({ agent_id: id }, fixture.context())).toEqual({ agent_id: id, status: 'closed' })
        expect(yield* fixture.exists(`${fixture.childDir('Stubborn')}/sigterm`)).toBe(true)
        expect(yield* fixture.pidAlive('Stubborn')).toBe(false)
      }),
    20_000
  )
})

describe('sub-agent ownership', () => {
  live('[VC-12] addresses only children of the calling session and reports their status', () =>
    Effect.gen(function* () {
      const fixture = yield* harness()
      const mine = yield* fixture.handlers.spawn({ message: 'Mine', model: MODEL, name: 'Mine' }, fixture.context())
      const theirs = yield* fixture.handlers.spawn({ message: 'Theirs', model: MODEL, name: 'Theirs' }, fixture.context('/sessions/other.jsonl'))
      expect((yield* fixture.handlers.list(fixture.context())).agents.map((agent) => agent.agent_id)).toEqual([mine.agent_id])
      const refusals = [
        yield* refusal(fixture.handlers.send({ agent_id: theirs.agent_id, message: 'hi' }, fixture.context())),
        yield* refusal(fixture.handlers.interrupt({ agent_id: theirs.agent_id }, fixture.context())),
        yield* refusal(fixture.handlers.close({ agent_id: theirs.agent_id }, fixture.context())),
        yield* refusal(fixture.handlers.close({ agent_id: 'deadbeef' }, fixture.context())),
      ]
      expect(new Set(refusals)).toEqual(new Set(['Only running agents spawned by this Pi session can be addressed.']))
      expect((yield* fixture.stdin('Theirs')).map((record) => record.type)).toEqual(['get_state', 'prompt'])

      expect(yield* fixture.handlers.send({ agent_id: mine.agent_id, message: 'Also check tests' }, fixture.context())).toEqual({
        agent_id: mine.agent_id,
        status: 'sent',
      })
      expect((yield* fixture.stdin('Mine')).at(-1)).toEqual({
        id: expect.any(String),
        message: 'Also check tests',
        streamingBehavior: 'steer',
        type: 'prompt',
      })
      expect(yield* fixture.handlers.interrupt({ agent_id: mine.agent_id }, fixture.context())).toEqual({
        agent_id: mine.agent_id,
        status: 'interrupted',
      })
      expect((yield* fixture.stdin('Mine')).slice(-2).map((record) => record.type)).toEqual(['clear_queue', 'abort'])

      yield* fixture.emit('Mine', { emit: { id: 'd1', method: 'confirm', title: 'Proceed?', type: 'extension_ui_request' } })
      yield* waitFor(() => fixture.dialogs.length === 1, 'the dialog')
      expect((yield* fixture.handlers.list(fixture.context())).agents[0]?.status).toBe('blocked')
      fixture.dialogs[0]?.resolve(true)
      yield* waitUntil(
        fixture.handlers.list(fixture.context()).pipe(Effect.map(({ agents }) => agents[0]?.status === 'working')),
        'the dialog to close'
      )
      yield* fixture.emit('Mine', assistant('Done'), settled)
      yield* waitUntil(fixture.handlers.list(fixture.context()).pipe(Effect.map(({ agents }) => agents[0]?.status === 'idle')), 'idle')

      expect(yield* fixture.handlers.close({ agent_id: mine.agent_id }, fixture.context())).toEqual({ agent_id: mine.agent_id, status: 'closed' })
      expect(yield* fixture.exists(`${fixture.childDir('Mine')}/eof`)).toBe(true)
      expect(yield* fixture.pidAlive('Mine')).toBe(false)
      expect(yield* fixture.handlers.list(fixture.context())).toEqual({ agents: [] })
      expect(yield* fixture.pidAlive('Theirs')).toBe(true)
    })
  )
})

const countEntry = () => statusBar.list().find((entry) => entry.key === 'subagents')

describe('running sub-agents', () => {
  live('[VC-1] publishes the running count, and clears it at zero and at session end', () =>
    Effect.gen(function* () {
      const fixture = yield* harness()
      const one = yield* fixture.handlers.spawn({ message: 'One', model: MODEL, name: 'One' }, fixture.context())
      yield* fixture.handlers.spawn({ message: 'Two', model: MODEL, name: 'Two' }, fixture.context())
      yield* fixture.handlers.spawn({ message: 'Theirs', model: MODEL, name: 'Theirs' }, fixture.context('/sessions/other.jsonl'))
      expect(countEntry()).toEqual({ key: 'subagents', priority: 30, text: '2 sub-agents', tone: 'muted' })
      expect(fixture.statuses.at(-1)).toEqual({ key: 'subagents', text: '2 sub-agents' })

      yield* fixture.handlers.close(one, fixture.context())
      expect(countEntry()?.text).toBe('1 sub-agent')
      yield* fixture.emit('Two', { exit: 0 })
      yield* waitFor(() => countEntry() === undefined, 'the count to clear')
      expect(fixture.statuses.at(-1)).toEqual({ key: 'subagents', text: undefined })

      yield* fixture.handlers.spawn({ message: 'Three', model: MODEL, name: 'Three' }, fixture.context())
      expect(countEntry()?.text).toBe('1 sub-agent')
      yield* Scope.close(fixture.scope, Exit.void)
      expect(countEntry()).toBeUndefined()
    })
  )

  live('[CT-2] lists running children of the calling session in spawn order with their cwd and session file', () =>
    Effect.gen(function* () {
      const fixture = yield* harness()
      const other = `${fixture.root}/other`
      yield* fixture.fs.makeDirectory(other)
      const first = yield* fixture.handlers.spawn({ message: 'A', model: MODEL, name: 'Alpha' }, fixture.context())
      yield* fixture.handlers.spawn({ message: 'T', model: MODEL, name: 'Theirs' }, fixture.context('/sessions/other.jsonl'))
      const second = yield* fixture.handlers.spawn({ cwd: '../other', message: 'B', model: MODEL }, fixture.context())
      expect(fixture.handlers.running(fixture.context())).toEqual([
        {
          agent_id: first.agent_id,
          cwd: fixture.project,
          model: MODEL,
          name: 'Alpha',
          session_file: `${fixture.childDir('Alpha')}/session.jsonl`,
          status: 'working',
        },
        { agent_id: second.agent_id, cwd: other, model: MODEL, session_file: `${fixture.childDir('default')}/session.jsonl`, status: 'working' },
      ])
      expect(fixture.handlers.running(fixture.context('/sessions/none.jsonl'))).toEqual([])
    })
  )
})

const overlayLines = (fixture: Effect.Success<ReturnType<typeof harness>>) =>
  (fixture.overlays[0]?.component.render(100) ?? []).map((line) => stripVTControlCharacters(line))

describe('sub-agent viewer', () => {
  live('[VC-3] lists the running children of this session and opens the chosen one in an overlay', () =>
    Effect.gen(function* () {
      const fixture = yield* harness()
      yield* openViewer(fixture.handlers, fixture.command())
      expect(fixture.notifications).toEqual(['info: No running sub-agents.'])

      yield* fixture.handlers.spawn({ message: 'A', model: MODEL, name: 'Scout' }, fixture.context())
      const second = yield* fixture.handlers.spawn({ message: 'B', model: MODEL }, fixture.context())
      yield* fixture.handlers.spawn({ message: 'C', model: MODEL, name: 'Theirs' }, fixture.context('/sessions/other.jsonl'))
      const viewing = yield* Effect.forkChild(openViewer(fixture.handlers, fixture.command()))
      yield* waitFor(() => fixture.dialogs.length === 1, 'the selection')
      expect(fixture.dialogs[0]?.detail).toEqual([`Scout · ${MODEL} · working`, `${second.agent_id} · ${MODEL} · working`])
      fixture.dialogs[0]?.resolve(`${second.agent_id} · ${MODEL} · working`)
      yield* waitFor(() => fixture.overlays.length === 1, 'the overlay')
      expect(fixture.overlays[0]?.options).toMatchObject({ overlay: true })
      expect(overlayLines(fixture)[0]).toStartWith(`╭─ ${second.agent_id} · ${MODEL} · working `)
      fixture.overlays[0]?.component.handleInput?.('q')
      yield* Fiber.join(viewing)
    })
  )

  live('[VC-5] sends nothing to the child and leaves tool expansion untouched while viewing', () =>
    Effect.gen(function* () {
      const fixture = yield* harness()
      yield* fixture.handlers.spawn({ message: 'A', model: MODEL, name: 'Scout' }, fixture.context())
      const viewing = yield* Effect.forkChild(openViewer(fixture.handlers, fixture.command()))
      yield* waitFor(() => fixture.dialogs.length === 1, 'the selection')
      fixture.dialogs[0]?.resolve(`Scout · ${MODEL} · working`)
      yield* waitFor(() => fixture.overlays.length === 1, 'the overlay')
      const overlay = fixture.overlays[0]?.component
      overlay?.render(100)
      overlay?.handleMouse?.(wheelUp)
      overlay?.handleInput?.('\u001B[A')
      overlay?.handleInput?.(EXPAND)
      overlay?.handleInput?.('\u001B')
      yield* Fiber.join(viewing)
      yield* Effect.promise(() => Bun.sleep(50))
      expect((yield* fixture.stdin('Scout')).map((record) => record.type)).toEqual(['get_state', 'prompt'])
      expect(fixture.toolsExpandedWrites()).toBe(0)
    })
  )

  live('[VC-6] keeps the transcript and marks the title exited when the viewed child exits', () =>
    Effect.gen(function* () {
      const fixture = yield* harness()
      yield* fixture.handlers.spawn({ message: 'A', model: MODEL, name: 'Scout' }, fixture.context())
      const entry = {
        id: 'u1',
        message: { content: [{ text: 'Survey the repo', type: 'text' }], role: 'user', timestamp: 1 },
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        type: 'message',
      }
      yield* fixture.fs.writeFileString(`${fixture.childDir('Scout')}/session.jsonl`, `${jsonText(entry)}\n`)
      const viewing = yield* Effect.forkChild(openViewer(fixture.handlers, fixture.command()))
      yield* waitFor(() => fixture.dialogs.length === 1, 'the selection')
      fixture.dialogs[0]?.resolve(`Scout · ${MODEL} · working`)
      yield* waitFor(() => fixture.overlays.length === 1, 'the overlay')
      expect(overlayLines(fixture).join('\n')).toContain('Survey the repo')
      yield* fixture.emit('Scout', { exit: 0 })
      yield* waitFor(() => (overlayLines(fixture)[0] ?? '').includes('· exited '), 'the exited title')
      expect(overlayLines(fixture).join('\n')).toContain('Survey the repo')
      fixture.overlays[0]?.component.handleInput?.('q')
      yield* Fiber.join(viewing)
    })
  )
})

describe('sub-agent dialogs', () => {
  live('[VC-13] shows child dialogs one at a time with the child label and answers each child', () =>
    Effect.gen(function* () {
      const fixture = yield* harness()
      yield* fixture.handlers.spawn({ message: 'A', model: MODEL, name: 'Alpha' }, fixture.context())
      yield* fixture.handlers.spawn({ message: 'B', model: MODEL }, fixture.context())
      yield* fixture.emit('Alpha', {
        emit: { id: 'a1', message: 'Run it?', method: 'confirm', timeout: 9000, title: 'Proceed?', type: 'extension_ui_request' },
      })
      yield* waitFor(() => fixture.dialogs.length === 1, 'the first dialog')
      yield* fixture.emit('default', { emit: { id: 'b1', method: 'confirm', title: 'Proceed?', type: 'extension_ui_request' } })
      yield* Effect.promise(() => Bun.sleep(50))
      expect(fixture.dialogs.map((call) => call.title)).toEqual(['[Alpha] Proceed?'])
      expect(fixture.dialogs[0]?.timeout).toBe(9000)
      expect(fixture.fake.state.emittedEvents).toEqual([{ data: { active: true, label: 'Proceed?' }, name: 'herdr:blocked' }])
      fixture.dialogs[0]?.resolve(true)
      yield* waitFor(() => fixture.dialogs.length === 2, 'the second dialog')
      expect(fixture.dialogs[1]?.title).toBe(`[${MODEL}] Proceed?`)
      fixture.dialogs[1]?.resolve(false)
      yield* waitUntil(fixture.stdin('default').pipe(Effect.map((records) => records.length === 3)), 'the second answer')
      expect((yield* fixture.stdin('Alpha')).at(-1)).toEqual({ confirmed: true, id: 'a1', type: 'extension_ui_response' })
      expect((yield* fixture.stdin('default')).at(-1)).toEqual({ confirmed: false, id: 'b1', type: 'extension_ui_response' })
      expect(fixture.fake.state.emittedEvents.map(({ data }) => data)).toEqual([
        { active: true, label: 'Proceed?' },
        { active: false },
        { active: true, label: 'Proceed?' },
        { active: false },
      ])
    })
  )

  live('[VC-13] returns selections and input, and cancels dismissed dialogs', () =>
    Effect.gen(function* () {
      const fixture = yield* harness()
      yield* fixture.handlers.spawn({ message: 'A', model: MODEL, name: 'Alpha' }, fixture.context())
      yield* fixture.emit('Alpha', {
        emit: { id: 's1', method: 'select', options: ['Allow', 'Block'], title: 'Command?', type: 'extension_ui_request' },
      })
      yield* waitFor(() => fixture.dialogs.length === 1, 'select')
      fixture.dialogs[0]?.resolve('Allow')
      yield* fixture.emit('Alpha', { emit: { id: 'i1', method: 'input', title: 'Value?', type: 'extension_ui_request' } })
      yield* waitFor(() => fixture.dialogs.length === 2, 'input')
      fixture.dialogs[1]?.resolve(undefined)
      yield* waitUntil(fixture.stdin('Alpha').pipe(Effect.map((records) => records.length === 4)), 'both answers')
      expect((yield* fixture.stdin('Alpha')).slice(2)).toEqual([
        { id: 's1', type: 'extension_ui_response', value: 'Allow' },
        { cancelled: true, id: 'i1', type: 'extension_ui_response' },
      ])
    })
  )

  live('[VC-13] dismisses an open dialog when its child is closed, and ignores fire-and-forget requests', () =>
    Effect.gen(function* () {
      const fixture = yield* harness()
      const { agent_id: id } = yield* fixture.handlers.spawn({ message: 'A', model: MODEL, name: 'Alpha' }, fixture.context())
      yield* fixture.emit('Alpha', { emit: { id: 'n1', message: 'hello', method: 'notify', type: 'extension_ui_request' } })
      yield* fixture.emit('Alpha', { emit: { id: 's1', method: 'select', options: ['Allow'], title: 'Command?', type: 'extension_ui_request' } })
      yield* waitFor(() => fixture.dialogs.length === 1, 'select')
      expect(fixture.uiCalls).toEqual(['select'])
      expect(fixture.dialogs[0]?.signal?.aborted).toBe(false)
      yield* fixture.handlers.close({ agent_id: id }, fixture.context())
      expect(fixture.dialogs[0]?.signal?.aborted).toBe(true)
      expect(fixture.fake.state.emittedEvents.at(-1)).toEqual({ data: { active: false }, name: 'herdr:blocked' })
    })
  )

  live('[VC-13] answers cancelled at once when the parent has no UI', () =>
    Effect.gen(function* () {
      const fixture = yield* harness({ hasUI: false })
      yield* fixture.handlers.spawn({ message: 'A', model: MODEL }, fixture.context())
      yield* fixture.emit('default', { emit: { id: 'c1', method: 'confirm', title: 'Proceed?', type: 'extension_ui_request' } })
      yield* waitUntil(fixture.stdin('default').pipe(Effect.map((records) => records.length === 3)), 'the answer')
      expect((yield* fixture.stdin('default')).at(-1)).toEqual({ cancelled: true, id: 'c1', type: 'extension_ui_response' })
      expect(fixture.uiCalls).toEqual([])
    })
  )
})
