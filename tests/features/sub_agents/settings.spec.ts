import { CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Effect } from 'effect'
import { FileSystem } from 'effect/FileSystem'

import { loadSubagentSettings } from '@/features/sub_agents/settings.js'
import { jsonText, parseJsonText } from '@/shared/utils/json.js'

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'subagent-settings-' })
  const options = { agentDir: `${root}/agent`, cwd: `${root}/project`, model: { id: 'current', provider: 'provider' }, projectTrusted: true }
  yield* fs.makeDirectory(options.agentDir)
  yield* fs.makeDirectory(`${options.cwd}/${CONFIG_DIR_NAME}`, { recursive: true })
  return { fs, globalPath: `${options.agentDir}/settings.json`, options, projectPath: `${options.cwd}/${CONFIG_DIR_NAME}/settings.json` }
})

describe('sub-agent settings', () => {
  it.scoped('initializes all profiles from the current model once and preserves other settings', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options } = yield* fixture
      yield* fs.writeFileString(globalPath, '{"theme":"dark","other":{"enabled":true}}')
      const settings = yield* loadSubagentSettings(options)
      const selected = 'provider/current'
      expect(settings).toEqual({ implementer: selected, librarian: selected, reviewer: selected, scout: selected })
      expect(parseJsonText(yield* fs.readFileString(globalPath))).toEqual({ other: { enabled: true }, subagents: settings, theme: 'dark' })
      const saved = yield* fs.readFileString(globalPath)
      expect(yield* loadSubagentSettings({ ...options, model: { id: 'changed', provider: 'other' } })).toEqual(settings)
      expect(yield* fs.readFileString(globalPath)).toBe(saved)
    })
  )

  it.scoped('initializes and reloads provider/model references with slashes inside the model ID', () =>
    Effect.gen(function* () {
      const { options } = yield* fixture
      const configured = { ...options, model: { id: 'anthropic/claude-sonnet-4-5', provider: 'openrouter' } }
      expect((yield* loadSubagentSettings(configured)).scout).toBe('openrouter/anthropic/claude-sonnet-4-5')
      expect((yield* loadSubagentSettings(options)).scout).toBe('openrouter/anthropic/claude-sonnet-4-5')
    })
  )

  it.scoped('initializes the target without replacing any link in a settings symlink chain', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options } = yield* fixture
      const target = `${options.cwd}/settings.json`
      const intermediate = `${options.agentDir}/managed-settings`
      yield* fs.writeFileString(target, '{"theme":"dark"}')
      yield* fs.symlink('../project/settings.json', intermediate)
      yield* fs.symlink(intermediate, globalPath)

      const settings = yield* loadSubagentSettings(options)

      expect(yield* fs.readLink(globalPath)).toBe(intermediate)
      expect(yield* fs.readLink(intermediate)).toBe('../project/settings.json')
      expect(parseJsonText(yield* fs.readFileString(target))).toEqual({ subagents: settings, theme: 'dark' })
      expect(yield* fs.readFileString(globalPath)).toBe(yield* fs.readFileString(target))
    })
  )

  it.scoped('refuses a dangling settings symlink without replacing it', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options } = yield* fixture
      const target = `${options.cwd}/missing.json`
      yield* fs.symlink(target, globalPath)

      expect((yield* Effect.exit(loadSubagentSettings(options)))._tag).toBe('Failure')
      expect(yield* fs.readLink(globalPath)).toBe(target)
      expect(yield* fs.exists(target)).toBe(false)
    })
  )

  it.scoped('creates missing settings only once a current model exists', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options } = yield* fixture
      expect(yield* loadSubagentSettings({ ...options, model: undefined })).toEqual({})
      expect(yield* fs.exists(globalPath)).toBe(false)
      expect((yield* loadSubagentSettings(options)).scout).toBe('provider/current')
      expect(yield* fs.exists(globalPath)).toBe(true)
    })
  )

  it.scoped('merges trusted project profiles without rewriting either settings file', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options, projectPath } = yield* fixture
      const global = '{"subagents":{"scout":"global/global","reviewer":"global/review"}}'
      const project = '{"subagents":{"scout":"project/project"}}'
      yield* fs.writeFileString(globalPath, global)
      yield* fs.writeFileString(projectPath, project)
      expect(yield* loadSubagentSettings(options)).toEqual({
        reviewer: 'global/review',
        scout: 'project/project',
      })
      expect((yield* loadSubagentSettings({ ...options, projectTrusted: false })).scout).toBe('global/global')
      expect(yield* fs.readFileString(globalPath)).toBe(global)
      expect(yield* fs.readFileString(projectPath)).toBe(project)
    })
  )

  it.scoped('honors project-only and empty blocks without initializing global defaults', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options, projectPath } = yield* fixture
      for (const subagents of [{ scout: 'project/project' }, {}]) {
        yield* fs.writeFileString(projectPath, jsonText({ subagents }))
        expect(yield* loadSubagentSettings(options)).toEqual(subagents)
        expect(yield* fs.exists(globalPath)).toBe(false)
      }
      yield* fs.writeFileString(projectPath, 'invalid ignored project JSON')
      expect((yield* loadSubagentSettings({ ...options, projectTrusted: false })).scout).toBe('provider/current')
    })
  )

  it.scoped('rejects malformed settings without overwriting them', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options } = yield* fixture
      for (const text of [
        '{',
        'null',
        '[]',
        '{"subagents":null}',
        '{"subagents":{"unknown":{}}}',
        '{"subagents":{"scout":"function"}}',
        '{"subagents":{"scout":{"model":"model","provider":"p"}}}',
        '{"subagents":{"scout":""}}',
        '{"subagents":{"scout":"/model"}}',
        '{"subagents":{"scout":"provider/"}}',
        '{"subagents":{"scout":"provider/ model"}}',
      ]) {
        yield* fs.writeFileString(globalPath, text)
        expect((yield* Effect.exit(loadSubagentSettings(options)))._tag).toBe('Failure')
        expect(yield* fs.readFileString(globalPath)).toBe(text)
      }
    })
  )
})
