import { type ExtensionContext } from '@earendil-works/pi-coding-agent'
import {
  Editor,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type EditorTheme,
  type Focusable,
} from '@earendil-works/pi-tui'
import { Data, Effect, Function } from 'effect'
import { Type, type Static } from 'typebox'

import { ToolFailure } from '@/shared/effect/errors.js'
import { PiCtx } from '@/shared/effect/pi_services.js'
import { isEmptyString, isTrue } from '@/shared/utils/predicates.js'

import { ASK_USER_PARAMETER_DESCRIPTIONS, buildAskUserResultMessage } from './prompt.js'

const MIN_OPTIONS = 2
const MAX_OPTIONS = 5

const OptionSchema = Type.Object({
  description: Type.Optional(
    Type.String({
      description: ASK_USER_PARAMETER_DESCRIPTIONS.optionDescription,
    })
  ),
  label: Type.String({
    description: ASK_USER_PARAMETER_DESCRIPTIONS.optionLabel,
  }),
})

export const AskUserParams = Type.Object({
  options: Type.Array(OptionSchema, {
    description: ASK_USER_PARAMETER_DESCRIPTIONS.options,
    maxItems: MAX_OPTIONS,
    minItems: MIN_OPTIONS,
  }),
  question: Type.String({
    description: ASK_USER_PARAMETER_DESCRIPTIONS.question,
  }),
})

export const AskUserDetailsSchema = Type.Object({
  answer: Type.Optional(Type.String()),
  cancelled: Type.Boolean(),
  options: Type.Array(Type.String()),
  question: Type.String(),
  wasCustom: Type.Boolean(),
})

type AskUserDetails = Static<typeof AskUserDetailsSchema>

type SelectionResult =
  | {
      answer: string
      wasCustom: boolean
      index?: number
    }
  | undefined

export interface DisplayOption {
  label: string
  description?: string
  isOther?: boolean
}

interface AskUserResult {
  content: { type: 'text'; text: string }[]
  details: AskUserDetails
}

class AskUserUiError extends Data.TaggedError('AskUserUiError')<{
  readonly cause: unknown
  readonly message: string
}> {}

const showQuestion = (
  ctx: ExtensionContext,
  question: string,
  allOptions: DisplayOption[],
  uiSignal: AbortSignal | undefined
): Effect.Effect<SelectionResult, AskUserUiError> =>
  Effect.tryPromise({
    catch: (cause) => new AskUserUiError({ cause, message: cause instanceof Error ? cause.message : String(cause) }),
    try: () =>
      ctx.ui.custom<SelectionResult>((tui, theme, _kb, done) => {
        let optionIndex = 0
        let editMode = false
        let cachedLines: string[] | undefined
        let cachedWidth: number | undefined

        let settled = false

        const finish = (result: SelectionResult) => {
          if (settled) {
            return
          }
          settled = true
          uiSignal?.removeEventListener('abort', cancel)
          done(result)
        }

        const cancel = () => {
          finish(undefined)
        }

        uiSignal?.addEventListener('abort', cancel, { once: true })
        if (uiSignal !== undefined && uiSignal.aborted) {
          queueMicrotask(cancel)
        }

        const editorTheme: EditorTheme = {
          borderColor: (text) => theme.fg('accent', text),
          selectList: {
            description: (text) => theme.fg('muted', text),
            noMatch: (text) => theme.fg('warning', text),
            scrollInfo: (text) => theme.fg('dim', text),
            selectedPrefix: (text) => theme.fg('accent', text),
            selectedText: (text) => theme.fg('accent', text),
          },
        }
        const editor = new Editor(tui, editorTheme)

        editor.onSubmit = (value) => {
          const trimmed = value.trim()
          if (isEmptyString(trimmed)) {
            editMode = false
            editor.setText('')
            refresh()
          } else {
            finish({ answer: trimmed, wasCustom: true })
          }
        }

        const refresh = () => {
          cachedLines = undefined
          cachedWidth = undefined
          tui.requestRender()
        }

        const selectOption = (index: number) => {
          const selected = allOptions[index]
          if (isTrue(selected.isOther)) {
            optionIndex = index
            editMode = true
            refresh()
          } else {
            finish({
              answer: selected.label,
              index: index + 1,
              wasCustom: false,
            })
          }
        }

        const handleInput = (data: string) => {
          if (editMode) {
            if (matchesKey(data, Key.escape)) {
              editMode = false
              editor.setText('')
              refresh()
              return
            }
            editor.handleInput(data)
            refresh()
            return
          }

          if (matchesKey(data, Key.up)) {
            optionIndex = (optionIndex - 1 + allOptions.length) % allOptions.length
            refresh()
            return
          }
          if (matchesKey(data, Key.down)) {
            optionIndex = (optionIndex + 1) % allOptions.length
            refresh()
            return
          }

          // Number keys jump straight to an option
          if (data.length === 1 && data >= '1' && data <= String(allOptions.length)) {
            selectOption(Number(data) - 1)
            return
          }

          if (matchesKey(data, Key.enter)) {
            selectOption(optionIndex)
            return
          }

          if (matchesKey(data, Key.escape)) {
            finish(undefined)
          }
        }

        const render = (width: number): string[] => {
          const renderWidth = Math.max(1, Math.floor(width))
          if (cachedLines !== undefined && cachedWidth === renderWidth) {
            return cachedLines
          }

          const lines: string[] = []
          const add = (line: string) => lines.push(truncateToWidth(line, renderWidth))
          const addWrapped = (text: string, indent: string, style: (value: string) => string) => {
            const safeIndent = visibleWidth(indent) < renderWidth ? indent : ''
            const contentWidth = Math.max(1, renderWidth - visibleWidth(safeIndent))
            for (const line of wrapTextWithAnsi(text, contentWidth)) {
              add(safeIndent + style(line))
            }
          }

          const title = ' Question '
          const ruleWidth = Math.max(0, renderWidth - visibleWidth(title) - 1)
          add(theme.fg('accent', `─${title}${'─'.repeat(ruleWidth)}`))
          addWrapped(question, ' ', (line) => theme.fg('text', theme.bold(line)))
          lines.push('')

          for (let index = 0; index < allOptions.length; index++) {
            const opt = allOptions[index]
            const selected = index === optionIndex
            const prefix = selected ? theme.fg('accent', ' ❯ ') : '   '
            const marker = isTrue(opt.isOther) ? '✎' : `${index + 1}.`
            const label = `${marker} ${opt.label}`
            let color: 'accent' | 'muted' | 'text'
            if (selected || (isTrue(opt.isOther) && editMode)) {
              color = 'accent'
            } else if (isTrue(opt.isOther)) {
              color = 'muted'
            } else {
              color = 'text'
            }

            addWrapped(label, prefix, (line) => theme.fg(color, line))

            if (opt.description !== undefined) {
              addWrapped(opt.description, '      ', (line) => theme.fg('muted', line))
            }
          }

          if (editMode) {
            lines.push('')
            add(theme.fg('muted', ' Your answer:'))
            const editorIndent = renderWidth > 1 ? ' ' : ''
            const editorWidth = Math.max(1, renderWidth - visibleWidth(editorIndent))
            for (const line of editor.render(editorWidth)) {
              add(editorIndent + line)
            }
          }

          lines.push('')
          if (editMode) {
            add(theme.fg('dim', ' Enter submit • Esc back to options'))
          } else {
            add(theme.fg('dim', ` ↑↓ or 1-${allOptions.length} select • Enter confirm • Esc dismiss`))
          }
          add(theme.fg('accent', '─'.repeat(renderWidth)))

          cachedLines = lines
          cachedWidth = renderWidth
          return lines
        }

        let focused = false
        return {
          dispose: () => {
            uiSignal?.removeEventListener('abort', cancel)
          },
          get focused() {
            return focused
          },
          set focused(value: boolean) {
            focused = value
            editor.focused = value
            cachedLines = undefined
            cachedWidth = undefined
          },
          handleInput,
          invalidate: () => {
            cachedLines = undefined
            cachedWidth = undefined
          },
          render,
        } satisfies Component & Focusable & { dispose: () => void }
      }),
  })

export const askUserEffect: {
  (signal: AbortSignal | undefined): (params: Static<typeof AskUserParams>) => Effect.Effect<AskUserResult, ToolFailure | AskUserUiError, PiCtx>
  (params: Static<typeof AskUserParams>, signal: AbortSignal | undefined): Effect.Effect<AskUserResult, ToolFailure | AskUserUiError, PiCtx>
} = Function.dual(2, (params: Static<typeof AskUserParams>, signal: AbortSignal | undefined) =>
  Effect.gen(function* () {
    const optionCount = params.options.length
    if (optionCount < MIN_OPTIONS || optionCount > MAX_OPTIONS) {
      return yield* ToolFailure.make({
        message: `ask_user requires between ${MIN_OPTIONS} and ${MAX_OPTIONS} options (got ${optionCount}). Retry with a valid number of options.`,
      })
    }

    const reply = (text: string, answer?: string, wasCustom = false): AskUserResult => ({
      content: [{ text, type: 'text' as const }],
      details: {
        answer,
        cancelled: answer === undefined,
        options: params.options.map((option) => option.label),
        question: params.question,
        wasCustom,
      },
    })

    const ctx = yield* PiCtx

    if (ctx.mode !== 'tui') {
      return reply(buildAskUserResultMessage({ kind: 'no-ui' }))
    }

    if (signal !== undefined && signal.aborted) {
      return reply(buildAskUserResultMessage({ kind: 'cancelled' }))
    }

    const allOptions: DisplayOption[] = [...params.options, { isOther: true, label: 'Write my own answer…' }]

    const result = yield* showQuestion(ctx, params.question, allOptions, signal)

    if (result === undefined) {
      const kind = signal !== undefined && signal.aborted ? 'cancelled' : 'dismissed'
      return reply(buildAskUserResultMessage({ kind }))
    }

    if (result.wasCustom) {
      return reply(
        buildAskUserResultMessage({
          answer: result.answer,
          kind: 'custom',
        }),
        result.answer,
        true
      )
    }

    return reply(
      buildAskUserResultMessage({
        answer: result.answer,
        index: result.index,
        kind: 'selected',
      }),
      result.answer
    )
  })
)
