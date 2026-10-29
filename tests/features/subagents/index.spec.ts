import { type AgentToolResult, initTheme, type Theme, type ToolRenderResultOptions } from '@earendil-works/pi-coding-agent'
import { type Component } from '@earendil-works/pi-tui'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asExtensionToolContext, asTheme, asTool } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime } from '@tests/utils/runtime.js'
import { Effect } from 'effect'
import { FileSystem } from 'effect/FileSystem'
import { Value } from 'typebox/value'

import { feature } from '@/features/subagents/index.js'
import { type AgentResult, type ListResult } from '@/features/subagents/subagents.js'
import { AgentModelSettingsError, loadAgentModelSettings } from '@/shared/effect/agent_models.js'
import { makeEnvironment } from '@/shared/effect/env.js'
import { jsonText } from '@/shared/utils/json.js'

interface DisplayTool {
  renderCall: (
    args: { agent_id?: string; model?: string; name?: string; message?: string },
    theme: Theme,
    context: { expanded: boolean }
  ) => Component
  renderResult: (
    result: AgentToolResult<AgentResult | ListResult | undefined>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: { isError: boolean }
  ) => Component
}

interface SpawnTool {
  execute: (id: string, params: { message: string; model: string }, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<unknown>
}

initTheme()
const theme = asTheme({ bold: (text: string) => text, fg: (_color: string, text: string) => text })
const renderText = (component: Component) =>
  component
    .render(160)
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
const registered = () => {
  const fixture = createFakePi()
  feature({ environment: makeEnvironment({}) }).implementation.register(fixture.pi, runtime)
  return fixture
}
const toolContext = (models: string[]) =>
  asExtensionToolContext({
    cwd: '/project',
    isProjectTrusted: () => false,
    modelRegistry: {
      getAvailable: () => models.map((model) => ({ id: model.slice(model.indexOf('/') + 1), provider: model.slice(0, model.indexOf('/')) })),
    },
  })

describe('subagents registration', () => {
  it('registers the sub-agent tools with headless guidance', () => {
    const fixture = registered()
    expect(feature()).toMatchObject({ id: 'subagents', status: { icon: '⇣', name: 'subagents' } })
    expect([...fixture.state.tools.keys()]).toEqual(['spawn_agent', 'send_message', 'interrupt_agent', 'close_agent', 'list_agents'])
    expect([...fixture.state.handlers.keys()]).toEqual(['before_agent_start'])
    const spawn = fixture.state.tools.get('spawn_agent')
    expect(spawn?.parameters).toMatchObject({ properties: { model: { description: 'No allowed models are available; spawning is disabled.' } } })
    expect(Value.Check(spawn?.parameters ?? {}, { message: 'Review', model: 'p/m', tools: ['read'] })).toBe(true)
    expect(Value.Check(spawn?.parameters ?? {}, { message: 'x'.repeat(32_769), model: 'p/m' })).toBe(false)
    const guidance = spawn?.promptGuidelines?.join('\n') ?? ''
    expect(guidance).toContain('subagent-result message')
    expect(guidance).toContain('subagents.allowedModels is mandatory')
    expect(guidance).not.toContain('Herdr')
  })

  it('[VC-15] registers no tool and no handler in a sub-agent', () => {
    const fixture = createFakePi()
    feature({ environment: makeEnvironment({ PI_SUBAGENT: '1' }) }).implementation.register(fixture.pi, runtime)
    expect(fixture.state.tools.size).toBe(0)
    expect(fixture.state.handlers.size).toBe(0)
  })

  it.scoped('[VC-19] offers only subagents.allowedModels to spawn_agent and ignores a legacy herdr block', () =>
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
      expect(fixture.state.tools.get('spawn_agent')?.parameters).toMatchObject({ properties: { model: { enum: ['p/b'] } } })
      expect(sections.subagents).toBe('spawn_agent may only use these allowed, available models: p/b.')
      yield* fs.writeFileString(`${agentDir}/settings.json`, jsonText({ herdr: { allowedModels: ['p/a'] } }))
      yield* Effect.promise(() => fixture.emit('before_agent_start', event, toolContext(['p/a', 'p/b'])))
      expect(sections.subagents).toContain('configure subagents.allowedModels')
      expect(fixture.state.tools.get('spawn_agent')?.parameters).not.toHaveProperty('properties.model.enum')
      const spawn = asTool<SpawnTool>(fixture.state.tools.get('spawn_agent'))
      const failure = yield* Effect.tryPromise(() =>
        spawn.execute('1', { message: 'Go', model: 'p/a' }, undefined, undefined, toolContext(['p/a']))
      ).pipe(Effect.match({ onFailure: (error) => error.cause, onSuccess: () => undefined }))
      expect(failure).toMatchObject({ _tag: 'ToolFailure', message: expect.stringContaining('Configure subagents.allowedModels') })
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
      expect(fixture.state.tools.get('spawn_agent')?.parameters).toHaveProperty(
        'properties.model.description',
        expect.stringContaining('Model notes: p/a: research only')
      )
      invalid = true
      yield* Effect.promise(() => fixture.emit('before_agent_start', { systemPromptOptions: { sections } }, toolContext(['p/a'])))
      expect(sections.subagents).toBe('spawn_agent is unavailable: invalid subagents.allowedModels')
    })
  )
})

const tool = (name: string) => asTool<DisplayTool>(registered().state.tools.get(name))

describe('subagents display', () => {
  it('renders calls and readable results', () => {
    const options = { expanded: false, isPartial: false }
    expect(
      renderText(tool('spawn_agent').renderCall({ message: 'Review\nthe diff', model: 'p/m', name: 'Review' }, theme, { expanded: false }))
    ).toBe('spawn_agent Review · p/m\nReview the diff')
    expect(renderText(tool('close_agent').renderCall({ agent_id: '1a2b3c4d' }, theme, { expanded: false }))).toBe('close_agent 1a2b3c4d')
    const started: AgentResult = { agent_id: '1a2b3c4d', model: 'p/m', status: 'started' }
    expect(renderText(tool('spawn_agent').renderResult({ content: [], details: started }, options, theme, { isError: false }))).toBe(
      'Started · 1a2b3c4d · p/m'
    )
    const failure = { content: [{ text: 'Could not start the agent: boom', type: 'text' as const }], details: undefined }
    expect(renderText(tool('spawn_agent').renderResult(failure, options, theme, { isError: true }))).toBe('Could not start the agent: boom')
    const listed: ListResult = { agents: [{ agent_id: '1a2b3c4d', awaiting_result: true, model: 'p/m', name: 'Review', status: 'blocked' }] }
    expect(renderText(tool('list_agents').renderResult({ content: [], details: listed }, options, theme, { isError: false }))).toBe(
      '1a2b3c4d · Review · blocked'
    )
    expect(renderText(tool('list_agents').renderResult({ content: [], details: { agents: [] } }, options, theme, { isError: false }))).toBe(
      'No spawned agents'
    )
  })
})
