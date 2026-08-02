import { describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join } from 'node:path'

import { type ExtensionAPI, type Theme } from '@earendil-works/pi-coding-agent'
import { visibleWidth, type TUI } from '@earendil-works/pi-tui'

const TEST_AGENT_DIR = '/tmp/pi-codex-subagents-tests'
const FAKE_RPC_CHILD = join(import.meta.dir, 'fixtures', 'fake_rpc_child.js')
const TEST_TEMP_DIR = join(TEST_AGENT_DIR, 'temp')
process.env.PI_SUBAGENT_TEMP_DIR = TEST_TEMP_DIR

const codingAgent = await import('@earendil-works/pi-coding-agent')
mock.module('@earendil-works/pi-coding-agent', () => ({
  ...codingAgent,
  CONFIG_DIR_NAME: '.pi',
  getAgentDir: () => TEST_AGENT_DIR,
}))

const { AgentManager, RpcJsonlDecoder, consumeFirstMatchingMailboxEvent, getAgent, getRunsDir, getSocketPath, parentScopeKey, taskStorageKey } =
  await import('../core.js')
const { SubagentPeekOverlay } = await import('../peek.js')

const requireChildProcess = <ChildProcess>(childProcess: ChildProcess | undefined): ChildProcess => {
  if (!childProcess) {
    throw new Error('expected the agent to own a child process')
  }
  return childProcess
}

interface CompletionEvent {
  agentName: string
  [field: string]: unknown
}

interface ActivityEvent {
  active: boolean
  parentSessionId: string
}

type FakeHandler = (event: unknown, ctx: unknown) => unknown
interface FakeTheme {
  bold: (text: string) => string
  fg: (color: string, text: string) => string
}
type FakeRenderer = (message: unknown, options: unknown, theme: FakeTheme) => unknown
type FakeWidget = (state: unknown, theme: FakeTheme) => { render: (width: number) => string[] }

interface FakeToolDefinition {
  name: string
  parameters: {
    required: string[]
    properties: Record<string, { enum?: string[] }>
  }
  execute: (...args: unknown[]) => Promise<unknown>
  renderCall: (...args: unknown[]) => unknown
}

interface FakeMessage {
  content: string
  details: Record<string, string>
}

const createAgentManager = (options: Record<string, unknown> = {}) =>
  new AgentManager({
    piCommand: { command: FAKE_RPC_CHILD },
    ...options,
  })

const processTest = (name: string, run: () => void | Promise<void>): void => {
  test(name, run, 15_000)
}

describe('RPC framing', () => {
  test('splits only on LF and preserves Unicode line separators', () => {
    const decoder = new RpcJsonlDecoder()
    const payload = JSON.stringify({ text: 'before\u2028after' })
    expect(decoder.push(Buffer.from(payload.slice(0, 7)))).toEqual([])
    expect(decoder.push(Buffer.from(`${payload.slice(7)}\n`))).toEqual([payload])
    expect(decoder.end()).toEqual([])
  })
})

describe('session-scoped identities', () => {
  test('separates parent sessions and formerly colliding task names', () => {
    expect(parentScopeKey('parent-a')).not.toBe(parentScopeKey('parent-b'))
    expect(taskStorageKey('review/api')).not.toBe(taskStorageKey('review__api'))
  })
})

describe('run storage', () => {
  const packageDir = join(TEST_AGENT_DIR, 'pi-codex-subagents')
  const configFile = join(packageDir, 'config.json')
  const fixtureDir = join(TEST_AGENT_DIR, 'retention-fixture')

  test('uses persistent package storage by default', () => {
    rmSync(configFile, { force: true })
    expect(getRunsDir()).toBe(join(packageDir, 'runs'))
  })

  test('keeps legacy temporary runs discoverable', () => {
    rmSync(configFile, { force: true })
    const parentSessionId = 'legacy-parent'
    const id = '11111111-1111-4111-8111-111111111111'
    const legacyRoot = join(TEST_TEMP_DIR, 'pi-codex-subagents', userInfo().username, 'runs')
    const legacyScope = join(legacyRoot, parentScopeKey(parentSessionId))
    mkdirSync(legacyScope, { recursive: true })
    writeFileSync(
      join(legacyScope, `${id}.info.json`),
      JSON.stringify({
        createdAt: Date.now(),
        finalResponse: 'legacy response',
        id,
        status: 'closed',
        taskName: 'legacy',
        updatedAt: Date.now(),
      })
    )

    expect(getAgent('legacy', parentSessionId)).toMatchObject({
      finalResponse: 'legacy response',
      id,
      status: 'completed',
    })
    rmSync(legacyScope, { force: true, recursive: true })
  })

  test('keeps agent lists in creation order when activity changes', async () => {
    rmSync(configFile, { force: true })
    const parentSessionId = 'creation-order'
    const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
    const now = Date.now()
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
        JSON.stringify({
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
      await manager.shutdown()
      rmSync(scope, { force: true, recursive: true })
    }
  })

  test('removes expired runs and outputs using configurable retention', () => {
    mkdirSync(packageDir, { recursive: true })
    rmSync(fixtureDir, { force: true, recursive: true })
    writeFileSync(configFile, JSON.stringify({ retentionDays: 3, storageDir: fixtureDir }))

    const now = Date.now()
    const oldTime = new Date(now - 4 * 24 * 60 * 60 * 1000)
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
          JSON.stringify({
            createdAt: oldTime.getTime(),
            id,
            lastActivity: oldTime.getTime(),
            updatedAt: oldTime.getTime(),
          })
        )
        utimesSync(file, oldTime, oldTime)
      }
      writeFileSync(activeMarker, JSON.stringify({ pid: process.pid, startedAt: now, token: 'test' }))
      writeFileSync(unrelatedAgentFile, 'keep')
      writeFileSync(staleLock, '')
      writeFileSync(liveOwnerLock, JSON.stringify({ pid: process.pid }))
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

      writeFileSync(configFile, JSON.stringify({ retentionDays: 0, storageDir: fixtureDir }))
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
})

const waitUntil = async (predicate: () => boolean, timeoutMs = 12_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for condition.')
}

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
  agent_type: 'implementer' as const,
  availableModels: AVAILABLE_MODELS,
  cwd: TEST_AGENT_DIR,
  message,
  parentModel: { id: 'gpt-5.6-sol', provider: 'openai' },
  parentSessionId,
  task_name,
})

describe('child process lifecycle', () => {
  processTest('resolves profiles before creating task artifacts', async () => {
    const parentSessionId = 'unavailable-profile-model'
    const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
    rmSync(scope, { force: true, recursive: true })
    const manager = createAgentManager()
    try {
      await expect(
        manager.spawnAgent({
          ...spawnParams(parentSessionId, 'worker', 'must not start'),
          availableModels: AVAILABLE_MODELS.filter((model) => model.id !== 'claude-sonnet-5'),
        })
      ).rejects.toThrow('not authenticated or available')
      expect(existsSync(scope)).toBe(false)
    } finally {
      await manager.shutdown()
    }
  })

  processTest('passes read-only profile metadata without changing the task message', async () => {
    const parentSessionId = 'readonly-profile-metadata'
    const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
    rmSync(scope, { force: true, recursive: true })
    const manager = createAgentManager()
    try {
      await manager.spawnAgent({
        ...spawnParams(parentSessionId, 'worker', 'inspect exactly this'),
        agent_type: 'scout',
      })
      const info = manager.getAgentInfo('worker', parentSessionId)
      expect(info).toMatchObject({
        color: 'accent',
        isReadonly: true,
        modelId: 'gpt-5.6-luna',
        profile: 'scout',
        provider: 'openai',
      })
      await waitUntil(() => manager.getAgentInfo('worker', parentSessionId).status === 'completed')
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
      await manager.shutdown()
      rmSync(scope, { force: true, recursive: true })
    }
  })

  processTest('reclaims a fresh lock whose PID identity no longer owns it, even with retention disabled', async () => {
    const parentSessionId = 'fresh-dead-lock'
    const packageDir = join(TEST_AGENT_DIR, 'pi-codex-subagents')
    const configFile = join(packageDir, 'config.json')
    const scope = join(packageDir, 'runs', parentScopeKey(parentSessionId))
    const lockFile = join(scope, `.task-${taskStorageKey('worker')}.lock`)
    mkdirSync(scope, { recursive: true })
    writeFileSync(configFile, JSON.stringify({ retentionDays: 0 }))
    writeFileSync(
      lockFile,
      JSON.stringify({
        createdAt: Date.now(),
        pid: process.pid,
        processIdentity: 'identity-from-an-exited-process',
      })
    )
    const manager = createAgentManager()
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'hold lock recovery'))
      expect(manager.getAgentInfo('worker', parentSessionId).status).toBe('running')
      expect(existsSync(lockFile)).toBe(false)
      await manager.interruptAgent(parentSessionId, 'worker')
    } finally {
      await manager.shutdown()
      rmSync(scope, { force: true, recursive: true })
      rmSync(configFile, { force: true })
    }
  })

  processTest('does not unlink a live lock that replaces the inspected dead instance', async () => {
    const parentSessionId = 'lock-replacement-race'
    const packageDir = join(TEST_AGENT_DIR, 'pi-codex-subagents')
    const configFile = join(packageDir, 'config.json')
    const scope = join(packageDir, 'runs', parentScopeKey(parentSessionId))
    const lockFile = join(scope, `.task-${taskStorageKey('worker')}.lock`)
    const displacedLock = `${lockFile}.displaced`
    mkdirSync(scope, { recursive: true })
    writeFileSync(configFile, JSON.stringify({ retentionDays: 0 }))
    writeFileSync(
      lockFile,
      JSON.stringify({
        createdAt: Date.now(),
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
            createdAt: Date.now(),
            pid: process.pid,
            token: 'live-replacement',
          })
        )
      },
    })
    try {
      await expect(manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'must not start'))).rejects.toThrow('already being created')
      expect(replaced).toBe(true)
      expect(JSON.parse(readFileSync(lockFile, 'utf8'))).toMatchObject({
        pid: process.pid,
        token: 'live-replacement',
      })
    } finally {
      await manager.shutdown()
      rmSync(scope, { force: true, recursive: true })
      rmSync(configFile, { force: true })
    }
  })

  processTest('reconciles a persisted starting record left before child ownership', async () => {
    const parentSessionId = 'starting-without-owner'
    const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
    const id = '33333333-3333-4333-8333-333333333333'
    const infoFile = join(scope, `${id}.info.json`)
    const now = Date.now()
    rmSync(scope, { force: true, recursive: true })
    mkdirSync(scope, { recursive: true })
    writeFileSync(
      infoFile,
      JSON.stringify({
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
      await manager.ready()
      const reconciled = manager.getAgentInfo('worker', parentSessionId)
      expect(reconciled.status).toBe('interrupted')
      expect(reconciled.childProcess).toBeUndefined()
    } finally {
      await manager.shutdown()
      rmSync(scope, { force: true, recursive: true })
    }
  })

  processTest('persists provisional ownership before the startup RPC round trip completes', async () => {
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
      await waitUntil(() => {
        try {
          return Boolean(manager.getAgentInfo('worker', parentSessionId).childProcess)
        } catch {
          return false
        }
      })
      const starting = manager.getAgentInfo('worker', parentSessionId)
      expect(starting.status).toBe('starting')
      expect(starting.childProcess?.pid).toBeNumber()
      expect(pidAlive(requireChildProcess(starting.childProcess).pid)).toBe(true)
      expect(spawnSettled).toBe(false)
      await spawning
      await manager.interruptAgent(parentSessionId, 'worker')
    } finally {
      await manager.shutdown()
      rmSync(scope, { force: true, recursive: true })
    }
  })

  processTest('hibernates after settle and lazily restarts the persisted session', async () => {
    rmSync(join(TEST_AGENT_DIR, 'pi-codex-subagents', 'config.json'), { force: true })
    const parentSessionId = 'lifecycle-settle'
    rmSync(join(getRunsDir(), parentScopeKey(parentSessionId)), {
      force: true,
      recursive: true,
    })
    const manager = createAgentManager()
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'first'))
      const first = manager.getAgentInfo('worker', parentSessionId)
      const firstPid = requireChildProcess(first.childProcess).pid
      await waitUntil(() => {
        const info = manager.getAgentInfo('worker', parentSessionId)
        return info.status === 'completed' && !info.childProcess
      })
      expect(pidAlive(firstPid)).toBe(false)
      expect(manager.readAgentResponse('worker', parentSessionId).finalResponse).toBe('response:first')

      expect(await manager.sendMessage(parentSessionId, 'worker', 'second')).toEqual({
        delivery: 'prompt',
      })
      const secondPid = requireChildProcess(manager.getAgentInfo('worker', parentSessionId).childProcess).pid
      expect(secondPid).not.toBe(firstPid)
      await waitUntil(() => {
        const info = manager.getAgentInfo('worker', parentSessionId)
        return info.status === 'completed' && !info.childProcess
      })
      expect(pidAlive(secondPid)).toBe(false)
      expect(manager.readAgentResponse('worker', parentSessionId).finalResponse).toBe('response:second')
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
        expect(start.args[start.args.indexOf('--append-system-prompt') + 1]).toContain('You are an implementation subagent.')
        expect(start.args.slice(start.args.indexOf('--provider'), start.args.indexOf('--provider') + 4)).toEqual([
          '--provider',
          'anthropic',
          '--model',
          'claude-sonnet-5',
        ])
        expect(start.args[start.args.indexOf('--thinking') + 1]).toBe('high')
        expect(start.args[start.args.indexOf('--tools') + 1]).toBe('read,bash,edit,write,grep,find,ls,hashline_read,hashline_write,safe_rm')
        expect(start.env).toMatchObject({
          PI_SUBAGENT_PROFILE: 'implementer',
          PI_SUBAGENT_READONLY: '0',
        })
        expect(start.env.PI_SUBAGENT_OWNER_TOKEN).toBeString()
        expect(start.env).not.toHaveProperty('PI_SESSION_ID')
        expect(start.env).not.toHaveProperty('PI_SESSION_FILE')
        expect(start.env).not.toHaveProperty('PI_PROVIDER')
        expect(start.env).not.toHaveProperty('PI_MODEL')
        expect(start.env).not.toHaveProperty('PI_REASONING_LEVEL')
      }
    } finally {
      await manager.shutdown()
      rmSync(join(getRunsDir(), parentScopeKey(parentSessionId)), {
        force: true,
        recursive: true,
      })
    }
  })

  processTest('hibernates after failure while preserving the error', async () => {
    const parentSessionId = 'lifecycle-failure'
    rmSync(join(getRunsDir(), parentScopeKey(parentSessionId)), {
      force: true,
      recursive: true,
    })
    const manager = createAgentManager()
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'fail now'))
      const started = manager.getAgentInfo('worker', parentSessionId)
      const { pid } = requireChildProcess(started.childProcess)
      await waitUntil(() => {
        const info = manager.getAgentInfo('worker', parentSessionId)
        return info.status === 'failed' && !info.childProcess
      })
      const failed = manager.readAgentResponse('worker', parentSessionId)
      expect(failed.error).toBe('fake failure')
      expect(pidAlive(pid)).toBe(false)
    } finally {
      await manager.shutdown()
      rmSync(join(getRunsDir(), parentScopeKey(parentSessionId)), {
        force: true,
        recursive: true,
      })
    }
  })

  processTest('accepts Darwin process ownership when ps cannot expose the token', async () => {
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
      await manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'hold darwin'))
      const running = manager.getAgentInfo('worker', parentSessionId)
      expect(running.childProcess?.pid).toBeNumber()
      expect(pidAlive(requireChildProcess(running.childProcess).pid)).toBe(true)
    } finally {
      await manager.shutdown()
      rmSync(join(getRunsDir(), parentScopeKey(parentSessionId)), {
        force: true,
        recursive: true,
      })
    }
  })

  processTest('interrupt terminates the child and clears runtime artifacts', async () => {
    const parentSessionId = 'lifecycle-interrupt'
    rmSync(join(getRunsDir(), parentScopeKey(parentSessionId)), {
      force: true,
      recursive: true,
    })
    const manager = createAgentManager()
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'hold interrupt'))
      const running = manager.getAgentInfo('worker', parentSessionId)
      const { pid } = requireChildProcess(running.childProcess)
      const interruptResult = await manager.interruptAgent(parentSessionId, 'worker')
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
      await manager.shutdown()
      rmSync(join(getRunsDir(), parentScopeKey(parentSessionId)), {
        force: true,
        recursive: true,
      })
    }
  })

  processTest('reconciles owned children without risking PID-reuse kills', async () => {
    const parentSessionId = 'lifecycle-reconcile'
    rmSync(join(getRunsDir(), parentScopeKey(parentSessionId)), {
      force: true,
      recursive: true,
    })
    const owner = createAgentManager()
    const reconcilers: InstanceType<typeof AgentManager>[] = []
    try {
      await owner.spawnAgent(spawnParams(parentSessionId, 'orphan', 'hold orphan'))
      const orphanPid = requireChildProcess(owner.getAgentInfo('orphan', parentSessionId).childProcess).pid
      const reconciler = createAgentManager()
      reconcilers.push(reconciler)
      await waitUntil(() => {
        const info = reconciler.getAgentInfo('orphan', parentSessionId)
        return info.status === 'interrupted' && !info.childProcess
      })
      await waitUntil(() => !pidAlive(orphanPid))
      expect(pidAlive(orphanPid)).toBe(false)

      await owner.spawnAgent(spawnParams(parentSessionId, 'pid-reuse', 'hold identity'))
      const mismatched = owner.getAgentInfo('pid-reuse', parentSessionId)
      const mismatchedPid = requireChildProcess(mismatched.childProcess).pid
      requireChildProcess(mismatched.childProcess).processIdentity = 'not-the-owned-process'
      writeFileSync(mismatched.infoFile, JSON.stringify(mismatched, undefined, 2))
      const mismatchReconciler = createAgentManager()
      reconcilers.push(mismatchReconciler)
      await waitUntil(() => {
        const info = mismatchReconciler.getAgentInfo('pid-reuse', parentSessionId)
        return info.status === 'interrupted' && !info.childProcess
      })
      expect(pidAlive(mismatchedPid)).toBe(true)
      await owner.shutdown()
      expect(pidAlive(mismatchedPid)).toBe(false)
    } finally {
      await Promise.all([owner.shutdown(), ...reconcilers.map((manager) => manager.shutdown())])
      rmSync(join(getRunsDir(), parentScopeKey(parentSessionId)), {
        force: true,
        recursive: true,
      })
    }
  })
})

describe('completion delivery', () => {
  processTest('publishes unclaimed settled and abnormal-exit completions', async () => {
    const parentSessionId = 'completion-callbacks'
    const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
    rmSync(scope, { force: true, recursive: true })
    const completions: CompletionEvent[] = []
    const manager = createAgentManager({
      onUnclaimedCompletion: (event: CompletionEvent) => completions.push(event),
    })
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, 'settled', 'first'))
      await waitUntil(() => completions.some((event) => event.agentName === '/settled'))
      expect(completions.filter((event) => event.agentName === '/settled')).toHaveLength(1)
      expect(completions.find((event) => event.agentName === '/settled')).toMatchObject({
        finalResponse: 'response:first',
        status: 'completed',
      })

      await manager.spawnAgent(spawnParams(parentSessionId, 'crashed', 'crash now'))
      await waitUntil(() => completions.some((event) => event.agentName === '/crashed'))
      expect(completions.filter((event) => event.agentName === '/crashed')).toHaveLength(1)
      const crashed = completions.find((event) => event.agentName === '/crashed')
      expect(crashed).toMatchObject({
        status: 'failed',
      })
      expect(crashed?.error).toContain('code=23')
    } finally {
      await manager.shutdown()
      rmSync(scope, { force: true, recursive: true })
    }
  })

  processTest('suppresses automatic delivery while wait tools claim completions', async () => {
    const parentSessionId = 'completion-waits'
    const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
    rmSync(scope, { force: true, recursive: true })
    const completions: CompletionEvent[] = []
    const manager = createAgentManager({
      onUnclaimedCompletion: (event: CompletionEvent) => completions.push(event),
    })
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, 'one', 'first'))
      const waited = await manager.waitAgent(parentSessionId, ['one'])
      expect(waited.event).toMatchObject({ agentName: '/one', status: 'completed' })
      expect(completions).toEqual([])

      await manager.spawnAgent(spawnParams(parentSessionId, 'two', 'second'))
      const all = await manager.waitAllAgents(parentSessionId, ['two'])
      expect(all.responses).toEqual([expect.objectContaining({ agent_name: '/two', status: 'completed' })])
      expect(completions).toEqual([])
    } finally {
      await manager.shutdown()
      rmSync(scope, { force: true, recursive: true })
    }
  })

  processTest('releases suppressed completions when wait_all_agents is cancelled', async () => {
    const parentSessionId = 'completion-wait-cancel'
    const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
    rmSync(scope, { force: true, recursive: true })
    const completions: CompletionEvent[] = []
    const manager = createAgentManager({
      onUnclaimedCompletion: (event: CompletionEvent) => completions.push(event),
    })
    const controller = new AbortController()
    try {
      await manager.spawnAgent(spawnParams(parentSessionId, 'slow', 'hold slow'))
      await manager.spawnAgent(spawnParams(parentSessionId, 'fast', 'fast'))
      const wait = manager.waitAllAgents(parentSessionId, ['slow', 'fast'], controller.signal)
      await waitUntil(() => manager.getAgentInfo('fast', parentSessionId).status === 'completed')
      expect(completions).toEqual([])
      controller.abort(new Error('cancelled'))
      await expect(wait).rejects.toThrow('aborted')
      await waitUntil(() => completions.some((event) => event.agentName === '/fast'))
      expect(completions.filter((event) => event.agentName === '/fast')).toHaveLength(1)
    } finally {
      await manager.shutdown()
      rmSync(scope, { force: true, recursive: true })
    }
  })

  processTest('reports active and inactive lifecycle transitions', async () => {
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
      await manager.spawnAgent(spawnParams(parentSessionId, 'worker', 'first'))
      await waitUntil(() => manager.getAgentInfo('worker', parentSessionId).status === 'completed')
      expect(activity).toContain(true)
      expect(activity.at(-1)).toBe(false)

      const settled = manager.getAgentInfo('worker', parentSessionId)
      const rejectedAt = activity.length
      await expect(manager.sendMessage(parentSessionId, 'worker', 'reject restart')).rejects.toThrow('fake prompt rejection')
      expect(manager.getAgentInfo('worker', parentSessionId)).toMatchObject({
        completedAt: settled.completedAt,
        finalResponse: settled.finalResponse,
        status: 'completed',
      })
      expect(manager.getAgentInfo('worker', parentSessionId).childProcess).toBeUndefined()
      expect(activity.slice(rejectedAt)).toContain(true)
      expect(activity.at(-1)).toBe(false)

      const restartAt = activity.length
      await manager.sendMessage(parentSessionId, 'worker', 'hold restart')
      expect(activity.slice(restartAt)).toContain(true)
      await manager.interruptAgent(parentSessionId, 'worker')
      expect(activity.at(-1)).toBe(false)
    } finally {
      await manager.shutdown()
      rmSync(scope, { force: true, recursive: true })
    }
  })
})

describe('extension completion delivery and TUI', () => {
  processTest('registers commands, renders one-line activity, and delivers bounded completions', async () => {
    const handlers = new Map<string, FakeHandler[]>()
    const tools = new Map<string, FakeToolDefinition>()
    const commands = new Map<string, unknown>()
    const renderers = new Map<string, FakeRenderer>()
    const sentMessages: { message: FakeMessage; options: unknown }[] = []
    let widget: FakeWidget | undefined
    const requireTool = (name: string): FakeToolDefinition => {
      const tool = tools.get(name)
      if (!tool) {
        throw new Error(`tool ${name} was not registered`)
      }
      return tool
    }
    const requireRenderer = (name: string): FakeRenderer => {
      const renderer = renderers.get(name)
      if (!renderer) {
        throw new Error(`renderer ${name} was not registered`)
      }
      return renderer
    }
    const requireWidget = (): FakeWidget => {
      if (!widget) {
        throw new Error('expected the sidebar widget to be registered')
      }
      return widget
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
      registerCommand(name: string, command: unknown) {
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
      mode: 'tui',
      model: { id: 'fake', provider: 'test' },
      modelRegistry: { getAvailable: () => AVAILABLE_MODELS },
      sessionManager: {
        getSessionFile: () => join(TEST_AGENT_DIR, 'parent.jsonl'),
        getSessionId: () => parentSessionId,
      },
      ui: {
        setWidget(_key: string, value: FakeWidget | undefined) {
          widget = value
        },
      },
    }
    const scope = join(getRunsDir(), parentScopeKey(parentSessionId))
    rmSync(scope, { force: true, recursive: true })
    const { default: subagentExtension } = await import('../index.js')
    subagentExtension(pi as unknown as ExtensionAPI, { piCommand: { command: FAKE_RPC_CHILD } })
    const emit = async (name: string, event: unknown = {}) => {
      for (const handler of handlers.get(name) ?? []) {
        await handler(event, ctx)
      }
    }

    try {
      await emit('session_start', { reason: 'startup' })
      expect(commands.has('agents')).toBe(true)
      expect(commands.has('subagent')).toBe(true)
      expect(commands.has('subagents')).toBe(true)
      expect(renderers.has('pi-codex-subagent-completion')).toBe(true)
      expect(requireTool('spawn_agent').parameters.required).toContain('agent_type')
      expect(requireTool('spawn_agent').parameters.properties.skills).toBeUndefined()
      expect(requireTool('spawn_agent').parameters.properties.agent_type.enum).toEqual(['scout', 'librarian', 'implementer', 'reviewer'])

      await requireTool('spawn_agent').execute(
        'spawn-1',
        {
          agent_type: 'implementer',
          message: 'slow finish',
          task_name: 'x'.repeat(200),
        },
        undefined,
        undefined,
        ctx
      )

      expect(widget).toBeFunction()
      const colorCalls: string[] = []
      const theme = {
        bold: (text: string) => text,
        fg: (color: string, text: string) => {
          colorCalls.push(color)
          return text
        },
      }
      const lines = requireWidget()({}, theme).render(40)
      expect(lines).toHaveLength(1)
      expect(visibleWidth(lines[0])).toBeLessThanOrEqual(40)
      expect(lines[0]).toContain('/subagents')
      expect(colorCalls).toContain('success')
      colorCalls.length = 0
      requireTool('spawn_agent').renderCall({ agent_type: 'librarian', task_name: 'research' }, theme)
      expect(colorCalls).toContain('mdLink')
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

      await waitUntil(() => sentMessages.length === 1)
      expect(widget).toBeUndefined()
      expect(sentMessages[0].options).toEqual({ deliverAs: 'steer', triggerTurn: true })
      expect(sentMessages[0].message.content).toContain('response:slow finish')

      await requireTool('spawn_agent').execute(
        'spawn-2',
        {
          agent_type: 'implementer',
          message: 'large response',
          task_name: 'large-output',
        },
        undefined,
        undefined,
        ctx
      )
      await waitUntil(() => sentMessages.length === 2)
      const large = sentMessages[1].message
      expect(Buffer.byteLength(large.content, 'utf8')).toBeLessThanOrEqual(50 * 1024)
      expect(large.content).toContain('Output truncated')
      expect(large.details.fullOutputPath).toBeString()
      expect(existsSync(large.details.fullOutputPath)).toBe(true)

      await requireTool('spawn_agent').execute(
        'spawn-3',
        { agent_type: 'scout', message: 'hold scout', task_name: 'hold-scout' },
        undefined,
        undefined,
        ctx
      )
      await requireTool('spawn_agent').execute(
        'spawn-4',
        { agent_type: 'librarian', message: 'hold library', task_name: 'hold-library' },
        undefined,
        undefined,
        ctx
      )
      colorCalls.length = 0
      const multiple = requireWidget()({}, theme).render(32)
      expect(multiple.every((line: string) => visibleWidth(line) <= 32)).toBe(true)
      expect(colorCalls).toContain('accent')
      expect(colorCalls).toContain('mdLink')
    } finally {
      await emit('session_shutdown', { reason: 'quit' })
      rmSync(scope, { force: true, recursive: true })
    }
  })
})

interface PeekOverlayInternals {
  cachedLines: string[] | undefined
  cachedWidth: number | undefined
  scrollOffset: number
  theme: Theme
}

describe('subagent peek overlay', () => {
  const createOverlay = (columns = 80, rows = 20) => {
    const now = Date.now()
    const info = {
      canonicalName: '/a-very-long-agent-name',
      color: 'warning' as const,
      createdAt: now,
      cwd: TEST_AGENT_DIR,
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
    const tui = {
      requestRender() {
        /* No-op stub; tests only assert on rendered output. */
      },
      terminal: { columns, rows },
    } as unknown as TUI
    const theme = {
      fg: (_color: string, text: string) => text,
    } as unknown as Theme
    return new SubagentPeekOverlay({
      done: () => {
        /* No-op stub; navigation is not exercised in these tests. */
      },
      info,
      theme,
      tui,
    })
  }

  test('initially follows a long transcript at the end', () => {
    const overlay = createOverlay()
    try {
      const internals = overlay as unknown as PeekOverlayInternals
      internals.cachedLines = Array.from({ length: 30 }, (_value, index) => `line-${index}`)
      internals.cachedWidth = 38

      const rendered = overlay.render(40)
      expect(internals.scrollOffset).toBe(18)
      expect(rendered[1]).toContain('line-18')
      expect(rendered[12]).toContain('line-29')
    } finally {
      overlay.dispose()
    }
  })

  test('renders profile identity separately from semantic status color', () => {
    const overlay = createOverlay()
    try {
      const colors: string[] = []
      ;(overlay as unknown as PeekOverlayInternals).theme = {
        fg(color: string, text: string) {
          colors.push(color)
          return text
        },
      } as Theme
      overlay.render(40)
      expect(colors).toContain('warning')
      expect(colors).toContain('success')
    } finally {
      overlay.dispose()
    }
  })

  test('keeps every frame line within a narrow render width', () => {
    const overlay = createOverlay(12, 14)
    try {
      const internals = overlay as unknown as PeekOverlayInternals
      internals.cachedLines = ['content that is much wider than the overlay']
      internals.cachedWidth = 10

      const rendered = overlay.render(12)
      expect(rendered.length).toBeGreaterThan(0)
      expect(rendered.every((line: string) => visibleWidth(line) <= 12)).toBe(true)
    } finally {
      overlay.dispose()
    }
  })
})

describe('completion mailbox', () => {
  test('waits until explicitly cancelled when no completion exists', async () => {
    const manager = createAgentManager()
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('cancelled')), 10)
    await expect(manager.waitAgent('empty-parent', undefined, controller.signal)).rejects.toThrow('cancelled')
    await manager.shutdown()
  })

  test('consumes one matching completion without dropping siblings', () => {
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
})
