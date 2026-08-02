import { describe, expect, test } from 'bun:test'

import backgroundPoll from '../index'

interface ToolResult {
  content: { text: string; type: string }[]
  terminate?: boolean
  details?: Record<string, unknown>
}

interface Tool {
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: Record<string, unknown>
  ) => Promise<ToolResult>
}

type Handler = (event: unknown, ctx: Record<string, unknown>) => Promise<void> | void

const setup = (execResults: { stdout: string; stderr: string; code: number }[]) => {
  let tool: Tool | undefined
  const handlers = new Map<string, Handler>()
  const messages: { message: Record<string, unknown>; options: Record<string, unknown> }[] = []
  let messageSent: (() => void) | undefined
  const sent = new Promise<void>((resolve) => {
    messageSent = resolve
  })

  backgroundPoll({
    exec: async () => execResults.shift() ?? { code: 1, stderr: 'not ready', stdout: '' },
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerTool: (definition: Tool) => {
      tool = definition
    },
    sendMessage: (message: Record<string, unknown>, options: Record<string, unknown>) => {
      messages.push({ message, options })
      messageSent?.()
    },
  } as unknown as Parameters<typeof backgroundPoll>[0])

  const statuses: unknown[] = []
  const ctx = {
    hasUI: true,
    ui: {
      notify: () => undefined,
      setStatus: (_key: string, value: unknown) => statuses.push(value),
      theme: { fg: (_color: string, value: string) => value },
    },
  }

  if (!tool) {
    throw new Error('background-poll did not register a tool')
  }

  return { ctx, handlers, messages, sent, statuses, tool }
}

describe('background poll', () => {
  test('returns immediately and wakes the agent after a successful poll', async () => {
    const fixture = setup([
      { code: 1, stderr: 'pending', stdout: '' },
      { code: 0, stderr: '', stdout: 'ready' },
    ])

    const result = await fixture.tool.execute(
      'call-1',
      {
        command: 'check-status',
        interval_seconds: 0,
        label: 'deployment',
        timeout_seconds: 10,
      },
      undefined,
      undefined,
      fixture.ctx
    )

    expect(result.terminate).toBeTrue()
    expect(result.content[0].text).toContain('Stop now')

    await fixture.sent
    expect(fixture.messages).toHaveLength(1)
    expect(fixture.messages[0].message.content).toContain('Background poll completed: deployment')
    expect(fixture.messages[0].message.content).toContain('ready')
    expect(fixture.messages[0].options).toEqual({ deliverAs: 'followUp', triggerTurn: true })
  })

  test('aborts active polling when the session shuts down', async () => {
    const fixture = setup([{ code: 1, stderr: 'pending', stdout: '' }])

    await fixture.tool.execute(
      'call-2',
      {
        command: 'check-status',
        interval_seconds: 60,
        timeout_seconds: 120,
      },
      undefined,
      undefined,
      fixture.ctx
    )

    await fixture.handlers.get('session_shutdown')?.({}, fixture.ctx)
    await Bun.sleep(5)

    expect(fixture.messages).toHaveLength(0)
    expect(fixture.statuses.at(-1)).toBeUndefined()
  })
})
