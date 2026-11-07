import { type AssistantMessage } from '@earendil-works/pi-ai'
import { type ExtensionAPI, type ExtensionContext, type MessageEndEvent } from '@earendil-works/pi-coding-agent'
import { Cause, Effect } from 'effect'
import { type Static, type TSchema, Type } from 'typebox'
import { Value } from 'typebox/value'

import { Env, type EnvApi } from '#shared/effect/env'
import { jsonText, parseJsonText } from '#shared/utils/json'

import { isMeridianModel } from './affinity.js'

const AUTH_ERROR = /Failed to authenticate|OAuth session expired/i
// Keep in sync with provider_retry: Pi retries this prefix, and provider_retry leaves it untouched.
const RETRY_PREFIX = 'server error: '
const LOGIN_COMMAND = ['claude', 'auth', 'login']
const LAYER_BOUNDS = [0.15, 0.15, 0.7, 0.7]

const InspectedBlockSchema = Type.Object({ block: Type.Object({ window_id: Type.String({ minLength: 1 }) }) })
const CreatedLayerSchema = Type.Object({ block_ids: Type.Array(Type.String(), { minItems: 1 }), layer_id: Type.String({ minLength: 1 }) })

interface RexTarget {
  readonly bin: string
  readonly block: string
  readonly session: string
}

const rexTarget = (env: EnvApi): RexTarget | undefined => {
  const { REX_BIN_DIR, REX_BLOCK, REX_SESSION } = env.all
  if (REX_BLOCK === undefined || REX_BLOCK === '' || REX_SESSION === undefined || REX_SESSION === '') {
    return undefined
  }
  return { bin: REX_BIN_DIR === undefined ? 'rex' : `${REX_BIN_DIR}/rex`, block: REX_BLOCK, session: REX_SESSION }
}

const isClaudeAuthError = (message: MessageEndEvent['message']): message is AssistantMessage =>
  message.role === 'assistant' && message.stopReason === 'error' && AUTH_ERROR.test(message.errorMessage ?? '')

/** Resolves to whether `claude auth login` exited successfully in a floating pane over Pi's own window. */
const loginInFloatingPane = (pi: ExtensionAPI, target: RexTarget, signal: AbortSignal | undefined): Effect.Effect<boolean> => {
  const exec = (args: string[], execSignal?: AbortSignal) => Effect.tryPromise(() => pi.exec(target.bin, args, { signal: execSignal }))
  const request = <Schema extends TSchema>(args: string[], schema: Schema) =>
    exec(args).pipe(
      Effect.flatMap((result) => Effect.try(() => (result.code === 0 ? parseJsonText(result.stdout) : undefined))),
      Effect.filterOrFail(
        (value): value is Static<Schema> => Value.Check(schema, value),
        () => new Cause.UnknownError(undefined, `rex ${args[0]} returned an unexpected response`)
      )
    )

  return Effect.gen(function* () {
    const inspected = yield* request(['block', 'inspect', '-s', target.session, target.block, '--json'], InspectedBlockSchema)
    const layout = { block: { flavor: 'com.superlogical.terminal.shell', label: 'claude login', options: { command: LOGIN_COMMAND } } }
    const layer = yield* request(
      [
        'api',
        'call',
        '-s',
        target.session,
        'session.new_layer',
        jsonText({ bounds: LAYER_BOUNDS, focus: true, layout, window_id: inspected.block.window_id }),
      ],
      CreatedLayerSchema
    )
    const waited = yield* exec(['wait', '-s', target.session, layer.block_ids[0]], signal)
    if (signal?.aborted === true || waited.killed) {
      yield* exec(['api', 'call', '-s', target.session, 'session.close_layer', jsonText({ layer_id: layer.layer_id })]).pipe(Effect.ignore)
      return false
    }
    return waited.code === 0
  }).pipe(Effect.orElseSucceed(() => false))
}

/**
 * Opens `claude auth login` in a floating Rex pane when Meridian reports an expired Claude Code login, then marks the
 * error retryable so Pi resends the request. At most one login is offered per agent run.
 */
export const makeLoginRetry = (pi: ExtensionAPI) => {
  let offered = false
  return {
    onMessageEnd: ({ message }: MessageEndEvent, ctx: ExtensionContext): Effect.Effect<{ message: AssistantMessage } | undefined, never, Env> =>
      Effect.gen(function* () {
        if (offered || !isClaudeAuthError(message)) {
          return undefined
        }
        const env = yield* Env
        const target = rexTarget(env)
        if (target === undefined || !isMeridianModel(ctx, env)) {
          return undefined
        }
        offered = true
        if (!(yield* loginInFloatingPane(pi, target, ctx.signal))) {
          return undefined
        }
        return { message: { ...message, errorMessage: `${RETRY_PREFIX}${message.errorMessage ?? ''}` } }
      }),
    reset: (): void => {
      offered = false
    },
  }
}
