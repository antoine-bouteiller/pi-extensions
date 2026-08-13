import { mock } from 'bun:test'
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Fixture setup and teardown must stay synchronously ordered against the child processes these specs start.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'

import { type Theme } from '@earendil-works/pi-coding-agent'
import { visibleWidth } from '@earendil-works/pi-tui'
import { makeAbortController } from '@tests/utils/abort_controller.js'
import { promiseFromEffect, tryPromiseEffect, describe, expect, it } from '@tests/utils/bun_effect.js'
import { asError, asExtensionApi, asNarrowed, asResult, asTheme, asTui } from '@tests/utils/casts.js'
import { withProcessEnv } from '@tests/utils/process_env.js'
import { Data, DateTime, Deferred, Effect, Fiber } from 'effect'

import { nodePath } from '@/shared/effect/node_path.js'
import { jsonText, parseJsonText, prettyJsonText } from '@/shared/utils/json.js'

const { dirname, join } = nodePath
const TEST_AGENT_DIR = '/tmp/pi-codex-subagents-tests'
const FAKE_RPC_CHILD = join(import.meta.dir, 'fixtures', 'fake_rpc_child.js')
const TEST_TEMP_DIR = join(TEST_AGENT_DIR, 'temp')
process.env.PI_SUBAGENT_TEMP_DIR = TEST_TEMP_DIR

const codingAgent = await import('@earendil-works/pi-coding-agent')
await mock.module('@earendil-works/pi-coding-agent', () => ({
  ...codingAgent,
  CONFIG_DIR_NAME: '.pi',
  getAgentDir: () => TEST_AGENT_DIR,
}))

const { runtime } = await import('@tests/utils/runtime.js')
const {
  AgentManager,
  RpcJsonlDecoder,
  consumeFirstMatchingMailboxEvent,
  getAgent,
  getRunsDir,
  getSocketPath,
  parentScopeKey,
  taskStorageKey,
  writeFullToolOutput,
} = await import('@/features/sub_agents/core.js')
const { AGENT_CONFIGS } = await import('@/features/sub_agents/profiles.js')
const { SubagentPeekOverlay } = await import('@/features/sub_agents/peek.js')
const { azureQuota } = await import('@/shared/state/azure_quota.js')
const { runningAgents } = await import('@/shared/state/agent_activity.js')

/*
 * Fixtures need concrete epoch values to build on-disk records and mtimes, and the assertions compare
 * them directly. These two are the only clock reads in the file.
 */
const nowMs = (): number => DateTime.toEpochMillis(DateTime.nowUnsafe())

const dateOf = (epochMs: number): Date => DateTime.toDateUtc(DateTime.makeUnsafe(epochMs))

const sleep = (durationMs: number): Promise<void> => promiseFromEffect(Effect.sleep(durationMs))

class TestLaunchError extends Data.TaggedError('TestLaunchError')<{ readonly message: string }> {}

const requireChildProcess = <ChildProcess>(childProcess: ChildProcess | undefined): ChildProcess => {
  if (childProcess === undefined) {
    throw new Error('expected the agent to own a child process')
  }
  return childProcess
}

const rejectionOf = (promise: Promise<unknown>): Promise<Error> =>
  promiseFromEffect(
    tryPromiseEffect(() => promise).pipe(
      Effect.matchEffect({
        onFailure: (error) => Effect.succeed(asError(error.cause)),
        onSuccess: () => Effect.die(new Error('expected promise to reject')),
      })
    )
  )

interface CompletionEvent {
  agentName: string
  [field: string]: unknown
}

interface ActivityEvent {
  active: boolean
  parentSessionId: string
}

interface InactivityEvent {
  agentName: string
  inactiveForMs: number
  parentSessionId: string
}

type FakeHandler = (event: unknown, ctx: unknown) => unknown
interface FakeTheme {
  bold: (text: string) => string
  fg: (color: string, text: string) => string
}
type FakeRenderer = (message: unknown, options: unknown, theme: FakeTheme) => unknown

interface FakeRenderable {
  render: (width: number) => string[]
}

interface FakeToolDefinition {
  description: string
  name: string
  parameters: {
    required: string[]
    properties: Record<string, { description?: string; enum?: string[]; type?: string }>
  }
  execute: (...args: unknown[]) => Promise<unknown>
  renderCall: (...args: unknown[]) => FakeRenderable
  renderResult: (...args: unknown[]) => FakeRenderable
}

interface FakeToolResult {
  content: { text: string; type: string }[]
  details: Record<string, unknown>
}

interface FakeMessage {
  content: string
  details: Record<string, string>
}

/*
 * The manager's asynchronous surface is Effect-returning; this is the single place these specs leave
 * Effect, so each test below keeps asserting on plain promises.
 */
const promising = (manager: InstanceType<typeof AgentManager>) => ({
  getAgentInfo: manager.getAgentInfo.bind(manager),
  instance: manager,
  interruptAgent: (...args: Parameters<typeof manager.interruptAgent>) => promiseFromEffect(manager.interruptAgent(...args)),
  listAgents: manager.listAgents.bind(manager),
  readAgentResponse: manager.readAgentResponse.bind(manager),
  ready: () => promiseFromEffect(manager.ready()),
  sendMessage: (...args: Parameters<typeof manager.sendMessage>) => promiseFromEffect(manager.sendMessage(...args)),
  shutdown: () => promiseFromEffect(manager.shutdown()),
  spawnAgent: (...args: Parameters<typeof manager.spawnAgent>) => promiseFromEffect(manager.spawnAgent(...args)),
  waitAgent: (...args: Parameters<typeof manager.waitAgent>) => promiseFromEffect(manager.waitAgent(...args)),
  waitAllAgents: (...args: Parameters<typeof manager.waitAllAgents>) => promiseFromEffect(manager.waitAllAgents(...args)),
})

const createAgentManager = (options: Record<string, unknown> = {}) =>
  promising(
    new AgentManager({
      piCommand: { command: FAKE_RPC_CHILD },
      ...options,
    })
  )

const processTest = (name: string, run: () => Effect.Effect<void, unknown>): void => {
  it.live(name, run, 15_000)
}

const withScoutProfile = <Success, Failure, Requirements>(
  patch: Partial<{ model: string; isReadonly: boolean }>,
  effect: Effect.Effect<Success, Failure, Requirements>
): Effect.Effect<Success, Failure, Requirements> =>
  Effect.sync(() => {
    const profile = AGENT_CONFIGS.scout
    const original = { isReadonly: profile.isReadonly, model: profile.model }
    Object.assign(profile, patch)
    return { original, profile }
  }).pipe(
    Effect.flatMap(({ original, profile }) =>
      effect.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            Object.assign(profile, original)
          })
        )
      )
    )
  )

describe('RPC framing', () => {
  it.effect('splits only on LF and preserves Unicode line separators', () =>
    Effect.sync(() => {
      const decoder = new RpcJsonlDecoder()
      const payload = jsonText({ text: 'before\u2028after' })
      expect(decoder.push(Buffer.from(payload.slice(0, 7)))).toEqual([])
      expect(decoder.push(Buffer.from(`${payload.slice(7)}\n`))).toEqual([payload])
      expect(decoder.end()).toEqual([])
    })
  )
})

describe('session-scoped identities', () => {
  it.effect('separates parent sessions and formerly colliding task names', () =>
    Effect.sync(() => {
      expect(parentScopeKey('parent-a')).not.toBe(parentScopeKey('parent-b'))
      expect(taskStorageKey('review/api')).not.toBe(taskStorageKey('review__api'))
    })
  )
})

describe('run storage', () => {
  const packageDir = join(TEST_AGENT_DIR, 'pi-codex-subagents')
  const configFile = join(packageDir, 'config.json')
  const fixtureDir = join(TEST_AGENT_DIR, 'retention-fixture')

  it.effect('uses persistent package storage by default', () =>
    Effect.sync(() => {
      rmSync(configFile, { force: true })
      expect(getRunsDir()).toBe(join(packageDir, 'runs'))
    })
  )

  it.effect('keeps legacy temporary runs discoverable', () =>
    Effect.sync(() => {
      rmSync(configFile, { force: true })
      const parentSessionId = 'legacy-parent'
      const id = '11111111-1111-4111-8111-111111111111'
      const legacyRoot = join(TEST_TEMP_DIR, 'pi-codex-subagents', userInfo().username, 'runs')
      const legacyScope = join(legacyRoot, parentScopeKey(parentSessionId))
      mkdirSync(legacyScope, { recursive: true })
      writeFileSync(
        join(legacyScope, `${id}.info.json`),
        jsonText({
          createdAt: nowMs(),
          finalResponse: 'legacy response',
          id,
          status: 'closed',
          taskName: 'legacy',
          updatedAt: nowMs(),
        })
      )

      expect(getAgent('legacy', parentSessionId)).toMatchObject({
        finalResponse: 'legacy response',
        id,
        status: 'completed',
      })
      rmSync(legacyScope, { force: true, recursive: true })
    })
  )

  it.effect('keeps agent lists in creation order when activity changes', () =>
    Effect.gen(function* () {
      rmSync(configFile, { force: true })
      const parentSessionId = 'creation-order'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      const now = nowMs()
      const agents = [
        {
          createdAt: now - 2000,
          id: '11111111-1111-4111-8111-111111111111',
          lastActivity: now,
          taskName: 'older',
        },
        {
          createdAt: now - 1000,
          id: '22222222-2222-4222-8222-222222222222',
          lastActivity: now - 1000,
          taskName: 'newer',
        },
      ]
      mkdirSync(scope, { recursive: true })
      for (const agent of agents) {
        writeFileSync(
          join(scope, `${agent.id}.info.json`),
          jsonText({
            ...agent,
            canonicalName: `/${agent.taskName}`,
            parentSessionId,
            status: 'completed',
            updatedAt: agent.lastActivity,
          })
        )
      }

      const manager = createAgentManager()
      try {
        expect(manager.listAgents(undefined, parentSessionId).map((agent) => agent.agent_name)).toEqual(['/newer', '/older'])
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )

  it.effect('removes expired runs and outputs using configurable retention', () =>
    Effect.sync(() => {
      mkdirSync(packageDir, { recursive: true })
      rmSync(fixtureDir, { force: true, recursive: true })
      writeFileSync(configFile, jsonText({ retentionDays: 3, storageDir: fixtureDir }))

      const now = nowMs()
      const oldTime = dateOf(now - 4 * 24 * 60 * 60 * 1000)
      const scope = join(fixtureDir, 'a'.repeat(24))
      const unrelatedScope = join(fixtureDir, 'unrelated')
      const outputs = join(fixtureDir, '_outputs')
      const expiredId = '11111111-1111-4111-8111-111111111111'
      const activeId = '22222222-2222-4222-8222-222222222222'
      const expiredInfo = join(scope, `${expiredId}.info.json`)
      const activeInfo = join(scope, `${activeId}.info.json`)
      const expiredOutput = join(outputs, `${oldTime.getTime()}-33333333-3333-4333-8333-333333333333.txt`)
      const activeMarker = join(TEST_TEMP_DIR, 'pi-codex-subagents', userInfo().username, 'sockets', `${activeId}.peek.json`)
      const unrelatedAgentFile = join(scope, `${expiredId}.notes`)
      const staleLock = join(scope, `.task-${'c'.repeat(24)}.lock`)
      const liveOwnerLock = join(scope, `.task-${'d'.repeat(24)}.lock`)

      try {
        mkdirSync(scope, { recursive: true })
        mkdirSync(unrelatedScope, { recursive: true })
        mkdirSync(outputs, { recursive: true })
        mkdirSync(dirname(activeMarker), { recursive: true })
        for (const [file, id] of [
          [expiredInfo, expiredId],
          [activeInfo, activeId],
        ]) {
          writeFileSync(
            file,
            jsonText({
              createdAt: oldTime.getTime(),
              id,
              lastActivity: oldTime.getTime(),
              updatedAt: oldTime.getTime(),
            })
          )
          utimesSync(file, oldTime, oldTime)
        }
        writeFileSync(activeMarker, jsonText({ pid: process.pid, startedAt: now, token: 'test' }))
        writeFileSync(unrelatedAgentFile, 'keep')
        writeFileSync(staleLock, '')
        writeFileSync(liveOwnerLock, jsonText({ pid: process.pid }))
        utimesSync(staleLock, oldTime, oldTime)
        utimesSync(liveOwnerLock, oldTime, oldTime)
        writeFileSync(expiredOutput, 'old')
        utimesSync(expiredOutput, oldTime, oldTime)
        writeFileSync(join(outputs, 'unrelated.txt'), 'keep')
        writeFileSync(join(unrelatedScope, 'unrelated.txt'), 'keep')

        createAgentManager()
        expect(existsSync(expiredInfo)).toBe(false)
        expect(existsSync(activeInfo)).toBe(true)
        expect(existsSync(unrelatedAgentFile)).toBe(true)
        expect(existsSync(staleLock)).toBe(false)
        expect(existsSync(liveOwnerLock)).toBe(true)
        expect(existsSync(expiredOutput)).toBe(false)
        expect(existsSync(join(outputs, 'unrelated.txt'))).toBe(true)
        expect(existsSync(join(unrelatedScope, 'unrelated.txt'))).toBe(true)

        writeFileSync(configFile, jsonText({ retentionDays: 0, storageDir: fixtureDir }))
        writeFileSync(expiredInfo, '{}')
        utimesSync(expiredInfo, oldTime, oldTime)
        createAgentManager()
        expect(existsSync(expiredInfo)).toBe(true)
      } finally {
        rmSync(fixtureDir, { force: true, recursive: true })
        rmSync(activeMarker, { force: true })
        rmSync(configFile, { force: true })
      }
    })
  )

  it.effect('creates the default run and socket directories with 0700 permissions', () =>
    Effect.gen(function* () {
      if (process.platform === 'win32') {
        return
      }
      rmSync(configFile, { force: true })
      rmSync(join(packageDir, 'runs'), { force: true, recursive: true })
      const socketDir = join(TEST_TEMP_DIR, 'pi-codex-subagents', userInfo().username, 'sockets')
      rmSync(socketDir, { force: true, recursive: true })
      const manager = createAgentManager()
      try {
        expect(statSync(getRunsDir()).mode & 0o777).toBe(0o700)
        expect(statSync(socketDir).mode & 0o777).toBe(0o700)
      } finally {
        yield* Effect.promise(() => manager.shutdown())
      }
    })
  )

  it.effect('creates the _outputs directory with 0700 permissions', () =>
    Effect.sync(() => {
      if (process.platform === 'win32') {
        return
      }
      rmSync(configFile, { force: true })
      const outputsDir = join(getRunsDir(), '_outputs')
      rmSync(outputsDir, { force: true, recursive: true })
      try {
        writeFullToolOutput('characterization content')
        expect(statSync(outputsDir).mode & 0o777).toBe(0o700)
      } finally {
        rmSync(outputsDir, { force: true, recursive: true })
      }
    })
  )

  it.effect('chmods a freshly created configured storage root to 0700', () =>
    Effect.gen(function* () {
      if (process.platform === 'win32') {
        return
      }
      rmSync(fixtureDir, { force: true, recursive: true })
      writeFileSync(configFile, jsonText({ storageDir: fixtureDir }))
      const manager = createAgentManager()
      try {
        expect(statSync(fixtureDir).mode & 0o777).toBe(0o700)
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(fixtureDir, { force: true, recursive: true })
        rmSync(configFile, { force: true })
      }
    })
  )

  it.effect('does not tighten permissions on a pre-existing configured storage root', () =>
    Effect.gen(function* () {
      if (process.platform === 'win32') {
        return
      }
      rmSync(fixtureDir, { force: true, recursive: true })
      mkdirSync(fixtureDir, { recursive: true })
      chmodSync(fixtureDir, 0o755)
      writeFileSync(configFile, jsonText({ storageDir: fixtureDir }))
      const manager = createAgentManager()
      try {
        expect(statSync(fixtureDir).mode & 0o777).toBe(0o755)
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(fixtureDir, { force: true, recursive: true })
        rmSync(configFile, { force: true })
      }
    })
  )
})

const waitUntil = (predicate: () => boolean, timeoutMs = 12_000): Promise<void> =>
  promiseFromEffect(
    Effect.gen(function* () {
      const deadline = nowMs() + timeoutMs
      while (nowMs() < deadline) {
        if (predicate()) {
          return undefined
        }
        yield* Effect.sleep(20)
      }
      return yield* Effect.die(new Error('Timed out waiting for condition.'))
    })
  )

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const AVAILABLE_MODELS = [
  { id: 'gpt-5.6-luna', provider: 'openai' },
  { id: 'gpt-5.6-sol', provider: 'openai' },
  { id: 'claude-haiku-4-5', provider: 'anthropic' },
  { id: 'claude-sonnet-5', provider: 'anthropic' },
  { id: 'claude-opus-5', provider: 'anthropic' },
]

const spawnParams = (parentSessionId: string, task_name: string, message: string) => ({
  agent_type: 'scout' as const,
  availableModels: AVAILABLE_MODELS,
  cwd: TEST_AGENT_DIR,
  message,
  parentModel: { id: 'gpt-5.6-sol', provider: 'openai' },
  parentSessionId,
  task_name,
})

const writeSessionWithContextUsage = (sessionFile: string, contextTokens: number): void => {
  const timestamp = dateOf(nowMs()).toISOString()
  writeFileSync(
    sessionFile,
    `${[
      JSON.stringify({ cwd: TEST_AGENT_DIR, id: '11111111-1111-4111-8111-111111111111', timestamp, type: 'session', version: 3 }),
      JSON.stringify({
        id: 'a1b2c3d4',
        message: {
          api: 'anthropic-messages',
          content: [{ text: 'done', type: 'text' }],
          model: 'claude-sonnet-5',
          provider: 'anthropic',
          role: 'assistant',
          stopReason: 'stop',
          timestamp: nowMs(),
          usage: {
            cacheRead: contextTokens - 2,
            cacheWrite: 0,
            cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
            input: 2,
            output: 10,
            totalTokens: contextTokens + 10,
          },
        },
        // oxlint-disable-next-line unicorn/no-null -- Session roots require a literal null parent.
        parentId: null,
        timestamp,
        type: 'message',
      }),
    ].join('\n')}\n`
  )
}

describe('child process lifecycle', () => {
  processTest('resolves profiles before creating task artifacts', () =>
    Effect.gen(function* () {
      const parentSessionId = 'unavailable-profile-model'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      rmSync(scope, { force: true, recursive: true })
      const manager = createAgentManager()
      try {
        expect(
          manager.spawnAgent({
            ...spawnParams(parentSessionId, 'worker', 'must not start'),
            availableModels: AVAILABLE_MODELS.filter((model) => model.id !== 'gpt-5.6-luna'),
          })
        ).rejects.toThrow('not authenticated or available')
        expect(existsSync(scope)).toBe(false)
      } finally {
        yield* Effect.promise(() => manager.shutdown())
      }
    })
  )

  processTest('allows write-capable Claude profiles', () =>
    Effect.gen(function* () {
      const parentSessionId = 'claude-write-capable'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      rmSync(scope, { force: true, recursive: true })
      const manager = createAgentManager()
      try {
        yield* withScoutProfile(
          { isReadonly: false, model: 'claude-sonnet-5' },
          Effect.gen(function* () {
            yield* Effect.promise(() => manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'hold write-capable')))
            expect(manager.getAgentInfo('worker', parentSessionId)).toMatchObject({
              isReadonly: false,
              modelId: 'claude-sonnet-5',
              status: 'running',
            })
          })
        )
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )

  processTest('limits one manager to three live Claude subagents', () =>
    Effect.gen(function* () {
      const parentSessionId = 'claude-live-limit'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      rmSync(scope, { force: true, recursive: true })
      const manager = createAgentManager()
      try {
        yield* withScoutProfile(
          { model: 'claude-sonnet-5' },
          Effect.gen(function* () {
            for (const task of ['one', 'two', 'three']) {
              yield* Effect.promise(() => manager.spawnAgent(spawnParams(parentSessionId, task, `hold ${task}`)))
            }
            const failure = yield* Effect.promise(() =>
              manager.spawnAgent(spawnParams(parentSessionId, 'four', 'hold four')).then(
                () => undefined,
                (error: unknown) => error
              )
            )
            expect(asError(failure).message).toContain('At most 3 Claude-backed subagents')
            expect(() => manager.getAgentInfo('four', parentSessionId)).toThrow('Agent not found')
          })
        )
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )

  processTest('allows one follow-up per logical agent and persists the consumed allowance', () =>
    Effect.gen(function* () {
      const parentSessionId = 'single-follow-up'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      rmSync(scope, { force: true, recursive: true })
      const manager = createAgentManager()
      try {
        yield* Effect.promise(() => manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'hold initial')))
        expect(yield* Effect.promise(() => manager.sendMessage(parentSessionId, 'worker', 'one correction'))).toEqual({ delivery: 'steer' })
        expect(manager.getAgentInfo('worker', parentSessionId).followUpUsed).toBe(true)
        expect(manager.sendMessage(parentSessionId, 'worker', 'another correction')).rejects.toThrow('single follow-up')
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )

  processTest('allows only one concurrent follow-up claim across managers', () =>
    Effect.gen(function* () {
      const parentSessionId = 'atomic-follow-up'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      rmSync(scope, { force: true, recursive: true })
      const firstManager = createAgentManager()
      const secondManager = createAgentManager()
      try {
        yield* Effect.promise(() => firstManager.spawnAgent(spawnParams(parentSessionId, 'worker', 'first')))
        yield* Effect.promise(() =>
          waitUntil(() => {
            const info = firstManager.getAgentInfo('worker', parentSessionId)
            return info.status === 'completed' && info.childProcess === undefined
          })
        )
        yield* Effect.promise(() => secondManager.ready())

        const results = yield* Effect.promise(() =>
          Promise.allSettled([
            firstManager.sendMessage(parentSessionId, 'worker', 'hold first follow-up'),
            secondManager.sendMessage(parentSessionId, 'worker', 'hold competing follow-up'),
          ])
        )
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
        expect(firstManager.getAgentInfo('worker', parentSessionId).followUpUsed).toBe(true)
      } finally {
        yield* Effect.promise(() => Promise.all([firstManager.shutdown(), secondManager.shutdown()]))
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )

  processTest('starts a fresh Claude agent instead of continuing at 112k context input tokens', () =>
    Effect.gen(function* () {
      const parentSessionId = 'claude-context-limit'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      rmSync(scope, { force: true, recursive: true })
      const manager = createAgentManager()
      try {
        yield* withScoutProfile(
          { model: 'claude-sonnet-5' },
          Effect.gen(function* () {
            yield* Effect.promise(() => manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'first')))
            yield* Effect.promise(() =>
              waitUntil(() => {
                const info = manager.getAgentInfo('worker', parentSessionId)
                return info.status === 'completed' && info.childProcess === undefined
              })
            )
            const info = manager.getAgentInfo('worker', parentSessionId)
            writeSessionWithContextUsage(info.sessionFile, 112_000)
            const failure = yield* Effect.promise(() =>
              manager.sendMessage(parentSessionId, 'worker', 'too much context').then(
                () => undefined,
                (error: unknown) => error
              )
            )
            expect(asError(failure).message).toContain('112000 context input tokens')
            expect(manager.getAgentInfo('worker', parentSessionId).childProcess).toBeUndefined()
            expect(manager.getAgentInfo('worker', parentSessionId).followUpUsed).toBe(false)

            writeSessionWithContextUsage(info.sessionFile, 111_999)
            expect(yield* Effect.promise(() => manager.sendMessage(parentSessionId, 'worker', 'hold below limit'))).toEqual({ delivery: 'prompt' })
          })
        )
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )

  processTest('passes read-only profile metadata without changing the task message', () =>
    Effect.gen(function* () {
      const parentSessionId = 'readonly-profile-metadata'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      rmSync(scope, { force: true, recursive: true })
      const manager = createAgentManager()
      try {
        yield* Effect.promise(() =>
          manager.spawnAgent({
            ...spawnParams(parentSessionId, 'worker', 'inspect exactly this'),
            agent_type: 'scout',
          })
        )
        const info = manager.getAgentInfo('worker', parentSessionId)
        expect(info).toMatchObject({
          color: 'accent',
          isReadonly: true,
          modelId: 'gpt-5.6-luna',
          profile: 'scout',
          provider: 'openai',
        })
        yield* Effect.promise(() =>
          waitUntil(() => {
            const contents = readFileSync(info.sessionFile, 'utf8')
            return contents.includes('"type":"prompt"') && contents.includes('"type":"started"')
          })
        )
        const records = readFileSync(info.sessionFile, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        expect(records.find((record) => record.type === 'prompt')?.message).toBe('inspect exactly this')
        const start = records.find((record) => record.type === 'started')
        expect(start.env).toMatchObject({
          PI_SUBAGENT_PROFILE: 'scout',
          PI_SUBAGENT_READONLY: '1',
        })
        expect(start.args[start.args.indexOf('--append-system-prompt') + 1]).toContain('This subagent role is read-only.')
        expect(start.args[start.args.indexOf('--tools') + 1]).toContain('fff-multi-grep')
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )

  processTest('forwards Azure quota reported by a subagent response', () =>
    Effect.gen(function* () {
      const parentSessionId = 'subagent-azure-quota'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      rmSync(scope, { force: true, recursive: true })
      azureQuota.set(undefined)
      const manager = createAgentManager()
      try {
        yield* Effect.promise(() => manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'quota response')))
        yield* Effect.promise(() => waitUntil(() => azureQuota.get() === 73))
        expect(azureQuota.get()).toBe(73)
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        azureQuota.set(undefined)
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )

  processTest('reclaims a fresh lock whose PID identity no longer owns it, even with retention disabled', () =>
    Effect.gen(function* () {
      const parentSessionId = 'fresh-dead-lock'
      const packageDir = join(TEST_AGENT_DIR, 'pi-codex-subagents')
      const configFile = join(packageDir, 'config.json')
      const scope = join(packageDir, 'runs', parentScopeKey(parentSessionId))
      const lockFile = join(scope, `.task-${taskStorageKey('worker')}.lock`)
      mkdirSync(scope, { recursive: true })
      writeFileSync(configFile, jsonText({ retentionDays: 0 }))
      writeFileSync(
        lockFile,
        jsonText({
          createdAt: nowMs(),
          pid: process.pid,
          processIdentity: 'identity-from-an-exited-process',
        })
      )
      const manager = createAgentManager()
      try {
        yield* Effect.promise(() => manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'hold lock recovery')))
        expect(manager.getAgentInfo('worker', parentSessionId).status).toBe('running')
        expect(existsSync(lockFile)).toBe(false)
        yield* Effect.promise(() => manager.interruptAgent(parentSessionId, 'worker'))
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(scope, { force: true, recursive: true })
        rmSync(configFile, { force: true })
      }
    })
  )

  processTest('does not unlink a live lock that replaces the inspected dead instance', () =>
    Effect.gen(function* () {
      const parentSessionId = 'lock-replacement-race'
      const packageDir = join(TEST_AGENT_DIR, 'pi-codex-subagents')
      const configFile = join(packageDir, 'config.json')
      const scope = join(packageDir, 'runs', parentScopeKey(parentSessionId))
      const lockFile = join(scope, `.task-${taskStorageKey('worker')}.lock`)
      const displacedLock = `${lockFile}.displaced`
      mkdirSync(scope, { recursive: true })
      writeFileSync(configFile, jsonText({ retentionDays: 0 }))
      writeFileSync(
        lockFile,
        jsonText({
          createdAt: nowMs(),
          pid: process.pid,
          processIdentity: 'identity-from-an-exited-process',
          token: 'dead-instance',
        })
      )
      let replaced = false
      const manager = createAgentManager({
        beforeReclaimTaskLockRemoval(file: string) {
          if (replaced) {
            return
          }
          replaced = true
          renameSync(file, displacedLock)
          writeFileSync(
            file,
            JSON.stringify({
              createdAt: nowMs(),
              pid: process.pid,
              token: 'live-replacement',
            })
          )
        },
      })
      try {
        expect(manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'must not start'))).rejects.toThrow('already being created')
        expect(replaced).toBe(true)
        expect(parseJsonText(readFileSync(lockFile, 'utf8'))).toMatchObject({
          pid: process.pid,
          token: 'live-replacement',
        })
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(scope, { force: true, recursive: true })
        rmSync(configFile, { force: true })
      }
    })
  )

  processTest('does not unlink a live lock that replaces the lock this caller is normally releasing', () =>
    Effect.gen(function* () {
      const parentSessionId = 'lock-release-race'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      const lockFile = join(scope, `.task-${taskStorageKey('worker')}.lock`)
      rmSync(scope, { force: true, recursive: true })
      let replaced = false
      const manager = createAgentManager({
        beforeReleaseTaskLockRemoval(file: string) {
          if (replaced || file !== lockFile) {
            return
          }
          replaced = true
          renameSync(file, `${file}.displaced`)
          writeFileSync(
            file,
            JSON.stringify({
              createdAt: nowMs(),
              pid: process.pid,
              token: 'concurrent-winner',
            })
          )
        },
      })
      try {
        yield* Effect.promise(() => manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'hold release race')))
        expect(replaced).toBe(true)
        expect(manager.getAgentInfo('worker', parentSessionId).status).toBe('running')
        expect(parseJsonText(readFileSync(lockFile, 'utf8'))).toMatchObject({ token: 'concurrent-winner' })
        yield* Effect.promise(() => manager.interruptAgent(parentSessionId, 'worker'))
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )

  processTest('reconciles a persisted starting record left before child ownership', () =>
    Effect.gen(function* () {
      const parentSessionId = 'starting-without-owner'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      const id = '33333333-3333-4333-8333-333333333333'
      const infoFile = join(scope, `${id}.info.json`)
      const now = nowMs()
      rmSync(scope, { force: true, recursive: true })
      mkdirSync(scope, { recursive: true })
      writeFileSync(
        infoFile,
        jsonText({
          canonicalName: '/worker',
          createdAt: now,
          cwd: TEST_AGENT_DIR,
          id,
          infoFile,
          lastActivity: now,
          logFile: join(scope, `${id}.log`),
          messageCount: 0,
          model: 'test:fake',
          modelId: 'fake',
          parentSessionId,
          provider: 'test',
          sessionFile: join(scope, `${id}.jsonl`),
          startedAt: now,
          status: 'starting',
          taskName: 'worker',
          updatedAt: now,
        })
      )
      const manager = createAgentManager()
      try {
        yield* Effect.promise(() => manager.ready())
        const reconciled = manager.getAgentInfo('worker', parentSessionId)
        expect(reconciled.status).toBe('interrupted')
        expect(reconciled.childProcess).toBeUndefined()
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )

  processTest('persists provisional ownership before the startup RPC round trip completes', () =>
    Effect.gen(function* () {
      const parentSessionId = 'startup-crash-window'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      rmSync(scope, { force: true, recursive: true })
      const manager = createAgentManager({
        childEnv: { PI_SUBAGENT_TEST_GET_STATE_DELAY_MS: '300' },
      })
      let spawnSettled = false
      try {
        const spawning = manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'hold startup')).finally(() => {
          spawnSettled = true
        })
        yield* Effect.promise(() =>
          waitUntil(() => {
            try {
              return Boolean(manager.getAgentInfo('worker', parentSessionId).childProcess)
            } catch {
              return false
            }
          })
        )
        const starting = manager.getAgentInfo('worker', parentSessionId)
        expect(starting.status).toBe('starting')
        expect(starting.childProcess?.pid).toBeNumber()
        expect(pidAlive(requireChildProcess(starting.childProcess).pid)).toBe(true)
        expect(spawnSettled).toBe(false)
        yield* Effect.promise(() => spawning)
        yield* Effect.promise(() => manager.interruptAgent(parentSessionId, 'worker'))
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )

  processTest('hibernates after settle and lazily restarts the persisted session', () =>
    Effect.gen(function* () {
      rmSync(join(TEST_AGENT_DIR, 'pi-codex-subagents', 'config.json'), { force: true })
      const parentSessionId = 'lifecycle-settle'
      rmSync(join(getRunsDir(), parentScopeKey(parentSessionId)), {
        force: true,
        recursive: true,
      })
      const manager = createAgentManager()
      try {
        yield* Effect.promise(() => manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'first')))
        const first = manager.getAgentInfo('worker', parentSessionId)
        const firstPid = requireChildProcess(first.childProcess).pid
        yield* Effect.promise(() =>
          waitUntil(() => {
            const info = manager.getAgentInfo('worker', parentSessionId)
            return info.status === 'completed' && info.childProcess === undefined
          })
        )
        expect(pidAlive(firstPid)).toBe(false)
        expect(manager.readAgentResponse('worker', parentSessionId).finalResponse).toBe('response:first')

        expect(yield* Effect.promise(() => manager.sendMessage(parentSessionId, 'worker', 'second'))).toEqual({
          delivery: 'prompt',
        })
        const secondPid = requireChildProcess(manager.getAgentInfo('worker', parentSessionId).childProcess).pid
        expect(secondPid).not.toBe(firstPid)
        yield* Effect.promise(() =>
          waitUntil(() => {
            const info = manager.getAgentInfo('worker', parentSessionId)
            return info.status === 'completed' && info.childProcess === undefined
          })
        )
        expect(pidAlive(secondPid)).toBe(false)
        expect(manager.readAgentResponse('worker', parentSessionId).finalResponse).toBe('response:second')
        expect(manager.getAgentInfo('worker', parentSessionId).followUpUsed).toBe(true)
        expect(manager.sendMessage(parentSessionId, 'worker', 'third')).rejects.toThrow('single follow-up')
        const sessionRecords = readFileSync(first.sessionFile, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        const starts = sessionRecords.filter((entry) => entry.type === 'started')
        expect(new Set(starts.map((entry) => entry.pid)).size).toBe(2)
        for (const start of starts) {
          expect(start.args).toContain('--no-context-files')
          expect(start.args).toContain('--no-skills')
          expect(start.args).toContain('--no-prompt-templates')
          expect(start.args).not.toContain('--no-extensions')
          expect(start.args).not.toContain('--extension')
          expect(start.args).not.toContain('--system-prompt')
          expect(start.args[start.args.indexOf('--append-system-prompt') + 1]).toContain('You are a fast codebase scout.')
          expect(start.args.slice(start.args.indexOf('--provider'), start.args.indexOf('--provider') + 4)).toEqual([
            '--provider',
            'openai',
            '--model',
            'gpt-5.6-luna',
          ])
          expect(start.args[start.args.indexOf('--thinking') + 1]).toBe('low')
          expect(start.args[start.args.indexOf('--tools') + 1]).toBe('read,bash,grep,find,ls,mcp,fffind,ffgrep,fff-multi-grep')
          expect(start.env).toMatchObject({
            PI_SUBAGENT_PROFILE: 'scout',
            PI_SUBAGENT_READONLY: '1',
          })
          expect(start.env.PI_SUBAGENT_OWNER_TOKEN).toBeString()
          expect(start.env).not.toHaveProperty('PI_SESSION_ID')
          expect(start.env).not.toHaveProperty('PI_SESSION_FILE')
          expect(start.env).not.toHaveProperty('PI_PROVIDER')
          expect(start.env).not.toHaveProperty('PI_MODEL')
          expect(start.env).not.toHaveProperty('PI_REASONING_LEVEL')
        }
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(join(getRunsDir(), parentScopeKey(parentSessionId)), {
          force: true,
          recursive: true,
        })
      }
    })
  )

  processTest('does not restart persisted agents whose profiles were removed', () =>
    Effect.gen(function* () {
      const parentSessionId = 'removed-profile'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      rmSync(scope, { force: true, recursive: true })
      const manager = createAgentManager()
      try {
        yield* Effect.promise(() => manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'first')))
        yield* Effect.promise(() =>
          waitUntil(() => {
            const info = manager.getAgentInfo('worker', parentSessionId)
            return info.status === 'completed' && info.childProcess === undefined
          })
        )
        const info = manager.getAgentInfo('worker', parentSessionId)
        writeFileSync(
          info.infoFile,
          prettyJsonText({ ...info, agentType: 'implementer', allowedTools: ['write'], isReadonly: false, profile: 'implementer' })
        )

        expect(manager.sendMessage(parentSessionId, 'worker', 'must not restart')).rejects.toThrow('unavailable profile: implementer')
        expect(manager.getAgentInfo('worker', parentSessionId).childProcess).toBeUndefined()
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )

  processTest('hibernates after failure while preserving the error', () =>
    Effect.gen(function* () {
      const parentSessionId = 'lifecycle-failure'
      rmSync(join(getRunsDir(), parentScopeKey(parentSessionId)), {
        force: true,
        recursive: true,
      })
      const manager = createAgentManager()
      try {
        yield* Effect.promise(() => manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'fail now')))
        const started = manager.getAgentInfo('worker', parentSessionId)
        const { pid } = requireChildProcess(started.childProcess)
        yield* Effect.promise(() =>
          waitUntil(() => {
            const info = manager.getAgentInfo('worker', parentSessionId)
            return info.status === 'failed' && info.childProcess === undefined
          })
        )
        const failed = manager.readAgentResponse('worker', parentSessionId)
        expect(failed.error).toBe('fake failure')
        expect(pidAlive(pid)).toBe(false)
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(join(getRunsDir(), parentScopeKey(parentSessionId)), {
          force: true,
          recursive: true,
        })
      }
    })
  )

  processTest('drains final output before handling immediate child exit', () =>
    Effect.gen(function* () {
      const parentSessionId = 'lifecycle-exit-after-output'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      rmSync(scope, { force: true, recursive: true })
      const manager = createAgentManager()
      try {
        yield* Effect.promise(() => manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'exit-after-output')))
        yield* Effect.promise(() =>
          waitUntil(() => {
            const info = manager.getAgentInfo('worker', parentSessionId)
            return info.status === 'completed' && info.childProcess === undefined
          })
        )
        const info = manager.getAgentInfo('worker', parentSessionId)
        expect(manager.readAgentResponse('worker', parentSessionId).finalResponse).toHaveLength(60 * 1024)
        expect(readFileSync(info.logFile, 'utf8')).toContain('final stderr before exit')
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )
  processTest('fails and terminates a child that closes stdin while remaining alive', () =>
    Effect.gen(function* () {
      const parentSessionId = 'lifecycle-closed-stdin'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      rmSync(scope, { force: true, recursive: true })
      const manager = createAgentManager()
      try {
        yield* Effect.promise(() => manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'close-stdin')))
        const sendError = yield* Effect.promise(() => manager.sendMessage(parentSessionId, 'worker', 'follow-up').then(() => undefined, asError))
        expect(sendError).toBeInstanceOf(Error)
        yield* Effect.promise(() =>
          waitUntil(() => {
            const info = manager.getAgentInfo('worker', parentSessionId)
            return info.status === 'failed' && info.childProcess === undefined
          })
        )
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )
  processTest('closes a spawned child when setup is interrupted before publication', () =>
    Effect.gen(function* () {
      const parentSessionId = 'lifecycle-interrupted-setup'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      rmSync(scope, { force: true, recursive: true })
      const spawned = yield* Deferred.make<void>()
      const blocked = yield* Deferred.make<void>()
      const manager = createAgentManager({
        afterProcessSpawn: () => Deferred.succeed(spawned, undefined).pipe(Effect.andThen(Deferred.await(blocked))),
      })
      try {
        const launch = yield* Effect.forkChild(manager.instance.spawnAgent(spawnParams(parentSessionId, 'worker', 'hold setup')))
        yield* Deferred.await(spawned)
        const info = manager.getAgentInfo('worker', parentSessionId)
        yield* Effect.promise(() =>
          waitUntil(() => existsSync(info.sessionFile) && readFileSync(info.sessionFile, 'utf8').includes('"type":"started"'))
        )
        const started = readFileSync(info.sessionFile, 'utf8')
          .trim()
          .split('\n')
          .map((line) => parseJsonText(line))
          .find((entry) => typeof entry === 'object' && entry !== null && 'type' in entry && entry.type === 'started')
        if (typeof started !== 'object' || started === null || !('pid' in started) || typeof started.pid !== 'number') {
          throw new Error('expected the fake child PID')
        }
        const { pid } = started
        yield* Fiber.interrupt(launch)
        yield* Effect.promise(() => waitUntil(() => !pidAlive(pid)))
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )

  processTest('accepts Darwin process ownership when ps cannot expose the token', () =>
    Effect.gen(function* () {
      if (process.platform !== 'darwin') {
        return
      }
      const parentSessionId = 'lifecycle-darwin'
      rmSync(join(getRunsDir(), parentScopeKey(parentSessionId)), {
        force: true,
        recursive: true,
      })
      const manager = createAgentManager()
      try {
        yield* Effect.promise(() => manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'hold darwin')))
        const running = manager.getAgentInfo('worker', parentSessionId)
        expect(running.childProcess?.pid).toBeNumber()
        expect(pidAlive(requireChildProcess(running.childProcess).pid)).toBe(true)
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(join(getRunsDir(), parentScopeKey(parentSessionId)), {
          force: true,
          recursive: true,
        })
      }
    })
  )

  processTest('interrupt terminates the child and clears runtime artifacts', () =>
    Effect.gen(function* () {
      const parentSessionId = 'lifecycle-interrupt'
      rmSync(join(getRunsDir(), parentScopeKey(parentSessionId)), {
        force: true,
        recursive: true,
      })
      const manager = createAgentManager()
      try {
        yield* Effect.promise(() => manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'hold interrupt')))
        const running = manager.getAgentInfo('worker', parentSessionId)
        const { pid } = requireChildProcess(running.childProcess)
        const interruptResult = yield* Effect.promise(() => manager.interruptAgent(parentSessionId, 'worker'))
        expect(interruptResult.previous_status).toBe('running')
        const interrupted = manager.getAgentInfo('worker', parentSessionId)
        expect(interrupted.status).toBe('interrupted')
        expect(interrupted.childProcess).toBeUndefined()
        expect(pidAlive(pid)).toBe(false)
        const socketDir = join(TEST_TEMP_DIR, 'pi-codex-subagents', userInfo().username, 'sockets')
        expect(existsSync(join(socketDir, `${running.id}.active.json`))).toBe(false)
        expect(existsSync(join(socketDir, `${running.id}.peek.json`))).toBe(false)
        if (process.platform !== 'win32') {
          expect(existsSync(getSocketPath(running.id))).toBe(false)
        }
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(join(getRunsDir(), parentScopeKey(parentSessionId)), {
          force: true,
          recursive: true,
        })
      }
    })
  )

  processTest('reconciles owned children without risking PID-reuse kills', () =>
    Effect.gen(function* () {
      const parentSessionId = 'lifecycle-reconcile'
      rmSync(join(getRunsDir(), parentScopeKey(parentSessionId)), {
        force: true,
        recursive: true,
      })
      const owner = createAgentManager()
      const reconcilers: ReturnType<typeof createAgentManager>[] = []
      try {
        yield* Effect.promise(() => owner.spawnAgent(spawnParams(parentSessionId, 'orphan', 'hold orphan')))
        const orphanPid = requireChildProcess(owner.getAgentInfo('orphan', parentSessionId).childProcess).pid
        const reconciler = createAgentManager()
        reconcilers.push(reconciler)
        yield* Effect.promise(() =>
          waitUntil(() => {
            const info = reconciler.getAgentInfo('orphan', parentSessionId)
            return info.status === 'interrupted' && info.childProcess === undefined
          })
        )
        yield* Effect.promise(() => waitUntil(() => !pidAlive(orphanPid)))
        expect(pidAlive(orphanPid)).toBe(false)

        yield* Effect.promise(() => owner.spawnAgent(spawnParams(parentSessionId, 'pid-reuse', 'hold identity')))
        const mismatched = owner.getAgentInfo('pid-reuse', parentSessionId)
        const mismatchedPid = requireChildProcess(mismatched.childProcess).pid
        requireChildProcess(mismatched.childProcess).processIdentity = 'not-the-owned-process'
        writeFileSync(mismatched.infoFile, prettyJsonText(mismatched))
        const mismatchReconciler = createAgentManager()
        reconcilers.push(mismatchReconciler)
        yield* Effect.promise(() =>
          waitUntil(() => {
            const info = mismatchReconciler.getAgentInfo('pid-reuse', parentSessionId)
            return info.status === 'interrupted' && info.childProcess === undefined
          })
        )
        expect(pidAlive(mismatchedPid)).toBe(true)
        yield* Effect.promise(() => owner.shutdown())
        expect(pidAlive(mismatchedPid)).toBe(false)
      } finally {
        yield* Effect.promise(() => Promise.all([owner.shutdown(), ...reconcilers.map((manager) => manager.shutdown())]))
        rmSync(join(getRunsDir(), parentScopeKey(parentSessionId)), {
          force: true,
          recursive: true,
        })
      }
    })
  )
})

describe('completion delivery', () => {
  processTest('publishes unclaimed settled and abnormal-exit completions', () =>
    Effect.gen(function* () {
      const parentSessionId = 'completion-callbacks'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      rmSync(scope, { force: true, recursive: true })
      const completions: CompletionEvent[] = []
      const manager = createAgentManager({
        onUnclaimedCompletion: (event: CompletionEvent) => completions.push(event),
      })
      try {
        const background = yield* Effect.promise(() => manager.spawnAgent(spawnParams(parentSessionId, 'settled', 'first')))
        expect(background.execution).toBe('background')
        yield* Effect.promise(() => waitUntil(() => completions.some((event) => event.agentName === '/settled')))
        expect(completions.filter((event) => event.agentName === '/settled')).toHaveLength(1)
        expect(completions.find((event) => event.agentName === '/settled')).toMatchObject({
          finalResponse: 'response:first',
          status: 'completed',
        })

        yield* Effect.promise(() => manager.spawnAgent(spawnParams(parentSessionId, 'crashed', 'crash now')))
        yield* Effect.promise(() => waitUntil(() => completions.some((event) => event.agentName === '/crashed')))
        expect(completions.filter((event) => event.agentName === '/crashed')).toHaveLength(1)
        const crashed = completions.find((event) => event.agentName === '/crashed')
        expect(crashed).toMatchObject({
          status: 'failed',
        })
        expect(crashed?.error).toContain('code=23')
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )

  processTest('claims immediate foreground completion before automatic delivery', () =>
    Effect.gen(function* () {
      const parentSessionId = 'foreground-immediate'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      rmSync(scope, { force: true, recursive: true })
      const completions: CompletionEvent[] = []
      const manager = createAgentManager({
        onUnclaimedCompletion: (event: CompletionEvent) => completions.push(event),
      })
      try {
        const result = yield* Effect.promise(() =>
          manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'immediate finish'), {
            waitForCompletion: true,
          })
        )
        expect(result).toMatchObject({
          completion: { agentName: '/worker', finalResponse: 'response:immediate finish', status: 'completed' },
          execution: 'foreground',
        })
        expect(completions).toEqual([])
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )

  processTest('prioritizes a foreground claim over an older wait for any agent', () =>
    Effect.gen(function* () {
      const parentSessionId = 'foreground-priority'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      rmSync(scope, { force: true, recursive: true })
      const manager = createAgentManager()
      const waitController = makeAbortController()
      let olderWaitSettled = false
      try {
        const olderWait = manager.waitAgent(parentSessionId, undefined, waitController.signal).finally(() => {
          olderWaitSettled = true
        })
        const foreground = yield* Effect.promise(() =>
          manager.spawnAgent(spawnParams(parentSessionId, 'foreground', 'immediate foreground'), {
            waitForCompletion: true,
          })
        )
        expect(foreground.completion).toMatchObject({ agentName: '/foreground', status: 'completed' })
        expect(olderWaitSettled).toBe(false)

        yield* Effect.promise(() => manager.spawnAgent(spawnParams(parentSessionId, 'background', 'immediate background')))
        const olderWaitResult = yield* Effect.promise(() => olderWait)
        expect(olderWaitResult.event).toMatchObject({ agentName: '/background', status: 'completed' })
      } finally {
        waitController.abort(new Error('test cleanup'))
        yield* Effect.promise(() => manager.shutdown())
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )

  processTest('returns foreground runtime failures without automatic delivery', () =>
    Effect.gen(function* () {
      const parentSessionId = 'foreground-failure'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      rmSync(scope, { force: true, recursive: true })
      const completions: CompletionEvent[] = []
      const manager = createAgentManager({
        onUnclaimedCompletion: (event: CompletionEvent) => completions.push(event),
      })
      try {
        const result = yield* Effect.promise(() =>
          manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'fail foreground'), {
            waitForCompletion: true,
          })
        )
        expect(result.completion).toMatchObject({ agentName: '/worker', error: 'fake failure', status: 'failed' })
        expect(completions).toEqual([])
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )

  processTest('releases a running foreground claim on abort without interrupting the child', () =>
    Effect.gen(function* () {
      const parentSessionId = 'foreground-abort-running'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      rmSync(scope, { force: true, recursive: true })
      const completions: CompletionEvent[] = []
      const controller = makeAbortController()
      const manager = createAgentManager({
        onUnclaimedCompletion: (event: CompletionEvent) => completions.push(event),
      })
      try {
        const spawn = manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'slow foreground'), {
          signal: controller.signal,
          waitForCompletion: true,
        })
        yield* Effect.promise(() => waitUntil(() => manager.listAgents(undefined, parentSessionId).some((agent) => agent.agent_status === 'running')))
        controller.abort(new Error('stop waiting'))
        expect(yield* Effect.promise(() => rejectionOf(spawn))).toHaveProperty('message', 'stop waiting')
        yield* Effect.promise(() => waitUntil(() => completions.some((event) => event.agentName === '/worker')))
        expect(completions.filter((event) => event.agentName === '/worker')).toHaveLength(1)
        expect(manager.getAgentInfo('worker', parentSessionId).status).toBe('completed')
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )

  processTest('rejects an already-aborted foreground spawn before creating artifacts', () =>
    Effect.gen(function* () {
      const parentSessionId = 'foreground-pre-abort'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      rmSync(scope, { force: true, recursive: true })
      const reason = new Error('already stopped')
      const signal = AbortSignal.abort(reason)
      const manager = createAgentManager()
      try {
        const spawn = manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'immediate ignored'), {
          signal,
          waitForCompletion: true,
        })
        const rejection = yield* Effect.promise(() => rejectionOf(spawn))
        expect(rejection.message).toBe('already stopped')
        expect(rejection.cause).toBe(reason)
        expect(() => manager.getAgentInfo('worker', parentSessionId)).toThrow('Agent not found')
        expect(existsSync(scope)).toBe(false)
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )

  processTest('releases a foreground claim when aborted during startup', () =>
    Effect.gen(function* () {
      const parentSessionId = 'foreground-abort-startup'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      rmSync(scope, { force: true, recursive: true })
      const completions: CompletionEvent[] = []
      const controller = makeAbortController()
      const manager = createAgentManager({
        childEnv: { PI_SUBAGENT_TEST_GET_STATE_DELAY_MS: '200' },
        onUnclaimedCompletion: (event: CompletionEvent) => completions.push(event),
      })
      try {
        const spawn = manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'immediate after startup'), {
          signal: controller.signal,
          waitForCompletion: true,
        })
        yield* Effect.promise(() =>
          waitUntil(() => manager.listAgents(undefined, parentSessionId).some((agent) => agent.agent_status === 'starting'))
        )
        yield* Effect.promise(() => waitUntil(() => manager.getAgentInfo('worker', parentSessionId).childProcess !== undefined))
        controller.abort(new Error('startup wait stopped'))
        expect(yield* Effect.promise(() => rejectionOf(spawn))).toHaveProperty('message', 'startup wait stopped')
        yield* Effect.promise(() => waitUntil(() => completions.some((event) => event.agentName === '/worker')))
        expect(completions.filter((event) => event.agentName === '/worker')).toHaveLength(1)
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )

  processTest('keeps the task lock until an aborted foreground launch settles', () =>
    Effect.gen(function* () {
      const parentSessionId = 'foreground-abort-before-ownership'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      rmSync(scope, { force: true, recursive: true })
      const controller = makeAbortController()
      const manager = createAgentManager()
      let reconciler: ReturnType<typeof createAgentManager> | undefined
      // A launch that never settles leaves the abort observable only through the foreground wait.
      asNarrowed<{ startLiveAgent: () => Effect.Effect<never> }, typeof manager.instance>(manager.instance).startLiveAgent = () => Effect.never
      try {
        const spawn = manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'unused'), {
          signal: controller.signal,
          waitForCompletion: true,
        })
        yield* Effect.promise(() =>
          waitUntil(() => manager.listAgents(undefined, parentSessionId).some((agent) => agent.agent_status === 'starting'))
        )
        controller.abort(new Error('stop before ownership'))
        expect(yield* Effect.promise(() => rejectionOf(spawn))).toHaveProperty('message', 'stop before ownership')

        const startedReconciler = createAgentManager()
        reconciler = startedReconciler
        yield* Effect.promise(() => startedReconciler.ready())
        expect(startedReconciler.getAgentInfo('worker', parentSessionId).status).toBe('starting')
      } finally {
        yield* Effect.promise(() => Promise.all([manager.shutdown(), ...(reconciler === undefined ? [] : [reconciler.shutdown()])]))
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )

  processTest('removes the foreground claim when launch rejects before an event', () =>
    Effect.gen(function* () {
      const parentSessionId = 'foreground-launch-rejection'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      rmSync(scope, { force: true, recursive: true })
      const completions: CompletionEvent[] = []
      const manager = createAgentManager({
        onUnclaimedCompletion: (event: CompletionEvent) => completions.push(event),
      })
      const internals = asNarrowed<
        {
          pushMailbox: (event: Record<string, unknown>) => void
          startLiveAgent: () => Effect.Effect<never, TestLaunchError>
          waiters: unknown[]
        },
        typeof manager.instance
      >(manager.instance)
      internals.startLiveAgent = () => Effect.fail(new TestLaunchError({ message: 'launch rejected' }))
      try {
        const spawn = manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'unused'), {
          waitForCompletion: true,
        })
        expect(yield* Effect.promise(() => rejectionOf(spawn))).toHaveProperty('message', 'launch rejected')
        expect(internals.waiters).toEqual([])

        internals.pushMailbox({
          agentName: '/worker',
          color: 'accent',
          createdAt: nowMs(),
          finalResponse: 'later result',
          id: 'later-event',
          isReadonly: true,
          parentSessionId,
          profile: 'scout',
          status: 'completed',
        })
        expect(completions).toEqual([expect.objectContaining({ agentName: '/worker', finalResponse: 'later result' })])
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )

  processTest('suppresses automatic delivery while wait tools claim completions', () =>
    Effect.gen(function* () {
      const parentSessionId = 'completion-waits'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      rmSync(scope, { force: true, recursive: true })
      const completions: CompletionEvent[] = []
      const manager = createAgentManager({
        onUnclaimedCompletion: (event: CompletionEvent) => completions.push(event),
      })
      try {
        yield* Effect.promise(() => manager.spawnAgent(spawnParams(parentSessionId, 'one', 'first')))
        const waited = yield* Effect.promise(() => manager.waitAgent(parentSessionId, ['one']))
        expect(waited.event).toMatchObject({ agentName: '/one', status: 'completed' })
        expect(completions).toEqual([])

        yield* Effect.promise(() => manager.spawnAgent(spawnParams(parentSessionId, 'two', 'second')))
        const all = yield* Effect.promise(() => manager.waitAllAgents(parentSessionId, ['two']))
        expect(all.responses).toEqual([expect.objectContaining({ agent_name: '/two', status: 'completed' })])
        expect(completions).toEqual([])
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )

  processTest('releases suppressed completions when wait_all_agents is cancelled', () =>
    Effect.gen(function* () {
      const parentSessionId = 'completion-wait-cancel'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      rmSync(scope, { force: true, recursive: true })
      const completions: CompletionEvent[] = []
      const manager = createAgentManager({
        onUnclaimedCompletion: (event: CompletionEvent) => completions.push(event),
      })
      const controller = makeAbortController()
      try {
        yield* Effect.promise(() => manager.spawnAgent(spawnParams(parentSessionId, 'slow', 'hold slow')))
        yield* Effect.promise(() => manager.spawnAgent(spawnParams(parentSessionId, 'fast', 'fast')))
        const wait = manager.waitAllAgents(parentSessionId, ['slow', 'fast'], controller.signal)
        yield* Effect.promise(() => waitUntil(() => manager.getAgentInfo('fast', parentSessionId).status === 'completed'))
        expect(completions).toEqual([])
        controller.abort(new Error('cancelled'))
        expect(wait).rejects.toThrow('cancelled')
        yield* Effect.promise(() => waitUntil(() => completions.some((event) => event.agentName === '/fast')))
        expect(completions.filter((event) => event.agentName === '/fast')).toHaveLength(1)
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )

  processTest('reports active and inactive lifecycle transitions', () =>
    Effect.gen(function* () {
      const parentSessionId = 'status-transitions'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      rmSync(scope, { force: true, recursive: true })
      const activity: boolean[] = []
      const manager = createAgentManager({
        onActivityChange: (event: ActivityEvent) => {
          if (event.parentSessionId === parentSessionId) {
            activity.push(event.active)
          }
        },
      })
      try {
        yield* Effect.promise(() => manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'first')))
        yield* Effect.promise(() => waitUntil(() => manager.getAgentInfo('worker', parentSessionId).status === 'completed'))
        expect(activity).toContain(true)
        expect(activity.at(-1)).toBe(false)

        const settled = manager.getAgentInfo('worker', parentSessionId)
        const rejectedAt = activity.length
        expect(manager.sendMessage(parentSessionId, 'worker', 'reject restart')).rejects.toThrow('fake prompt rejection')
        expect(manager.getAgentInfo('worker', parentSessionId)).toMatchObject({
          completedAt: settled.completedAt,
          finalResponse: settled.finalResponse,
          status: 'completed',
        })
        expect(manager.getAgentInfo('worker', parentSessionId).childProcess).toBeUndefined()
        expect(activity.slice(rejectedAt)).toContain(true)
        expect(activity.at(-1)).toBe(false)

        const restartAt = activity.length
        yield* Effect.promise(() => manager.sendMessage(parentSessionId, 'worker', 'hold restart'))
        expect(activity.slice(restartAt)).toContain(true)
        yield* Effect.promise(() => manager.interruptAgent(parentSessionId, 'worker'))
        expect(activity.at(-1)).toBe(false)
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )

  processTest('reports inactivity once per idle spell without stopping the agent', () =>
    Effect.gen(function* () {
      const parentSessionId = 'inactivity-monitor'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      rmSync(scope, { force: true, recursive: true })
      const inactivity: InactivityEvent[] = []
      const manager = createAgentManager({
        inactivityTimeoutMs: 50,
        onInactivity: (event: InactivityEvent) => inactivity.push(event),
      })
      try {
        yield* Effect.promise(() => manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'hold inactivity')))
        yield* Effect.promise(() => waitUntil(() => inactivity.length === 1))
        expect(inactivity[0]).toMatchObject({ agentName: '/worker', parentSessionId })
        expect(inactivity[0].inactiveForMs).toBeGreaterThanOrEqual(50)
        expect(manager.getAgentInfo('worker', parentSessionId).status).toBe('running')
        expect(yield* Effect.promise(() => manager.sendMessage(parentSessionId, 'worker', 'new direction'))).toEqual({ delivery: 'steer' })
        expect(manager.listAgents(undefined, parentSessionId)[0].last_task_message).toBe('new direction')
        yield* Effect.promise(() => waitUntil(() => inactivity.length === 2))
        yield* Effect.promise(() => sleep(80))
        expect(inactivity).toHaveLength(2)
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )

  processTest('routes one completion to only the first of two waiting callers', () =>
    Effect.gen(function* () {
      const parentSessionId = 'two-waiters'
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      rmSync(scope, { force: true, recursive: true })
      const manager = createAgentManager()
      const secondController = makeAbortController()
      try {
        yield* Effect.promise(() => manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'first')))
        let secondSettled = false
        const first = manager.waitAgent(parentSessionId, ['worker'])
        const second = manager.waitAgent(parentSessionId, ['worker'], secondController.signal).finally(() => {
          secondSettled = true
        })
        const firstResult = yield* Effect.promise(() => first)
        expect(firstResult.event).toMatchObject({ agentName: '/worker', status: 'completed' })
        yield* Effect.promise(() => sleep(20))
        expect(secondSettled).toBe(false)
        secondController.abort(new Error('no second completion is coming'))
        expect(second).rejects.toThrow('no second completion is coming')
        yield* Effect.promise(() => waitUntil(() => secondSettled))
      } finally {
        yield* Effect.promise(() => manager.shutdown())
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )
})

describe('extension completion delivery and status activity', () => {
  processTest('registers commands, publishes status activity, and delivers bounded notifications', () =>
    Effect.gen(function* () {
      const handlers = new Map<string, FakeHandler[]>()
      const tools = new Map<string, FakeToolDefinition>()
      interface FakeCommand {
        handler: (args: string | undefined, ctx: unknown) => Promise<void>
      }
      type FakeTerminalInputHandler = (data: string) => { consume?: boolean; data?: string } | undefined

      const commands = new Map<string, FakeCommand>()
      const renderers = new Map<string, FakeRenderer>()
      const sentMessages: { message: FakeMessage; options: unknown }[] = []
      let terminalInputHandler: FakeTerminalInputHandler | undefined
      let mainIdle = true
      const requireTool = (name: string): FakeToolDefinition => {
        const tool = tools.get(name)
        if (tool === undefined) {
          throw new Error(`tool ${name} was not registered`)
        }
        return tool
      }
      const requireRenderer = (name: string): FakeRenderer => {
        const renderer = renderers.get(name)
        if (renderer === undefined) {
          throw new Error(`renderer ${name} was not registered`)
        }
        return renderer
      }
      const pi = {
        getActiveTools() {
          return ['read', 'bash']
        },
        getThinkingLevel() {
          return 'high'
        },
        on(name: string, handler: FakeHandler) {
          const entries = handlers.get(name) ?? []
          entries.push(handler)
          handlers.set(name, entries)
        },
        registerCommand(name: string, command: FakeCommand) {
          commands.set(name, command)
        },
        registerMessageRenderer(name: string, renderer: FakeRenderer) {
          renderers.set(name, renderer)
        },
        registerTool(tool: FakeToolDefinition) {
          tools.set(tool.name, tool)
        },
        sendMessage(message: FakeMessage, options: unknown) {
          sentMessages.push({ message, options })
        },
      }
      const parentSessionId = 'index-integration-parent'
      const ctx = {
        cwd: TEST_AGENT_DIR,
        isIdle: () => mainIdle,
        mode: 'tui',
        model: { id: 'fake', provider: 'test' },
        modelRegistry: { getAvailable: () => AVAILABLE_MODELS },
        sessionManager: {
          getSessionFile: () => join(TEST_AGENT_DIR, 'parent.jsonl'),
          getSessionId: () => parentSessionId,
        },
        ui: {
          notify() {
            /* Interrupt failures are not expected in this integration test. */
          },
          onTerminalInput(handler: FakeTerminalInputHandler) {
            terminalInputHandler = handler
            return () => {
              terminalInputHandler = undefined
            }
          },
        },
      }
      const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
      rmSync(scope, { force: true, recursive: true })
      const { register: subagentExtension } = yield* Effect.promise(() => import('@/features/sub_agents/index.js'))
      subagentExtension(asExtensionApi(pi), runtime, { inactivityTimeoutMs: 5000, piCommand: { command: FAKE_RPC_CHILD } })
      const emit = (name: string, event: unknown = {}): Promise<void> =>
        promiseFromEffect(
          Effect.forEach(handlers.get(name) ?? [], (handler) => Effect.promise(() => Promise.resolve(handler(event, ctx))), {
            concurrency: 1,
            discard: true,
          })
        )

      try {
        yield* Effect.promise(() => emit('session_start', { reason: 'startup' }))
        expect(commands.has('agents')).toBe(true)
        expect(commands.has('subagent')).toBe(true)
        expect(commands.has('subagents')).toBe(true)
        expect(renderers.has('pi-codex-subagent-completion')).toBe(true)
        const spawnTool = requireTool('spawn_agent')
        expect(spawnTool.parameters.required).toContain('agent_type')
        expect(spawnTool.parameters.required).not.toContain('run_in_background')
        expect(spawnTool.parameters.properties.skills).toBeUndefined()
        expect(spawnTool.parameters.properties.agent_type.enum).toEqual(['scout', 'librarian', 'reviewer'])
        expect(spawnTool.parameters.properties.run_in_background.type).toBe('boolean')
        expect(spawnTool.description).toContain('Foreground is the default')
        expect(requireTool('wait_agent').description).toContain('background')
        expect(requireTool('wait_all_agents').description).toContain('background')

        const beforeAgentStart = handlers.get('before_agent_start')?.[0]
        if (beforeAgentStart === undefined) {
          throw new Error('before_agent_start was not registered')
        }
        yield* withProcessEnv('PI_SUBAGENT_OWNER_TOKEN', undefined, () =>
          Effect.sync(() => {
            const parentPrompt = asResult<{ systemPrompt: string }>(beforeAgentStart({ systemPrompt: 'base' }, ctx))
            expect(parentPrompt.systemPrompt).toContain('Foreground is the default')
            expect(parentPrompt.systemPrompt).toContain('Never repeat a pending child')
          })
        )
        yield* withProcessEnv('PI_SUBAGENT_OWNER_TOKEN', 'child', () =>
          Effect.sync(() => {
            expect(beforeAgentStart({ systemPrompt: 'base' }, ctx)).toBeUndefined()
          })
        )

        const backgroundResult = asResult<FakeToolResult>(
          yield* Effect.promise(() =>
            spawnTool.execute(
              'spawn-1',
              {
                agent_type: 'scout',
                message: 'slow finish',
                run_in_background: true,
                task_name: 'x'.repeat(200),
              },
              undefined,
              undefined,
              ctx
            )
          )
        )
        expect(backgroundResult.content[0].text).toContain('in background')
        expect(backgroundResult.details.execution).toBe('background')

        const colorCalls: string[] = []
        const theme = {
          bold: (text: string) => text,
          fg: (color: string, text: string) => {
            colorCalls.push(color)
            return text
          },
        }
        const foregroundCall = spawnTool.renderCall({ agent_type: 'librarian', task_name: 'research' }, theme)
        expect(foregroundCall.render(100).join('\n')).toContain('[foreground]')
        const backgroundCall = spawnTool.renderCall({ agent_type: 'librarian', run_in_background: true, task_name: 'research' }, theme)
        expect(backgroundCall.render(100).join('\n')).toContain('[background]')
        expect(colorCalls).toContain('mdLink')
        colorCalls.length = 0
        spawnTool.renderResult(
          {
            content: [{ text: 'done', type: 'text' }],
            details: {
              color: 'mdLink',
              completion: { agentName: '/research', color: 'mdLink', profile: 'librarian', status: 'completed' },
              execution: 'foreground',
              profile: 'librarian',
              task_name: '/research',
            },
          },
          {},
          theme
        )
        expect(colorCalls).toContain('mdLink')
        expect(colorCalls).toContain('success')
        colorCalls.length = 0
        spawnTool.renderResult(
          {
            content: [{ text: 'failed', type: 'text' }],
            details: {
              color: 'mdLink',
              completion: { agentName: '/research', color: 'mdLink', error: 'failure', profile: 'librarian', status: 'failed' },
              execution: 'foreground',
              profile: 'librarian',
              task_name: '/research',
            },
          },
          {},
          theme
        )
        expect(colorCalls).toContain('mdLink')
        expect(colorCalls).toContain('error')
        colorCalls.length = 0
        requireRenderer('pi-codex-subagent-completion')(
          {
            details: {
              agent_name: '/research',
              color: 'mdLink',
              profile: 'librarian',
              status: 'completed',
            },
          },
          { expanded: false },
          theme
        )
        expect(colorCalls).toContain('mdLink')
        expect(colorCalls).toContain('success')

        yield* Effect.promise(() => waitUntil(() => sentMessages.length === 1))
        expect(sentMessages[0].options).toEqual({ deliverAs: 'steer', triggerTurn: true })
        expect(sentMessages[0].message.content).toContain('response:slow finish')

        const foregroundNotifications = sentMessages.length
        let foregroundSettled = false
        const foregroundPromise = spawnTool
          .execute('spawn-foreground', { agent_type: 'scout', message: 'slow foreground', task_name: 'foreground' }, undefined, undefined, ctx)
          .finally(() => {
            foregroundSettled = true
          })
        yield* Effect.promise(() => waitUntil(() => runningAgents.list().some((agent) => agent.name === '/foreground')))
        expect(foregroundSettled).toBe(false)
        const foregroundResult = asResult<FakeToolResult>(yield* Effect.promise(() => foregroundPromise))
        expect(foregroundResult.content[0].text).toContain('response:slow foreground')
        expect(foregroundResult.details.execution).toBe('foreground')
        expect(sentMessages).toHaveLength(foregroundNotifications)

        const largeForeground = asResult<FakeToolResult>(
          yield* Effect.promise(() =>
            spawnTool.execute(
              'spawn-large-foreground',
              { agent_type: 'scout', message: 'large foreground', task_name: 'large-foreground' },
              undefined,
              undefined,
              ctx
            )
          )
        )
        expect(Buffer.byteLength(largeForeground.content[0].text, 'utf8')).toBeLessThanOrEqual(50 * 1024)
        expect(largeForeground.content[0].text.split('\n').length).toBeLessThanOrEqual(2000)
        expect(largeForeground.content[0].text).toContain('Output truncated')
        expect(largeForeground.details.fullOutputPath).toBeString()
        expect(existsSync(String(largeForeground.details.fullOutputPath))).toBe(true)

        const abortController = makeAbortController()
        const abortNotifications = sentMessages.length
        const abortedForeground = spawnTool.execute(
          'spawn-aborted-foreground',
          { agent_type: 'scout', message: 'slow aborted foreground', task_name: 'aborted-foreground' },
          abortController.signal,
          undefined,
          ctx
        )
        yield* Effect.promise(() => waitUntil(() => runningAgents.list().some((agent) => agent.name === '/aborted-foreground')))
        abortController.abort('tool wait stopped')
        const toolAbortReason = yield* Effect.promise(() =>
          abortedForeground.then(
            () => 'unexpected success',
            (error: unknown) => error
          )
        )
        expect(toolAbortReason).toBe('tool wait stopped')
        yield* Effect.promise(() => waitUntil(() => sentMessages.some(({ message }) => message.content.includes('/aborted-foreground'))))
        expect(sentMessages.filter(({ message }) => message.content.includes('/aborted-foreground'))).toHaveLength(1)
        expect(sentMessages.length).toBe(abortNotifications + 1)

        const largeBackgroundNotifications = sentMessages.length
        yield* Effect.promise(() =>
          requireTool('spawn_agent').execute(
            'spawn-2',
            {
              agent_type: 'scout',
              message: 'large response',
              run_in_background: true,
              task_name: 'large-output',
            },
            undefined,
            undefined,
            ctx
          )
        )
        yield* Effect.promise(() => waitUntil(() => sentMessages.length === largeBackgroundNotifications + 1))
        const large = sentMessages.at(-1)?.message
        if (large === undefined) {
          throw new Error('large background completion was not delivered')
        }
        expect(Buffer.byteLength(large.content, 'utf8')).toBeLessThanOrEqual(50 * 1024)
        expect(large.content).toContain('Output truncated')
        expect(large.details.fullOutputPath).toBeString()
        expect(existsSync(large.details.fullOutputPath)).toBe(true)

        yield* Effect.promise(() =>
          requireTool('spawn_agent').execute(
            'spawn-3',
            { agent_type: 'scout', message: 'hold scout', run_in_background: true, task_name: 'hold-scout' },
            undefined,
            undefined,
            ctx
          )
        )
        yield* Effect.promise(() =>
          requireTool('spawn_agent').execute(
            'spawn-4',
            { agent_type: 'librarian', message: 'hold library', run_in_background: true, task_name: 'hold-library' },
            undefined,
            undefined,
            ctx
          )
        )
        expect(runningAgents.list().map((agent) => agent.name)).toEqual(['/hold-scout', '/hold-library'])

        expect(terminalInputHandler?.('\x1b[27;1:3u')).toBeUndefined()
        mainIdle = false
        expect(terminalInputHandler?.('\x1b')).toBeUndefined()
        expect(runningAgents.list().map((agent) => agent.name)).toEqual(['/hold-scout', '/hold-library'])

        mainIdle = true
        expect(terminalInputHandler?.('\x1b')).toEqual({ consume: true })
        yield* Effect.promise(() => waitUntil(() => runningAgents.list().length === 0))
      } finally {
        yield* Effect.promise(() => emit('session_shutdown', { reason: 'quit' }))
        rmSync(scope, { force: true, recursive: true })
      }
    })
  )
})

interface PeekOverlayInternals {
  cachedLines: string[] | undefined
  cachedWidth: number | undefined
  scrollOffset: number
  theme: Theme
}

describe('subagent peek overlay', () => {
  const createOverlay = (
    columns = 80,
    rows = 20,
    done: (navigation?: 'previous' | 'next') => void = () => {
      /* No-op by default; navigation tests pass a callback. */
    },
    onEscape: () => void = () => {
      /* No-op by default; Escape behavior tests pass a callback. */
    }
  ) => {
    const now = nowMs()
    const info = {
      canonicalName: '/a-very-long-agent-name',
      color: 'warning' as const,
      createdAt: now,
      cwd: TEST_AGENT_DIR,
      followUpUsed: false,
      id: '44444444-4444-4444-8444-444444444444',
      infoFile: join(TEST_AGENT_DIR, 'nonexistent-peek.info.json'),
      isReadonly: true,
      logFile: join(TEST_AGENT_DIR, 'nonexistent-peek.log'),
      messageCount: 0,
      model: 'test:a-very-long-model-name',
      modelId: 'a-very-long-model-name',
      parentSessionId: 'peek-parent',
      profile: 'reviewer',
      provider: 'test',
      sessionFile: join(TEST_AGENT_DIR, 'nonexistent-peek-session.jsonl'),
      status: 'completed' as const,
      taskName: 'a-very-long-agent-name',
      updatedAt: now,
    }
    const tui = asTui({
      requestRender() {
        /* No-op stub; tests only assert on rendered output. */
      },
      terminal: { columns, rows },
    })
    const theme = asTheme({
      fg: (_color: string, text: string) => text,
    })
    return new SubagentPeekOverlay({
      done,
      info,
      onEscape,
      theme,
      tui,
    })
  }

  it.effect('initially follows a long transcript at the end', () =>
    Effect.sync(() => {
      const overlay = createOverlay()
      try {
        const internals = asNarrowed<PeekOverlayInternals, typeof overlay>(overlay)
        internals.cachedLines = Array.from({ length: 30 }, (_value, index) => `line-${index}`)
        internals.cachedWidth = 38

        const rendered = overlay.render(40)
        expect(rendered).toHaveLength(20)
        expect(internals.scrollOffset).toBe(14)
        expect(rendered[1]).toContain('line-14')
        expect(rendered[16]).toContain('line-29')
      } finally {
        overlay.dispose()
      }
    })
  )

  it.effect('renders profile identity separately from semantic status color', () =>
    Effect.sync(() => {
      const overlay = createOverlay()
      try {
        const colors: string[] = []
        asNarrowed<PeekOverlayInternals, typeof overlay>(overlay).theme = asTheme({
          fg(color: string, text: string) {
            colors.push(color)
            return text
          },
        })
        overlay.render(40)
        expect(colors).toContain('warning')
        expect(colors).toContain('success')
      } finally {
        overlay.dispose()
      }
    })
  )

  it.effect('keeps every frame line within a narrow render width', () =>
    Effect.sync(() => {
      const overlay = createOverlay(12, 14)
      try {
        const internals = asNarrowed<PeekOverlayInternals, typeof overlay>(overlay)
        internals.cachedLines = ['content that is much wider than the overlay']
        internals.cachedWidth = 10

        const rendered = overlay.render(12)
        expect(rendered.length).toBeGreaterThan(0)
        expect(rendered.every((line: string) => visibleWidth(line) <= 12)).toBe(true)
      } finally {
        overlay.dispose()
      }
    })
  )

  it.effect('escape cancels the running parent without closing the overlay while q closes it', () =>
    Effect.sync(() => {
      const navigation: ('previous' | 'next' | undefined)[] = []
      let escapes = 0
      const overlay = createOverlay(
        80,
        20,
        (result) => navigation.push(result),
        () => escapes++
      )
      overlay.handleInput('\x1b')
      expect(escapes).toBe(1)
      expect(navigation).toEqual([])
      overlay.handleInput('q')
      expect(navigation).toEqual([undefined])
    })
  )
})

describe('completion mailbox', () => {
  it.effect('waits until explicitly cancelled when no completion exists', () =>
    Effect.gen(function* () {
      const manager = createAgentManager()
      const controller = makeAbortController()
      const pending = manager.waitAgent('empty-parent', undefined, controller.signal)
      yield* Effect.yieldNow
      controller.abort(new Error('cancelled'))
      expect(yield* Effect.promise(() => rejectionOf(pending))).toHaveProperty('message', 'cancelled')
      yield* Effect.promise(() => manager.shutdown())
    })
  )

  it.effect('consumes one matching completion without dropping siblings', () =>
    Effect.sync(() => {
      const events = [
        { agentName: '/one', createdAt: 1, id: '1', parentSessionId: 'parent', status: 'completed' },
        { agentName: '/two', createdAt: 2, id: '2', parentSessionId: 'parent', status: 'completed' },
        { agentName: '/one', createdAt: 3, id: '3', parentSessionId: 'other', status: 'completed' },
      ]
      expect(consumeFirstMatchingMailboxEvent(events, 'parent')?.agentName).toBe('/one')
      expect(events.map((event) => event.id)).toEqual(['2', '3'])
      expect(consumeFirstMatchingMailboxEvent(events, 'parent', new Set(['/two']))?.agentName).toBe('/two')
      expect(events.map((event) => event.id)).toEqual(['3'])
    })
  )
})
