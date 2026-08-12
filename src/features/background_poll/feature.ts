import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Clock, Context, Deferred, Effect, Exit, type Fiber, Function, HashMap, Option, Ref, Scope, Semaphore } from 'effect'
import { Type, type Static } from 'typebox'

import { type AppRuntime } from '@/shared/effect/app_services.js'
import { ToolFailure } from '@/shared/effect/errors.js'
import { createStatusChannel } from '@/shared/state/status_bar.js'
import { isEmptyString, isTrue } from '@/shared/utils/predicates.js'
import { truncateOutput, truncationNotice } from '@/shared/utils/tool_output.js'

const status = createStatusChannel('background-poll', { icon: '⏳', priority: 20, tone: 'muted' })

const DEFAULT_INTERVAL_SECONDS = 10
const DEFAULT_TIMEOUT_SECONDS = 60 * 60
const POLL_COMMAND_TIMEOUT_MS = 30_000

const BackgroundPollParams = Type.Object({
  command: Type.String({
    description: 'Shell command to run repeatedly. Exit 0 means the awaited result is ready; any other exit code retries.',
  }),
  interval_seconds: Type.Optional(
    Type.Number({
      description: `Seconds between attempts (default: ${DEFAULT_INTERVAL_SECONDS}).`,
      maximum: 3600,
      minimum: 1,
    })
  ),
  label: Type.Optional(Type.String({ description: 'Short description of the result being awaited.' })),
  timeout_seconds: Type.Optional(
    Type.Number({
      description: `Maximum total wait in seconds (default: ${DEFAULT_TIMEOUT_SECONDS}).`,
      maximum: 86_400,
      minimum: 1,
    })
  ),
})

type BackgroundPollInput = Static<typeof BackgroundPollParams>

interface PollResultDetails {
  taskId: string
  label: string
  command: string
  attempts: number
  elapsedMs: number
  outcome: 'completed' | 'timed-out' | 'error'
  exitCode?: number
}

interface PollCommandResult {
  readonly code: number
  readonly stderr: string
  readonly stdout: string
}

export interface PollLoopOptions {
  readonly command: string
  readonly exec: (timeoutMs: number) => Effect.Effect<PollCommandResult, ToolFailure>
  readonly intervalMs: number
  readonly label: string
  readonly taskId: string
  readonly timeoutMs: number
}

export interface PollLoopResult {
  readonly details: PollResultDetails
  readonly output: string
}

export const formatPollOutput: {
  (stderr: string): (stdout: string) => string
  (stdout: string, stderr: string): string
} = Function.dual(2, (stdout: string, stderr: string): string => {
  const output = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n')
  if (isEmptyString(output)) {
    return '(command produced no output)'
  }

  const truncated = truncateOutput(output, {
    from: 'tail',
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  })
  return truncated.truncated ? truncated.content + truncationNotice(truncated, { from: 'tail' }) : truncated.content
})

export const runPollLoop = (options: PollLoopOptions): Effect.Effect<PollLoopResult> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    const deadline = startedAt + options.timeoutMs
    let attempts = 0
    let lastOutput = '(no poll attempt completed)'

    while (true) {
      const now = yield* Clock.currentTimeMillis
      if (now >= deadline) {
        return {
          details: {
            attempts,
            command: options.command,
            elapsedMs: now - startedAt,
            label: options.label,
            outcome: 'timed-out' as const,
            taskId: options.taskId,
          },
          output: lastOutput,
        }
      }

      attempts += 1
      const commandResult = yield* Effect.result(options.exec(Math.min(POLL_COMMAND_TIMEOUT_MS, Math.max(1, deadline - now))))
      if (commandResult._tag === 'Failure') {
        const failedAt = yield* Clock.currentTimeMillis
        return {
          details: {
            attempts,
            command: options.command,
            elapsedMs: failedAt - startedAt,
            label: options.label,
            outcome: 'error' as const,
            taskId: options.taskId,
          },
          output: commandResult.failure.message,
        }
      }

      lastOutput = formatPollOutput(commandResult.success.stdout, commandResult.success.stderr)
      if (commandResult.success.code === 0) {
        const completedAt = yield* Clock.currentTimeMillis
        return {
          details: {
            attempts,
            command: options.command,
            elapsedMs: completedAt - startedAt,
            exitCode: commandResult.success.code,
            label: options.label,
            outcome: 'completed' as const,
            taskId: options.taskId,
          },
          output: lastOutput,
        }
      }

      const afterAttempt = yield* Clock.currentTimeMillis
      const remaining = deadline - afterAttempt
      if (remaining > 0) {
        yield* Effect.sleep(Math.min(Math.max(1, options.intervalMs), remaining))
      }
    }
  })

interface PollStateShape {
  readonly mutex: Semaphore.Semaphore
  readonly sessionScope: Ref.Ref<Option.Option<Scope.Closeable>>
  readonly shuttingDown: Ref.Ref<boolean>
  readonly tasks: Ref.Ref<HashMap.HashMap<string, Fiber.Fiber<void>>>
}

class PollState extends Context.Service<PollState, PollStateShape>()('pi-extensions/features/background_poll/feature/PollState') {}

const updateStatus = (state: PollStateShape, ctx: ExtensionContext): Effect.Effect<void> =>
  Effect.gen(function* () {
    const count = HashMap.size(yield* Ref.get(state.tasks))
    yield* Effect.sync(() => {
      if (count === 0) {
        status.clear(ctx)
      } else {
        status.set(ctx, { text: `${count} background poll${count === 1 ? '' : 's'}` })
      }
    })
  })

const OUTCOME_HEADLINES: Record<PollResultDetails['outcome'], string> = {
  completed: 'Background poll completed',
  error: 'Background poll failed',
  'timed-out': 'Background poll timed out',
}

const wakeAgent = (
  pi: ExtensionAPI,
  state: PollStateShape,
  sessionScope: Scope.Closeable,
  result: PollLoopResult,
  ctx: ExtensionContext
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const current = yield* Ref.get(state.sessionScope)
    if (Option.isNone(current) || current.value !== sessionScope) {
      return
    }

    const { details, output } = result
    const headline = `${OUTCOME_HEADLINES[details.outcome]}: ${details.label}`
    yield* Effect.sync(() => {
      pi.sendMessage(
        {
          content: `${headline}\nTask: ${details.taskId}\nAttempts: ${details.attempts}\n\n${output}`,
          customType: 'background-poll-result',
          details,
          display: true,
        },
        { deliverAs: 'followUp', triggerTurn: true }
      )
      if (ctx.hasUI) {
        ctx.ui.notify(headline, details.outcome === 'completed' ? 'info' : 'warning')
      }
    })
  })

const startSession = Effect.gen(function* () {
  const state = yield* PollState
  yield* state.mutex.withPermits(1)(
    Effect.gen(function* () {
      const next = yield* Scope.make()
      yield* Ref.set(state.shuttingDown, false)
      const previous = yield* Ref.getAndSet(state.sessionScope, Option.some(next))
      if (Option.isSome(previous)) {
        yield* Scope.close(previous.value, Exit.void)
      }
    })
  )
})

const stopSession = (ctx: ExtensionContext): Effect.Effect<void, never, PollState> =>
  Effect.gen(function* () {
    const state = yield* PollState
    yield* state.mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* Ref.set(state.shuttingDown, true)
        const current = yield* Ref.getAndSet(state.sessionScope, Option.none())
        if (Option.isSome(current)) {
          yield* Scope.close(current.value, Exit.void)
        }
        yield* Ref.set(state.tasks, HashMap.empty())
        yield* updateStatus(state, ctx)
      })
    )
  })

const registerPoll = (
  pi: ExtensionAPI,
  toolCallId: string,
  params: BackgroundPollInput,
  ctx: ExtensionContext
): Effect.Effect<void, ToolFailure, PollState> =>
  Effect.gen(function* () {
    const state = yield* PollState
    yield* state.mutex.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(state.sessionScope)
        if (Option.isNone(current)) {
          const message = (yield* Ref.get(state.shuttingDown))
            ? 'Cannot register a background poll during shutdown'
            : 'Cannot register a background poll without an active session'
          return yield* ToolFailure.make({ message })
        }

        const sessionScope = current.value
        const taskId = `poll-${toolCallId}`
        const label = params.label?.trim() || params.command
        const start = yield* Deferred.make<void>()
        const loop = Deferred.await(start).pipe(
          Effect.andThen(
            runPollLoop({
              command: params.command,
              exec: (timeoutMs) =>
                Effect.tryPromise({
                  catch: (cause) => ToolFailure.make({ cause, message: cause instanceof Error ? cause.message : String(cause) }),
                  try: (signal) => pi.exec('sh', ['-lc', params.command], { signal, timeout: timeoutMs }),
                }),
              intervalMs: (params.interval_seconds ?? DEFAULT_INTERVAL_SECONDS) * 1000,
              label,
              taskId,
              timeoutMs: (params.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
            })
          ),
          Effect.flatMap((result) => wakeAgent(pi, state, sessionScope, result, ctx)),
          Effect.ensuring(
            Effect.gen(function* () {
              yield* Ref.update(state.tasks, HashMap.remove(taskId))
              yield* updateStatus(state, ctx)
            })
          )
        )
        const fiber = yield* Effect.forkIn(loop, sessionScope)
        yield* Ref.update(state.tasks, HashMap.set(taskId, fiber))
        yield* updateStatus(state, ctx)
        yield* Deferred.succeed(start, undefined)
        return undefined
      })
    )
  })

const registerImpl = (pi: ExtensionAPI, runtime: AppRuntime): void => {
  const pollState: PollStateShape = Effect.runSync(
    Effect.gen(function* () {
      return {
        mutex: yield* Semaphore.make(1),
        sessionScope: yield* Ref.make<Option.Option<Scope.Closeable>>(Option.none()),
        shuttingDown: yield* Ref.make(false),
        tasks: yield* Ref.make(HashMap.empty<string, Fiber.Fiber<void>>()),
      }
    })
  )

  pi.registerTool({
    description:
      'Register a shell command that is polled in the background until it exits successfully. The current agent run can end completely; completion, timeout, or failure automatically wakes the agent with the final output. Output is truncated to 50KB or 2000 lines.',
    // oxlint-disable-next-line effecttsgo/async-function -- Pi awaits the value returned by `execute`, so this boundary must stay a promise.
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      await runtime.runPromise(
        Effect.suspend(() =>
          isTrue(signal?.aborted)
            ? ToolFailure.make({ message: 'Background poll registration was cancelled' })
            : registerPoll(pi, toolCallId, params, ctx)
        ).pipe(Effect.provideService(PollState, pollState))
      )
      const taskId = `poll-${toolCallId}`
      const label = params.label?.trim() || params.command
      return {
        content: [
          {
            text: `Registered background poll ${taskId} (${label}). Stop now; the agent will be woken automatically when it completes, times out, or fails. Do not poll it manually.`,
            type: 'text' as const,
          },
        ],
        details: {
          command: params.command,
          intervalSeconds: params.interval_seconds ?? DEFAULT_INTERVAL_SECONDS,
          label,
          taskId,
          timeoutSeconds: params.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
        },
        terminate: true,
      }
    },
    label: 'Background Poll',
    name: 'background_poll',
    parameters: BackgroundPollParams,
    promptGuidelines: [
      'Use background_poll for long-running external work that can be checked with a repeatable shell command. Make the command exit 0 only when the awaited result is ready, then end the response; background_poll wakes the agent automatically.',
      'Do not manually poll after registering background_poll. Call background_poll in a tool-only turn after finishing all other immediate work so the agent can stop until the result arrives.',
    ],
    promptSnippet: 'Wait for an asynchronous condition without repeatedly polling or keeping the agent running',
  })

  pi.on('session_start', () => runtime.runPromise(startSession.pipe(Effect.provideService(PollState, pollState))))
  pi.on('session_shutdown', (_event, ctx) => runtime.runPromise(stopSession(ctx).pipe(Effect.provideService(PollState, pollState))))
}

export const register: {
  (runtime: AppRuntime): (pi: ExtensionAPI) => void
  (pi: ExtensionAPI, runtime: AppRuntime): void
} = Function.dual((args) => typeof args[0].on === 'function', registerImpl)
