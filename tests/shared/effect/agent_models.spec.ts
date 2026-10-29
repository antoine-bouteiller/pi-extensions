import { CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Cause, Effect } from 'effect'
import { FileSystem } from 'effect/FileSystem'

import { loadAgentModelSettings } from '@/shared/effect/agent_models.js'
import { jsonText } from '@/shared/utils/json.js'

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'agent-models-' })
  const options = { agentDir: `${root}/agent`, cwd: `${root}/project`, projectTrusted: true }
  yield* fs.makeDirectory(options.agentDir)
  yield* fs.makeDirectory(`${options.cwd}/${CONFIG_DIR_NAME}`, { recursive: true })
  return {
    fs,
    globalPath: `${options.agentDir}/settings.json`,
    options,
    projectPath: `${options.cwd}/${CONFIG_DIR_NAME}/settings.json`,
  }
})

describe('Agent model settings', () => {
  it.scoped('[VC-19] reads only the subagents block and ignores a legacy herdr block', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options } = yield* fixture
      yield* fs.writeFileString(globalPath, jsonText({ herdr: { allowedModels: ['p/a'] }, subagents: { allowedModels: ['p/b'] } }))
      expect(yield* loadAgentModelSettings(options)).toEqual({ allowedModels: ['p/b'], modelNotes: {} })
      yield* fs.writeFileString(globalPath, jsonText({ herdr: { allowedModels: ['p/a'], profiles: {} } }))
      expect(yield* loadAgentModelSettings(options)).toEqual({ allowedModels: [], modelNotes: {} })
      yield* fs.writeFileString(globalPath, jsonText({ subagents: { allowedModels: ['p/b'], profiles: {} } }))
      expect((yield* Effect.flip(loadAgentModelSettings(options))).message).toContain('subagents.allowedModels')
    })
  )

  it.scoped('merges model notes, with trusted project notes overriding global ones', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options, projectPath } = yield* fixture
      yield* fs.writeFileString(globalPath, jsonText({ subagents: { allowedModels: ['a/x'], modelNotes: { 'a/x': 'global', 'a/y': 'kept' } } }))
      yield* fs.writeFileString(projectPath, jsonText({ subagents: { modelNotes: { 'a/x': 'project' } } }))
      expect(yield* loadAgentModelSettings(options)).toEqual({ allowedModels: ['a/x'], modelNotes: { 'a/x': 'project', 'a/y': 'kept' } })
      expect((yield* loadAgentModelSettings({ ...options, projectTrusted: false })).modelNotes).toEqual({ 'a/x': 'global', 'a/y': 'kept' })
    })
  )

  it.scoped('defaults missing files, blocks, and lists to an empty allowlist without writing files', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options, projectPath } = yield* fixture
      expect(yield* loadAgentModelSettings(options)).toEqual({ allowedModels: [], modelNotes: {} })
      expect(yield* fs.exists(globalPath)).toBe(false)
      expect(yield* fs.exists(projectPath)).toBe(false)

      yield* fs.writeFileString(globalPath, '{"theme":"dark"}')
      yield* fs.writeFileString(projectPath, '{"subagents":{}}')
      expect(yield* loadAgentModelSettings(options)).toEqual({ allowedModels: [], modelNotes: {} })
    })
  )

  it.scoped('loads a global allowlist while accepting unrelated Pi settings', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options, projectPath } = yield* fixture
      const allowedModels = ['azure-openai-responses/gpt-6-sol', 'provider_2/vendor/model:version', `p/${'m'.repeat(254)}`]
      yield* fs.writeFileString(globalPath, jsonText({ subagents: { allowedModels }, theme: 'dark' }))
      expect(yield* loadAgentModelSettings(options)).toEqual({ allowedModels, modelNotes: {} })

      yield* fs.writeFileString(projectPath, '{"subagents":{}}')
      expect(yield* loadAgentModelSettings(options)).toEqual({ allowedModels, modelNotes: {} })
    })
  )

  it.scoped('replaces the global allowlist with the trusted project list, including an empty list', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options, projectPath } = yield* fixture
      yield* fs.writeFileString(globalPath, '{"subagents":{"allowedModels":["global/model"]}}')
      yield* fs.writeFileString(projectPath, '{"subagents":{"allowedModels":["project/model"]}}')
      expect(yield* loadAgentModelSettings(options)).toEqual({ allowedModels: ['project/model'], modelNotes: {} })

      yield* fs.writeFileString(projectPath, '{"subagents":{"allowedModels":[]}}')
      expect(yield* loadAgentModelSettings(options)).toEqual({ allowedModels: [], modelNotes: {} })
    })
  )

  it.scoped('never reads project settings when the project is untrusted', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options, projectPath } = yield* fixture
      yield* fs.writeFileString(projectPath, 'not valid JSON')
      expect(yield* loadAgentModelSettings({ ...options, projectTrusted: false })).toEqual({ allowedModels: [], modelNotes: {} })

      yield* fs.writeFileString(globalPath, '{"subagents":{"allowedModels":["global/model"]}}')
      expect(yield* loadAgentModelSettings({ ...options, projectTrusted: false })).toEqual({ allowedModels: ['global/model'], modelNotes: {} })
    })
  )

  it.scoped('rejects malformed settings with their path instead of falling back to an empty allowlist', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options } = yield* fixture
      for (const text of [
        '{',
        'null',
        '[]',
        '{"subagents":null}',
        '{"subagents":[]}',
        '{"subagents":{"unknown":true}}',
        '{"subagents":{"allowedModels":null}}',
        '{"subagents":{"allowedModels":"provider/model"}}',
        '{"subagents":{"allowedModels":{}}}',
        '{"subagents":{"allowedModels":[null]}}',
        '{"subagents":{"allowedModels":[1]}}',
        '{"subagents":{"modelNotes":[]}}',
        '{"subagents":{"modelNotes":{"provider/model":1}}}',
        '{"subagents":{"modelNotes":{"provider/model":""}}}',
        String.raw`{"subagents":{"modelNotes":{"provider/model":"a\nb"}}}`,
      ]) {
        yield* fs.writeFileString(globalPath, text)
        const error = yield* Effect.flip(loadAgentModelSettings(options))
        expect(error.message).toContain(globalPath)
        expect(yield* fs.readFileString(globalPath)).toBe(text)
      }
    })
  )

  it.scoped('rejects invalid exact model identifiers', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options } = yield* fixture
      for (const model of [
        '',
        'model',
        '/model',
        'provider/',
        'provider/-model',
        'provider.name/model',
        'provider name/model',
        'provider/model name',
        'provider/model\n',
        'provider/\tmodel',
        'provider/mo\0del',
        'provider/mo\x7fdel',
        'provider/mo\x85del',
        `p/${'m'.repeat(255)}`,
      ]) {
        yield* fs.writeFileString(globalPath, jsonText({ subagents: { allowedModels: [model] } }))
        const exit = yield* Effect.exit(loadAgentModelSettings(options))
        expect(exit._tag).toBe('Failure')
        if (exit._tag === 'Failure') {
          expect(Cause.pretty(exit.cause)).toContain(globalPath)
          expect(Cause.pretty(exit.cause)).toContain('subagents.allowedModels')
        }
      }
    })
  )

  it.scoped('rejects malformed trusted project settings rather than using the global list', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options, projectPath } = yield* fixture
      yield* fs.writeFileString(globalPath, '{"subagents":{"allowedModels":["global/model"]}}')
      yield* fs.writeFileString(projectPath, '{"subagents":{"allowedModels":["invalid"]}}')
      const exit = yield* Effect.exit(loadAgentModelSettings(options))
      expect(exit._tag).toBe('Failure')
      if (exit._tag === 'Failure') {
        expect(Cause.pretty(exit.cause)).toContain(projectPath)
      }
    })
  )

  it.scoped('propagates global and trusted project settings file read failures', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options, projectPath } = yield* fixture
      yield* fs.makeDirectory(projectPath)
      expect((yield* Effect.exit(loadAgentModelSettings(options)))._tag).toBe('Failure')
      expect(yield* loadAgentModelSettings({ ...options, projectTrusted: false })).toEqual({ allowedModels: [], modelNotes: {} })

      yield* fs.makeDirectory(globalPath)
      expect((yield* Effect.exit(loadAgentModelSettings({ ...options, projectTrusted: false })))._tag).toBe('Failure')
    })
  )
})
