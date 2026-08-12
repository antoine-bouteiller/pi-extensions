import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asCommand, asExtensionContext } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime } from '@tests/utils/runtime.js'

import { register as registerPromptRewind } from '@/features/prompt_rewind/index.js'

const REWIND_COMMAND = 'prompt-rewind-cancel'

type TerminalResult = { consume?: boolean; data?: string } | undefined
type TerminalHandler = (data: string) => TerminalResult

interface FakeEntry {
  id: string
  parentId: string | null
  type: 'message'
  message: { role: 'user' | 'assistant'; content: string }
}

interface CommandHandler {
  handler: (args: string, ctx: unknown) => Promise<void>
}

interface InputSubmission {
  images?: unknown[]
  source: string
  streamingBehavior?: string
  text: string
}

const createHarness = (dispatchSubmittedCommands = false) => {
  const fixture = createFakePi()
  registerPromptRewind(fixture.pi, runtime)

  let terminalHandler: TerminalHandler | undefined
  let terminalUnsubscribed = false
  let editorText = ''
  let editorTextAfterWait: string | undefined
  let overlay = false
  let pendingMessages = false
  let leafId: string | null = 'root'
  const entries = new Map<string, FakeEntry>([
    ['root', { id: 'root', message: { content: 'previous response', role: 'assistant' }, parentId: 'before-root', type: 'message' }],
  ])
  const aborts: number[] = []
  const notifications: { level: string; message: string }[] = []
  const submittedCommands: string[] = []
  const submittedCommandTasks: Promise<void>[] = []
  const waitForIdleCalls: number[] = []
  const navigateTreeCalls: string[] = []
  let navigateTreeResult: { cancelled: boolean } = { cancelled: false }

  const editor = {
    onSubmit: (text: string) => {
      submittedCommands.push(text)
      // Pi only dispatches extension commands through this path while the main run is still active.
      if (dispatchSubmittedCommands && aborts.length === 0) {
        const registered = asCommand<CommandHandler>(fixture.state.commands.get(REWIND_COMMAND))
        submittedCommandTasks.push(registered.handler('', ctx))
      }
    },
  }
  const tui = { hasOverlay: () => overlay }

  const ctx = asExtensionContext({
    abort: () => {
      aborts.push(aborts.length)
    },
    hasPendingMessages: () => pendingMessages,
    mode: 'tui',
    navigateTree: async (targetId: string) => {
      navigateTreeCalls.push(targetId)
      if (targetId === leafId || navigateTreeResult.cancelled) {
        return navigateTreeResult
      }
      const target = entries.get(targetId)
      leafId = target?.message.role === 'user' ? target.parentId : targetId
      return navigateTreeResult
    },
    sessionManager: {
      getBranch: () => {
        const path: FakeEntry[] = []
        let current = leafId === null ? undefined : entries.get(leafId)
        while (current !== undefined) {
          path.push(current)
          current = current.parentId === null ? undefined : entries.get(current.parentId)
        }
        return path.toReversed()
      },
      getLeafId: () => leafId,
    },
    ui: {
      getEditorComponent: () => () => editor,
      getEditorText: () => editorText,
      notify: (message: string, level: string) => {
        notifications.push({ level, message })
      },
      onTerminalInput: (handler: TerminalHandler) => {
        terminalHandler = handler
        terminalUnsubscribed = false
        return () => {
          terminalHandler = undefined
          terminalUnsubscribed = true
        }
      },
      setEditorComponent: (factory?: (tui: unknown, theme: unknown, keybindings: unknown) => unknown) => {
        factory?.(tui, {}, {})
      },
      setEditorText: (text: string) => {
        editorText = text
      },
    },
    waitForIdle: async () => {
      waitForIdleCalls.push(waitForIdleCalls.length)
      if (editorTextAfterWait !== undefined) {
        editorText = editorTextAfterWait
      }
    },
  })

  const startSession = async (mode: 'tui' | 'rpc' = 'tui'): Promise<void> => {
    await fixture.emit('session_start', {}, { ...ctx, mode })
  }

  const submit = async (input: InputSubmission): Promise<void> => {
    await fixture.emit('input', input, ctx)
    await fixture.emit('before_agent_start', {}, ctx)
    await fixture.emit('agent_start', {}, ctx)
  }

  const submitAndArm = (text = 'hello'): Promise<void> => submit({ source: 'interactive', text })

  const dispatch = (data: string): TerminalResult => terminalHandler?.(data)
  const escape = (): TerminalResult => dispatch('\x1b')

  const addEntry = (id: string, parentId: string | null, role: 'assistant' | 'user', content: string): void => {
    entries.set(id, { id, message: { content, role }, parentId, type: 'message' })
    leafId = id
  }

  const command = () => asCommand<CommandHandler>(fixture.state.commands.get(REWIND_COMMAND))

  return {
    aborts,
    addAssistantEntry: (id: string, parentId: string, content = '') => addEntry(id, parentId, 'assistant', content),
    addUserEntry: (id: string, parentId: string | null, content: string) => addEntry(id, parentId, 'user', content),
    command,
    ctx,
    dispatch,
    editorText: () => editorText,
    escape,
    fixture,
    flushSubmittedCommands: async () => {
      await Promise.all(submittedCommandTasks)
    },
    hasTerminalHandler: () => terminalHandler !== undefined,
    navigateTreeCalls,
    notifications,
    setEditorText: (value: string) => {
      editorText = value
    },
    setEditorTextAfterWait: (value: string) => {
      editorTextAfterWait = value
    },
    setNavigateTreeResult: (value: { cancelled: boolean }) => {
      navigateTreeResult = value
    },
    setOverlay: (value: boolean) => {
      overlay = value
    },
    setPendingMessages: (value: boolean) => {
      pendingMessages = value
    },
    startSession,
    submit,
    submitAndArm,
    submittedCommands,
    terminalUnsubscribed: () => terminalUnsubscribed,
    waitForIdleCalls,
  }
}

describe('prompt rewind', () => {
  it.effect('registers exactly one internal command and no tools or message renderers', () => {
    const harness = createHarness()

    expect([...harness.fixture.state.handlers.keys()].toSorted()).toEqual(
      [
        'agent_end',
        'agent_start',
        'before_agent_start',
        'input',
        'message_update',
        'session_shutdown',
        'session_start',
        'tool_execution_start',
      ].toSorted()
    )
    expect([...harness.fixture.state.commands.keys()]).toEqual([REWIND_COMMAND])
    expect(harness.fixture.state.tools.size).toBe(0)
  })

  it.effect('does not register a terminal listener outside tui mode', async () => {
    const harness = createHarness()
    await harness.startSession('rpc')

    expect(harness.hasTerminalHandler()).toBeFalse()
  })

  it.effect('Escape dispatches the internal command before aborting and restores the prompt for editing', async () => {
    const harness = createHarness(true)
    await harness.startSession()
    await harness.submitAndArm('original raw text')
    harness.addUserEntry('user-1', 'root', 'original raw text')
    harness.addAssistantEntry('aborted-1', 'user-1')

    const result = harness.escape()
    await harness.flushSubmittedCommands()

    expect(result).toEqual({ consume: true })
    expect(harness.submittedCommands).toEqual([`/${REWIND_COMMAND}`])
    expect(harness.aborts).toHaveLength(1)
    expect(harness.navigateTreeCalls).toEqual(['user-1'])
    expect(harness.editorText()).toBe('original raw text')
  })

  it.effect('never arms for image attachments', async () => {
    const harness = createHarness()
    await harness.startSession()
    await harness.submit({ images: [{ data: 'x', type: 'image' }], source: 'interactive', text: 'hi' })

    const result = harness.escape()

    expect(result).toBeUndefined()
    expect(harness.aborts).toHaveLength(0)
  })

  it.effect('never arms for non-interactive sources', async () => {
    const harness = createHarness()
    await harness.startSession()
    await harness.submit({ source: 'rpc', text: 'hi' })

    const result = harness.escape()

    expect(result).toBeUndefined()
    expect(harness.aborts).toHaveLength(0)
  })

  it.effect('never arms for queued steering submissions', async () => {
    const harness = createHarness()
    await harness.startSession()
    await harness.submit({ source: 'interactive', streamingBehavior: 'steer', text: 'hi' })

    const result = harness.escape()

    expect(result).toBeUndefined()
    expect(harness.aborts).toHaveLength(0)
  })

  it.effect('ignores key release and key repeat sequences even while armed', async () => {
    const harness = createHarness()
    await harness.startSession()
    await harness.submitAndArm()

    expect(harness.dispatch('\x1b[27;1:3u')).toBeUndefined()
    expect(harness.dispatch('\x1b[27;1:2u')).toBeUndefined()
    expect(harness.aborts).toHaveLength(0)
  })

  it.effect('ignores non-escape keys while armed', async () => {
    const harness = createHarness()
    await harness.startSession()
    await harness.submitAndArm()

    const result = harness.dispatch('a')

    expect(result).toBeUndefined()
    expect(harness.aborts).toHaveLength(0)
  })

  it.effect('does not hijack Escape while messages are queued, so the built-in restore still runs', async () => {
    const harness = createHarness()
    await harness.startSession()
    await harness.submitAndArm()
    harness.setPendingMessages(true)

    const result = harness.escape()

    expect(result).toBeUndefined()
    expect(harness.aborts).toHaveLength(0)
  })

  it.effect('does not hijack Escape when the editor already holds a fresh draft', async () => {
    const harness = createHarness()
    await harness.startSession()
    await harness.submitAndArm()
    harness.setEditorText('a new draft')

    const result = harness.escape()

    expect(result).toBeUndefined()
    expect(harness.aborts).toHaveLength(0)
  })

  it.effect('leaves overlay Escape handling alone and disarms the rewind', async () => {
    const harness = createHarness()
    await harness.startSession()
    await harness.submitAndArm()
    harness.setOverlay(true)

    expect(harness.escape()).toBeUndefined()
    harness.setOverlay(false)
    expect(harness.escape()).toBeUndefined()
    expect(harness.submittedCommands).toEqual([])
  })
  it.effect('consumes a second Escape while the first cancellation is still in flight', async () => {
    const harness = createHarness()
    await harness.startSession()
    await harness.submitAndArm()

    harness.escape()
    const second = harness.escape()

    expect(second).toEqual({ consume: true })
    expect(harness.aborts).toHaveLength(0)
  })

  it.effect('disarms on the first assistant message update', async () => {
    const harness = createHarness()
    await harness.startSession()
    await harness.submitAndArm()
    await harness.fixture.emit('message_update', {})

    const result = harness.escape()

    expect(result).toBeUndefined()
    expect(harness.aborts).toHaveLength(0)
  })

  it.effect('disarms on tool_execution_start', async () => {
    const harness = createHarness()
    await harness.startSession()
    await harness.submitAndArm()
    await harness.fixture.emit('tool_execution_start', {})

    const result = harness.escape()

    expect(result).toBeUndefined()
    expect(harness.aborts).toHaveLength(0)
  })

  it.effect('disarms on agent_end', async () => {
    const harness = createHarness()
    await harness.startSession()
    await harness.submitAndArm()
    await harness.fixture.emit('agent_end', {})

    const result = harness.escape()

    expect(result).toBeUndefined()
    expect(harness.aborts).toHaveLength(0)
  })

  it.effect('does not disarm before the assistant starts producing output', async () => {
    const harness = createHarness()
    await harness.startSession()
    await harness.submitAndArm()
    await harness.fixture.emit('message_start', { message: { role: 'assistant' } })

    const result = harness.escape()

    expect(result).toEqual({ consume: true })
  })

  it.effect('command handler rewinds the captured user entry and restores the raw pre-expansion text', async () => {
    const harness = createHarness()
    await harness.startSession()
    await harness.submitAndArm('/skill:foo do the thing')
    harness.escape()
    harness.addUserEntry('user-1', 'root', 'expanded skill content, not the raw text')
    harness.addAssistantEntry('aborted-1', 'user-1')

    await harness.command().handler('', harness.ctx)

    expect(harness.aborts).toHaveLength(1)
    expect(harness.waitForIdleCalls).toHaveLength(1)
    expect(harness.navigateTreeCalls).toEqual(['user-1'])
    expect(harness.editorText()).toBe('/skill:foo do the thing')
  })

  it.effect('command handler preserves a draft typed while cancellation settles', async () => {
    const harness = createHarness()
    await harness.startSession()
    await harness.submitAndArm('original')
    harness.escape()
    harness.addUserEntry('user-1', 'root', 'original')
    harness.addAssistantEntry('aborted-1', 'user-1')
    harness.setEditorTextAfterWait('new draft')

    await harness.command().handler('', harness.ctx)

    expect(harness.editorText()).toBe('original\n\nnew draft')
  })

  it.effect('command handler notifies when no matching entry exists', async () => {
    const harness = createHarness()
    await harness.startSession()
    await harness.submitAndArm('original')
    harness.escape()

    await harness.command().handler('', harness.ctx)

    expect(harness.navigateTreeCalls).toEqual([])
    expect(harness.notifications).toHaveLength(1)
    expect(harness.notifications[0]?.level).toBe('warning')
  })

  it.effect('command handler does not restore raw text when navigateTree reports cancellation', async () => {
    const harness = createHarness()
    await harness.startSession()
    await harness.submitAndArm('original')
    harness.escape()
    harness.addUserEntry('user-1', 'root', 'expanded')
    harness.addAssistantEntry('aborted-1', 'user-1')
    harness.setNavigateTreeResult({ cancelled: true })

    await harness.command().handler('', harness.ctx)

    expect(harness.navigateTreeCalls).toEqual(['user-1'])
    expect(harness.editorText()).toBe('')
  })

  it.effect('command handler is a no-op when nothing was captured', async () => {
    const harness = createHarness()
    await harness.startSession()

    await harness.command().handler('', harness.ctx)

    expect(harness.aborts).toHaveLength(0)
    expect(harness.waitForIdleCalls).toHaveLength(0)
    expect(harness.navigateTreeCalls).toEqual([])
  })

  it.effect('session_shutdown unsubscribes the terminal listener and clears in-flight state', async () => {
    const harness = createHarness()
    await harness.startSession()
    await harness.submitAndArm()
    harness.escape()

    await harness.fixture.emit('session_shutdown', {})

    expect(harness.terminalUnsubscribed()).toBeTrue()
    await harness.command().handler('', harness.ctx)
    expect(harness.navigateTreeCalls).toEqual([])
  })

  it.effect('session_start resets stale arming from a previous session', async () => {
    const harness = createHarness()
    await harness.startSession()
    await harness.submitAndArm()

    await harness.startSession()
    const result = harness.escape()

    expect(result).toBeUndefined()
    expect(harness.aborts).toHaveLength(0)
  })
})
