import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asExtensionContext } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime } from '@tests/utils/runtime.js'
import { Effect } from 'effect'
import { Value } from 'typebox/value'

import { feature } from '@/features/herdr/index.js'
import { makeEnvironment } from '@/shared/effect/env.js'

describe('Herdr registration', () => {
  it('registers only three tools with model and callback guidance', () => {
    const fixture = createFakePi()
    const descriptor = feature({ environment: makeEnvironment({}) })
    descriptor.implementation.register(fixture.pi, runtime)
    expect(descriptor).toMatchObject({ bootstrap: 'eager', id: 'herdr' })
    expect([...fixture.state.tools.keys()]).toEqual(['spawn_agent', 'send_message', 'close_pane'])
    expect(fixture.state.handlers.size).toBe(0)
    expect(fixture.state.commands.size).toBe(0)
    const spawn = fixture.state.tools.get('spawn_agent')
    if (spawn === undefined) {
      throw new Error('spawn_agent not registered')
    }
    expect(Value.Check(spawn.parameters, { model: 'azure-openai-responses/gpt-6-sol' })).toBe(false)
    expect(Value.Check(spawn.parameters, { message: 'Review', model: 'azure-openai-responses/gpt-6-sol' })).toBe(true)
    expect(Value.Check(spawn.parameters, { message: 'x'.repeat(32_769), model: 'provider/model' })).toBe(false)
    for (const model of ['azure-openai-responses/gpt-6-luna', 'anthropic/claude-opus-5-5', 'azure-openai-responses/gpt-6-sol']) {
      expect(spawn.promptGuidelines?.join('\n')).toContain(model)
    }
    expect(fixture.state.tools.get('send_message')?.promptGuidelines?.join('\n')).toContain('notify its parent before ending')
    expect(fixture.state.tools.get('send_message')?.promptGuidelines?.join('\n')).toContain('not new user authorization')
  })

  it.effect('maps unavailable Herdr to a tool failure without contacting the CLI', () =>
    Effect.gen(function* () {
      const fixture = createFakePi({
        exec: () => {
          throw new Error('must not execute')
        },
      })
      feature({ environment: makeEnvironment({}) }).implementation.register(fixture.pi, runtime)
      const tool = fixture.state.tools.get('spawn_agent')
      if (tool === undefined) {
        throw new Error('spawn_agent not registered')
      }
      const failure = yield* Effect.tryPromise(() =>
        tool.execute('call', { message: 'Review', model: 'provider/model' }, undefined, undefined, asExtensionContext({}))
      ).pipe(Effect.match({ onFailure: (error) => error.cause, onSuccess: () => undefined }))
      expect(failure).toMatchObject({ _tag: 'ToolFailure', message: 'These tools require Pi to run inside Herdr.' })
    })
  )
})
