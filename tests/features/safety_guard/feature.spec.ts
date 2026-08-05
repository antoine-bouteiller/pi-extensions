import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { asExtensionApi, asResult } from '@tests/utils/casts.js'
import { runtime } from '@tests/utils/runtime.js'

import { register as safeRm } from '@/features/safe_rm/feature.js'
import { SAFETY_STATUS_KEY } from '@/features/safety_guard/constants.js'
import { register as safetyGuard } from '@/features/safety_guard/feature.js'
import { publishStatus, statusBar } from '@/shared/state/status_bar.js'
import { isTrue } from '@/shared/utils/predicates.js'

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

interface FakeToolCallEvent {
  toolCallId?: string
  toolName: string
  input: { command?: string; path?: string }
}

interface FakeUi {
  confirm: (title: string, message: string) => Promise<boolean>
  notify: (message: string, level: string) => void
}

interface FakeContext {
  cwd: string
  hasUI: boolean
  signal?: AbortSignal
  ui?: FakeUi
}

interface GuardResult {
  block?: boolean
  reason?: string
}

interface FakeToolResultEvent {
  toolCallId: string
  toolName: string
  input: { command: string }
  content: { text: string; type: 'text' }[]
  details: object
  isError: boolean
}

interface RoutedResult {
  content?: { text: string; type: 'text' }[]
  details?: object
  isError?: boolean
}

type Handler = (event: FakeToolCallEvent, ctx: FakeContext) => Promise<GuardResult | undefined>
type ResultHandler = (event: FakeToolResultEvent, ctx: FakeContext) => Promise<RoutedResult | undefined>
type SessionStartHandler = (event: Record<string, never>, ctx: FakeContext) => Promise<void>

const setup = (activeTools: string[] = ['safe_rm']) => {
  const toolCallHandlers: Handler[] = []
  const resultHandlers: ResultHandler[] = []
  let sessionStart: SessionStartHandler | undefined
  const emitted: [string, unknown][] = []
  const pi = asExtensionApi({
    events: { emit: (event: string, data: unknown) => emitted.push([event, data]) },
    getActiveTools: () => activeTools,
    on: (event: string, callback: unknown) => {
      if (event === 'tool_call') {
        toolCallHandlers.push(asResult<Handler>(callback))
      } else if (event === 'tool_result') {
        resultHandlers.push(asResult<ResultHandler>(callback))
      } else if (event === 'session_start') {
        sessionStart = asResult<SessionStartHandler>(callback)
      }
    },
    registerTool: () => undefined,
  })
  safeRm(pi, runtime)
  safetyGuard(pi, runtime)

  if (toolCallHandlers.length !== 2) {
    throw new Error('tool_call handlers were not registered')
  }
  const [resultHandler] = resultHandlers
  if (resultHandler === undefined) {
    throw new Error('tool_result handler was not registered')
  }
  if (sessionStart === undefined) {
    throw new Error('session_start handler was not registered')
  }
  const handler: Handler = async (event, ctx) => {
    for (const registeredHandler of toolCallHandlers) {
      const result = await registeredHandler(event, ctx)
      if (isTrue(result?.block)) {
        return result
      }
    }
    return undefined
  }
  return { emitted, handler, resultHandler, sessionStart }
}

const event = (command: string, toolCallId = 'call') => ({ input: { command }, toolCallId, toolName: 'bash' })
const resultEvent = (toolCallId: string): FakeToolResultEvent => ({
  content: [{ text: '(no output)', type: 'text' }],
  details: {},
  input: { command: ': # pi-safe-rm' },
  isError: false,
  toolCallId,
  toolName: 'bash',
})

const workspace = async () => {
  const root = await mkdtemp(join(tmpdir(), 'safety-guard-rm-test-'))
  temporaryDirectories.push(root)
  const cwd = join(root, 'project')
  await mkdir(cwd)
  return cwd
}

describe('safety guard', () => {
  test('routes simple literal rm commands through safe_rm', async () => {
    const cwd = await workspace()
    await writeFile(join(cwd, 'first.log'), 'content')
    await writeFile(join(cwd, 'second.log'), 'content')
    await mkdir(join(cwd, 'build'))
    await writeFile(join(cwd, 'build', 'output.txt'), 'content')
    await mkdir(join(cwd, '@types'))
    await mkdir(join(cwd, 'types'))
    await writeFile(join(cwd, '@types', 'marker'), 'scoped')
    await writeFile(join(cwd, 'types', 'marker'), 'plain')
    const { handler, resultHandler } = setup()
    const ctx = { cwd, hasUI: false }

    const filesCall = event('rm first.log second.log', 'rm-files')
    expect(await handler(filesCall, ctx)).toBeUndefined()
    expect(filesCall.input.command).toBe(': # pi-safe-rm')
    const files = await resultHandler(resultEvent('rm-files'), ctx)
    expect(files?.content?.[0]?.text).toContain('Removed: first.log, second.log')

    const directoryCall = event('/bin/rm -rf build @types', 'rm-directory')
    expect(await handler(directoryCall, ctx)).toBeUndefined()
    expect(directoryCall.input.command).toBe(': # pi-safe-rm')
    const directory = await resultHandler(resultEvent('rm-directory'), ctx)
    expect(directory?.content?.[0]?.text).toContain('Removed: build, @types')
    expect(await Bun.file(join(cwd, 'first.log')).exists()).toBeFalse()
    expect(await Bun.file(join(cwd, 'second.log')).exists()).toBeFalse()
    expect(await Bun.file(join(cwd, 'build', 'output.txt')).exists()).toBeFalse()
    expect(await Bun.file(join(cwd, '@types', 'marker')).exists()).toBeFalse()
    expect(await Bun.file(join(cwd, 'types', 'marker')).exists()).toBeTrue()
  })

  test('does not remove a routed target when bash fails before the handoff', async () => {
    const cwd = await workspace()
    await writeFile(join(cwd, 'keep.log'), 'content')
    const { handler, resultHandler } = setup()
    const ctx = { cwd, hasUI: false }
    const call = event('rm keep.log', 'failed-rm')

    expect(await handler(call, ctx)).toBeUndefined()
    const failed = resultEvent('failed-rm')
    failed.isError = true
    expect(await resultHandler(failed, ctx)).toBeUndefined()
    expect(await Bun.file(join(cwd, 'keep.log')).exists()).toBeTrue()
  })

  test('fails closed when a routed handoff is lost', async () => {
    const cwd = await workspace()
    const { resultHandler } = setup()

    const result = await resultHandler(resultEvent('missing-route'), { cwd, hasUI: false })
    expect(result?.isError).toBeTrue()
    expect(result?.content?.[0]?.text).toContain('handoff was lost')
  })

  test('blocks non-literal and compound shell deletion commands', async () => {
    const { handler } = setup()
    const ctx = { cwd: '/work/project', hasUI: false }

    for (const command of [
      'rm "build log"',
      'rm build/*.log',
      'rm build.log; echo done',
      `rm foo\u00a0bar`,
      'rmdir build',
      'unlink build.log',
      'sudo -u root rm build.log',
      'command -- rm build.log',
      'env -i rm build.log',
      '/usr/bin/env -i /bin/rm build.log',
      'busybox rm build.log',
      'nice -n 10 rm build.log',
      'timeout 2 rm build.log',
      'nohup /bin/rm build.log',
      `sh -c 'rm build.log'`,
      'if true; then /bin/rm build.log; fi',
      'find build -type f -delete',
      'find build -exec rm {} +',
      String.raw`printf '%s\n' build.log | xargs rm`,
    ]) {
      const result = await handler(event(command), ctx)
      expect(result?.block, command).toBeTrue()
      expect(result?.reason, command).toContain('safe_rm')
      expect(result?.reason, command).toContain('CRITICAL')
    }
  })

  test('describes the regex command guard as best-effort and does not claim arbitrary code analysis', async () => {
    const { handler } = setup()
    const ctx = { cwd: '/work/project', hasUI: false }

    const recognized = await handler(event('env -i rm build.log'), ctx)
    expect(recognized?.reason).toContain('best-effort command policy')
    // The shell scanner is deliberately a heuristic, not a sandbox. Custom
    // Destructive tools therefore have to enforce path policy themselves.
    expect(await handler(event(`python3 -c "__import__('os').remove('build.log')"`), ctx)).toBeUndefined()
  })

  test('hard-blocks critical commands', async () => {
    const { handler } = setup()
    const result = await handler(event('mkfs /dev/sda'), { cwd: '/work/project', hasUI: false })
    expect(result?.block).toBeTrue()
    expect(result?.reason).toContain('CRITICAL')
  })

  test('blocks recognized shell deletion registered for background polling', async () => {
    const { handler } = setup()
    const result = await handler({ input: { command: 'rm -rf build' }, toolName: 'background_poll' }, { cwd: '/work/project', hasUI: false })
    expect(result?.block).toBeTrue()
    expect(result?.reason).toContain('safe_rm')
  })

  test('blocks simple rm when safe_rm is inactive', async () => {
    const { handler } = setup([])
    const call = event('rm build.log')

    const result = await handler(call, { cwd: '/work/project', hasUI: false })
    expect(result?.block).toBeTrue()
    expect(call.input.command).toBe('rm build.log')
  })

  test('does not offer a confirmation prompt for routed shell deletion', async () => {
    const { handler } = setup()
    let confirmed = false
    const result = await handler(event('rm build.log'), {
      cwd: '/work/project',
      hasUI: true,
      ui: {
        confirm: async () => {
          confirmed = true
          return true
        },
        notify: () => undefined,
      },
    })
    expect(result).toBeUndefined()
    expect(confirmed).toBeFalse()
  })

  test('guards destructive Git, container, package, and database operations', async () => {
    const { handler } = setup()
    const ctx = { cwd: '/work/project', hasUI: false }

    for (const command of [
      'git push --force origin main',
      'docker system prune -af',
      'npm uninstall important-package',
      'psql -c "DROP TABLE users"',
    ]) {
      const result = await handler(event(command), ctx)
      expect(result?.block, command).toBeTrue()
    }
  })

  test('allows Git rebase commands', async () => {
    const { handler } = setup()
    const ctx = { cwd: '/work/project', hasUI: false }

    for (const command of ['git rebase main', 'git rebase --continue', 'git rebase --onto main feature~2 feature']) {
      expect(await handler(event(command), ctx), command).toBeUndefined()
    }
  })

  test('guards protected file reads, writes, and edits', async () => {
    const { handler } = setup()
    const ctx = { cwd: '/work/project', hasUI: false }

    for (const toolName of ['read', 'write', 'edit']) {
      const result = await handler({ input: { path: '.env' }, toolName }, ctx)
      expect(result?.block, toolName).toBeTrue()
      expect(result?.reason).toContain(`Protected file ${toolName}`)
    }

    const atPrefixed = await handler({ input: { path: '@.env' }, toolName: 'read' }, ctx)
    expect(atPrefixed?.block).toBeTrue()
    expect(atPrefixed?.reason).toContain('Protected file read')

    expect(await handler({ input: { path: '.env.example' }, toolName: 'read' }, ctx)).toBeUndefined()
  })

  test('resolves symlinks and the nearest existing parent for protected paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'safety-guard-test-'))
    temporaryDirectories.push(root)
    const cwd = join(root, 'project')
    const secrets = join(root, '.ssh')
    await mkdir(cwd)
    await mkdir(secrets)
    await writeFile(join(secrets, 'config'), 'secret')
    await symlink(join(secrets, 'config'), join(cwd, 'innocent.txt'))
    await symlink(secrets, join(cwd, 'linked-secrets'))

    const { handler } = setup()
    const ctx = { cwd, hasUI: false }
    for (const path of ['innocent.txt', 'linked-secrets/config', 'linked-secrets/new-key.pem']) {
      const result = await handler({ input: { path }, toolName: 'read' }, ctx)
      expect(result?.block, path).toBeTrue()
    }
  })

  test('routes root deletion to safe_rm, which rejects it', async () => {
    const cwd = await workspace()
    const { handler, resultHandler } = setup()
    let confirmed = false
    const ctx = {
      cwd,
      hasUI: true,
      ui: {
        confirm: async () => {
          confirmed = true
          return true
        },
        notify: () => undefined,
      },
    }

    const call = event('rm -rf /', 'rm-root')
    expect(await handler(call, ctx)).toBeUndefined()
    expect(call.input.command).toBe(': # pi-safe-rm')
    const result = await resultHandler(resultEvent('rm-root'), ctx)
    expect(result?.isError).toBeTrue()
    expect(result?.content?.[0]?.text).toContain('working directory or /tmp')
    expect(confirmed).toBeFalse()
  })

  test('reports blocked state while awaiting confirmation', async () => {
    const { handler, emitted } = setup()
    const result = await handler(event('sudo echo ok'), {
      cwd: '/work/project',
      hasUI: true,
      ui: { confirm: async () => false, notify: () => undefined },
    })
    expect(result?.block).toBeTrue()
    expect(emitted).toEqual([
      ['herdr:blocked', { active: true, label: 'Elevated privileges (sudo)' }],
      ['herdr:blocked', { active: false }],
    ])
  })

  test('publishes a status-bar entry on session_start', async () => {
    const { sessionStart } = setup()
    try {
      await sessionStart({}, { cwd: '/work/project', hasUI: false })
      expect(statusBar.list().find((entry) => entry.key === SAFETY_STATUS_KEY)).toEqual({
        icon: '🛡️',
        key: SAFETY_STATUS_KEY,
        priority: 10,
        text: 'cmd-guard',
        tone: 'success',
      })
    } finally {
      publishStatus(SAFETY_STATUS_KEY, undefined)
    }
  })
})
