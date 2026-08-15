import { type AssistantMessage } from '@earendil-works/pi-ai'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asCommand, asExtensionContext, asNarrowed } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime } from '@tests/utils/runtime.js'
import { Effect } from 'effect'

import { register } from '@/features/plain_english/index.js'

interface CommandHandler {
  handler: (args: string, ctx: unknown) => Promise<void>
}

const configuredEnvironment = { PI_PLAIN_ENGLISH_MIN_CHARS: '1', PI_PLAIN_ENGLISH_MODEL: 'test/rewriter' }

const context = (notifications: { message: string; level: string }[]) =>
  asExtensionContext({
    cwd: process.cwd(),
    modelRegistry: {
      complete: () =>
        Promise.resolve(asNarrowed<AssistantMessage, object>({ content: [{ text: 'Clearer prose', type: 'text' }], stopReason: 'stop' })),
      find: () => asNarrowed<object, object>({}),
    },
    ui: {
      notify: (message: string, level: string) => {
        notifications.push({ level, message })
      },
    },
  })

const assistantEvent = {
  message: {
    api: 'test',
    content: [{ text: 'Dense prose.', type: 'text' }],
    model: 'test',
    provider: 'test',
    role: 'assistant',
    stopReason: 'stop',
    timestamp: 0,
    usage: {},
  },
  type: 'message_end',
}

const settle = Effect.sleep(10)

const command = (fixture: ReturnType<typeof createFakePi>, name: string): CommandHandler =>
  asCommand<CommandHandler>(fixture.state.commands.get(name))

describe('plain english registration', () => {
  it('registers its renderer, lifecycle handlers, and commands when configured', () => {
    const fixture = createFakePi()

    register(fixture.pi, runtime, configuredEnvironment)

    expect([...fixture.state.entryRenderers.keys()]).toEqual(['plain-english'])
    expect([...fixture.state.handlers.keys()]).toEqual(['session_start', 'session_shutdown', 'message_end'])
    expect([...fixture.state.commands.keys()]).toEqual(['plain-english', 'plain-english-md'])
  })

  it('keeps both commands and the renderer available without a configured model', () => {
    const fixture = createFakePi()

    register(fixture.pi, runtime, {})

    expect([...fixture.state.entryRenderers.keys()]).toEqual(['plain-english'])
    expect(fixture.state.handlers.size).toBe(0)
    expect([...fixture.state.commands.keys()]).toEqual(['plain-english', 'plain-english-md'])
  })

  it.live('toggles message rewrites while leaving Markdown rewriting available', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      const notifications: { message: string; level: string }[] = []
      const ctx = context(notifications)
      register(fixture.pi, runtime, configuredEnvironment)

      yield* Effect.promise(() => fixture.emit('session_start', {}, ctx))
      yield* Effect.promise(() => command(fixture, 'plain-english').handler('off', ctx))
      yield* Effect.promise(() => fixture.emit('message_end', assistantEvent, ctx))
      yield* settle
      expect(fixture.state.entries).toEqual([])

      yield* Effect.promise(() => command(fixture, 'plain-english').handler('on', ctx))
      yield* Effect.promise(() => fixture.emit('message_end', assistantEvent, ctx))
      yield* settle
      expect(fixture.state.entries).toEqual([{ customType: 'plain-english', data: { text: 'Clearer prose' } }])

      yield* Effect.promise(() => command(fixture, 'plain-english').handler('', ctx))
      yield* Effect.promise(() => fixture.emit('message_end', assistantEvent, ctx))
      yield* settle
      expect(fixture.state.entries).toHaveLength(1)

      yield* Effect.promise(() => command(fixture, 'plain-english').handler('typo', ctx))
      yield* Effect.promise(() => fixture.emit('message_end', assistantEvent, ctx))
      yield* settle
      expect(fixture.state.entries).toHaveLength(1)

      yield* Effect.promise(() => command(fixture, 'plain-english-md').handler('', ctx))
      expect(notifications.map(({ message }) => message)).toContain('Provide a Markdown file path.')
      expect(notifications.map(({ message }) => message)).toContain('Plain-English rewrites are off.')
      expect(notifications.map(({ message }) => message)).toContain('Plain-English rewrites are on.')
      expect(notifications).toContainEqual({ level: 'warning', message: 'Usage: /plain-english [on|off]' })
    })
  )

  it.live('notifies once without calling the provider when the configured model cannot be resolved', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      const notifications: { message: string; level: string }[] = []
      let completionCalls = 0
      const ctx = asExtensionContext({
        cwd: process.cwd(),
        modelRegistry: {
          complete: () => {
            completionCalls += 1
            return Promise.resolve(asNarrowed<AssistantMessage, object>({ content: [], stopReason: 'stop' }))
          },
          find: () => undefined,
        },
        ui: {
          notify: (message: string, level: string) => {
            notifications.push({ level, message })
          },
        },
      })
      register(fixture.pi, runtime, configuredEnvironment)

      yield* Effect.promise(() => fixture.emit('session_start', {}, ctx))
      yield* Effect.promise(() => fixture.emit('message_end', assistantEvent, ctx))
      yield* settle

      expect(fixture.state.entries).toEqual([])
      expect(completionCalls).toBe(0)
      expect(notifications).toHaveLength(1)
      expect(notifications[0]?.level).toBe('warning')
    })
  )
})
