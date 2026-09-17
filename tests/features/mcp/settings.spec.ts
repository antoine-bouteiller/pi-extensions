import { CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Effect } from 'effect'
import { FileSystem } from 'effect/FileSystem'

import { loadMcpSettings } from '@/features/mcp/settings.js'

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'mcp-settings-' })
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

describe('MCP settings', () => {
  it.scoped('loads direct tool exposure while accepting unrelated Pi settings', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options } = yield* fixture
      yield* fs.writeFileString(globalPath, '{"theme":"dark","mcp":{"directTools":{"linear":["get_issue"],"other":true,"off":false}}}')

      expect(yield* loadMcpSettings(options)).toEqual({
        directTools: { linear: ['get_issue'], off: false, other: true },
      })
    })
  )

  it.scoped('merges trusted project exposure by server, including false and empty overrides', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options, projectPath } = yield* fixture
      yield* fs.writeFileString(globalPath, '{"mcp":{"directTools":{"linear":["get_issue"],"other":true,"off":true}}}')
      yield* fs.writeFileString(projectPath, '{"mcp":{"directTools":{"linear":[],"other":false,"project":["search"]}}}')

      expect(yield* loadMcpSettings(options)).toEqual({
        directTools: { linear: [], off: true, other: false, project: ['search'] },
      })
    })
  )

  it.scoped('never reads project settings when the project is untrusted', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options, projectPath } = yield* fixture
      yield* fs.writeFileString(globalPath, '{"mcp":{"directTools":{"global":true}}}')
      yield* fs.writeFileString(projectPath, 'not valid JSON')

      expect(yield* loadMcpSettings({ ...options, projectTrusted: false })).toEqual({ directTools: { global: true } })
    })
  )

  it.scoped('defaults missing files and blocks to empty settings without writing files', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options, projectPath } = yield* fixture
      expect(yield* loadMcpSettings(options)).toEqual({})
      expect(yield* fs.exists(globalPath)).toBe(false)
      expect(yield* fs.exists(projectPath)).toBe(false)

      yield* fs.writeFileString(globalPath, '{"theme":"dark"}')
      yield* fs.writeFileString(projectPath, '{"mcp":{}}')
      expect(yield* loadMcpSettings(options)).toEqual({})
    })
  )

  it.scoped('rejects malformed MCP settings and unsupported MCP fields', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options } = yield* fixture
      for (const text of [
        '{',
        'null',
        '{"mcp":null}',
        '{"mcp":{"unknown":true}}',
        '{"mcp":{"directTools":[]}}',
        '{"mcp":{"directTools":{"":true}}}',
        '{"mcp":{"directTools":{"linear":"get_issue"}}}',
        '{"mcp":{"directTools":{"linear":[""]}}}',
      ]) {
        yield* fs.writeFileString(globalPath, text)
        expect((yield* Effect.exit(loadMcpSettings(options)))._tag).toBe('Failure')
        expect(yield* fs.readFileString(globalPath)).toBe(text)
      }
    })
  )

  it.scoped('propagates settings file read failures', () =>
    Effect.gen(function* () {
      const { fs, globalPath, options } = yield* fixture
      yield* fs.makeDirectory(globalPath)

      expect((yield* Effect.exit(loadMcpSettings(options)))._tag).toBe('Failure')
    })
  )
})
