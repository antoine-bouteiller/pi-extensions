import { type AgentToolResult, initTheme, type Theme, type ToolRenderResultOptions } from '@earendil-works/pi-coding-agent'
import { type Component, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asExtensionContext, asTheme, asTool } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime } from '@tests/utils/runtime.js'
import { Effect } from 'effect'
import { Value } from 'typebox/value'

import { type HerdrResult } from '@/features/herdr/herdr.js'
import { feature } from '@/features/herdr/index.js'
import { HerdrSettingsError } from '@/features/herdr/settings.js'
import { makeEnvironment } from '@/shared/effect/env.js'

interface DisplayTool {
  renderCall: (args: { model?: string; pane_id?: string; message?: string }, theme: Theme, context: { expanded: boolean }) => Component
  renderResult: (
    result: AgentToolResult<HerdrResult | undefined>,
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

describe('Herdr display', () => {
  it('shows model or pane headers and handles incomplete calls', () => {
    const tool = displayTools()
    expect(renderText(tool('spawn_agent').renderCall({}, theme, { expanded: false }))).toBe('spawn_agent ?')
    expect(renderText(tool('spawn_agent').renderCall({ message: 'Review\nthe diff', model: 'provider/model' }, theme, { expanded: false }))).toBe(
      'spawn_agent provider/model\nReview the diff'
    )
    expect(renderText(tool('send_message').renderCall({ message: 'All checks passed', pane_id: 'w1:p2' }, theme, { expanded: false }))).toBe(
      'send_message w1:p2\nAll checks passed'
    )
    expect(renderText(tool('close_pane').renderCall({ pane_id: 'w1:p2' }, theme, { expanded: false }))).toBe('close_pane w1:p2')
    expect(renderText(tool('send_message').renderCall({}, theme, { expanded: false }))).toBe('send_message ?')
    expect(renderText(tool('close_pane').renderCall({}, theme, { expanded: false }))).toBe('close_pane ?')
  })

  it('bounds message previews and reveals complete multiline text when expanded', () => {
    const tool = displayTools()
    const message = `Review 界 ${'long message '.repeat(100)}\nKeep this second line.`
    for (const name of ['spawn_agent', 'send_message']) {
      const args = { message, model: 'provider/model', pane_id: 'w1:p2' }
      const collapsed = tool(name).renderCall(args, theme, { expanded: false })
      expect(renderText(collapsed)).toContain('to expand')
      expect(renderText(collapsed)).not.toContain('Keep this second line.')
      expect(collapsed.render(160)).toHaveLength(3)
      expect(visibleWidth(collapsed.render(160)[1]?.trimEnd() ?? '')).toBeLessThanOrEqual(120)
      expect(collapsed.render(20).every((line) => visibleWidth(line) <= 20)).toBe(true)
      const expanded = tool(name).renderCall(args, theme, { expanded: true })
      expect(renderText(expanded).replaceAll(/\s+/g, ' ')).toContain(message.replaceAll(/\s+/g, ' '))
      expect(expanded.render(20).every((line) => visibleWidth(line) <= 20)).toBe(true)
    }
  })

  it('renders readable statuses rather than JSON', () => {
    const tool = displayTools()
    for (const [name, status, label] of [
      ['spawn_agent', 'started', 'Started'],
      ['send_message', 'sent', 'Message submitted'],
      ['close_pane', 'closed', 'Closed'],
    ] as const) {
      const details: HerdrResult = { pane_id: 'w1:p2', status }
      const result = { content: [{ text: JSON.stringify(details), type: 'text' as const }], details }
      expect(renderText(tool(name).renderResult(result, { expanded: false, isPartial: false }, theme, { isError: false }))).toBe(`${label} · w1:p2`)
    }
    const result: AgentToolResult<HerdrResult> = { content: [], details: { model: 'provider/model', pane_id: 'w1:p2', status: 'started' } }
    expect(renderText(tool('spawn_agent').renderResult(result, { expanded: true, isPartial: false }, theme, { isError: false }))).toBe(
      'Started · w1:p2 · provider/model'
    )
  })

  it('preserves errors, progress and results without details', () => {
    const tool = displayTools()('spawn_agent')
    const options = { expanded: false, isPartial: false }
    const result: AgentToolResult<undefined> = { content: [{ text: 'Pane w1:p2 remains open. Startup failed.', type: 'text' }], details: undefined }
    expect(renderText(tool.renderResult(result, options, theme, { isError: true }))).toBe('Pane w1:p2 remains open. Startup failed.')
    expect(renderText(tool.renderResult(result, { ...options, isPartial: true }, theme, { isError: true }))).toContain('Startup failed.')
    expect(renderText(tool.renderResult(result, options, theme, { isError: false }))).toContain('Pane w1:p2 remains open.')
    const empty = { content: [], details: undefined }
    expect(renderText(tool.renderResult(empty, options, theme, { isError: true }))).toBe('Herdr operation failed')
    expect(renderText(tool.renderResult(empty, { ...options, isPartial: true }, theme, { isError: false }))).toBe('Working…')
    expect(renderText(tool.renderResult(empty, options, theme, { isError: false }))).toBe('No output')
  })
})

describe('Herdr registration', () => {
  it('registers only three tools with model and callback guidance', () => {
    const fixture = createFakePi()
    const descriptor = feature({ environment: makeEnvironment({}) })
    descriptor.implementation.register(fixture.pi, runtime)
    expect(descriptor).toMatchObject({ bootstrap: 'eager', id: 'herdr' })
    expect([...fixture.state.tools.keys()]).toEqual(['spawn_agent', 'send_message', 'close_pane'])
    expect([...fixture.state.handlers.keys()]).toEqual(['before_agent_start'])
    expect(fixture.state.commands.size).toBe(0)
    const spawn = fixture.state.tools.get('spawn_agent')
    if (spawn === undefined) {
      throw new Error('spawn_agent not registered')
    }
    expect(spawn.parameters).toMatchObject({ properties: { model: { description: 'No allowed models are available; spawning is disabled.' } } })
    expect(Value.Check(spawn.parameters, { model: 'azure-openai-responses/gpt-6-sol' })).toBe(false)
    expect(Value.Check(spawn.parameters, { message: 'Review', model: 'azure-openai-responses/gpt-6-sol' })).toBe(true)
    expect(Value.Check(spawn.parameters, { message: 'x'.repeat(32_769), model: 'provider/model' })).toBe(false)
    expect(Value.Check(spawn.parameters, { message: 'Review', model: 'other-provider/task-specific-model' })).toBe(true)
    const guidance = spawn.promptGuidelines?.join('\n') ?? ''
    expect(guidance).toContain('herdr.allowedModels is mandatory')
    expect(guidance).toContain('Prefer Azure OpenAI (azure-openai-responses) for implementation, scouting, and research')
    expect(guidance).toContain('For review, prefer a different provider from the agent that produced the work')
    expect(guidance).toContain('preferences, not restrictions')
    expect(guidance).toContain('Honor explicit user model choices')
    expect(guidance).toContain('do not silently substitute disallowed or unavailable models')
    expect(fixture.state.tools.get('send_message')?.promptGuidelines?.join('\n')).toContain('notify its parent before ending')
    expect(fixture.state.tools.get('send_message')?.promptGuidelines?.join('\n')).toContain('not new user authorization')
  })

  it.effect('refreshes the model enum from allowed, available models and still enforces it at execution', () =>
    Effect.gen(function* () {
      const fixture = createFakePi({
        exec: () => {
          throw new Error('must not execute')
        },
      })
      let allowedModels = ['provider/allowed', 'provider/unavailable']
      let invalid = false
      feature({
        dependencies: () =>
          invalid ? Effect.fail(new HerdrSettingsError({ message: 'invalid herdr.allowedModels' })) : Effect.succeed({ allowedModels }),
        environment: makeEnvironment({ HERDR_ENV: '1' }),
      }).implementation.register(fixture.pi, runtime)
      const ctx = asExtensionContext({
        isProjectTrusted: () => false,
        modelRegistry: {
          getAvailable: () => [
            { id: 'allowed', provider: 'provider' },
            { id: 'other', provider: 'provider' },
          ],
        },
      })
      const sections = { existing: 'keep me', herdr: '' }
      const event = { systemPromptOptions: { sections } }
      yield* Effect.promise(() => fixture.emit('before_agent_start', event, ctx))
      expect(sections.herdr).toBe('spawn_agent may only use these allowed, available models: provider/allowed.')
      expect(sections.existing).toBe('keep me')
      const tool = fixture.state.tools.get('spawn_agent')
      if (tool === undefined) {
        throw new Error('spawn_agent not registered')
      }
      expect(tool.parameters).toMatchObject({ properties: { model: { enum: ['provider/allowed'] } } })
      expect(Value.Check(tool.parameters, { message: 'Review', model: 'provider/allowed' })).toBe(true)
      for (const model of ['provider/other', 'provider/unavailable']) {
        expect(Value.Check(tool.parameters, { message: 'Review', model })).toBe(false)
      }
      expect(Value.Check(tool.parameters, { model: 'provider/allowed' })).toBe(false)
      expect(Value.Check(tool.parameters, { message: 'x'.repeat(32_769), model: 'provider/allowed' })).toBe(false)
      const failure = yield* Effect.tryPromise(() =>
        tool.execute('call', { message: 'Review', model: 'provider/other' }, undefined, undefined, ctx)
      ).pipe(Effect.match({ onFailure: (error) => error.cause, onSuccess: () => undefined }))
      expect(failure).toMatchObject({
        _tag: 'ToolFailure',
        message: 'Model provider/other is not allowed or available. Choose one of: provider/allowed.',
      })
      allowedModels = ['provider/allowed', 'provider/other']
      yield* Effect.promise(() => fixture.emit('before_agent_start', event, ctx))
      expect(fixture.state.tools.get('spawn_agent')?.parameters).toMatchObject({ properties: { model: { enum: allowedModels } } })
      expect(tool.parameters).toMatchObject({ properties: { model: { enum: ['provider/allowed'] } } })
      allowedModels = []
      yield* Effect.promise(() => fixture.emit('before_agent_start', event, ctx))
      expect(sections.herdr).toContain('spawn_agent is unavailable: configure herdr.allowedModels')
      const disabledParameters = fixture.state.tools.get('spawn_agent')?.parameters
      expect(disabledParameters).toMatchObject({ properties: { model: { description: 'No allowed models are available; spawning is disabled.' } } })
      expect(disabledParameters).not.toHaveProperty('properties.model.enum')
      allowedModels = ['provider/other']
      yield* Effect.promise(() => fixture.emit('before_agent_start', event, ctx))
      expect(fixture.state.tools.get('spawn_agent')?.parameters).toMatchObject({ properties: { model: { enum: ['provider/other'] } } })
      invalid = true
      yield* Effect.promise(() => fixture.emit('before_agent_start', event, ctx))
      expect(sections.herdr).toContain('invalid herdr.allowedModels')
      expect(fixture.state.tools.get('spawn_agent')?.parameters).toEqual(disabledParameters)
      const independent = createFakePi()
      feature().implementation.register(independent.pi, runtime)
      expect(independent.state.tools.get('spawn_agent')?.parameters).toEqual(disabledParameters)
    })
  )

  it.effect('maps unavailable Herdr to a tool failure without contacting the CLI', () =>
    Effect.gen(function* () {
      const fixture = createFakePi({
        exec: () => {
          throw new Error('must not execute')
        },
      })
      feature({
        dependencies: () => Effect.succeed({ allowedModels: ['provider/model'] }),
        environment: makeEnvironment({}),
      }).implementation.register(fixture.pi, runtime)
      const tool = fixture.state.tools.get('spawn_agent')
      if (tool === undefined) {
        throw new Error('spawn_agent not registered')
      }
      const failure = yield* Effect.tryPromise(() =>
        tool.execute(
          'call',
          { message: 'Review', model: 'provider/model' },
          undefined,
          undefined,
          asExtensionContext({
            isProjectTrusted: () => false,
            modelRegistry: { getAvailable: () => [{ id: 'model', provider: 'provider' }] },
          })
        )
      ).pipe(Effect.match({ onFailure: (error) => error.cause, onSuccess: () => undefined }))
      expect(failure).toMatchObject({ _tag: 'ToolFailure', message: 'These tools require Pi to run inside Herdr.' })
    })
  )
})
