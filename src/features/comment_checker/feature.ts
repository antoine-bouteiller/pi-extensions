import { execFile } from 'node:child_process'

import { type ExtensionAPI, type ExtensionContext, type ToolResultEvent } from '@earendil-works/pi-coding-agent'
import { type Cause, Context, Effect, Function } from 'effect'

import { type AppRuntime } from '@/shared/effect/app_services.js'
import { makeEventHandler } from '@/shared/effect/runtime.js'
import { isRecord } from '@/shared/utils/records.js'

const MAX_OUTPUT_BYTES = 64 * 1024
const PROCESS_TIMEOUT_MS = 30_000

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

interface CommandRunnerShape {
  readonly run: (input: HookInput) => Effect.Effect<CheckerResult, Cause.UnknownError>
}

class CommandRunner extends Context.Service<CommandRunner, CommandRunnerShape>()('pi-extensions/features/comment_checker/feature/CommandRunner') {}

const record = (value: unknown): Record<string, unknown> | undefined => (isRecord(value) ? value : undefined)

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

const runCommentChecker = (input: HookInput): Effect.Effect<CheckerResult> =>
  Effect.callback<CheckerResult>((resume) => {
    const child = execFile('comment-checker', ['check'], { maxBuffer: MAX_OUTPUT_BYTES, timeout: PROCESS_TIMEOUT_MS }, (error, stdout, stderr) => {
      let exitCode: number | undefined = 0
      if (typeof error?.code === 'number') {
        exitCode = error.code
      } else if (error !== null) {
        exitCode = undefined
      }
      resume(Effect.succeed({ exitCode, stderr, stdout }))
    })
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(JSON.stringify(input))
    return Effect.sync(() => {
      child.kill()
    })
  }).pipe(
    Effect.timeoutOrElse({
      duration: PROCESS_TIMEOUT_MS,
      orElse: () => Effect.succeed({ exitCode: undefined, stderr: '', stdout: '' }),
    })
  )

const productionRunner: CommandRunnerShape = { run: runCommentChecker }

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
    if (warning === '') {
      return undefined
    }

    return {
      content: [...event.content, { text: `\n\n${warning}`, type: 'text' as const }],
    }
  })

export const register: {
  (runtime: AppRuntime, runner?: CheckerRunner): (pi: ExtensionAPI) => void
  (pi: ExtensionAPI, runtime: AppRuntime, runner?: CheckerRunner): void
} = Function.dual(
  (args) => typeof args[0].on === 'function',
  (pi: ExtensionAPI, runtime: AppRuntime, runner?: CheckerRunner): void => {
    const commandRunner: CommandRunnerShape = runner === undefined ? productionRunner : { run: (input) => Effect.tryPromise(() => runner(input)) }

    pi.on(
      'tool_result',
      makeEventHandler(runtime)((event: ToolResultEvent, ctx: ExtensionContext) =>
        checkerResult(event, ctx).pipe(Effect.provideService(CommandRunner, commandRunner))
      )
    )
  }
)
