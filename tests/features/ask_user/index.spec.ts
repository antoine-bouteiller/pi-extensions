import { describe, expect, test } from 'bun:test'

import { CURSOR_MARKER, visibleWidth, type Component, type Focusable } from '@earendil-works/pi-tui'
import { asTool } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime } from '@tests/utils/runtime.js'
import { Effect } from 'effect'

import { register as askUser } from '@/features/ask_user/index.js'

interface AskUserResult {
  content: { type: 'text'; text: string }[]
  details: {
    question: string
    options: string[]
    answer: string | undefined
    wasCustom: boolean
    cancelled: boolean
  }
}

interface AskUserTool {
  execute: (
    toolCallId: string,
    params: {
      question: string
      options: { label: string; description?: string }[]
    },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: unknown
  ) => Promise<AskUserResult>
}

type PromptComponent = Component & Focusable

const params = {
  options: [{ label: 'Now' }, { label: 'Tomorrow' }],
  question: 'When should this ship?',
}

const setup = (customError?: Error) => {
  let component: PromptComponent | undefined
  let customCalls = 0
  const tui = {
    requestRender: () => undefined,
    terminal: { rows: 24 },
  }
  const theme = {
    bold: (value: string) => value,
    fg: (_color: string, value: string) => value,
  }
  const ui = {
    custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => PromptComponent) => {
      customCalls++
      if (customError !== undefined) {
        return Promise.reject(customError)
      }
      return Effect.runPromise(
        Effect.callback<unknown>((resume) => {
          component = factory(tui, theme, {}, (result) => resume(Effect.succeed(result)))
        })
      )
    },
  }

  const fakePi = createFakePi()
  askUser(fakePi.pi, runtime)
  const tool = asTool<AskUserTool>(fakePi.state.tools.get('ask_user'))

  return {
    get component() {
      if (component === undefined) {
        throw new Error('component not initialized')
      }
      return component
    },
    get customCalls() {
      return customCalls
    },
    nonTuiContext: { mode: 'rpc', ui },
    tool,
    tuiContext: { mode: 'tui', ui },
  }
}

const type = (component: PromptComponent, text: string) => {
  for (const character of text) {
    component.handleInput?.(character)
  }
}

describe('ask_user tool behavior', () => {
  test('returns the selected answer and option number', async () => {
    const fixture = setup()
    const pending = fixture.tool.execute('call-1', params, undefined, undefined, fixture.tuiContext)

    fixture.component.handleInput?.('2')
    const result = await pending

    expect(result.content[0].text).toBe('User selected option 2: Tomorrow')
    expect(result.details).toMatchObject({
      answer: 'Tomorrow',
      cancelled: false,
      wasCustom: false,
    })
  })

  test('reports dismissal without selecting an answer', async () => {
    const fixture = setup()
    const pending = fixture.tool.execute('call-2', params, undefined, undefined, fixture.tuiContext)

    fixture.component.handleInput?.('\x1b')
    const result = await pending

    expect(result.content[0].text).toContain('User dismissed the question')
    expect(result.details).toMatchObject({ answer: undefined, cancelled: true })
  })

  test('reports cancellation when aborted while the prompt is open', async () => {
    const fixture = setup()
    const controller = new AbortController()
    const pending = fixture.tool.execute('call-3', params, controller.signal, undefined, fixture.tuiContext)

    controller.abort()
    const result = await pending

    expect(result.content[0].text).toBe('Cancelled')
    expect(result.details).toMatchObject({ answer: undefined, cancelled: true })
  })

  test('submits trimmed custom input', async () => {
    const fixture = setup()
    const pending = fixture.tool.execute('call-4', params, undefined, undefined, fixture.tuiContext)

    fixture.component.handleInput?.('3')
    type(fixture.component, '  Wait until Friday  ')
    fixture.component.handleInput?.('\r')
    const result = await pending

    expect(result.content[0].text).toBe('User wrote their own answer: Wait until Friday')
    expect(result.details).toMatchObject({
      answer: 'Wait until Friday',
      cancelled: false,
      wasCustom: true,
    })
  })

  test('returns a plain-text fallback without opening UI outside TUI mode', async () => {
    const fixture = setup()
    const result = await fixture.tool.execute('call-5', params, undefined, undefined, fixture.nonTuiContext)

    expect(result.content[0].text).toContain('Ask the user in plain text instead')
    expect(result.details).toMatchObject({ answer: undefined, cancelled: true })
    expect(fixture.customCalls).toBe(0)
  })

  test('preserves tagged UI failures at the tool boundary', async () => {
    const cause = new Error('UI exploded')
    const fixture = setup(cause)

    const rejection = await fixture.tool.execute('ui-error', params, undefined, undefined, fixture.tuiContext).then(
      () => undefined,
      (error: unknown) => error
    )

    expect(rejection).toMatchObject({ _tag: 'AskUserUiError', cause, message: 'UI exploded' })
  })
})

describe('ask_user prompt component', () => {
  test('propagates focus to the embedded editor for IME cursor positioning', async () => {
    const fixture = setup()
    const pending = fixture.tool.execute('call-6', params, undefined, undefined, fixture.tuiContext)

    fixture.component.focused = true
    fixture.component.handleInput?.('3')

    expect(fixture.component.render(40).join('\n')).toContain(CURSOR_MARKER)

    fixture.component.handleInput?.('\x1b')
    fixture.component.handleInput?.('\x1b')
    await pending
  })

  test('wraps wide Unicode content and invalidates its cache when width changes', async () => {
    const fixture = setup()
    const pending = fixture.tool.execute(
      'call-7',
      {
        options: [{ description: 'A long explanatory description', label: 'A long first option' }, { label: 'Second option' }],
        question: '界界界界',
      },
      undefined,
      undefined,
      fixture.tuiContext
    )

    fixture.component.render(40)
    const narrowLines = fixture.component.render(8)

    expect(narrowLines.every((line) => visibleWidth(line) <= 8)).toBeTrue()
    expect(narrowLines.join('').match(/界/g)).toHaveLength(4)

    fixture.component.handleInput?.('\x1b')
    await pending
  })
})
