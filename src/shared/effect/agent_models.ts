import { CONFIG_DIR_NAME, type ExtensionContext, getAgentDir } from '@earendil-works/pi-coding-agent'
import { Effect, Schema } from 'effect'
import { FileSystem } from 'effect/FileSystem'
import { Path } from 'effect/Path'
import { Type } from 'typebox'
import { Value } from 'typebox/value'

import { parseJsonText } from '#shared/utils/json'

const ModelSchema = Type.String({ maxLength: 256, pattern: String.raw`^[a-zA-Z0-9_-]+/[^\s\x00-\x1f\x7f-\x9f-][^\s\x00-\x1f\x7f-\x9f]*$` })
const NoteSchema = Type.String({ maxLength: 500, minLength: 1, pattern: String.raw`^[^\x00-\x1f\x7f-\x9f]+$` })
const AgentModelSettingsSchema = Type.Object(
  { allowedModels: Type.Optional(Type.Array(ModelSchema)), modelNotes: Type.Optional(Type.Record(Type.String(), NoteSchema)) },
  { additionalProperties: false }
)
const SettingsSchema = Type.Object({ subagents: Type.Optional(AgentModelSettingsSchema) }, { additionalProperties: true })

/** @internal */
export class AgentModelSettingsError extends Schema.TaggedError<AgentModelSettingsError, { readonly brand: unique symbol }>()(
  'AgentModelSettingsError',
  {
    cause: Schema.optional(Schema.Unknown),
    message: Schema.String,
  }
) {}

interface AgentModelSettings {
  readonly allowedModels: readonly string[]
  readonly modelNotes: Readonly<Record<string, string>>
}

export type AgentModelSettingsLoader = (options: {
  readonly agentDir: string
  readonly cwd: string
  readonly projectTrusted: boolean
}) => Effect.Effect<AgentModelSettings, AgentModelSettingsError, FileSystem | Path>

const readSettings = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const text = yield* fs.readFileString(path).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === 'NotFound',
        () => Effect.succeed('{}')
      ),
      Effect.mapError((error) => AgentModelSettingsError.make({ cause: error, message: `${path}: ${error.message}` }))
    )
    return yield* Effect.try({
      catch: (error) => AgentModelSettingsError.make({ cause: error, message: `${path}: ${String(error)}` }),
      try: () => {
        const settings = parseJsonText(text)
        if (!Value.Check(SettingsSchema, settings)) {
          throw new Error(
            'expected subagents.allowedModels to be an array of exact provider/model-id strings (at most 256 characters, no whitespace or control characters) and subagents.modelNotes to map model ids to single-line notes (at most 500 characters).'
          )
        }
        return settings
      },
    })
  })

/** Reads `subagents.allowedModels` and `subagents.modelNotes` from global settings, overridden by trusted project settings. */
export const loadAgentModelSettings: AgentModelSettingsLoader = (options) =>
  Effect.gen(function* () {
    const path = yield* Path
    const global = yield* readSettings(path.join(options.agentDir, 'settings.json'))
    const project = options.projectTrusted ? yield* readSettings(path.join(options.cwd, CONFIG_DIR_NAME, 'settings.json')) : {}

    return {
      allowedModels: project.subagents?.allowedModels ?? global.subagents?.allowedModels ?? [],
      modelNotes: { ...global.subagents?.modelNotes, ...project.subagents?.modelNotes },
    }
  })

/** The allowed models the registry can currently use, with their notes. */
export const availableAgentModels = (ctx: ExtensionContext, load: AgentModelSettingsLoader = loadAgentModelSettings) =>
  Effect.gen(function* () {
    const settings = yield* load({ agentDir: getAgentDir(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() })
    const models = ctx.modelRegistry
      .getAvailable()
      .map((model) => `${model.provider}/${model.id}`)
      .filter((model) => settings.allowedModels.includes(model))
    return {
      models,
      notes: models.flatMap((model) => (settings.modelNotes[model] === undefined ? [] : [`${model}: ${settings.modelNotes[model]}`])),
    }
  })
