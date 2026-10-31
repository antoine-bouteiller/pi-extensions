import { type ExtensionAPI, type ExtensionContext, type ExtensionEvent } from '@earendil-works/pi-coding-agent'
import { Clock, Effect, MutableRef, Scope } from 'effect'

import { StatusBar, type StatusBarApi } from '#shared/effect/app_services'
import { isTrue } from '#shared/utils/predicates'

import { StatusEditor } from './editor.js'
import { renderFooterLine, renderStatusLine } from './footer.js'
import { emptyModelInfoState, type ModelInfoState, turnMetrics } from './state.js'

/*
 * The individual payload interfaces are not re-exported from the package root, but the
 * `ExtensionEvent` union is, so each payload is narrowed by its own `type` discriminant instead of
 * being restated here.
 */
type PiEvent<Type extends ExtensionEvent['type']> = Extract<ExtensionEvent, { type: Type }>

const TITLE_MODEL_SETTING = 'sessionTitleModel'
const TITLE_PROMPT = "Write a 3 to 6 word title for a coding session that starts with the user's message. Reply with the title only."
const FALLBACK_TITLE_LENGTH = 40

const promptTitle = (prompt: string): string => {
  const line = prompt.trim().split('\n', 1)[0]?.replaceAll(/\s+/g, ' ') ?? ''
  return line.length > FALLBACK_TITLE_LENGTH ? `${line.slice(0, FALLBACK_TITLE_LENGTH - 1).trimEnd()}…` : line
}

type EditorFactory = ReturnType<ExtensionContext['ui']['getEditorComponent']>

export interface PanelHandlers {
  readonly sessionStart: (event: PiEvent<'session_start'>, ctx: ExtensionContext) => Effect.Effect<void, never, StatusBar | Scope.Scope>
  readonly beforeAgentStart: (event: PiEvent<'before_agent_start'>, ctx: ExtensionContext) => Effect.Effect<void>
  readonly modelSelect: (event: PiEvent<'model_select'>, ctx: ExtensionContext) => Effect.Effect<void>
  readonly thinkingLevelSelect: (event: PiEvent<'thinking_level_select'>, ctx: ExtensionContext) => Effect.Effect<void>
  readonly messageEnd: (event: PiEvent<'message_end'>, ctx: ExtensionContext) => Effect.Effect<void>
  readonly turnEnd: (event: PiEvent<'turn_end'>, ctx: ExtensionContext) => Effect.Effect<void>
  readonly agentSettled: (event: PiEvent<'agent_settled'>, ctx: ExtensionContext) => Effect.Effect<void>
  readonly sessionShutdown: (event: PiEvent<'session_shutdown'>, ctx: ExtensionContext) => Effect.Effect<void>
}

export const makePanelController = (pi: ExtensionAPI): PanelHandlers => {
  const modelState = MutableRef.make<ModelInfoState>(emptyModelInfoState())
  let requestRender: (() => void) | undefined
  let previousEditor: EditorFactory | undefined
  let installed = false
  let sessionScope: Scope.Scope | undefined
  let titleRequested = false
  let unsubscribeStatuses: (() => void) | undefined

  const getModel = (): ModelInfoState => MutableRef.get(modelState)
  const updateModel = (updater: (model: ModelInfoState) => ModelInfoState): Effect.Effect<void> =>
    Effect.sync(() => {
      MutableRef.update(modelState, updater)
      requestRender?.()
    })

  const applyModelInfo = (ctx: ExtensionContext, model: ModelInfoState): ModelInfoState => {
    const usage = ctx.getContextUsage()
    return {
      ...model,
      contextPercent: usage?.percent ?? undefined,
      contextTokens: usage?.tokens ?? undefined,
      contextWindow: usage?.contextWindow ?? ctx.model?.contextWindow ?? 0,
      modelId: ctx.model?.id ?? 'no-model',
      thinking: isTrue(ctx.model?.reasoning) ? pi.getThinkingLevel() : 'off',
    }
  }

  const refreshModel = (ctx: ExtensionContext): Effect.Effect<void> => updateModel((model) => applyModelInfo(ctx, model))

  // Pi puts the session name in the terminal title, which Rex shows as the pane name.
  const nameSession = (title: string | undefined): Effect.Effect<void> =>
    Effect.sync(() => {
      if (title !== undefined && title !== '' && pi.getSessionName() === undefined) {
        pi.setSessionName(title)
      }
    })

  const titleModel = (ctx: ExtensionContext) => {
    const setting: unknown = Reflect.get(pi.getSettings(), TITLE_MODEL_SETTING)
    const slash = typeof setting === 'string' ? setting.indexOf('/') : -1
    return typeof setting === 'string' && slash > 0 ? ctx.modelRegistry.find(setting.slice(0, slash), setting.slice(slash + 1)) : undefined
  }

  const generateTitle = (model: NonNullable<ReturnType<typeof titleModel>>, prompt: string, ctx: ExtensionContext) =>
    Effect.gen(function* () {
      const reply = yield* Effect.tryPromise(() =>
        ctx.modelRegistry.complete(
          model,
          { messages: [{ content: prompt.slice(0, 4000), role: 'user', timestamp: Date.now() }], systemPrompt: TITLE_PROMPT },
          { maxTokens: 32 }
        )
      )
      return reply.stopReason === 'error'
        ? undefined
        : reply.content
            .flatMap((part) => (part.type === 'text' ? [part.text] : []))
            .join('')
            .split('\n', 1)[0]
            ?.trim()
            .replaceAll(/^["'`]+|["'`.]+$/g, '')
            .slice(0, 60)
    })

  const install = (ctx: ExtensionContext, statusBar: StatusBarApi): void => {
    ctx.ui.setFooter((tui, theme) => {
      requestRender = () => tui.requestRender()
      return {
        invalidate() {
          /* Empty */
        },
        render: (width: number) => [renderFooterLine(getModel(), statusBar.list(), theme, width)],
      }
    })
    unsubscribeStatuses?.()
    unsubscribeStatuses = statusBar.subscribe(() => requestRender?.())
    if (!installed) {
      previousEditor = ctx.ui.getEditorComponent()
    }
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) =>
        new StatusEditor(tui, theme, keybindings, (width, color, activity) => renderStatusLine(getModel(), ctx.ui.theme, width, color, activity))
    )
    installed = true
  }

  return {
    agentSettled: (_event, ctx) => refreshModel(ctx),
    beforeAgentStart: (event, ctx) =>
      Effect.gen(function* () {
        if (ctx.mode !== 'tui' || event.messageType !== 'user' || titleRequested || sessionScope === undefined || pi.getSessionName() !== undefined) {
          return
        }
        titleRequested = true
        const fallback = promptTitle(event.prompt)
        const model = titleModel(ctx)
        if (model === undefined) {
          yield* nameSession(fallback)
          return
        }
        yield* Effect.forkIn(
          generateTitle(model, event.prompt, ctx).pipe(
            Effect.map((title) => (title === undefined || title === '' ? fallback : title)),
            Effect.orElseSucceed(() => fallback),
            Effect.flatMap(nameSession)
          ),
          sessionScope
        )
      }),
    messageEnd: (event) =>
      Effect.gen(function* () {
        if (event.message.role !== 'assistant') {
          return
        }
        const metrics = turnMetrics(event.message, yield* Clock.currentTimeMillis)
        yield* updateModel((model) => ({ ...model, ...metrics }))
      }),
    modelSelect: (_event, ctx) => refreshModel(ctx),
    sessionShutdown: (_event, ctx) =>
      Effect.sync(() => {
        requestRender = undefined
        unsubscribeStatuses?.()
        unsubscribeStatuses = undefined
        if (ctx.mode === 'tui' && installed) {
          ctx.ui.setFooter(undefined)
          ctx.ui.setEditorComponent(previousEditor)
        }
        installed = false
        previousEditor = undefined
        sessionScope = undefined
      }),
    sessionStart: (_event, ctx) =>
      Effect.gen(function* () {
        const statusBar = yield* StatusBar
        MutableRef.set(modelState, emptyModelInfoState())
        sessionScope = yield* Scope.Scope
        titleRequested = false
        if (ctx.mode === 'tui') {
          install(ctx, statusBar)
        }
        yield* refreshModel(ctx)
      }),
    thinkingLevelSelect: (event) => updateModel((model) => ({ ...model, thinking: event.level })),
    turnEnd: (_event, ctx) => refreshModel(ctx),
  }
}
