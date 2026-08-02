import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'

import { isProtectedPath } from '../shared/protected_paths'
import { createStatusChannel } from '../shared/status_bar'
import { ALL_PATTERNS, COMMAND_EXCERPT_CONTEXT_LINES, COMMAND_EXCERPT_MAX_LENGTH, SAFETY_STATUS_KEY } from './constants'

const status = createStatusChannel(SAFETY_STATUS_KEY, {
  icon: '🛡️',
  priority: 10,
  tone: 'success',
})

const commandExcerpt = (command: string, pattern: RegExp): string => {
  const lines = command.split(/\r?\n/)
  const matchedIndex = Math.max(
    0,
    lines.findIndex((line) => pattern.test(line))
  )
  const start = Math.max(0, matchedIndex - COMMAND_EXCERPT_CONTEXT_LINES)
  const end = Math.min(lines.length, matchedIndex + COMMAND_EXCERPT_CONTEXT_LINES + 1)
  return lines
    .slice(start, end)
    .map((line, offset) => {
      const lineNumber = start + offset + 1
      const marker = start + offset === matchedIndex ? '>' : ' '
      const displayed = line.length > COMMAND_EXCERPT_MAX_LENGTH ? `${line.slice(0, COMMAND_EXCERPT_MAX_LENGTH)}…` : line
      return `${marker} ${lineNumber}: ${displayed}`
    })
    .join('\n')
}

interface ConfirmRiskOptions {
  pi: ExtensionAPI
  ctx: ExtensionContext
  label: string
  message: string
}

const confirmRisk = async ({ pi, ctx, label, message }: ConfirmRiskOptions): Promise<{ block: true; reason: string } | undefined> => {
  if (!ctx.hasUI) {
    return { block: true, reason: `${label} blocked (non-interactive mode)` }
  }

  pi.events.emit('herdr:blocked', { active: true, label })
  try {
    const allowed = await ctx.ui.confirm(`⚠️ ${label}`, `${message}\n\nAllow this operation?`)
    return allowed ? undefined : { block: true, reason: `${label} — blocked by user` }
  } finally {
    pi.events.emit('herdr:blocked', { active: false })
  }
}

export default function safetyGuard(pi: ExtensionAPI) {
  // Biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Rule dispatch is intentionally centralized
  pi.on('tool_call', async (event, ctx) => {
    let command: string | undefined
    if (isToolCallEventType('bash', event)) {
      ;({ command } = event.input)
    } else if (event.toolName === 'background_poll') {
      const { command: rawCommand } = event.input as { command?: unknown }
      if (typeof rawCommand === 'string') {
        command = rawCommand
      }
    }

    if (command !== undefined) {
      // This scanner catches common command spellings for UX and policy
      // Guidance. It is intentionally not presented as a shell parser or
      // Sandbox; destructive custom tools must enforce safety themselves.
      for (const rule of ALL_PATTERNS) {
        if (!rule.pattern.test(command)) {
          continue
        }
        if (rule.severity === 'critical') {
          if (ctx.hasUI) {
            ctx.ui.notify(`🚫 Blocked: ${rule.label}`, 'error')
          }
          return {
            block: true,
            reason: `CRITICAL (best-effort command policy): ${rule.label} — recognized command blocked`,
          }
        }

        return confirmRisk({
          ctx,
          label: rule.label,
          message: `Category: ${rule.category}\n\n${commandExcerpt(command, rule.pattern)}`,
          pi,
        })
      }
      return undefined
    }

    let protectedOperation: 'edit' | 'read' | 'write' | undefined
    let protectedPath: string | undefined
    if (isToolCallEventType('read', event)) {
      protectedOperation = 'read'
      protectedPath = event.input.path
    } else if (isToolCallEventType('write', event)) {
      protectedOperation = 'write'
      protectedPath = event.input.path
    } else if (isToolCallEventType('edit', event)) {
      protectedOperation = 'edit'
      protectedPath = event.input.path
    }

    if (protectedOperation === undefined || protectedPath === undefined || !(await isProtectedPath(protectedPath, ctx.cwd))) {
      return undefined
    }

    const label = `Protected file ${protectedOperation}`
    return confirmRisk({ ctx, label, message: `${protectedOperation} ${protectedPath}`, pi })
  })

  pi.on('session_start', async (_event, ctx) => {
    status.set(ctx, { text: 'cmd-guard' })
  })
}
