import { execFile } from 'node:child_process'

import { type ExtensionAPI, type ExtensionContext, type ToolResultEvent } from '@earendil-works/pi-coding-agent'

import { isRecord } from '../shared/records.js'

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

const record = (value: unknown): Record<string, unknown> | undefined => (isRecord(value) ? value : undefined)

const hookInput = (event: ToolResultEvent, ctx: ExtensionContext): HookInput | undefined => {
  if (event.isError) {
    return undefined
  }

  const input = record(event.input)
  if (!input || typeof input.path !== 'string') {
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

const runCommentChecker = (input: HookInput): Promise<CheckerResult> =>
  new Promise((resolve) => {
    const child = execFile('comment-checker', ['check'], { maxBuffer: MAX_OUTPUT_BYTES, timeout: PROCESS_TIMEOUT_MS }, (error, stdout, stderr) => {
      let exitCode: number | undefined = 0
      if (typeof error?.code === 'number') {
        exitCode = error.code
      } else if (error) {
        exitCode = undefined
      }
      resolve({
        exitCode,
        stderr,
        stdout,
      })
    })
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(JSON.stringify(input))
  })

export default function commentChecker(pi: ExtensionAPI, runner: CheckerRunner = runCommentChecker) {
  pi.on('tool_result', async (event, ctx) => {
    const input = hookInput(event, ctx)
    if (!input) {
      return undefined
    }

    const result = await runner(input)
    if (result.exitCode !== 2) {
      return undefined
    }

    const warning = (result.stderr || result.stdout).trim()
    if (!warning) {
      return undefined
    }

    return {
      content: [...event.content, { text: `\n\n${warning}`, type: 'text' as const }],
    }
  })
}
