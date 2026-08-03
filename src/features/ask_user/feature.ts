/**
 * Ask_user - Lets the model ask a single multiple-choice question.
 *
 * - 2 to 5 model-provided options, plus an always-present "Write my own answer" option
 * - Popup UI: arrow keys or number keys to pick, Enter to confirm
 * - "Write my own answer" opens an inline editor (Esc returns to the options)
 * - Esc on the options dismisses the question (the model is told you declined)
 */

import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import {
  Editor,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type EditorTheme,
  type Focusable,
} from '@earendil-works/pi-tui'
import { Effect } from 'effect'
import { Type, type Static } from 'typebox'
import { Check } from 'typebox/value'

import { type AppRuntime } from '@/shared/effect/app_services.js'
import { ToolFailure } from '@/shared/effect/errors.js'
import { PiCtx } from '@/shared/effect/pi_services.js'
import { perInvocation } from '@/shared/effect/runtime.js'

import {
  ASK_USER_PARAMETER_DESCRIPTIONS,
  ASK_USER_PROMPT_GUIDELINES,
  ASK_USER_PROMPT_SNIPPET,
  ASK_USER_TOOL_DESCRIPTION,
  buildAskUserResultMessage,
} from './prompt.js'

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

const AskUserParams = Type.Object({
  options: Type.Array(OptionSchema, {
    description: ASK_USER_PARAMETER_DESCRIPTIONS.options,
    maxItems: MAX_OPTIONS,
    minItems: MIN_OPTIONS,
  }),
  question: Type.String({
    description: ASK_USER_PARAMETER_DESCRIPTIONS.question,
  }),
})

const AskUserDetailsSchema = Type.Object({
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

interface DisplayOption {
  label: string
  description?: string
  isOther?: boolean
}

interface AskUserResult {
  content: { type: 'text'; text: string }[]
  details: AskUserDetails
}

const showQuestion = (
  ctx: ExtensionContext,
  question: string,
  allOptions: DisplayOption[],
  uiSignal: AbortSignal | undefined
): Effect.Effect<SelectionResult, Error> =>
  Effect.tryPromise({
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
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
        if (uiSignal?.aborted) {
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
          if (trimmed) {
            finish({ answer: trimmed, wasCustom: true })
          } else {
            editMode = false
            editor.setText('')
            refresh()
          }
        }

        const refresh = () => {
          cachedLines = undefined
          cachedWidth = undefined
          tui.requestRender()
        }

        const selectOption = (index: number) => {
          const selected = allOptions[index]
          if (selected.isOther) {
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
          if (cachedLines && cachedWidth === renderWidth) {
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
            const marker = opt.isOther ? '✎' : `${index + 1}.`
            const label = `${marker} ${opt.label}`
            let color: 'accent' | 'muted' | 'text'
            if (selected || (opt.isOther && editMode)) {
              color = 'accent'
            } else if (opt.isOther) {
              color = 'muted'
            } else {
              color = 'text'
            }

            addWrapped(label, prefix, (line) => theme.fg(color, line))

            if (opt.description) {
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

const askUserEffect = (
  params: Static<typeof AskUserParams>,
  signal: AbortSignal | undefined
): Effect.Effect<AskUserResult, ToolFailure | Error, PiCtx> =>
  Effect.gen(function* () {
    const optionCount = params.options.length
    if (optionCount < MIN_OPTIONS || optionCount > MAX_OPTIONS) {
      return yield* Effect.fail(
        new ToolFailure({
          message: `ask_user requires between ${MIN_OPTIONS} and ${MAX_OPTIONS} options (got ${optionCount}). Retry with a valid number of options.`,
        })
      )
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

    if (signal?.aborted) {
      return reply(buildAskUserResultMessage({ kind: 'cancelled' }))
    }

    const allOptions: DisplayOption[] = [...params.options, { isOther: true, label: 'Write my own answer…' }]

    const result = yield* showQuestion(ctx, params.question, allOptions, signal)

    if (!result) {
      const kind = signal?.aborted ? 'cancelled' : 'dismissed'
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

export const register = (pi: ExtensionAPI, runtime: AppRuntime): void => {
  pi.registerTool({
    description: ASK_USER_TOOL_DESCRIPTION,
    /*
     * `signal` is threaded into the Effect body instead of being handed to `runPromise`. The
     * component below already resolves `done(undefined)` cooperatively on abort so it can report
     * "Cancelled" as a normal result; letting `runPromise` interrupt the fiber on the same signal
     * would instead reject the tool call, which is exactly what "neither path may fail" rules out.
     */
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) =>
      runtime.runPromise(
        askUserEffect(params, signal ?? undefined).pipe(
          Effect.provide(perInvocation(ctx)),
          Effect.catch((error) => Effect.fail(error instanceof ToolFailure ? new Error(error.message) : error))
        )
      ),
    label: 'Ask User',
    name: 'ask_user',
    parameters: AskUserParams,
    promptGuidelines: ASK_USER_PROMPT_GUIDELINES,
    promptSnippet: ASK_USER_PROMPT_SNIPPET,
    renderCall(args, theme, _context) {
      let text = theme.fg('toolTitle', theme.bold('ask_user '))
      text += theme.fg('muted', typeof args.question === 'string' ? args.question : '')
      const opts = Array.isArray(args.options) ? (args.options as DisplayOption[]) : []
      if (opts.length > 0) {
        const numbered = opts.map((option, index) => `${index + 1}. ${option.label}`)
        text += `\n${theme.fg('dim', `  ${numbered.join('  ')}`)}`
      }
      return new Text(text, 0, 0)
    },
    renderResult(result, _options, theme, _context) {
      const details = Check(AskUserDetailsSchema, result.details) ? result.details : undefined
      if (!details) {
        const [first] = result.content
        return new Text(first?.type === 'text' ? first.text : '', 0, 0)
      }

      if (details.cancelled || details.answer === undefined) {
        return new Text(theme.fg('warning', '✗ dismissed'), 0, 0)
      }

      if (details.wasCustom) {
        return new Text(theme.fg('success', '✓ ') + theme.fg('muted', '(wrote) ') + theme.fg('accent', details.answer), 0, 0)
      }

      const idx = details.options.indexOf(details.answer) + 1
      const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer
      return new Text(theme.fg('success', '✓ ') + theme.fg('accent', display), 0, 0)
    },
  })
}
