import { type AgentToolResult, initTheme, type Theme, type ToolRenderResultOptions } from '@earendil-works/pi-coding-agent'
import { type Component, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asExtensionContext, asExtensionToolContext, asResult, asTheme, asTool } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime } from '@tests/utils/runtime.js'
import { Effect, Exit, Scope } from 'effect'
import { FileSystem } from 'effect/FileSystem'
import { Value } from 'typebox/value'

import { feature } from '@/features/peers/index.js'
import { type MessageResult, type OpenResult } from '@/features/peers/peers.js'
import { AgentModelSettingsError, loadAgentModelSettings } from '@/shared/effect/agent_models.js'
import { makeEnvironment } from '@/shared/effect/env.js'
import { jsonText } from '@/shared/utils/json.js'

interface DisplayTool {
  renderCall: (args: { model?: string; name?: string; pane_id?: string; message?: string }, theme: Theme, context: { expanded: boolean }) => Component
  renderResult: (
    result: AgentToolResult<OpenResult | MessageResult | undefined>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: { isError: boolean }
  ) => Component
}

initTheme()
const theme = asTheme({ bold: (text: string) => text, fg: (_color: string, text: string) => text })
const renderText = (component: Component) =>
  component
    .render(160)
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
const displayTools = () => {
  const fixture = createFakePi()
  feature({ environment: makeEnvironment({}) }).implementation.register(fixture.pi, runtime)
  return (name: string) => asTool<DisplayTool>(fixture.state.tools.get(name))
}
const toolContext = (models: string[]) =>
  asExtensionToolContext({
    cwd: '/project',
    isProjectTrusted: () => false,
    modelRegistry: {
      getAvailable: () => models.map((model) => ({ id: model.slice(model.indexOf('/') + 1), provider: model.slice(0, model.indexOf('/')) })),
    },
  })
const failureOf = (promise: () => Promise<unknown>) =>
  Effect.tryPromise(promise).pipe(Effect.match({ onFailure: (error) => error.cause, onSuccess: () => undefined }))

describe('peers display', () => {
  it('shows model or pane headers and handles incomplete calls', () => {
    const tool = displayTools()
    expect(renderText(tool('open_agent').renderCall({}, theme, { expanded: false }))).toBe('open_agent ?')
    expect(renderText(tool('open_agent').renderCall({ message: 'Review\nthe diff', model: 'p/m', name: 'Review' }, theme, { expanded: false }))).toBe(
      'open_agent Review · p/m\nReview the diff'
    )
    expect(renderText(tool('message_peer').renderCall({ message: 'Hi', pane_id: 'w1:p2' }, theme, { expanded: false }))).toBe(
      'message_peer w1:p2\nHi'
    )
    const long = `${'long message '.repeat(100)}\nsecond line`
    const collapsed = tool('message_peer').renderCall({ message: long, pane_id: 'w1:p2' }, theme, { expanded: false })
    expect(renderText(collapsed)).toContain('to expand')
    expect(collapsed.render(20).every((line) => visibleWidth(line) <= 20)).toBe(true)
    expect(renderText(tool('message_peer').renderCall({ message: long, pane_id: 'w1:p2' }, theme, { expanded: true }))).toContain('second line')
  })

  it('renders readable statuses, errors, and progress', () => {
    const tool = displayTools()
    const options = { expanded: false, isPartial: false }
    const opened: OpenResult = { model: 'p/m', pane_id: 'block:1', status: 'opened' }
    expect(renderText(tool('open_agent').renderResult({ content: [], details: opened }, options, theme, { isError: false }))).toBe(
      'Opened · block:1 · p/m'
    )
    const sent: MessageResult = { pane_id: 'w1:p2', status: 'sent' }
    expect(renderText(tool('message_peer').renderResult({ content: [], details: sent }, options, theme, { isError: false }))).toBe(
      'Message submitted · w1:p2'
    )
    const failed = { content: [{ text: 'Tab block:1 was created and remains open.', type: 'text' as const }], details: undefined }
    expect(renderText(tool('open_agent').renderResult(failed, options, theme, { isError: true }))).toBe('Tab block:1 was created and remains open.')
    expect(renderText(tool('open_agent').renderResult({ content: [], details: undefined }, options, theme, { isError: true }))).toBe(
      'Peer operation failed'
    )
    expect(
      renderText(tool('open_agent').renderResult({ content: [], details: undefined }, { ...options, isPartial: true }, theme, { isError: false }))
    ).toBe('Working…')
  })
})

describe('peers registration', () => {
  it('registers the peer tools and refreshes models before each turn', () => {
    const fixture = createFakePi()
    const descriptor = feature({ environment: makeEnvironment({}) })
    descriptor.implementation.register(fixture.pi, runtime)
    expect(descriptor).toMatchObject({ id: 'peers', status: { icon: '↗', name: 'peers' } })
    expect([...fixture.state.tools.keys()]).toEqual(['open_agent', 'message_peer', 'discover_agents'])
    expect([...fixture.state.handlers.keys()]).toEqual(['before_agent_start'])
    const open = fixture.state.tools.get('open_agent')
    expect(open?.parameters).toMatchObject({ properties: { model: { description: 'No allowed models are available; opening is disabled.' } } })
    expect(Value.Check(open?.parameters ?? {}, { message: 'Review', model: 'p/m' })).toBe(true)
    expect(Value.Check(open?.parameters ?? {}, { message: 'Review', model: 'p/m', tools: ['read'] })).toBe(true)
    expect(open?.parameters).not.toHaveProperty('properties.tools')
    expect(open?.promptGuidelines?.join('\n')).toContain('nothing it produces is reported back')
    expect(fixture.state.tools.get('message_peer')?.promptGuidelines?.join('\n')).toContain('comes from a peer, not your user')
  })

  it.scoped('[VC-15] registers nothing and writes no presence record in a sub-agent', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem
      const agentDir = yield* fs.makeTempDirectoryScoped()
      const fixture = createFakePi()
      const descriptor = feature({
        dependencies: { agentDir },
        environment: makeEnvironment({ PI_SUBAGENT: '1', REX_BLOCK: 'block:1', REX_SESSION: 'session:1' }),
      })
      descriptor.implementation.register(fixture.pi, runtime)
      expect(fixture.state.tools.size).toBe(0)
      expect(fixture.state.handlers.size).toBe(0)
      const scope = yield* Scope.make()
      const ctx = asExtensionContext({ cwd: '/project', mode: 'tui', sessionManager: { getSessionFile: () => '/s.jsonl' } })
      yield* Effect.promise(() => runtime.runPromise(Scope.provide(scope)(descriptor.implementation.activate?.(asResult({}), ctx) ?? Effect.void)))
      yield* Scope.close(scope, Exit.void)
      expect(yield* fs.readDirectory(agentDir)).toEqual([])
    })
  )

  it.scoped('[VC-19] offers only subagents.allowedModels to open_agent and ignores a legacy herdr block', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem
      const agentDir = yield* fs.makeTempDirectoryScoped()
      const fixture = createFakePi()
      feature({
        dependencies: { loadSettings: (options) => loadAgentModelSettings({ ...options, agentDir }) },
        environment: makeEnvironment({}),
      }).implementation.register(fixture.pi, runtime)
      const sections: Record<string, string> = {}
      const event = { systemPromptOptions: { sections } }
      yield* fs.writeFileString(`${agentDir}/settings.json`, jsonText({ herdr: { allowedModels: ['p/a'] }, subagents: { allowedModels: ['p/b'] } }))
      yield* Effect.promise(() => fixture.emit('before_agent_start', event, toolContext(['p/a', 'p/b'])))
      expect(fixture.state.tools.get('open_agent')?.parameters).toMatchObject({ properties: { model: { enum: ['p/b'] } } })
      expect(sections.peers).toBe('open_agent may only use these allowed, available models: p/b.')
      yield* fs.writeFileString(`${agentDir}/settings.json`, jsonText({ herdr: { allowedModels: ['p/a'] } }))
      yield* Effect.promise(() => fixture.emit('before_agent_start', event, toolContext(['p/a', 'p/b'])))
      expect(sections.peers).toContain('configure subagents.allowedModels')
      expect(fixture.state.tools.get('open_agent')?.parameters).not.toHaveProperty('properties.model.enum')
      yield* fs.writeFileString(`${agentDir}/settings.json`, jsonText({ subagents: { profiles: {} } }))
      yield* Effect.promise(() => fixture.emit('before_agent_start', event, toolContext(['p/b'])))
      expect(sections.peers).toContain('open_agent is unavailable:')
    })
  )

  it.effect('adds model notes and reports settings failures in the prompt section', () =>
    Effect.gen(function* () {
      const fixture = createFakePi()
      let invalid = false
      feature({
        dependencies: {
          loadSettings: () =>
            invalid
              ? Effect.fail(AgentModelSettingsError.make({ message: 'invalid subagents.allowedModels' }))
              : Effect.succeed({ allowedModels: ['p/a'], modelNotes: { 'p/a': 'research only' } }),
        },
        environment: makeEnvironment({}),
      }).implementation.register(fixture.pi, runtime)
      const sections: Record<string, string> = {}
      yield* Effect.promise(() => fixture.emit('before_agent_start', { systemPromptOptions: { sections } }, toolContext(['p/a'])))
      expect(fixture.state.tools.get('open_agent')?.parameters).toHaveProperty(
        'properties.model.description',
        expect.stringContaining('Model notes: p/a: research only')
      )
      invalid = true
      yield* Effect.promise(() => fixture.emit('before_agent_start', { systemPromptOptions: { sections } }, toolContext(['p/a'])))
      expect(sections.peers).toBe('open_agent is unavailable: invalid subagents.allowedModels')
    })
  )

  it.effect('fails every peer tool outside Herdr and Rex without contacting a CLI', () =>
    Effect.gen(function* () {
      const fixture = createFakePi({
        exec: () => {
          throw new Error('must not execute')
        },
      })
      feature({
        dependencies: { loadSettings: () => Effect.succeed({ allowedModels: ['p/m'], modelNotes: {} }) },
        environment: makeEnvironment({ REX_BLOCK: 'block:only' }),
      }).implementation.register(fixture.pi, runtime)
      const ctx = toolContext(['p/m'])
      const expected = { _tag: 'ToolFailure', message: 'These tools require Pi to run inside Herdr or Rex.' }
      const open = fixture.state.tools.get('open_agent')
      const message = fixture.state.tools.get('message_peer')
      const discover = fixture.state.tools.get('discover_agents')
      expect(
        yield* failureOf(() => open?.execute('1', { message: 'Review', model: 'p/m' }, undefined, undefined, ctx) ?? Promise.resolve())
      ).toMatchObject(expected)
      expect(
        yield* failureOf(() => message?.execute('2', { message: 'Hi', pane_id: 'x' }, undefined, undefined, ctx) ?? Promise.resolve())
      ).toMatchObject(expected)
      expect(yield* failureOf(() => discover?.execute('3', {}, undefined, undefined, ctx) ?? Promise.resolve())).toMatchObject(expected)
    })
  )
})
