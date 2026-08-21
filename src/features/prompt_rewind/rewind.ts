/**
 * Prompt_rewind - Escape between submitting a text-only prompt and the first assistant
 * output rewinds the just-submitted message and restores its raw, pre-expansion text
 * to the editor instead of leaving an orphaned user turn on the active branch.
 *
 * Image prompts are left to Pi's built-in Escape handling: there is no public API to
 * restore attachments into the editor, so rewinding them would silently drop images.
 */

import {
  type BeforeAgentStartEvent,
  CustomEditor,
  type ExtensionCommandContext,
  type ExtensionContext,
  type InputEvent,
  type SessionMessageEntry,
  type SessionStartEvent,
} from '@earendil-works/pi-coding-agent'
import { type EditorComponent, isKeyRelease, isKeyRepeat, matchesKey, type TUI } from '@earendil-works/pi-tui'
import { Effect } from 'effect'

import { isNotEmptyString, isTrue } from '#shared/utils/predicates'

export const REWIND_COMMAND = 'prompt-rewind-cancel'

interface RewindCapture {
  readonly rawText: string
  readonly parentId: string | null
}

export interface RewindController {
  readonly rewindCancelledPrompt: (ctx: ExtensionCommandContext) => Effect.Effect<void>
  readonly captureInput: (event: InputEvent) => void
  readonly capturePrompt: (event: BeforeAgentStartEvent, ctx: ExtensionContext) => void
  readonly arm: () => void
  readonly disarm: () => void
  readonly start: (event: SessionStartEvent, ctx: ExtensionContext) => void
  readonly shutdown: () => void
}

export const makeRewindController = (): RewindController => {
  let pendingInputText: string | undefined
  let capturedParent: RewindCapture | undefined
  let armed: RewindCapture | undefined
  let pendingRewind: RewindCapture | undefined
  let canceling = false
  let submitToApp: ((text: string) => void) | undefined
  let tui: TUI | undefined
  let terminalUnsubscribe: (() => void) | undefined

  const disarm = (): void => {
    armed = undefined
  }

  const resetState = (): void => {
    pendingInputText = undefined
    capturedParent = undefined
    armed = undefined
    pendingRewind = undefined
    canceling = false
    submitToApp = undefined
    tui = undefined
  }

  const unsubscribeTerminal = (): void => {
    terminalUnsubscribe?.()
    terminalUnsubscribe = undefined
  }

  const armEscapeRewind = (ctx: ExtensionContext): void => {
    unsubscribeTerminal()
    terminalUnsubscribe = ctx.ui.onTerminalInput((data) => {
      if (isKeyRelease(data) || isKeyRepeat(data)) {
        return undefined
      }
      if (isTrue(tui?.hasOverlay())) {
        disarm()
        return undefined
      }
      if (!matchesKey(data, 'escape')) {
        return undefined
      }
      if (canceling) {
        return { consume: true }
      }
      if (armed === undefined || submitToApp === undefined) {
        return undefined
      }
      // Queued messages take priority: let the built-in Escape restore them instead of hijacking it.
      if (ctx.hasPendingMessages()) {
        return undefined
      }
      // A fresh draft in the editor must not be clobbered by the rewound raw text.
      if (isNotEmptyString(ctx.ui.getEditorText().trim())) {
        return undefined
      }

      pendingRewind = armed
      armed = undefined
      canceling = true
      submitToApp(`/${REWIND_COMMAND}`)
      return { consume: true }
    })
  }

  const captureAppSubmit = (ctx: ExtensionContext): void => {
    const previous = ctx.ui.getEditorComponent()
    let probe: EditorComponent | undefined
    ctx.ui.setEditorComponent((currentTui, theme, keybindings) => {
      tui = currentTui
      probe = previous?.(currentTui, theme, keybindings) ?? new CustomEditor(currentTui, theme, keybindings)
      return probe
    })
    submitToApp = probe?.onSubmit
    ctx.ui.setEditorComponent(previous)
  }

  const captureInput = (event: InputEvent): void => {
    const hasImages = Boolean(event.images && event.images.length > 0)
    pendingInputText = event.source === 'interactive' && event.streamingBehavior === undefined && !hasImages ? event.text : undefined
  }

  const capturePrompt = (_event: BeforeAgentStartEvent, ctx: ExtensionContext): void => {
    capturedParent = pendingInputText === undefined ? undefined : { parentId: ctx.sessionManager.getLeafId(), rawText: pendingInputText }
    pendingInputText = undefined
  }

  const arm = (): void => {
    armed = capturedParent
    capturedParent = undefined
  }

  const start = (_event: SessionStartEvent, ctx: ExtensionContext): void => {
    resetState()
    if (ctx.mode === 'tui') {
      captureAppSubmit(ctx)
      armEscapeRewind(ctx)
    }
  }

  const shutdown = (): void => {
    unsubscribeTerminal()
    resetState()
  }

  const rewindCancelledPrompt = (ctx: ExtensionCommandContext): Effect.Effect<void> =>
    Effect.suspend(() => {
      const capture = pendingRewind
      pendingRewind = undefined
      if (capture === undefined) {
        canceling = false
        return Effect.void
      }

      return Effect.gen(function* () {
        ctx.abort()
        yield* Effect.promise(() => ctx.waitForIdle())

        const branch = ctx.sessionManager.getBranch()
        const parentIndex = capture.parentId === null ? -1 : branch.findIndex((entry) => entry.id === capture.parentId)
        const userEntry = branch
          .slice(parentIndex + 1)
          .find((entry): entry is SessionMessageEntry => entry.type === 'message' && entry.message.role === 'user')
        if ((capture.parentId !== null && parentIndex === -1) || userEntry === undefined) {
          ctx.ui.notify('prompt_rewind: could not find the cancelled message to rewind.', 'warning')
          return
        }

        const draft = ctx.ui.getEditorText()
        const result = yield* Effect.promise(() => ctx.navigateTree(userEntry.id))
        if (!result.cancelled) {
          ctx.ui.setEditorText([capture.rawText, draft].filter((text) => text.trim()).join('\n\n'))
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            canceling = false
          })
        )
      )
    })

  return { arm, captureInput, capturePrompt, disarm, rewindCancelledPrompt, shutdown, start }
}
