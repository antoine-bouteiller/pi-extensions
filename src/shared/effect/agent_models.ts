import { homedir } from 'node:os'

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

export class AgentRequestError extends Schema.TaggedError<AgentRequestError, { readonly brand: unique symbol }>()('AgentRequestError', {
  message: Schema.String,
}) {}

const requestError = (message: string) => AgentRequestError.make({ message })

export const AgentMessageParam = Type.String({ maxLength: 32_768, minLength: 1 })
export const AgentModelParam = Type.String({
  description: 'Exact provider/model-id, for example azure-openai-responses/gpt-6-sol.',
  maxLength: 256,
  minLength: 1,
})
export const AgentNameParam = (description: string) =>
  Type.String({ description, maxLength: 64, minLength: 1, pattern: String.raw`^[^\s\x00-\x1f\x7f-\x9f-][^\x00-\x1f\x7f-\x9f]*$` })
export const AgentThinkingParam = Type.Union(
  [
    Type.Literal('off'),
    Type.Literal('minimal'),
    Type.Literal('low'),
    Type.Literal('medium'),
    Type.Literal('high'),
    Type.Literal('xhigh'),
    Type.Literal('max'),
  ],
  { description: 'Thinking level for the agent.' }
)
export const AgentCwdParam = (description: string) =>
  Type.String({ description, maxLength: 4096, minLength: 1, pattern: String.raw`^[^\x00-\x1f\x7f-\x9f]+$` })

/** Rejects empty text and terminal control characters other than newline and tab. */
export const checkAgentMessage = (message: string): Effect.Effect<string, AgentRequestError> => {
  const controls = message.match(/\p{Cc}/gu)?.some((character) => character !== '\n' && character !== '\t') === true
  return message.trim().length === 0 || controls
    ? Effect.fail(requestError('Messages must contain text and no terminal control characters (except newline and tab).'))
    : Effect.succeed(message)
}

/** Splits an exact `provider/model-id`, rejecting values Pi's CLI would read as flags or patterns. */
export const splitAgentModel = (value: string): Effect.Effect<{ readonly provider: string; readonly model: string }, AgentRequestError> => {
  const slash = value.indexOf('/')
  const provider = value.slice(0, slash)
  const model = value.slice(slash + 1)
  if (slash < 1 || !/^[a-zA-Z0-9_-]+$/.test(provider) || !/^[^-\s][^\s]*$/.test(model) || /\p{Cc}/u.test(model)) {
    return Effect.fail(requestError('model must be an exact provider/model-id.'))
  }
  return Effect.succeed({ model, provider })
}

/** Fails unless `model` is allowed and available; `models` comes from {@link availableAgentModels}. */
export const requireAllowedModel = (model: string, models: readonly string[]): Effect.Effect<void, AgentRequestError> => {
  if (models.includes(model)) {
    return Effect.void
  }
  return Effect.fail(
    requestError(
      models.length === 0
        ? 'No allowed models are available. Configure subagents.allowedModels in settings.json with available provider/model-id values.'
        : `Model ${model} is not allowed or available. Choose one of: ${models.join(', ')}.`
    )
  )
}

/** Resolves an absolute, `~/`, or relative directory; undefined when it is `cwd` itself. */
export const resolveAgentDirectory = (cwd: string, requested: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const path = yield* Path
    const expanded = requested === '~' || requested.startsWith('~/') ? path.join(homedir(), requested.slice(1)) : requested
    const missing = () => requestError(`cwd ${requested} is not an existing directory.`)
    const directory = yield* fs.realPath(path.resolve(cwd, expanded)).pipe(Effect.mapError(missing))
    const info = yield* fs.stat(directory).pipe(Effect.mapError(missing))
    if (info.type !== 'Directory') {
      return yield* missing()
    }
    return directory === cwd ? undefined : directory
  })
