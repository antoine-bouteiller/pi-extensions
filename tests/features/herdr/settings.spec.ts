import { CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Cause, Effect } from 'effect'
import { FileSystem } from 'effect/FileSystem'

import { loadHerdrSettings } from '@/features/herdr/settings.js'
import { jsonText } from '@/shared/utils/json.js'

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'herdr-settings-' })
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

describe('Herdr settings', () => {
  it.scoped('defaults missing files, blocks, and lists to an empty allowlist without writing files', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options, projectPath } = yield* fixture
      expect(yield* loadHerdrSettings(options)).toEqual({ allowedModels: [] })
      expect(yield* fs.exists(globalPath)).toBe(false)
      expect(yield* fs.exists(projectPath)).toBe(false)

      yield* fs.writeFileString(globalPath, '{"theme":"dark"}')
      yield* fs.writeFileString(projectPath, '{"herdr":{}}')
      expect(yield* loadHerdrSettings(options)).toEqual({ allowedModels: [] })
    })
  )

  it.scoped('loads a global allowlist while accepting unrelated Pi settings', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options, projectPath } = yield* fixture
      const allowedModels = ['azure-openai-responses/gpt-6-sol', 'provider_2/vendor/model:version', `p/${'m'.repeat(254)}`]
      yield* fs.writeFileString(globalPath, jsonText({ herdr: { allowedModels }, theme: 'dark' }))
      expect(yield* loadHerdrSettings(options)).toEqual({ allowedModels })

      yield* fs.writeFileString(projectPath, '{"herdr":{}}')
      expect(yield* loadHerdrSettings(options)).toEqual({ allowedModels })
    })
  )

  it.scoped('replaces the global allowlist with the trusted project list, including an empty list', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options, projectPath } = yield* fixture
      yield* fs.writeFileString(globalPath, '{"herdr":{"allowedModels":["global/model"]}}')
      yield* fs.writeFileString(projectPath, '{"herdr":{"allowedModels":["project/model"]}}')
      expect(yield* loadHerdrSettings(options)).toEqual({ allowedModels: ['project/model'] })

      yield* fs.writeFileString(projectPath, '{"herdr":{"allowedModels":[]}}')
      expect(yield* loadHerdrSettings(options)).toEqual({ allowedModels: [] })
    })
  )

  it.scoped('never reads project settings when the project is untrusted', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options, projectPath } = yield* fixture
      yield* fs.writeFileString(projectPath, 'not valid JSON')
      expect(yield* loadHerdrSettings({ ...options, projectTrusted: false })).toEqual({ allowedModels: [] })

      yield* fs.writeFileString(globalPath, '{"herdr":{"allowedModels":["global/model"]}}')
      expect(yield* loadHerdrSettings({ ...options, projectTrusted: false })).toEqual({ allowedModels: ['global/model'] })
    })
  )

  it.scoped('rejects malformed settings with their path instead of falling back to an empty allowlist', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options } = yield* fixture
      for (const text of [
        '{',
        'null',
        '[]',
        '{"herdr":null}',
        '{"herdr":[]}',
        '{"herdr":{"unknown":true}}',
        '{"herdr":{"allowedModels":null}}',
        '{"herdr":{"allowedModels":"provider/model"}}',
        '{"herdr":{"allowedModels":{}}}',
        '{"herdr":{"allowedModels":[null]}}',
        '{"herdr":{"allowedModels":[1]}}',
      ]) {
        yield* fs.writeFileString(globalPath, text)
        const error = yield* Effect.flip(loadHerdrSettings(options))
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
        yield* fs.writeFileString(globalPath, jsonText({ herdr: { allowedModels: [model] } }))
        const exit = yield* Effect.exit(loadHerdrSettings(options))
        expect(exit._tag).toBe('Failure')
        if (exit._tag === 'Failure') {
          expect(Cause.pretty(exit.cause)).toContain(globalPath)
          expect(Cause.pretty(exit.cause)).toContain('herdr.allowedModels')
        }
      }
    })
  )

  it.scoped('rejects malformed trusted project settings rather than using the global list', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options, projectPath } = yield* fixture
      yield* fs.writeFileString(globalPath, '{"herdr":{"allowedModels":["global/model"]}}')
      yield* fs.writeFileString(projectPath, '{"herdr":{"allowedModels":["invalid"]}}')
      const exit = yield* Effect.exit(loadHerdrSettings(options))
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
      expect((yield* Effect.exit(loadHerdrSettings(options)))._tag).toBe('Failure')
      expect(yield* loadHerdrSettings({ ...options, projectTrusted: false })).toEqual({ allowedModels: [] })

      yield* fs.makeDirectory(globalPath)
      expect((yield* Effect.exit(loadHerdrSettings({ ...options, projectTrusted: false })))._tag).toBe('Failure')
    })
  )
})
