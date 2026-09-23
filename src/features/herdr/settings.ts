import { CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent'
import { Data, Effect } from 'effect'
import { FileSystem } from 'effect/FileSystem'
import { Path } from 'effect/Path'
import { Type } from 'typebox'
import { Value } from 'typebox/value'

import { parseJsonText } from '#shared/utils/json'

const ModelSchema = Type.String({ maxLength: 256, pattern: '^[a-zA-Z0-9_-]+/[^\\s\\x00-\\x1f\\x7f-\\x9f-][^\\s\\x00-\\x1f\\x7f-\\x9f]*$' })
const HerdrSettingsSchema = Type.Object({ allowedModels: Type.Optional(Type.Array(ModelSchema)) }, { additionalProperties: false })
const SettingsSchema = Type.Object({ herdr: Type.Optional(HerdrSettingsSchema) }, { additionalProperties: true })

export class HerdrSettingsError extends Data.TaggedError('HerdrSettingsError')<{ readonly message: string; readonly cause?: unknown }> {}

const readSettings = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const text = yield* fs.readFileString(path).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === 'NotFound',
        () => Effect.succeed('{}')
      )
    )
    return yield* Effect.try({
      catch: (error) => new HerdrSettingsError({ cause: error, message: `${path}: ${String(error)}` }),
      try: () => {
        const settings = parseJsonText(text)
        if (!Value.Check(SettingsSchema, settings)) {
          throw new Error(
            'expected herdr.allowedModels to be an array of exact provider/model-id strings (at most 256 characters, no whitespace or control characters).'
          )
        }
        return settings
      },
    })
  })

export const loadHerdrSettings = (options: { readonly agentDir: string; readonly cwd: string; readonly projectTrusted: boolean }) =>
  Effect.gen(function* () {
    const path = yield* Path
    const global = yield* readSettings(path.join(options.agentDir, 'settings.json'))
    const project = options.projectTrusted ? yield* readSettings(path.join(options.cwd, CONFIG_DIR_NAME, 'settings.json')) : {}

    return { allowedModels: project.herdr?.allowedModels ?? global.herdr?.allowedModels ?? [] }
  })
