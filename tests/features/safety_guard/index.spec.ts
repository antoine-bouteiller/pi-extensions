import { afterEach } from 'bun:test'
import { tmpdir } from 'node:os'

import { promiseFromEffect, describe, expect, it } from '@tests/utils/bun_effect.js'
import { asExtensionApi, asResult } from '@tests/utils/casts.js'
import { runtime } from '@tests/utils/runtime.js'
import { Effect, FileSystem, Path } from 'effect'

import { register as safeRm } from '@/features/safe_rm/index.js'
import { SAFETY_STATUS_KEY } from '@/features/safety_guard/constants.js'
import { register as safetyGuard } from '@/features/safety_guard/index.js'
import { publishStatus, statusBar } from '@/shared/state/status_bar.js'
import { isTrue } from '@/shared/utils/predicates.js'

const pathService = runtime.runSync(Path.Path)
const { join } = pathService
const mkdir = (path: string, options?: { recursive?: boolean }) => FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.makeDirectory(path, options)))
const mkdtemp = (prefix: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.makeTempDirectory({ directory: pathService.dirname(prefix), prefix: pathService.basename(prefix) }))
  )
const rm = (path: string, options?: { force?: boolean; recursive?: boolean }) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.remove(path, options)))
const symlink = (fromPath: string, toPath: string) => FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.symlink(fromPath, toPath)))
const writeFile = (path: string, data: string) => FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.writeFileString(path, data)))

const temporaryDirectories: string[] = []
afterEach(() =>
  runtime.runPromise(
    Effect.forEach(temporaryDirectories.splice(0), (path) => rm(path, { force: true, recursive: true }), { concurrency: 'unbounded' })
  )
)

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
  const handler: Handler = (event, ctx) =>
    promiseFromEffect(
      Effect.gen(function* () {
        for (const registeredHandler of toolCallHandlers) {
          const result = yield* Effect.promise(() => Promise.resolve(registeredHandler(event, ctx)))
          if (isTrue(result?.block)) {
            return result
          }
        }
        return undefined
      })
    )
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

const workspace = Effect.gen(function* () {
  const root = yield* mkdtemp(join(tmpdir(), 'safety-guard-rm-test-'))
  temporaryDirectories.push(root)
  const cwd = join(root, 'project')
  yield* mkdir(cwd)
  return cwd
})

describe('safety guard', () => {
  it.effect('routes simple literal rm commands through safe_rm', () =>
    Effect.gen(function* () {
      const cwd = yield* workspace
      yield* writeFile(join(cwd, 'first.log'), 'content')
      yield* writeFile(join(cwd, 'second.log'), 'content')
      yield* mkdir(join(cwd, 'build'))
      yield* writeFile(join(cwd, 'build', 'output.txt'), 'content')
      yield* mkdir(join(cwd, '@types'))
      yield* mkdir(join(cwd, 'types'))
      yield* writeFile(join(cwd, '@types', 'marker'), 'scoped')
      yield* writeFile(join(cwd, 'types', 'marker'), 'plain')
      const { handler, resultHandler } = setup()
      const ctx = { cwd, hasUI: false }

      const filesCall = event('rm first.log second.log', 'rm-files')
      expect(yield* Effect.promise(() => handler(filesCall, ctx))).toBeUndefined()
      expect(filesCall.input.command).toBe(': # pi-safe-rm')
      const files = yield* Effect.promise(() => resultHandler(resultEvent('rm-files'), ctx))
      expect(files?.content?.[0]?.text).toContain('Removed: first.log, second.log')

      const directoryCall = event('/bin/rm -rf build @types', 'rm-directory')
      expect(yield* Effect.promise(() => handler(directoryCall, ctx))).toBeUndefined()
      expect(directoryCall.input.command).toBe(': # pi-safe-rm')
      const directory = yield* Effect.promise(() => resultHandler(resultEvent('rm-directory'), ctx))
      expect(directory?.content?.[0]?.text).toContain('Removed: build, @types')
      expect(yield* Effect.promise(() => Bun.file(join(cwd, 'first.log')).exists())).toBeFalse()
      expect(yield* Effect.promise(() => Bun.file(join(cwd, 'second.log')).exists())).toBeFalse()
      expect(yield* Effect.promise(() => Bun.file(join(cwd, 'build', 'output.txt')).exists())).toBeFalse()
      expect(yield* Effect.promise(() => Bun.file(join(cwd, '@types', 'marker')).exists())).toBeFalse()
      expect(yield* Effect.promise(() => Bun.file(join(cwd, 'types', 'marker')).exists())).toBeTrue()
    })
  )

  it.effect('does not remove a routed target when bash fails before the handoff', () =>
    Effect.gen(function* () {
      const cwd = yield* workspace
      yield* writeFile(join(cwd, 'keep.log'), 'content')
      const { handler, resultHandler } = setup()
      const ctx = { cwd, hasUI: false }
      const call = event('rm keep.log', 'failed-rm')

      expect(yield* Effect.promise(() => handler(call, ctx))).toBeUndefined()
      const failed = resultEvent('failed-rm')
      failed.isError = true
      expect(yield* Effect.promise(() => resultHandler(failed, ctx))).toBeUndefined()
      expect(yield* Effect.promise(() => Bun.file(join(cwd, 'keep.log')).exists())).toBeTrue()
    })
  )

  it.effect('fails closed when a routed handoff is lost', () =>
    Effect.gen(function* () {
      const cwd = yield* workspace
      const { resultHandler } = setup()

      const result = yield* Effect.promise(() => resultHandler(resultEvent('missing-route'), { cwd, hasUI: false }))
      expect(result?.isError).toBeTrue()
      expect(result?.content?.[0]?.text).toContain('handoff was lost')
    })
  )

  it.effect('blocks non-literal and compound shell deletion commands', () =>
    Effect.gen(function* () {
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
        const result = yield* Effect.promise(() => handler(event(command), ctx))
        expect(result?.block, command).toBeTrue()
        expect(result?.reason, command).toContain('safe_rm')
        expect(result?.reason, command).toContain('CRITICAL')
      }
    })
  )

  it.effect('allows compound commands whose literal rm targets pass safe_rm validation', () =>
    Effect.gen(function* () {
      const cwd = yield* workspace
      yield* mkdir(join(cwd, 'src'))
      yield* writeFile(join(cwd, 'src', 'App.tsx'), 'content')
      const { handler } = setup()
      const ctx = { cwd, hasUI: false }

      const call = event('git rm -q --cached src/App.tsx;\n rm -f src/App.tsx; git add src/app.tsx; ls src/')
      expect(yield* Effect.promise(() => handler(call, ctx))).toBeUndefined()
      expect(call.input.command).toContain('rm -f src/App.tsx')
      expect(yield* Effect.promise(() => Bun.file(join(cwd, 'src', 'App.tsx')).exists())).toBeTrue()
    })
  )

  it.effect('blocks a compound command whose rm target fails safe_rm validation', () =>
    Effect.gen(function* () {
      const cwd = yield* workspace
      const { handler } = setup()

      const result = yield* Effect.promise(() => handler(event('echo start && rm -f /etc/hosts && echo done'), { cwd, hasUI: false }))
      expect(result?.block).toBeTrue()
      expect(result?.reason).toContain('working directory or /tmp')
    })
  )

  it.effect('ignores dangerous words inside message arguments', () =>
    Effect.gen(function* () {
      const { handler } = setup()
      const ctx = { cwd: '/work/project', hasUI: false }

      for (const command of [
        `git commit -m 'rm -rf build and reboot the worker'`,
        'git commit --message="sudo shutdown of the DROP TABLE users path"',
        'gh pr create --title "mkfs /dev/sda guard" --body "blocks find . -delete"',
      ]) {
        expect(yield* Effect.promise(() => handler(event(command), ctx)), command).toBeUndefined()
      }
    })
  )

  it.effect('describes the regex command guard as best-effort and does not claim arbitrary code analysis', () =>
    Effect.gen(function* () {
      const { handler } = setup()
      const ctx = { cwd: '/work/project', hasUI: false }

      const recognized = yield* Effect.promise(() => handler(event('env -i rm build.log'), ctx))
      expect(recognized?.reason).toContain('best-effort command policy')
      // The shell scanner is deliberately a heuristic, not a sandbox. Custom
      // Destructive tools therefore have to enforce path policy themselves.
      expect(yield* Effect.promise(() => handler(event(`python3 -c "__import__('os').remove('build.log')"`), ctx))).toBeUndefined()
    })
  )

  it.effect('hard-blocks critical commands', () =>
    Effect.gen(function* () {
      const { handler } = setup()
      const result = yield* Effect.promise(() => handler(event('mkfs /dev/sda'), { cwd: '/work/project', hasUI: false }))
      expect(result?.block).toBeTrue()
      expect(result?.reason).toContain('CRITICAL')
    })
  )

  it.effect('blocks recognized shell deletion registered for background polling', () =>
    Effect.gen(function* () {
      const { handler } = setup()
      const result = yield* Effect.promise(() =>
        handler({ input: { command: 'rm -rf build' }, toolName: 'background_poll' }, { cwd: '/work/project', hasUI: false })
      )
      expect(result?.block).toBeTrue()
      expect(result?.reason).toContain('safe_rm')
    })
  )

  it.effect('blocks simple rm when safe_rm is inactive', () =>
    Effect.gen(function* () {
      const { handler } = setup([])
      const call = event('rm build.log')

      const result = yield* Effect.promise(() => handler(call, { cwd: '/work/project', hasUI: false }))
      expect(result?.block).toBeTrue()
      expect(call.input.command).toBe('rm build.log')
    })
  )

  it.effect('does not offer a confirmation prompt for routed shell deletion', () =>
    Effect.gen(function* () {
      const { handler } = setup()
      let confirmed = false
      const result = yield* Effect.promise(() =>
        handler(event('rm build.log'), {
          cwd: '/work/project',
          hasUI: true,
          ui: {
            confirm: () =>
              promiseFromEffect(
                Effect.sync(() => {
                  confirmed = true
                  return true
                })
              ),
            notify: () => undefined,
          },
        })
      )
      expect(result).toBeUndefined()
      expect(confirmed).toBeFalse()
    })
  )

  it.effect('guards destructive Git, container, package, and database operations', () =>
    Effect.gen(function* () {
      const { handler } = setup()
      const ctx = { cwd: '/work/project', hasUI: false }

      for (const command of [
        'git push --force origin main',
        'docker system prune -af',
        'npm uninstall important-package',
        'psql -c "DROP TABLE users"',
      ]) {
        const result = yield* Effect.promise(() => handler(event(command), ctx))
        expect(result?.block, command).toBeTrue()
      }
    })
  )

  it.effect('hard-blocks Git force pushes', () =>
    Effect.gen(function* () {
      const { handler } = setup()
      const ctx = {
        cwd: '/work/project',
        hasUI: true,
        ui: { confirm: () => promiseFromEffect(Effect.succeed(true)), notify: () => undefined },
      }

      for (const command of [
        'git push --force origin main',
        'git push origin main -f',
        'git push -uf origin main',
        'git -C /work/project push --force origin main',
        'git --git-dir=.git push -f origin main',
        'git --no-optional-locks push --force origin main',
        "git push '--force' origin main",
        String.raw`git pu\
sh --force origin main`,
        String.raw`git push --for\
ce origin main`,
        String.raw`git push \
 --force origin main`,
        'git push --force; echo done',
      ]) {
        const result = yield* Effect.promise(() => handler(event(command), ctx))
        expect(result?.block, command).toBeTrue()
        expect(result?.reason, command).toContain('Git force push')
        expect(result?.reason, command).toContain('CRITICAL')
      }
    })
  )

  it.effect('allows all other Git operations', () =>
    Effect.gen(function* () {
      const { handler } = setup()
      const ctx = { cwd: '/work/project', hasUI: false }

      for (const command of [
        'git reset --hard HEAD~1',
        'git clean -fd',
        'git checkout -- package.json',
        'git restore package.json',
        'git branch -D feature',
        'git tag -d v1.0.0',
        'git filter-repo --path secrets.txt --invert-paths',
        'git replace old new',
        'git update-ref -d refs/heads/feature',
        'git prune',
        'git push --delete origin feature',
        'git push origin :refs/heads/feature',
        'git push --force-with-lease origin main',
        'git push origin topic-f',
        'git push origin feature--force',
        'git push -of origin main',
        'git push -ofoo origin main',
        'git push --mirror origin',
        'git push origin +main',
        'git --no-pager status push --force',
        'git commit --amend --no-edit',
        'git commit --fixup HEAD',
        'git rebase --onto main feature~2 feature',
      ]) {
        expect(yield* Effect.promise(() => handler(event(command), ctx)), command).toBeUndefined()
      }
    })
  )

  it.effect('guards protected file reads, writes, and edits', () =>
    Effect.gen(function* () {
      const { handler } = setup()
      const ctx = { cwd: '/work/project', hasUI: false }

      for (const toolName of ['read', 'write', 'edit']) {
        const result = yield* Effect.promise(() => handler({ input: { path: '.env' }, toolName }, ctx))
        expect(result?.block, toolName).toBeTrue()
        expect(result?.reason).toContain(`Protected file ${toolName}`)
      }

      const atPrefixed = yield* Effect.promise(() => handler({ input: { path: '@.env' }, toolName: 'read' }, ctx))
      expect(atPrefixed?.block).toBeTrue()
      expect(atPrefixed?.reason).toContain('Protected file read')

      expect(yield* Effect.promise(() => handler({ input: { path: '.env.example' }, toolName: 'read' }, ctx))).toBeUndefined()
    })
  )

  it.effect('resolves symlinks and the nearest existing parent for protected paths', () =>
    Effect.gen(function* () {
      const root = yield* mkdtemp(join(tmpdir(), 'safety-guard-test-'))
      temporaryDirectories.push(root)
      const cwd = join(root, 'project')
      const secrets = join(root, '.ssh')
      yield* mkdir(cwd)
      yield* mkdir(secrets)
      yield* writeFile(join(secrets, 'config'), 'secret')
      yield* symlink(join(secrets, 'config'), join(cwd, 'innocent.txt'))
      yield* symlink(secrets, join(cwd, 'linked-secrets'))

      const { handler } = setup()
      const ctx = { cwd, hasUI: false }
      for (const path of ['innocent.txt', 'linked-secrets/config', 'linked-secrets/new-key.pem']) {
        const result = yield* Effect.promise(() => handler({ input: { path }, toolName: 'read' }, ctx))
        expect(result?.block, path).toBeTrue()
      }
    })
  )

  it.effect('routes root deletion to safe_rm, which rejects it', () =>
    Effect.gen(function* () {
      const cwd = yield* workspace
      const { handler, resultHandler } = setup()
      let confirmed = false
      const ctx = {
        cwd,
        hasUI: true,
        ui: {
          confirm: () =>
            promiseFromEffect(
              Effect.sync(() => {
                confirmed = true
                return true
              })
            ),
          notify: () => undefined,
        },
      }

      const call = event('rm -rf /', 'rm-root')
      expect(yield* Effect.promise(() => handler(call, ctx))).toBeUndefined()
      expect(call.input.command).toBe(': # pi-safe-rm')
      const result = yield* Effect.promise(() => resultHandler(resultEvent('rm-root'), ctx))
      expect(result?.isError).toBeTrue()
      expect(result?.content?.[0]?.text).toContain('working directory or /tmp')
      expect(confirmed).toBeFalse()
    })
  )

  it.effect('reports blocked state while awaiting confirmation', () =>
    Effect.gen(function* () {
      const { handler, emitted } = setup()
      const result = yield* Effect.promise(() =>
        handler(event('sudo echo ok'), {
          cwd: '/work/project',
          hasUI: true,
          ui: { confirm: () => promiseFromEffect(Effect.succeed(false)), notify: () => undefined },
        })
      )
      expect(result?.block).toBeTrue()
      expect(emitted).toEqual([
        ['herdr:blocked', { active: true, label: 'Elevated privileges (sudo)' }],
        ['herdr:blocked', { active: false }],
      ])
    })
  )

  it.effect('publishes a status-bar entry on session_start', () =>
    Effect.gen(function* () {
      const { sessionStart } = setup()
      try {
        yield* Effect.promise(() => sessionStart({}, { cwd: '/work/project', hasUI: false }))
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
  )
})
