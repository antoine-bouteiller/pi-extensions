/**
 * Prompt_rewind - Escape between submitting a text-only prompt and the first assistant
 * output rewinds the just-submitted message and restores its raw, pre-expansion text
 * to the editor instead of leaving an orphaned user turn on the active branch.
 *
 * Image prompts are left to Pi's built-in Escape handling: there is no public API to
 * restore attachments into the editor, so rewinding them would silently drop images.
 */

import {
  type AgentEndEvent,
  type BeforeAgentStartEvent,
  CustomEditor,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type InputEvent,
  type MessageUpdateEvent,
  type SessionMessageEntry,
  type SessionShutdownEvent,
  type SessionStartEvent,
  type ToolExecutionStartEvent,
} from '@earendil-works/pi-coding-agent'
import { type EditorComponent, isKeyRelease, isKeyRepeat, matchesKey, type TUI } from '@earendil-works/pi-tui'
import { Function } from 'effect'

import { type AppRuntime } from '@/shared/effect/app_services.js'

const REWIND_COMMAND = 'prompt-rewind-cancel'

interface RewindCapture {
  readonly rawText: string
  readonly parentId: string | null
}

const registerImpl = (pi: ExtensionAPI, _runtime: AppRuntime): void => {
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
      if (tui?.hasOverlay() === true) {
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
      if (ctx.ui.getEditorText().trim().length > 0) {
        return undefined
      }

      pendingRewind = armed
      armed = undefined
      canceling = true
      ctx.abort()
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

  pi.on('input', (event: InputEvent) => {
    const hasImages = Boolean(event.images && event.images.length > 0)
    pendingInputText = event.source === 'interactive' && event.streamingBehavior === undefined && !hasImages ? event.text : undefined
  })

  pi.on('before_agent_start', (_event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
    capturedParent = pendingInputText === undefined ? undefined : { parentId: ctx.sessionManager.getLeafId(), rawText: pendingInputText }
    pendingInputText = undefined
  })

  pi.on('agent_start', () => {
    armed = capturedParent
    capturedParent = undefined
  })

  pi.on('message_update', (_event: MessageUpdateEvent) => {
    disarm()
  })

  pi.on('tool_execution_start', (_event: ToolExecutionStartEvent) => {
    disarm()
  })

  pi.on('agent_end', (_event: AgentEndEvent) => {
    disarm()
  })

  pi.on('session_start', (_event: SessionStartEvent, ctx: ExtensionContext) => {
    resetState()
    if (ctx.mode === 'tui') {
      captureAppSubmit(ctx)
      armEscapeRewind(ctx)
    }
  })

  pi.on('session_shutdown', (_event: SessionShutdownEvent) => {
    unsubscribeTerminal()
    resetState()
  })

  pi.registerCommand(REWIND_COMMAND, {
    description: 'Internal: rewinds the just-cancelled prompt from the active branch and restores its raw text to the editor.',
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const capture = pendingRewind
      pendingRewind = undefined
      if (capture === undefined) {
        canceling = false
        return
      }

      try {
        ctx.abort()
        await ctx.waitForIdle()

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
        const result = await ctx.navigateTree(userEntry.id)
        if (!result.cancelled) {
          ctx.ui.setEditorText([capture.rawText, draft].filter((text) => text.trim()).join('\n\n'))
        }
      } finally {
        canceling = false
      }
    },
  })
}

export const register: {
  (runtime: AppRuntime): (pi: ExtensionAPI) => void
  (pi: ExtensionAPI, runtime: AppRuntime): void
} = Function.dual((args) => typeof args[0].on === 'function', registerImpl)
