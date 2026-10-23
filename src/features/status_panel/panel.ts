import { type ExtensionAPI, type ExtensionContext, type ExtensionEvent } from '@earendil-works/pi-coding-agent'
import { Clock, Effect, MutableRef, Path as PathService } from 'effect'
import { type Path } from 'effect/Path'

import { isTrue } from '#shared/utils/predicates'

import { StatusEditor } from './editor.js'
import { renderFooterLine, renderStatusLine } from './footer.js'
import { formatDirectory } from './render.js'
import { emptyModelInfoState, turnMetrics, type ModelInfoState } from './state.js'

/*
 * The individual payload interfaces are not re-exported from the package root, but the
 * `ExtensionEvent` union is, so each payload is narrowed by its own `type` discriminant instead of
 * being restated here.
 */
type PiEvent<Type extends ExtensionEvent['type']> = Extract<ExtensionEvent, { type: Type }>

type EditorFactory = ReturnType<ExtensionContext['ui']['getEditorComponent']>

export interface PanelHandlers {
  readonly sessionStart: (event: PiEvent<'session_start'>, ctx: ExtensionContext) => Effect.Effect<void, never, Path>
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

  const install = (ctx: ExtensionContext, path: Path): void => {
    ctx.ui.setFooter((tui, theme) => {
      requestRender = () => tui.requestRender()
      return {
        invalidate() {
          /* Empty */
        },
        render: (width: number) => [renderFooterLine(getModel(), theme, width)],
      }
    })
    if (!installed) {
      previousEditor = ctx.ui.getEditorComponent()
    }
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) =>
        new StatusEditor(tui, theme, keybindings, (width, color, activity) => renderStatusLine(getModel(), ctx.ui.theme, width, color, activity))
    )
    installed = true
    ctx.ui.setTitle(`pi · ${formatDirectory(ctx.cwd, path)}`)
  }

  return {
    agentSettled: (_event, ctx) => refreshModel(ctx),
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
        if (ctx.mode === 'tui' && installed) {
          ctx.ui.setFooter(undefined)
          ctx.ui.setEditorComponent(previousEditor)
        }
        installed = false
        previousEditor = undefined
      }),
    sessionStart: (_event, ctx) =>
      Effect.gen(function* () {
        const path = yield* PathService.Path
        MutableRef.set(modelState, emptyModelInfoState())
        if (ctx.mode === 'tui') {
          install(ctx, path)
        }
        yield* refreshModel(ctx)
      }),
    thinkingLevelSelect: (event) => updateModel((model) => ({ ...model, thinking: event.level })),
    turnEnd: (_event, ctx) => refreshModel(ctx),
  }
}
