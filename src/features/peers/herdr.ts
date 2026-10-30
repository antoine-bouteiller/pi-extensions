import { fileURLToPath } from 'node:url'

import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Effect, Option, Semaphore } from 'effect'
import { SecureRandom } from 'effect/crypto/SecureRandom'
import { Path } from 'effect/Path'
import { type Static, type TSchema, Type } from 'typebox'
import { Value } from 'typebox/value'

import { parseJsonText } from '#shared/utils/json'

import { type OpenRequest, type Peer, type PeerBackend, peerError } from './peers.js'

const optionalText = Type.Optional(Type.Union([Type.String(), Type.Null()]))
const PaneSchema = Type.Object({
  agent: Type.Optional(Type.String()),
  agent_session: Type.Optional(Type.Object({ agent: Type.String(), kind: Type.String(), value: Type.String() })),
  agent_status: Type.Optional(Type.String()),
  cwd: optionalText,
  pane_id: Type.String({ minLength: 1 }),
  terminal_id: Type.String({ minLength: 1 }),
  workspace_id: Type.String({ minLength: 1 }),
})
const WorkspaceSchema = Type.Object({ label: optionalText, workspace_id: Type.String({ minLength: 1 }) })
type Pane = Static<typeof PaneSchema>

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const decode = <Schema extends TSchema>(schema: Schema, value: unknown): Static<Schema> => {
  if (!Value.Check(schema, value)) {
    throw peerError('Herdr returned an unexpected response.')
  }
  return value
}
const sessionFile = (pane: Pane): string | undefined =>
  pane.agent === 'pi' && pane.agent_session?.agent === 'pi' && pane.agent_session.kind === 'path' ? pane.agent_session.value : undefined
const peerOf = (pane: Pane, group = pane.workspace_id): Peer => ({
  group,
  id: pane.pane_id,
  status: pane.agent_status ?? 'unknown',
  ...(typeof pane.cwd === 'string' && { cwd: pane.cwd }),
})

export const makeHerdrBackend = (pi: ExtensionAPI): PeerBackend => {
  /** Keyed by parent session and target directory; only directories other than the caller's are cached. */
  const workspaces = new Map<string, string>()
  const placement = Semaphore.makeUnsafe(1)

  const request = <Schema extends TSchema>(cwd: string, args: string[], schema: Schema) =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        catch: (error) => peerError(errorMessage(error)),
        try: () => pi.exec('herdr', args, { cwd, timeout: 40_000 }),
      })
      if (result.code !== 0 || result.killed) {
        return yield* peerError(result.stderr.trim().slice(0, 2000) || 'Herdr command failed or timed out. Inspect Herdr before retrying a mutation.')
      }
      return yield* Effect.try({
        catch: (error) => (error instanceof Error && '_tag' in error ? peerError(error.message) : peerError(errorMessage(error))),
        try: () => decode(schema, decode(Type.Object({ result: Type.Unknown() }), parseJsonText(result.stdout)).result),
      })
    })

  const currentPane = (ctx: ExtensionContext) =>
    Effect.gen(function* () {
      const { pane } = yield* request(ctx.cwd, ['pane', 'current', '--current'], Type.Object({ pane: PaneSchema }))
      const session = ctx.sessionManager.getSessionFile()
      if (session === undefined || sessionFile(pane) !== session) {
        return yield* peerError('Herdr does not identify this pane as the current Pi session.')
      }
      return pane
    })

  const createTab = (ctx: ExtensionContext, label: string, directory: string | undefined, callerWorkspace: string) =>
    Effect.gen(function* () {
      const path = yield* Path
      const cwdArgs = ['--cwd', directory ?? ctx.cwd, '--no-focus']
      const createWorkspace = (key: string, target: string) =>
        request(ctx.cwd, ['workspace', 'create', '--label', path.basename(target), ...cwdArgs], Type.Object({ root_pane: PaneSchema })).pipe(
          Effect.tap(({ root_pane }) => Effect.sync(() => workspaces.set(key, root_pane.workspace_id))),
          Effect.map(({ root_pane }) => root_pane)
        )
      const tab = (workspace: string) =>
        request(ctx.cwd, ['tab', 'create', '--workspace', workspace, '--label', label, ...cwdArgs], Type.Object({ root_pane: PaneSchema })).pipe(
          Effect.map(({ root_pane }) => root_pane)
        )
      if (directory === undefined) {
        return yield* tab(callerWorkspace)
      }
      const key = `${ctx.sessionManager.getSessionFile()}\n${directory}`
      const known = workspaces.get(key)
      if (known === undefined) {
        return yield* createWorkspace(key, directory)
      }
      return yield* tab(known).pipe(
        Effect.catchIf(
          (error) => error.message.includes('workspace_not_found'),
          () => createWorkspace(key, directory)
        )
      )
    })

  return {
    activate: () => Effect.void,
    caller: (ctx) => currentPane(ctx).pipe(Effect.map((pane) => peerOf(pane))),
    inspect: (cwd, id) =>
      request(cwd, ['agent', 'get', id], Type.Object({ agent: PaneSchema })).pipe(
        Effect.map(({ agent }) => (sessionFile(agent) === undefined ? Option.none() : Option.some(peerOf(agent)))),
        Effect.catchIf(
          (error) => error.message.includes('agent_not_found') || error.message.includes('pane_not_found'),
          () => Effect.succeedNone
        )
      ),
    list: (ctx) =>
      Effect.gen(function* () {
        const [{ agents }, listed] = yield* Effect.all([
          request(ctx.cwd, ['agent', 'list'], Type.Object({ agents: Type.Array(PaneSchema) })),
          request(ctx.cwd, ['workspace', 'list'], Type.Object({ workspaces: Type.Array(WorkspaceSchema) })),
        ])
        const labels = new Map(listed.workspaces.map((workspace) => [workspace.workspace_id, workspace.label ?? workspace.workspace_id]))
        return agents.filter((agent) => sessionFile(agent) !== undefined).map((agent) => peerOf(agent, labels.get(agent.workspace_id)))
      }),
    name: 'herdr',
    open: (ctx, openRequest: OpenRequest, signal) =>
      Effect.gen(function* () {
        const caller = yield* currentPane(ctx)
        const label = openRequest.name ?? `${openRequest.provider}/${openRequest.model}`
        const pane = yield* placement.withPermits(1)(
          Effect.gen(function* () {
            if (signal?.aborted === true) {
              return yield* peerError('Cancelled before creating a tab.')
            }
            return yield* createTab(ctx, label, openRequest.directory, caller.workspace_id)
          })
        )
        return yield* Effect.gen(function* () {
          if (signal?.aborted === true) {
            return yield* peerError('Cancelled after creating the tab.')
          }
          const random = yield* SecureRandom
          const id = yield* random.uuidV4()
          const { agent } = yield* request(
            ctx.cwd,
            [
              'agent',
              'start',
              `pi-${id.slice(0, 8)}`,
              '--kind',
              'pi',
              '--pane',
              pane.pane_id,
              '--',
              '--provider',
              openRequest.provider,
              '--model',
              openRequest.model,
              ...(openRequest.thinking === undefined ? [] : ['--thinking', openRequest.thinking]),
              '--extension',
              fileURLToPath(new URL('../../index.ts', import.meta.url)),
            ],
            Type.Object({ agent: PaneSchema })
          )
          if (agent.pane_id !== pane.pane_id || agent.terminal_id !== pane.terminal_id || sessionFile(agent) === undefined) {
            return yield* peerError('Herdr did not start the expected Pi session in the new tab.')
          }
          yield* request(ctx.cwd, ['agent', 'prompt', pane.pane_id, openRequest.text], Type.Object({ agent: PaneSchema }))
          return peerOf(agent)
        }).pipe(Effect.mapError((error) => peerError(`Pane ${pane.pane_id} was created and remains open. ${error.message}`)))
      }),
    submit: (ctx, to, text) => request(ctx.cwd, ['agent', 'prompt', to.id, text], Type.Object({ agent: PaneSchema })).pipe(Effect.asVoid),
  }
}
