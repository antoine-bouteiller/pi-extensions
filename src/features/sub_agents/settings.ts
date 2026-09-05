import { CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent'
import { Effect, Schema } from 'effect'
import { FileSystem } from 'effect/FileSystem'
import { Path } from 'effect/Path'
import { Type } from 'typebox'
import { Value } from 'typebox/value'

import { writePrivateFile } from '#shared/effect/bun_host_file_system'
import { parseJsonText } from '#shared/utils/json'

import { SubagentSettingsSchema, type SubagentSettings } from './model.js'

const settingsText = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }))
const SettingsSchema = Type.Object({ subagents: Type.Optional(SubagentSettingsSchema) }, { additionalProperties: true })

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
        throw new Error(`${path}: expected subagents to map profile names to "provider/model-id" strings.`)
      }
      return settings
    })
  })

export const loadSubagentSettings = (options: {
  readonly agentDir: string
  readonly cwd: string
  readonly model?: { readonly id: string; readonly provider: string }
  readonly projectTrusted: boolean
}) =>
  Effect.gen(function* () {
    const path = yield* Path
    const globalPath = path.join(options.agentDir, 'settings.json')
    const global = yield* readSettings(globalPath)
    const project = options.projectTrusted ? yield* readSettings(path.join(options.cwd, CONFIG_DIR_NAME, 'settings.json')) : {}
    if (global.subagents !== undefined || project.subagents !== undefined) {
      return { ...global.subagents, ...project.subagents }
    }
    if (options.model === undefined) {
      return {}
    }
    const selected = `${options.model.provider}/${options.model.id}`
    const subagents: SubagentSettings = { implementer: selected, librarian: selected, reviewer: selected, scout: selected }
    const fs = yield* FileSystem
    yield* fs.makeDirectory(options.agentDir, { recursive: true })
    const target = yield* fs.realPath(globalPath).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === 'NotFound',
        (error) =>
          fs.readLink(globalPath).pipe(
            Effect.matchEffect({
              onFailure: (linkError) => (linkError.reason._tag === 'NotFound' ? Effect.succeed(globalPath) : Effect.fail(linkError)),
              onSuccess: () => Effect.fail(error),
            })
          )
      )
    )
    yield* writePrivateFile(target, `${settingsText({ ...global, subagents })}\n`)
    return subagents
  })
