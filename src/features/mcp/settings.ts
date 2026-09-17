import { CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent'
import { Effect } from 'effect'
import { FileSystem } from 'effect/FileSystem'
import { Path } from 'effect/Path'
import { Type } from 'typebox'
import { Value } from 'typebox/value'

import { parseJsonText } from '#shared/utils/json'

export interface McpSettings {
  readonly directTools?: Record<string, boolean | string[]>
}

const DirectToolSettingSchema = Type.Union([Type.Boolean(), Type.Array(Type.String({ minLength: 1 }))])
const McpSettingsSchema = Type.Object(
  { directTools: Type.Optional(Type.Record(Type.String({ pattern: '[\\s\\S]+' }), DirectToolSettingSchema, { additionalProperties: false })) },
  { additionalProperties: false }
)
const SettingsSchema = Type.Object({ mcp: Type.Optional(McpSettingsSchema) }, { additionalProperties: true })

const readSettings = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const text = yield* fs.readFileString(path).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === 'NotFound',
        () => Effect.succeed('{}')
      )
    )
    return yield* Effect.try(() => {
      const settings = parseJsonText(text)
      if (!Value.Check(SettingsSchema, settings)) {
        throw new Error(`${path}: expected mcp.directTools to map non-empty server names to booleans or arrays of non-empty tool names.`)
      }
      return settings
    })
  })

export const loadMcpSettings = (options: { readonly agentDir: string; readonly cwd: string; readonly projectTrusted: boolean }) =>
  Effect.gen(function* () {
    const path = yield* Path
    const global = yield* readSettings(path.join(options.agentDir, 'settings.json'))
    const project = options.projectTrusted ? yield* readSettings(path.join(options.cwd, CONFIG_DIR_NAME, 'settings.json')) : {}
    const globalDirectTools = global.mcp?.directTools
    const projectDirectTools = project.mcp?.directTools

    if (globalDirectTools === undefined && projectDirectTools === undefined) {
      return {}
    }
    return { directTools: { ...globalDirectTools, ...projectDirectTools } }
  })
