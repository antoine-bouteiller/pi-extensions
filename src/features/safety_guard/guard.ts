import { isToolCallEventType, type ExtensionContext, type ToolCallEvent, type ToolCallEventResult } from '@earendil-works/pi-coding-agent'
import { Cause, Effect, Match } from 'effect'
import { type FileSystem } from 'effect/FileSystem'
import { type PlatformError } from 'effect/PlatformError'

import { parseSimpleRm, validateSafeRmTargets, type SafeRmToolParams } from '#features/safe_rm/remove'
import { StatusBar } from '#shared/effect/app_services'
import { Pi, Ui } from '#shared/effect/pi_services'
import { resolveProtectedPathEffect } from '#shared/utils/protected_paths'

import { ALL_PATTERNS, COMMAND_EXCERPT_CONTEXT_LINES, COMMAND_EXCERPT_MAX_LENGTH, SAFETY_STATUS_KEY, SHELL_DELETION_PATTERN } from './constants'
import { commandSegments, maskProse } from './scan'

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

const allow = undefined

type GuardDecision =
  | { readonly _tag: 'Allow' }
  | { readonly _tag: 'Block'; readonly reason: string; readonly notifyLabel?: string }
  | { readonly _tag: 'Confirm'; readonly label: string; readonly message: string }

/**
 * A compound command is routable when every deletion it contains is a literal `rm` that safe_rm
 * could have expressed itself. Those targets are then validated with safe_rm's own rules, and the
 * shell command runs unchanged so its ordering is preserved.
 *
 * ponytail: validation happens before the shell runs, so it is not a TOCTOU fence like the tool
 * path; route deletions through safe_rm itself if a hostile local process is in scope.
 */
const routeDeletions = (scannedCommand: string): SafeRmToolParams[] | undefined => {
  const routes: SafeRmToolParams[] = []
  for (const segment of commandSegments(scannedCommand)) {
    if (!SHELL_DELETION_PATTERN.pattern.test(segment)) {
      continue
    }
    const route = parseSimpleRm(segment)
    if (route === undefined) {
      return undefined
    }
    routes.push(route)
  }
  return routes.length > 0 ? routes : undefined
}

const validateDeletions = (routes: SafeRmToolParams[], ctx: ExtensionContext): Effect.Effect<string | undefined, never, FileSystem> =>
  Effect.forEach(routes, (params) => validateSafeRmTargets({ cwd: ctx.cwd, params, signal: ctx.signal }), { concurrency: 1 }).pipe(
    Effect.as(undefined),
    Effect.catchCause((cause) => {
      const error: unknown = Cause.squash(cause)
      return Effect.succeed(error instanceof Error ? error.message : String(error))
    })
  )

const decideForCommand = (command: string, ctx: ExtensionContext): Effect.Effect<GuardDecision, never, FileSystem> =>
  Effect.gen(function* () {
    const scannedCommand = command.replaceAll(/\\\r?\n/g, '')
    const maskedCommand = maskProse(scannedCommand)
    for (const rule of ALL_PATTERNS) {
      if (!rule.pattern.test(maskedCommand)) {
        continue
      }
      const routes = rule === SHELL_DELETION_PATTERN ? routeDeletions(scannedCommand) : undefined
      if (routes !== undefined) {
        const failure = yield* validateDeletions(routes, ctx)
        if (failure === undefined) {
          continue
        }
        return {
          _tag: 'Block',
          notifyLabel: rule.label,
          reason: `CRITICAL (best-effort command policy): ${rule.label} — safe_rm validation rejected a target: ${failure}`,
        }
      }
      if (rule.severity === 'critical') {
        return {
          _tag: 'Block',
          notifyLabel: rule.label,
          reason: `CRITICAL (best-effort command policy): ${rule.label} — recognized command blocked`,
        }
      }
      return {
        _tag: 'Confirm',
        label: rule.label,
        message: `Category: ${rule.category}\n\n${commandExcerpt(command, rule.pattern)}`,
      }
    }
    return { _tag: 'Allow' }
  })

const decideForProtectedTarget = (
  operation: 'edit' | 'read' | 'write',
  path: string,
  cwd: string
): Effect.Effect<GuardDecision, PlatformError, FileSystem> =>
  Effect.gen(function* () {
    const resolution = yield* resolveProtectedPathEffect(path, cwd)
    if (!resolution.protected) {
      return { _tag: 'Allow' }
    }
    return { _tag: 'Confirm', label: `Protected file ${operation}`, message: `${operation} ${path}` }
  })

const confirmRisk = ({ label, message }: { label: string; message: string }): Effect.Effect<ToolCallEventResult | undefined, never, Pi | Ui> =>
  Effect.gen(function* () {
    const ui = yield* Ui
    if (!(yield* ui.hasUI)) {
      return { block: true, reason: `${label} blocked (non-interactive mode)` }
    }

    const pi = yield* Pi
    pi.events.emit('herdr:blocked', { active: true, label })
    return yield* Effect.ensuring(
      Effect.gen(function* () {
        const allowed = yield* ui.confirm(`⚠️ ${label}`, `${message}\n\nAllow this operation?`)
        return allowed ? undefined : { block: true, reason: `${label} — blocked by user` }
      }),
      Effect.sync(() => {
        pi.events.emit('herdr:blocked', { active: false })
      })
    )
  })

const runDecision = (decision: GuardDecision): Effect.Effect<ToolCallEventResult | undefined, never, Pi | Ui> =>
  Match.valueTags(decision, {
    Allow: () => Effect.succeed(allow),
    Block: (block) =>
      Effect.gen(function* () {
        if (block.notifyLabel !== undefined) {
          const ui = yield* Ui
          if (yield* ui.hasUI) {
            yield* ui.notify(`🚫 Blocked: ${block.notifyLabel}`, 'error')
          }
        }
        return { block: true, reason: block.reason }
      }),
    Confirm: (confirm) => confirmRisk(confirm),
  })

const extractCommand = (event: ToolCallEvent): string | undefined => {
  if (isToolCallEventType('bash', event)) {
    return event.input.command
  }
  if (event.toolName === 'background_poll') {
    const { command } = event.input as { command?: unknown }
    return typeof command === 'string' ? command : undefined
  }
  return undefined
}

const extractProtectedTarget = (event: ToolCallEvent): { operation: 'edit' | 'read' | 'write'; path: string } | undefined => {
  if (isToolCallEventType('read', event)) {
    return { operation: 'read', path: event.input.path }
  }
  if (isToolCallEventType('write', event)) {
    return { operation: 'write', path: event.input.path }
  }
  if (isToolCallEventType('edit', event)) {
    return { operation: 'edit', path: event.input.path }
  }
  return undefined
}

export const handleToolCall = (event: ToolCallEvent, ctx: ExtensionContext) =>
  Effect.gen(function* () {
    const command = extractCommand(event)
    if (command !== undefined) {
      return yield* runDecision(yield* decideForCommand(command, ctx))
    }

    const target = extractProtectedTarget(event)
    if (target === undefined) {
      return undefined
    }

    const decision = yield* decideForProtectedTarget(target.operation, target.path, ctx.cwd)
    return yield* runDecision(decision)
  })

export const announceGuardStatus: Effect.Effect<void, never, StatusBar | Ui> = Effect.gen(function* () {
  const statusBar = yield* StatusBar
  yield* statusBar.channel(SAFETY_STATUS_KEY, { icon: '🛡️', priority: 10, tone: 'success' }).set({ text: 'cmd-guard' })
})
