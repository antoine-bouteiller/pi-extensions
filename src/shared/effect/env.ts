import { Context, Layer } from 'effect'

export const ENVIRONMENT_KEYS = [
  'MERIDIAN_BASE_URL',
  'NO_COLOR',
  'PI_SUBAGENT',
  'PI_SUBAGENT_OWNER_TOKEN',
  'PI_SUBAGENT_READONLY',
  'PI_SUBAGENT_TEMP_DIR',
] as const

export type EnvironmentKey = (typeof ENVIRONMENT_KEYS)[number]

export interface EnvApi {
  readonly get: (key: EnvironmentKey) => string | undefined
  readonly all: Readonly<Record<string, string | undefined>>
}

/* This is a snapshot with synchronous `get` rather than Config because Pi/TUI callbacks and module-level defaults cannot await. */
export const makeEnvironment = (source: Readonly<Record<string, string | undefined>>): EnvApi => {
  const all = { ...source }
  return {
    all,
    get: (key) => all[key],
  }
}

export class Env extends Context.Service<Env, EnvApi>()('pi-extensions/shared/effect/env') {}

export const processEnvironment: EnvApi = makeEnvironment(process.env)

export const EnvLive: Layer.Layer<Env> = Layer.succeed(Env)(processEnvironment)

export const envLayer = (source: Readonly<Record<string, string | undefined>>): Layer.Layer<Env> => Layer.succeed(Env)(makeEnvironment(source))
