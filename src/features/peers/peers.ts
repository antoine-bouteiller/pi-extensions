import { type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Effect, Option, Schema, type Scope } from 'effect'
import { type SecureRandom } from 'effect/crypto/SecureRandom'
import { type FileSystem } from 'effect/FileSystem'
import { type Path } from 'effect/Path'
import { type Static, Type } from 'typebox'
import { Value } from 'typebox/value'

import {
  AgentCwdParam,
  AgentMessageParam,
  AgentModelParam,
  type AgentModelSettingsLoader,
  AgentNameParam,
  AgentThinkingParam,
  availableAgentModels,
  checkAgentMessage,
  loadAgentModelSettings,
  requireAllowedModel,
  resolveAgentDirectory,
  splitAgentModel,
} from '#shared/effect/agent_models'

export const OpenAgentParams = Type.Object({
  cwd: Type.Optional(
    AgentCwdParam(
      'Directory for the agent, only when the user asks to work in another folder or project: absolute, ~/-relative, or relative to the current directory. The agent opens in a workspace or session for that folder.'
    )
  ),
  message: AgentMessageParam,
  model: AgentModelParam,
  name: Type.Optional(AgentNameParam('Short tab label, for example "Review auth". Defaults to the model.')),
  thinking: Type.Optional(AgentThinkingParam),
})
export const MessagePeerParams = Type.Object({ message: AgentMessageParam, pane_id: Type.String({ minLength: 1 }) })
export const DiscoverAgentsParams = Type.Object({})

export class PeerError extends Schema.TaggedError<PeerError, { readonly brand: unique symbol }>()('PeerError', {
  message: Schema.String,
}) {}

export const peerError = (message: string) => PeerError.make({ message })

export interface Peer {
  /** Rex block_id. */
  readonly id: string
  readonly status: string
  /** Rex session label. */
  readonly group: string
  readonly cwd?: string
}

export interface OpenRequest {
  readonly provider: string
  readonly model: string
  readonly name?: string
  readonly thinking?: string
  /** Resolved; undefined means `ctx.cwd`. */
  readonly directory?: string
  /** Opening header, blank line, then the task. */
  readonly text: string
}

type PeerServices = FileSystem | Path | SecureRandom

export interface PeerBackend {
  readonly name: 'rex'
  readonly activate: (ctx: ExtensionContext) => Effect.Effect<void, PeerError, PeerServices | Scope.Scope>
  readonly caller: (ctx: ExtensionContext, signal?: AbortSignal) => Effect.Effect<Peer, PeerError, PeerServices>
  /** None when the target is gone or does not run Pi. */
  readonly inspect: (cwd: string, id: string) => Effect.Effect<Option.Option<Peer>, PeerError, PeerServices>
  /** Every live Pi in every group, the caller included. */
  readonly list: (ctx: ExtensionContext, signal?: AbortSignal) => Effect.Effect<readonly Peer[], PeerError, PeerServices>
  /** Resolves once the new Pi is identified and its task is submitted. */
  readonly open: (ctx: ExtensionContext, request: OpenRequest, signal?: AbortSignal) => Effect.Effect<Peer, PeerError, PeerServices>
  readonly submit: (ctx: ExtensionContext, to: Peer, text: string) => Effect.Effect<void, PeerError, PeerServices>
}

export interface OpenResult {
  readonly pane_id: string
  readonly status: 'opened'
  readonly model: string
}
export interface MessageResult {
  readonly pane_id: string
  readonly status: 'sent'
}
interface DiscoveredAgent {
  readonly pane_id: string
  readonly status: string
  readonly workspace: string
  readonly cwd?: string
}
export interface DiscoverResult {
  readonly agents: readonly DiscoveredAgent[]
}

const cancelled = (signal?: AbortSignal): boolean => signal?.aborted === true
const refusedPeer = () => peerError('Messages may target only other top-level Pi agents listed by discover_agents.')

export const makePeerHandlers = (backend: PeerBackend | undefined, loadSettings: AgentModelSettingsLoader = loadAgentModelSettings) => {
  const requireBackend = (signal?: AbortSignal) => {
    if (cancelled(signal)) {
      return Effect.fail(peerError('Cancelled before contacting the terminal.'))
    }
    return backend === undefined ? Effect.fail(peerError('These tools require Pi to run inside Rex.')) : Effect.succeed(backend)
  }

  const availableModels = (ctx: ExtensionContext) =>
    availableAgentModels(ctx, loadSettings).pipe(Effect.mapError((error) => peerError(error.message)))

  return {
    activate: (ctx: ExtensionContext) => backend?.activate(ctx) ?? Effect.void,
    availableModels,
    discover: (ctx: ExtensionContext, signal?: AbortSignal) =>
      Effect.gen(function* () {
        const terminal = yield* requireBackend(signal)
        const caller = yield* terminal.caller(ctx, signal)
        const peers = yield* terminal.list(ctx, signal)
        return {
          agents: peers
            .filter((peer) => peer.id !== caller.id)
            .map((peer) => ({ pane_id: peer.id, status: peer.status, workspace: peer.group, ...(peer.cwd !== undefined && { cwd: peer.cwd }) })),
        } satisfies DiscoverResult
      }),
    message: (params: Static<typeof MessagePeerParams>, ctx: ExtensionContext, signal?: AbortSignal) =>
      Effect.gen(function* () {
        const message = yield* checkAgentMessage(params.message).pipe(Effect.mapError((error) => peerError(error.message)))
        const terminal = yield* requireBackend(signal)
        const caller = yield* terminal.caller(ctx, signal)
        if (params.pane_id === caller.id) {
          return yield* refusedPeer()
        }
        const target = yield* terminal.inspect(ctx.cwd, params.pane_id)
        if (Option.isNone(target)) {
          return yield* refusedPeer()
        }
        if (cancelled(signal)) {
          return yield* peerError('Cancelled before sending the message.')
        }
        yield* terminal.submit(
          ctx,
          target.value,
          `Message from Pi agent in pane ${caller.id} (cwd ${ctx.cwd}), not from your user. Reply with message_peer to pane ${caller.id} only if a response is needed:\n\n${message}`
        )
        return { pane_id: params.pane_id, status: 'sent' } satisfies MessageResult
      }),
    open: (params: Static<typeof OpenAgentParams>, ctx: ExtensionContext, signal?: AbortSignal) =>
      Effect.gen(function* () {
        const message = yield* checkAgentMessage(params.message)
        const { model, provider } = yield* splitAgentModel(params.model)
        if (!Value.Check(OpenAgentParams, params)) {
          return yield* peerError('name must be a single-line label, thinking a supported level, and cwd a path.')
        }
        const directory = params.cwd === undefined ? undefined : yield* resolveAgentDirectory(ctx.cwd, params.cwd)
        const { models } = yield* availableModels(ctx)
        yield* requireAllowedModel(params.model, models)
        const terminal = yield* requireBackend(signal)
        const caller = yield* terminal.caller(ctx, signal)
        const text = `Task from Pi agent in pane ${caller.id} (cwd ${ctx.cwd}), started at its user's request. You are an independent agent and your results are not reported back. Reply with message_peer to pane ${caller.id} only if a response is needed:\n\n${message}`
        const opened = yield* terminal.open(
          ctx,
          {
            model,
            provider,
            text,
            ...(directory !== undefined && { directory }),
            ...(params.name !== undefined && { name: params.name }),
            ...(params.thinking !== undefined && { thinking: params.thinking }),
          },
          signal
        )
        return { model: params.model, pane_id: opened.id, status: 'opened' } satisfies OpenResult
      }).pipe(Effect.mapError((error) => (error._tag === 'PeerError' ? error : peerError(error.message)))),
  }
}
