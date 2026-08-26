import { type AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Effect, pipe } from 'effect'

import { bunFileSystem, bunPath } from '@/shared/effect/bun_services.js'

import {
  JsonlDecoder,
  MAX_ARTIFACT_BYTES,
  MAX_FRAME_BYTES,
  MAX_INLINE_BYTES,
  MAX_INLINE_LINES,
  ProtocolError,
  encodeFrame,
  parseParentFrame,
} from '../../../src/features/sub_agents/protocol.js'
import { SubagentWorker } from '../../../src/features/sub_agents/worker.js'
import { asNarrowed } from '../../utils/casts.js'
import { startFakeProvider } from './fixtures/fake_provider.js'
import { workerHarness } from './fixtures/worker_harness.js'

const config = {
  agent_id: 'agent',
  run_dir: '/tmp/run',
  session: { expected_dir: '/tmp/sessions', mode: 'create' as const },
  turn: 1,
  type: 'config' as const,
  version: 1 as const,
  worker: {
    agentDir: '/tmp/agent',
    contextCeiling: 100,
    cwd: '/tmp',
    memoryPolicy: { inMemory: 'fixed' as const, persistence: 'session_file_only' as const },
    model: 'fake',
    projectTrusted: true,
    prompt: '',
    provider: 'fake',
    resourcePolicy: { configuredExtensions: true as const, contextFiles: false as const, promptTemplates: false as const, skills: false as const },
    tools: [],
    version: 1 as const,
  },
}

const bytes = new TextEncoder()
const task = (message: string) => ({ agent_id: 'agent', command_id: 'task-command', message, turn: 1, type: 'task' as const })
const promise = <Value>(evaluate: () => Promise<Value>): Effect.Effect<Value> => Effect.promise(evaluate)
const rejects = (value: Promise<void>): Effect.Effect<void> =>
  promise(() =>
    value.then(
      () => expect.unreachable(),
      (error: unknown) => expect(error).toBeInstanceOf(ProtocolError)
    )
  )

const strictFrames = (stdout: string): readonly unknown[] =>
  stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown)

const exactTaskFrame = (size: number) => {
  const empty = bytes.encode(encodeFrame(task(''))).byteLength
  return task('x'.repeat(size - empty))
}
const frameType = (value: unknown): string | undefined => {
  const type = typeof value === 'object' && value !== null ? Reflect.get(value, 'type') : undefined
  return typeof type === 'string' ? type : undefined
}
interface ArtifactResult {
  readonly conclusion_artifact: string
  readonly conclusion_bytes: number
  readonly conclusion_preview: string
}

const frames = (output: readonly string[]): readonly unknown[] => strictFrames(output.join(''))
const artifactResult = (value: unknown): ArtifactResult => {
  const artifact = typeof value === 'object' && value !== null ? Reflect.get(value, 'conclusion_artifact') : undefined
  const count = typeof value === 'object' && value !== null ? Reflect.get(value, 'conclusion_bytes') : undefined
  const preview = typeof value === 'object' && value !== null ? Reflect.get(value, 'conclusion_preview') : undefined
  if (typeof artifact !== 'string' || typeof count !== 'number' || typeof preview !== 'string') {
    throw new Error('Result did not include an artifact.')
  }
  return { conclusion_artifact: artifact, conclusion_bytes: count, conclusion_preview: preview }
}
const sessionPath = (value: unknown): string => {
  const path = typeof value === 'object' && value !== null ? Reflect.get(value, 'session_path') : undefined
  if (typeof path !== 'string') {
    throw new Error('Ready frame did not include a session path.')
  }
  return path
}

const startHarnessedWorker = (options: { readonly activeTools?: readonly string[]; readonly frame?: typeof config } = {}) => {
  const output: string[] = []
  const harness = workerHarness({ activeTools: options.activeTools })
  const worker = new SubagentWorker(
    {
      write: (value) => {
        output.push(value)
      },
    },
    harness.factory
  )
  return pipe(
    promise(() => worker.accept(options.frame ?? config)),
    Effect.andThen(promise(() => worker.accept(task('task body')))),
    Effect.andThen(promise(() => harness.promptStarted())),
    Effect.andThen(promise(() => harness.start())),
    Effect.as({ harness, output, worker })
  )
}
const sdkEvent = (type: AgentSessionEvent['type']): AgentSessionEvent => asNarrowed<AgentSessionEvent, object>({ type })

describe('sub-agent worker protocol', () => {
  it('accepts one closed strict-LF config frame', () => {
    const encoded = new TextEncoder().encode(encodeFrame(config))
    expect(parseParentFrame(encoded)).toEqual(config)
    expect(() => parseParentFrame(new TextEncoder().encode(JSON.stringify(config)))).toThrow(ProtocolError)
    expect(() => parseParentFrame(new TextEncoder().encode(`${JSON.stringify(config)}\r\n`))).toThrow(ProtocolError)
  })

  it('enforces strict framing at every boundary and rejects malformed parent input', () => {
    const exact = exactTaskFrame(MAX_FRAME_BYTES)
    expect(bytes.encode(encodeFrame(exact)).byteLength).toBe(MAX_FRAME_BYTES)
    expect(parseParentFrame(bytes.encode(encodeFrame(exact)))).toEqual(exact)
    const oversized = `${JSON.stringify(exactTaskFrame(MAX_FRAME_BYTES + 1))}\n`
    expect(() => new JsonlDecoder().push(bytes.encode(oversized))).toThrow(ProtocolError)
    for (const line of [
      '',
      '\r',
      '{not-json}',
      JSON.stringify({ ...config, extra: true }),
      JSON.stringify({ ...task('x'), extra: true }),
      JSON.stringify({ agent_id: 'agent', command_id: 'steer', extra: true, message: 'x', turn: 1, type: 'steer' }),
      JSON.stringify({ agent_id: 'agent', command_id: 'stop', extra: true, turn: 1, type: 'interrupt' }),
    ]) {
      expect(() => parseParentFrame(bytes.encode(`${line}\n`))).toThrow(ProtocolError)
    }
    expect(() => parseParentFrame(new Uint8Array([255, 10]))).toThrow(ProtocolError)
    const unfinished = new JsonlDecoder()
    unfinished.push(bytes.encode('{'))
    expect(() => unfinished.end()).toThrow(ProtocolError)
  })

  it('decodes chunk-split and multi-frame streams without accepting bare CR', () => {
    const encoded = bytes.encode(`${encodeFrame(config)}${encodeFrame(task('hello'))}`)
    const decoder = new JsonlDecoder()
    expect(decoder.push(encoded.slice(0, 7))).toEqual([])
    expect(decoder.push(encoded.slice(7))).toEqual([config, task('hello')])
    expect(() => new JsonlDecoder().push(bytes.encode(`${JSON.stringify(config)}\r\n`))).toThrow(ProtocolError)
  })

  it.effect('enforces config-first state and correlation before starting SDK work', () =>
    Effect.gen(function* () {
      const output: string[] = []
      const worker = new SubagentWorker({
        write: (frame) => {
          output.push(frame)
        },
      })
      yield* rejects(worker.accept(task('hello')))
      yield* promise(() => worker.accept(config))
      yield* rejects(worker.accept(config))
      yield* rejects(worker.accept({ ...config, agent_id: 'other' }))
      yield* rejects(worker.accept({ agent_id: 'other', command_id: 'stop', turn: 1, type: 'interrupt' }))
      yield* rejects(worker.accept({ agent_id: 'agent', command_id: 'steer', message: 'later', turn: 1, type: 'steer' }))
      yield* rejects(worker.accept({ agent_id: 'agent', command_id: 'stop', turn: 1, type: 'interrupt' }))
      expect(output).toEqual([])
    })
  )

  it.effect('fails on parent EOF in every non-terminal lifecycle state', () =>
    Effect.gen(function* () {
      const awaitingConfig = new SubagentWorker({ write: () => undefined })
      yield* rejects(awaitingConfig.parentEof())

      const awaitingTask = new SubagentWorker({ write: () => undefined })
      yield* promise(() => awaitingTask.accept(config))
      yield* rejects(awaitingTask.parentEof())

      const startingHarness = workerHarness()
      const starting = new SubagentWorker({ write: () => undefined }, startingHarness.factory)
      yield* promise(() => starting.accept(config))
      yield* promise(() => starting.accept(task('task body')))
      yield* promise(() => startingHarness.promptStarted())
      yield* rejects(starting.parentEof())
      expect(startingHarness.aborts()).toBe(1)

      const running = yield* startHarnessedWorker()
      yield* rejects(running.worker.parentEof())
      expect(running.harness.aborts()).toBe(1)
    })
  )

  it.effect('serializes lifecycle races, command correlation, and SDK progress through the harness', () =>
    Effect.gen(function* () {
      const { harness, output, worker } = yield* startHarnessedWorker()
      yield* promise(() => worker.accept({ agent_id: 'agent', command_id: 'steer-command', message: 'focus', turn: 1, type: 'steer' }))
      yield* promise(() => harness.emit(sdkEvent('message_update')))
      yield* promise(() => harness.emit(sdkEvent('tool_execution_start')))
      yield* promise(() => harness.emit(sdkEvent('tool_execution_end')))
      yield* promise(() => harness.settle('done'))
      yield* promise(() => worker.accept({ agent_id: 'agent', command_id: 'late-steer', message: 'late', turn: 1, type: 'steer' }))
      expect(frames(output)).toEqual([
        expect.objectContaining({ command_id: 'task-command', type: 'progress' }),
        expect.objectContaining({ command_id: 'task-command', type: 'ready' }),
        expect.objectContaining({ command_id: 'steer-command', type: 'steer_ack' }),
        expect.objectContaining({ activity: 'assistant_activity', type: 'progress' }),
        expect.objectContaining({ activity: 'tool_started', type: 'progress' }),
        expect.objectContaining({ activity: 'tool_finished', type: 'progress' }),
        { agent_id: 'agent', command_id: 'task-command', conclusion: 'done', context_tokens: 100, status: 'completed', turn: 1, type: 'result' },
        expect.objectContaining({ code: 'turn_settled', command_id: 'late-steer', status: 'completed', type: 'command_error' }),
      ])
      expect(harness.disposed()).toBe(1)
    })
  )

  it.effect('settles and exits when the terminal result write rejects', () =>
    Effect.gen(function* () {
      const harness = workerHarness()
      const worker = new SubagentWorker(
        {
          write: (value) => {
            if (frameType(JSON.parse(value)) === 'result') {
              return Promise.reject(new Error('broken parent pipe'))
            }
            return undefined
          },
        },
        harness.factory
      )
      yield* promise(() => worker.accept(config))
      yield* promise(() => worker.accept(task('task body')))
      yield* promise(() => harness.promptStarted())
      yield* promise(() => harness.start())
      yield* promise(() =>
        harness.settle('done').then(
          () => expect.unreachable(),
          () => undefined
        )
      )
      yield* promise(() => worker.waitForSettlement())
      expect(worker.state).toBe('exiting')
      expect(harness.disposed()).toBe(1)
    })
  )

  it.effect('continues terminal writes after a failed advisory progress frame', () =>
    Effect.gen(function* () {
      const output: string[] = []
      const harness = workerHarness()
      const worker = new SubagentWorker(
        {
          write: (value) => {
            const frame = JSON.parse(value) as unknown
            const activity = typeof frame === 'object' && frame !== null ? Reflect.get(frame, 'activity') : undefined
            if (frameType(frame) === 'progress' && activity === 'assistant_activity') {
              return Promise.reject(new Error('broken progress write'))
            }
            output.push(value)
            return undefined
          },
        },
        harness.factory
      )
      yield* promise(() => worker.accept(config))
      yield* promise(() => worker.accept(task('task body')))
      yield* promise(() => harness.promptStarted())
      yield* promise(() => harness.start())
      yield* promise(() =>
        harness.emit(sdkEvent('message_update')).then(
          () => expect.unreachable(),
          () => undefined
        )
      )
      yield* promise(() => harness.settle('done'))
      expect(frames(output).at(-1)).toEqual(expect.objectContaining({ conclusion: 'done', type: 'result' }))
    })
  )

  it.effect('reports rejected steering and interrupts without an acknowledgement', () =>
    Effect.gen(function* () {
      const rejected = yield* startHarnessedWorker()
      rejected.harness.rejectSteer('full')
      yield* promise(() => rejected.worker.accept({ agent_id: 'agent', command_id: 'steer-command', message: 'focus', turn: 1, type: 'steer' }))
      expect(frames(rejected.output).at(-1)).toEqual(
        expect.objectContaining({ code: 'queue_rejected', command_id: 'steer-command', type: 'command_error' })
      )

      const interrupted = yield* startHarnessedWorker()
      yield* promise(() => interrupted.worker.accept({ agent_id: 'agent', command_id: 'interrupt-command', turn: 1, type: 'interrupt' }))
      yield* promise(() => interrupted.harness.settle('late natural result'))
      expect(interrupted.harness.aborts()).toBe(1)
      expect(frames(interrupted.output)).toContainEqual({
        agent_id: 'agent',
        command_id: 'task-command',
        error: { code: 'interrupted', message: 'The sub-agent was interrupted.' },
        status: 'interrupted',
        turn: 1,
        type: 'result',
      })
      expect(frames(interrupted.output).some((frame) => frameType(frame) === 'steer_ack')).toBe(false)
    })
  )

  it.effect('maps provider errors and aborted model settlements to agent_failed', () =>
    Effect.gen(function* () {
      for (const stopReason of ['error', 'aborted'] as const) {
        const started = yield* startHarnessedWorker()
        yield* promise(() => started.harness.settle('unavailable', stopReason))
        expect(frames(started.output).at(-1)).toEqual(
          expect.objectContaining({ error: expect.objectContaining({ code: 'agent_failed' }), status: 'failed' })
        )
      }
    })
  )

  it.effect(
    'enforces output boundaries and writes relative artifacts at exact byte counts',
    () =>
      Effect.gen(function* () {
        const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'sub-agent-artifact-' })
        const runDir = bunPath.join(root, 'run')
        const artifactFrame = { ...config, run_dir: runDir }
        for (const conclusion of [
          'x'.repeat(MAX_INLINE_BYTES),
          'x'.repeat(MAX_INLINE_BYTES + 1),
          `${'x\n'.repeat(MAX_INLINE_LINES - 1)}x`,
          `${'x\n'.repeat(MAX_INLINE_LINES)}x`,
        ]) {
          const started = yield* startHarnessedWorker({ frame: artifactFrame })
          yield* promise(() => started.harness.settle(conclusion))
          const result = frames(started.output).at(-1)
          if (conclusion === 'x'.repeat(MAX_INLINE_BYTES) || conclusion === `${'x\n'.repeat(MAX_INLINE_LINES - 1)}x`) {
            expect(result).toEqual(expect.objectContaining({ conclusion, status: 'completed' }))
          } else {
            const artifact = artifactResult(result)
            expect(artifact.conclusion_artifact.includes('/')).toBe(false)
            expect(artifact.conclusion_bytes).toBe(bytes.encode(conclusion).byteLength)
            expect(bytes.encode(artifact.conclusion_preview).byteLength).toBeLessThanOrEqual(MAX_INLINE_BYTES)
            expect(artifact.conclusion_preview.split('\n').length).toBeLessThanOrEqual(MAX_INLINE_LINES)
            if (conclusion === 'x'.repeat(MAX_INLINE_BYTES + 1)) {
              expect(artifact.conclusion_preview).toBe('x'.repeat(MAX_INLINE_BYTES))
            }
            if (conclusion === `${'x\n'.repeat(MAX_INLINE_LINES)}x`) {
              expect(artifact.conclusion_preview).toBe(`${'x\n'.repeat(MAX_INLINE_LINES - 1)}x`)
            }
            expect(yield* bunFileSystem.readFileString(bunPath.join(runDir, artifact.conclusion_artifact))).toBe(conclusion)
          }
        }
        const exactLimit = yield* startHarnessedWorker({ frame: artifactFrame })
        yield* promise(() => exactLimit.harness.settle('x'.repeat(MAX_ARTIFACT_BYTES)))
        expect(frames(exactLimit.output).at(-1)).toEqual(expect.objectContaining({ conclusion_bytes: MAX_ARTIFACT_BYTES, status: 'completed' }))

        const multibyte = yield* startHarnessedWorker({ frame: artifactFrame })
        const multibyteConclusion = '€'.repeat(Math.ceil(MAX_INLINE_BYTES / 3))
        yield* promise(() => multibyte.harness.settle(multibyteConclusion))
        const multibyteArtifact = artifactResult(frames(multibyte.output).at(-1))
        expect(multibyteArtifact.conclusion_bytes).toBe(bytes.encode(multibyteConclusion).byteLength)
        expect(multibyteArtifact.conclusion_preview).toBe('€'.repeat(Math.floor(MAX_INLINE_BYTES / 3)))

        const tooLarge = yield* startHarnessedWorker({ frame: artifactFrame })
        yield* promise(() => tooLarge.harness.settle('x'.repeat(MAX_ARTIFACT_BYTES + 1)))
        expect(frames(tooLarge.output).at(-1)).toEqual(
          expect.objectContaining({ error: expect.objectContaining({ code: 'result_too_large' }), status: 'failed' })
        )
      }),
    20_000
  )

  it.effect('builds artifact previews without repeatedly encoding their accumulated prefix', () =>
    Effect.gen(function* () {
      const conclusion = 'x'.repeat(MAX_INLINE_BYTES + 1)
      let encodedConclusionBytes = 0
      const originalEncode = Reflect.get(TextEncoder.prototype, 'encode')
      TextEncoder.prototype.encode = function encode(input = '') {
        if (/^x+$/.test(input)) {
          encodedConclusionBytes += input.length
        }
        return originalEncode.call(this, input)
      }
      try {
        const root = yield* bunFileSystem.makeTempDirectory({ prefix: 'sub-agent-preview-' })
        const started = yield* startHarnessedWorker({ frame: { ...config, run_dir: bunPath.join(root, 'run') } })
        yield* promise(() => started.harness.settle(conclusion))
        expect(artifactResult(frames(started.output).at(-1)).conclusion_preview).toBe('x'.repeat(MAX_INLINE_BYTES))
        expect(encodedConclusionBytes).toBeLessThanOrEqual(conclusion.length * 3)
      } finally {
        TextEncoder.prototype.encode = originalEncode
      }
    })
  )

  it.effect('exits without a terminal frame when boot cannot validate active tools', () =>
    Effect.gen(function* () {
      const output: string[] = []
      const harness = workerHarness({ activeTools: ['configured', 'extension'] })
      const worker = new SubagentWorker(
        {
          write: (value) => {
            output.push(value)
          },
        },
        harness.factory
      )
      const frame = { ...config, worker: { ...config.worker, tools: ['configured'] } }
      yield* promise(() => worker.accept(frame))
      yield* promise(() => worker.accept(task('task body')))
      yield* promise(() =>
        worker.waitForSettlement().then(
          () => expect.unreachable(),
          (error: unknown) => expect(error).toBeInstanceOf(Error)
        )
      )
      expect(harness.prompt()).toBeUndefined()
      expect(harness.disposed()).toBe(1)
      expect(output).toEqual([])
    })
  )

  it.effect('disposes a session created after the parent stream ended during startup', () =>
    Effect.gen(function* () {
      const output: string[] = []
      const harness = workerHarness({ holdCreate: true })
      const worker = new SubagentWorker(
        {
          write: (value) => {
            output.push(value)
          },
        },
        harness.factory
      )
      yield* promise(() => worker.accept(config))
      yield* promise(() => worker.accept(task('task body')))
      const ended = worker.parentEof()
      harness.releaseCreate()
      yield* rejects(ended)
      yield* promise(() =>
        worker.waitForSettlement().then(
          () => expect.unreachable(),
          (error: unknown) => expect(error).toBeInstanceOf(Error)
        )
      )
      expect(harness.prompt()).toBeUndefined()
      expect(harness.disposed()).toBe(1)
      expect(output).toEqual([])
    })
  )

  it.effect('bounds an oversized failure message so the frame stays encodable', () =>
    Effect.gen(function* () {
      const rejected = yield* startHarnessedWorker()
      rejected.harness.rejectSteer('x'.repeat(2 * MAX_FRAME_BYTES))
      yield* promise(() => rejected.worker.accept({ agent_id: 'agent', command_id: 'steer-command', message: 'focus', turn: 1, type: 'steer' }))
      const frame = frames(rejected.output).at(-1)
      expect(frame).toEqual(expect.objectContaining({ code: 'queue_rejected', command_id: 'steer-command', type: 'command_error' }))
      expect(bytes.encode(encodeFrame(frame)).byteLength).toBeLessThanOrEqual(MAX_FRAME_BYTES)
    })
  )

  it.scoped(
    'runs the real worker entrypoint against a loopback provider without stdout contamination',
    () =>
      Effect.gen(function* () {
        const root = yield* bunFileSystem.makeTempDirectoryScoped({ prefix: 'sub-agent-worker-' })
        const agentDir = bunPath.join(root, 'agent')
        const runDir = bunPath.join(root, 'run')
        const sessions = bunPath.join(root, 'sessions')
        const provider = yield* Effect.acquireRelease(
          Effect.sync(() => startFakeProvider('deterministic conclusion')),
          (active) => Effect.sync(active.close)
        )
        const models = {
          providers: {
            fake: {
              api: 'openai-completions',
              apiKey: 'test-key',
              baseUrl: `${provider.url}/v1`,
              models: [{ contextWindow: 8192, id: 'fake-model', maxTokens: 1024 }],
            },
          },
        }
        yield* bunFileSystem.makeDirectory(agentDir, { recursive: true })
        yield* promise(() => Bun.write(bunPath.join(agentDir, 'models.json'), JSON.stringify(models)))
        const entrypoint = new URL('../../../src/features/sub_agents/worker.ts', import.meta.url).pathname
        const frame = {
          ...config,
          run_dir: runDir,
          session: { expected_dir: sessions, mode: 'create' as const },
          worker: { ...config.worker, agentDir, cwd: '/tmp', model: 'fake-model', prompt: 'exact prompt', provider: 'fake' },
        }
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
        yield* promise(() => Promise.resolve(child.stdin.write(encodeFrame(frame))))
        yield* promise(() => Promise.resolve(child.stdin.write(encodeFrame(task('say hello')))))
        yield* promise(() => Promise.resolve(child.stdin.flush()))
        const stdout = yield* promise(() => new Response(child.stdout).text())
        const stderr = yield* promise(() => new Response(child.stderr).text())
        const exitCode = yield* promise(() => child.exited)
        expect(exitCode, stderr).toBe(0)
        const childFrames = strictFrames(stdout)
        const readyIndex = childFrames.findIndex((candidate) => frameType(candidate) === 'ready')
        const resultIndex = childFrames.findIndex((candidate) => frameType(candidate) === 'result')
        expect(readyIndex, stdout).toBeGreaterThanOrEqual(0)
        expect(resultIndex).toBeGreaterThan(readyIndex)
        expect(childFrames[resultIndex]).toEqual({
          agent_id: 'agent',
          command_id: 'task-command',
          conclusion: 'deterministic conclusion',
          context_tokens: 9,
          status: 'completed',
          turn: 1,
          type: 'result',
        })
        const ready = childFrames[readyIndex]
        const path = sessionPath(ready)
        expect(path.startsWith(`${sessions}/`)).toBe(true)
        expect(yield* bunFileSystem.readFileString(path)).toContain('session')
      }),
    20_000
  )
})
