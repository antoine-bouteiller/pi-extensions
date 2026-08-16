import { type ExtensionContext, type ToolResultEvent } from '@earendil-works/pi-coding-agent'
import { Cause, Context, Effect, Stream } from 'effect'
import { type PlatformError } from 'effect/PlatformError'
import { ChildProcess } from 'effect/unstable/process'

import { nodeChildProcessSpawner } from '#shared/effect/node_services'
import { jsonText, type JsonObject } from '#shared/utils/json'
import { isEmptyString } from '#shared/utils/predicates'
import { isRecord } from '#shared/utils/records'

const MAX_OUTPUT_BYTES = 64 * 1024
const PROCESS_TIMEOUT_MS = 30_000
const EMPTY_CHECKER_RESULT: CheckerResult = { exitCode: undefined, stderr: '', stdout: '' }

interface CheckerEdit {
  old_string: string
  new_string: string
}

interface HookInput {
  session_id: string
  tool_name: 'Write' | 'MultiEdit'
  transcript_path: string
  cwd: string
  hook_event_name: 'PostToolUse'
  tool_input: {
    file_path: string
    content?: string
    edits?: CheckerEdit[]
  }
}

interface CheckerResult {
  exitCode: number | undefined
  stdout: string
  stderr: string
}

export type CheckerRunner = (input: HookInput) => Promise<CheckerResult>

interface CommandRunnerApi {
  readonly run: (input: HookInput) => Effect.Effect<CheckerResult, Cause.UnknownError>
}

class CommandRunner extends Context.Service<CommandRunner, CommandRunnerApi>()('pi-extensions/features/comment_checker/checker/CommandRunner') {}

const record = (value: unknown): JsonObject | undefined => (isRecord(value) ? value : undefined)

const hookInput = (event: ToolResultEvent, ctx: ExtensionContext): HookInput | undefined => {
  if (event.isError) {
    return undefined
  }

  const input = record(event.input)
  if (input === undefined || typeof input.path !== 'string') {
    return undefined
  }
  const { path } = input

  const base = {
    cwd: ctx.cwd,
    hook_event_name: 'PostToolUse' as const,
    session_id: ctx.sessionManager.getSessionId(),
    transcript_path: '',
  }

  if (event.toolName === 'write' && typeof input.content === 'string') {
    return {
      ...base,
      tool_input: { content: input.content, file_path: path },
      tool_name: 'Write',
    }
  }

  if (event.toolName !== 'edit' || !Array.isArray(input.edits)) {
    return undefined
  }

  const edits = input.edits.flatMap((value): CheckerEdit[] => {
    const edit = record(value)
    return typeof edit?.oldText === 'string' && typeof edit.newText === 'string' ? [{ new_string: edit.newText, old_string: edit.oldText }] : []
  })
  if (edits.length === 0) {
    return undefined
  }

  return {
    ...base,
    tool_input: { edits, file_path: path },
    tool_name: 'MultiEdit',
  }
}

interface OutputChunks {
  readonly chunks: Uint8Array[]
  readonly size: number
}

const appendChunk = (output: OutputChunks, chunk: Uint8Array, size: number): OutputChunks => {
  output.chunks.push(chunk)
  return { chunks: output.chunks, size }
}

const collectOutput = (stream: Stream.Stream<Uint8Array, PlatformError>): Effect.Effect<string, PlatformError | Cause.UnknownError> =>
  Stream.runFoldEffect(
    stream,
    (): OutputChunks => ({ chunks: [], size: 0 }),
    (output, chunk) => {
      const size = output.size + chunk.byteLength
      return size > MAX_OUTPUT_BYTES
        ? Effect.fail(new Cause.UnknownError(undefined, `Comment checker output exceeded ${MAX_OUTPUT_BYTES} bytes`))
        : Effect.succeed(appendChunk(output, chunk, size))
    }
  ).pipe(Effect.map(({ chunks }) => Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString()))

const runCommentChecker = (input: HookInput, executable = 'comment-checker'): Effect.Effect<CheckerResult> =>
  Effect.scoped(
    Effect.gen(function* () {
      const command = ChildProcess.make(executable, ['check'], {
        detached: false,
        forceKillAfter: 1000,
        stderr: 'pipe',
        stdin: { endOnDone: true, stream: Stream.succeed(new TextEncoder().encode(jsonText(input))) },
        stdout: 'pipe',
      })
      const child = yield* nodeChildProcessSpawner.spawn(command)
      const { exitCode, stderr, stdout } = yield* Effect.all(
        {
          exitCode: child.exitCode,
          stderr: collectOutput(child.stderr),
          stdout: collectOutput(child.stdout),
        },
        { concurrency: 'unbounded' }
      )
      return { exitCode: Number(exitCode), stderr, stdout }
    })
  ).pipe(
    Effect.timeoutOrElse({ duration: PROCESS_TIMEOUT_MS, orElse: () => Effect.succeed(EMPTY_CHECKER_RESULT) }),
    Effect.orElseSucceed(() => EMPTY_CHECKER_RESULT)
  )

export const makeCommentCheckerRunner =
  (executable: string): CheckerRunner =>
  (input) =>
    Effect.runPromise(runCommentChecker(input, executable))

const productionRunner: CommandRunnerApi = { run: runCommentChecker }

const checkerResult = (
  event: ToolResultEvent,
  ctx: ExtensionContext
): Effect.Effect<{ content: ToolResultEvent['content'] } | undefined, Cause.UnknownError, CommandRunner> =>
  Effect.gen(function* () {
    const input = hookInput(event, ctx)
    if (input === undefined) {
      return undefined
    }

    const runner = yield* CommandRunner
    const result = yield* runner.run(input)
    if (result.exitCode !== 2) {
      return undefined
    }

    const warning = (result.stderr || result.stdout).trim()
    if (isEmptyString(warning)) {
      return undefined
    }

    return {
      content: [...event.content, { text: `\n\n${warning}`, type: 'text' as const }],
    }
  })

export const makeCheckerHandler = (
  runner?: CheckerRunner
): ((event: ToolResultEvent, ctx: ExtensionContext) => Effect.Effect<{ content: ToolResultEvent['content'] } | undefined, Cause.UnknownError>) => {
  const commandRunner: CommandRunnerApi = runner === undefined ? productionRunner : { run: (input) => Effect.tryPromise(() => runner(input)) }

  return (event, ctx) => checkerResult(event, ctx).pipe(Effect.provideService(CommandRunner, commandRunner))
}
