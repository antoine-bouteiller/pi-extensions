import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type InlineExtension,
} from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Effect, FileSystem } from 'effect'

import { jsonText, parseJsonText } from '#shared/utils/json'
import { join } from '#shared/utils/path'

import registerProviderRetry from './fixtures/extension.js'

const GENERIC_ERROR = 'An error occurred while processing the request'
const MODEL = 'fake-model'

interface FakeProvider {
  readonly close: () => void
  readonly requests: () => number
  readonly url: string
}

const sse = (value: unknown): string => `data: ${jsonText(value)}\n\n`

interface ProviderFailure {
  readonly message?: string
  readonly status?: number
}

const startFakeProvider = (failures: number | readonly ProviderFailure[]): FakeProvider => {
  const plannedFailures: readonly ProviderFailure[] =
    typeof failures === 'number' ? Array.from({ length: failures }, () => ({ message: GENERIC_ERROR })) : failures
  let requests = 0
  const server = Bun.serve({
    fetch: (request) => {
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/chat/completions') {
        return new Response('not found', { status: 404 })
      }
      requests += 1
      const failure = plannedFailures[requests - 1]
      if (failure !== undefined) {
        const message = failure.message ?? 'An unknown error occurred'
        if (failure.status !== undefined && failure.status !== 200) {
          return Response.json({ error: { message } }, { status: failure.status })
        }
        return new Response(sse({ error: failure.message === undefined ? {} : { message } }), { headers: { 'content-type': 'text/event-stream' } })
      }
      return new Response(
        [
          sse({
            choices: [
              {
                delta: { content: 'recovered', role: 'assistant' },
                finish_reason: undefined,
                index: 0,
              },
            ],
            created: 0,
            id: 'fake-completion',
            model: MODEL,
            object: 'chat.completion.chunk',
          }),
          sse({
            choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
            created: 0,
            id: 'fake-completion',
            model: MODEL,
            object: 'chat.completion.chunk',
          }),
          'data: [DONE]\n\n',
        ].join(''),
        { headers: { 'content-type': 'text/event-stream' } }
      )
    },
    hostname: '127.0.0.1',
    port: 0,
  })
  return {
    close: () => server.stop(true),
    requests: () => requests,
    url: `http://127.0.0.1:${server.port}`,
  }
}

interface SessionHarness {
  readonly events: readonly AgentSessionEvent[]
  readonly session: AgentSession
}

const createHarness = (options: {
  readonly agentDir: string
  readonly baseDelayMs?: number
  readonly extensionFactories?: InlineExtension[]
  readonly maxRetries: number
  readonly providerUrl: string
  readonly retryEnabled?: boolean
}): Promise<SessionHarness> => {
  const modelsPath = join(options.agentDir, 'models.json')
  const models = `{"providers":{"fake":{"api":"openai-completions","apiKey":"test-key","baseUrl":"${options.providerUrl}/v1","models":[{"contextWindow":8192,"id":"${MODEL}","maxTokens":1024}]}}}`
  return Bun.write(modelsPath, models)
    .then(() =>
      ModelRuntime.create({
        authPath: join(options.agentDir, 'auth.json'),
        modelsPath,
      })
    )
    .then((modelRuntime) => {
      const model = modelRuntime.getModel('fake', MODEL)
      if (model === undefined) {
        throw new Error('Fake model was not loaded.')
      }
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: {
          baseDelayMs: options.baseDelayMs ?? 1,
          enabled: options.retryEnabled ?? true,
          maxRetries: options.maxRetries,
        },
      })
      const resourceLoader = new DefaultResourceLoader({
        agentDir: options.agentDir,
        cwd: '/tmp',
        extensionFactories: options.extensionFactories,
        settingsManager,
        systemPromptOverride: () => 'Reply with the provider response.',
      })
      return resourceLoader.reload().then(() => ({ model, modelRuntime, resourceLoader, settingsManager }))
    })
    .then(({ model, modelRuntime, resourceLoader, settingsManager }) =>
      createAgentSession({
        agentDir: options.agentDir,
        cwd: '/tmp',
        model,
        modelRuntime,
        noTools: 'all',
        resourceLoader,
        sessionManager: SessionManager.inMemory('/tmp'),
        settingsManager,
        thinkingLevel: 'off',
      })
    )
    .then(({ session }) =>
      session.bindExtensions({ mode: 'print' }).then(() => {
        const events: AgentSessionEvent[] = []
        session.subscribe((event) => {
          events.push(event)
        })
        return { events, session }
      })
    )
}

const assistant = (session: AgentSession) => {
  const message = session.messages.toReversed().find((candidate) => candidate.role === 'assistant')
  if (message?.role !== 'assistant') {
    throw new Error('Expected an assistant message.')
  }
  return message
}

const retryStarts = (events: readonly AgentSessionEvent[]): number => events.filter((event) => event.type === 'auto_retry_start').length

const retryExtension: InlineExtension = {
  factory: registerProviderRetry,
  name: 'provider-retry',
}

describe('provider retry session integration', () => {
  const run = (
    failure: ProviderFailure,
    options: {
      readonly baseDelayMs?: number
      readonly failures?: number
      readonly maxRetries?: number
      readonly retryEnabled?: boolean
    } = {}
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: 'provider-retry-session-',
      })
      const provider = yield* Effect.acquireRelease(
        Effect.sync(() => startFakeProvider(Array.from({ length: options.failures ?? 1 }, () => failure))),
        (active) => Effect.sync(active.close)
      )
      const agentDir = join(root, 'agent')
      yield* fs.makeDirectory(agentDir, { recursive: true })
      const harness = yield* Effect.promise(() =>
        createHarness({
          agentDir,
          baseDelayMs: options.baseDelayMs,
          extensionFactories: [retryExtension],
          maxRetries: options.maxRetries ?? 2,
          providerUrl: provider.url,
          retryEnabled: options.retryEnabled,
        })
      )
      yield* Effect.promise(() => harness.session.prompt('hello'))
      return { harness, provider }
    })

  it.scoped(
    'preserves an unhooked generic stream failure exactly',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: 'provider-retry-session-',
        })
        const provider = yield* Effect.acquireRelease(
          Effect.sync(() => startFakeProvider(1)),
          (active) => Effect.sync(active.close)
        )
        const agentDir = join(root, 'agent')
        yield* fs.makeDirectory(agentDir, { recursive: true })
        const harness = yield* Effect.promise(() => createHarness({ agentDir, maxRetries: 2, providerUrl: provider.url }))
        yield* Effect.promise(() => harness.session.prompt('hello'))
        expect(provider.requests()).toBe(1)
        expect(retryStarts(harness.events)).toBe(0)
        expect(assistant(harness.session)).toMatchObject({
          errorMessage: GENERIC_ERROR,
          stopReason: 'error',
        })
        harness.session.dispose()
      }),
    20_000
  )

  it.scoped('recovers an unrelated stream error after a 200 response', () =>
    run({ message: 'socket closed while decoding stream', status: 200 }).pipe(
      Effect.tap(({ harness, provider }) =>
        Effect.sync(() => {
          expect(provider.requests()).toBe(2)
          expect(retryStarts(harness.events)).toBe(1)
          expect(assistant(harness.session)).toMatchObject({
            stopReason: 'stop',
          })
          harness.session.dispose()
        })
      )
    )
  )

  it.scoped('does not broaden known 401 failures', () =>
    run({ message: 'Unauthorized', status: 401 }).pipe(
      Effect.tap(({ harness, provider }) =>
        Effect.sync(() => {
          expect(provider.requests()).toBe(1)
          expect(retryStarts(harness.events)).toBe(0)
          expect(assistant(harness.session)).toMatchObject({
            stopReason: 'error',
          })
          harness.session.dispose()
        })
      )
    )
  )

  it.scoped('retries HTTP 501 and 505 failures that Pi did not natively retry', () =>
    Effect.forEach([501, 505], (status) =>
      run({ message: `gateway failure (${status})`, status }).pipe(
        Effect.tap(({ harness, provider }) =>
          Effect.sync(() => {
            expect(provider.requests()).toBe(2)
            expect(retryStarts(harness.events)).toBe(1)
            expect(assistant(harness.session)).toMatchObject({
              stopReason: 'stop',
            })
            harness.session.dispose()
          })
        )
      )
    ).pipe(Effect.asVoid)
  )

  it.scoped('preserves Pi native 429 retries and billing exclusions', () =>
    Effect.gen(function* () {
      for (const failure of [
        { message: 'rate limit exceeded', status: 429 },
        { message: 'Billing quota exceeded', status: 500 },
      ]) {
        const { harness, provider } = yield* run(failure)
        expect(provider.requests()).toBe(failure.status === 429 ? 2 : 1)
        expect(retryStarts(harness.events)).toBe(failure.status === 429 ? 1 : 0)
        harness.session.dispose()
      }
    })
  )

  it.scoped('stops at the native retry budget with exponential backoff', () =>
    run({ message: GENERIC_ERROR }, { failures: 4, maxRetries: 2 }).pipe(
      Effect.tap(({ harness, provider }) =>
        Effect.sync(() => {
          expect(provider.requests()).toBe(3)
          expect(harness.events.filter((event) => event.type === 'auto_retry_start').map((event) => event.delayMs)).toEqual([1, 2])
          expect(assistant(harness.session)).toMatchObject({ errorMessage: `server error: ${GENERIC_ERROR}`, stopReason: 'error' })
          harness.session.dispose()
        })
      )
    )
  )

  it.scoped('honors retry.enabled false', () =>
    run({ message: 'unrelated service failure', status: 500 }, { retryEnabled: false }).pipe(
      Effect.tap(({ harness, provider }) =>
        Effect.sync(() => {
          expect(provider.requests()).toBe(1)
          expect(retryStarts(harness.events)).toBe(0)
          harness.session.dispose()
        })
      )
    )
  )

  it.scoped(
    'cancels during native retry backoff',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: 'provider-retry-session-',
        })
        const provider = yield* Effect.acquireRelease(
          Effect.sync(() => startFakeProvider([{ message: 'temporary failure', status: 500 }])),
          (active) => Effect.sync(active.close)
        )
        const agentDir = join(root, 'agent')
        yield* fs.makeDirectory(agentDir, { recursive: true })
        const harness = yield* Effect.promise(() =>
          createHarness({
            agentDir,
            baseDelayMs: 1000,
            extensionFactories: [retryExtension],
            maxRetries: 2,
            providerUrl: provider.url,
          })
        )
        const retryStarted = Promise.withResolvers<void>()
        const unsubscribe = harness.session.subscribe((event) => {
          if (event.type === 'auto_retry_start') {
            retryStarted.resolve()
          }
        })
        const prompt = harness.session.prompt('hello')
        yield* Effect.promise(() => retryStarted.promise)
        unsubscribe()
        yield* Effect.promise(() => harness.session.abort())
        yield* Effect.promise(() => prompt)
        expect(provider.requests()).toBe(1)
        expect(retryStarts(harness.events)).toBe(1)
        expect(harness.session.isIdle).toBe(true)
        harness.session.dispose()
      }),
    20_000
  )
})

const frames = (stdout: string): readonly unknown[] =>
  stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => parseJsonText(line))

const frameType = (value: unknown): string | undefined => {
  const type = typeof value === 'object' && value !== null ? Reflect.get(value, 'type') : undefined
  return typeof type === 'string' ? type : undefined
}

describe('provider retry sub-agent integration', () => {
  it.scoped(
    'loads the configured extension in the real worker and waits for native recovery before its result',
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: 'provider-retry-worker-',
        })
        const provider = yield* Effect.acquireRelease(
          Effect.sync(() => startFakeProvider(1)),
          (active) => Effect.sync(active.close)
        )
        const agentDir = join(root, 'agent')
        const runDir = join(root, 'run')
        const sessions = join(root, 'sessions')
        const extensionPath = new URL('fixtures/extension.ts', import.meta.url).pathname
        yield* fs.makeDirectory(agentDir, { recursive: true })
        const models = `{"providers":{"fake":{"api":"openai-completions","apiKey":"test-key","baseUrl":"${provider.url}/v1","models":[{"contextWindow":8192,"id":"${MODEL}","maxTokens":1024}]}}}`
        const settings = jsonText({ extensions: [extensionPath], retry: { baseDelayMs: 1 } })
        yield* Effect.promise(() => Bun.write(join(agentDir, 'models.json'), models))
        yield* Effect.promise(() => Bun.write(join(agentDir, 'settings.json'), settings))
        const entrypoint = new URL('../../../src/features/sub_agents/worker.ts', import.meta.url).pathname
        const child = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.spawn([process.execPath, entrypoint], {
              cwd: '/tmp',
              env: { ...process.env, PI_OFFLINE: '1' },
              stderr: 'pipe',
              stdin: 'pipe',
              stdout: 'pipe',
            })
          ),
          (active) => Effect.sync(() => active.kill()).pipe(Effect.ignore, Effect.andThen(Effect.promise(() => active.exited).pipe(Effect.ignore)))
        )
        const config = {
          agent_id: 'agent',
          run_dir: runDir,
          session: { expected_dir: sessions, mode: 'create' as const },
          turn: 1,
          type: 'config' as const,
          version: 1 as const,
          worker: {
            agentDir,
            contextCeiling: 100,
            cwd: '/tmp',
            memoryPolicy: {
              inMemory: 'fixed' as const,
              persistence: 'session_file_only' as const,
            },
            model: MODEL,
            projectTrusted: true,
            prompt: '',
            provider: 'fake',
            resourcePolicy: {
              configuredExtensions: true as const,
              contextFiles: false as const,
              promptTemplates: false as const,
              skills: false as const,
            },
            tools: [],
            version: 1 as const,
          },
        }
        const task = {
          agent_id: 'agent',
          command_id: 'task-command',
          message: 'say hello',
          turn: 1,
          type: 'task' as const,
        }
        yield* Effect.promise(() => Promise.resolve(child.stdin.write(`${jsonText(config)}\n`)))
        yield* Effect.promise(() => Promise.resolve(child.stdin.write(`${jsonText(task)}\n`)))
        yield* Effect.promise(() => Promise.resolve(child.stdin.flush()))
        const stdout = yield* Effect.promise(() => new Response(child.stdout).text())
        const stderr = yield* Effect.promise(() => new Response(child.stderr).text())
        const exitCode = yield* Effect.promise(() => child.exited)
        expect(exitCode, stderr).toBe(0)
        const output = frames(stdout)
        const ready = output.findIndex((frame) => frameType(frame) === 'ready')
        const result = output.findIndex((frame) => frameType(frame) === 'result')
        expect(provider.requests()).toBe(2)
        expect(ready, stdout).toBeGreaterThanOrEqual(0)
        expect(result, stdout).toBeGreaterThan(ready)
        expect(output[result]).toEqual(
          expect.objectContaining({
            conclusion: 'recovered',
            status: 'completed',
            type: 'result',
          })
        )
      }),
    20_000
  )
})
