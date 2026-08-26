import { homedir } from 'node:os'

import { type AgentToolResult, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Context, Data, Deferred, Effect, Match, Option, Ref, Schema } from 'effect'
import { type FileSystem } from 'effect/FileSystem'
import { type Path } from 'effect/Path'
import { Type, type Static } from 'typebox'

import { type AppServices } from '#shared/effect/app_services'
import { ToolFailure } from '#shared/effect/errors'
import { createStatusChannel } from '#shared/state/status_bar'
import { type JsonObject, type JsonValue, jsonText } from '#shared/utils/json'
import { join } from '#shared/utils/path'
import { isEmptyString, isFalse, isNotEmptyString, isNotNullOrUndefined, isNullOrUndefined, isTrue } from '#shared/utils/predicates'
import { isRecord } from '#shared/utils/records'

import { loadGlobalMcpConfig } from './config.js'
import { boundGatewayOutput } from './output.js'
import {
  assertOpenableAuthorizationUrl,
  type McpGatewayPolicy,
  type McpPolicyRequest,
  type McpServerMap,
  type McpServerStatus as McpServerStatusValue,
  type McpToolAnnotations,
} from './types.js'

const SEARCH_RESULT_LIMIT = 30
const SEARCH_FETCH_LIMIT = SEARCH_RESULT_LIMIT + 1
const LIST_RESULT_LIMIT = 30
const STARTUP_CONNECT_CONCURRENCY = 4
const status = createStatusChannel('mcp', { priority: 30, tone: 'muted' })

const READONLY_DBX_TOOLS = new Set(['dbx_list_connections', 'dbx_list_tables', 'dbx_describe_table', 'dbx_get_schema_context'])

export const unrestrictedMcpPolicy: McpGatewayPolicy = {
  allows: () => true,
  name: 'unrestricted',
}

export const readonlyMcpPolicy: McpGatewayPolicy = {
  allows(request: Readonly<McpPolicyRequest>): boolean {
    if (isTrue(request.annotations.readOnlyHint) && !isTrue(request.annotations.destructiveHint)) {
      return true
    }
    return request.server === 'dbx' && Object.keys(request.annotations).length === 0 && READONLY_DBX_TOOLS.has(request.remoteName)
  },
  name: 'read-only',
}

export const mcpPolicyFromEnvironment = (environment: Readonly<Record<string, string | undefined>> = process.env): McpGatewayPolicy =>
  environment.PI_SUBAGENT_READONLY === '1' ? readonlyMcpPolicy : unrestrictedMcpPolicy

export const McpGatewayParameters = Type.Object({
  args: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.String({ description: 'A JSON object encoded as a string.' })])),
  connect: Type.Optional(Type.String({ description: 'MCP server name to connect.' })),
  describe: Type.Optional(Type.String({ description: 'Exposed MCP tool name to describe.' })),
  regex: Type.Optional(Type.Boolean({ description: 'Interpret search as a regular expression.' })),
  search: Type.Optional(Type.String({ description: 'Text or regular expression to search for.' })),
  server: Type.Optional(Type.String({ description: 'Limit an operation to one MCP server.' })),
  tool: Type.Optional(Type.String({ description: 'Exposed MCP tool name to call.' })),
})

type McpGatewayInput = Static<typeof McpGatewayParameters>

interface McpServerStatus {
  name: string
  status: McpServerStatusValue
  error?: string
}

interface McpToolSummary {
  name: string
  server?: string
  description?: string
  annotations?: McpToolAnnotations
}

export interface McpToolDescription extends McpToolSummary {
  inputSchema?: JsonValue
}

export interface McpOperationOptions {
  server?: string
  signal?: AbortSignal
}

export interface McpSearchOptions extends McpOperationOptions {
  regex?: boolean
  limit?: number
}

/** The deliberately small manager surface consumed by the gateway. */
export interface McpGatewayManager {
  status: () => readonly McpServerStatus[]
  oauthServers: () => readonly string[]
  connect: (server: string, options?: McpOperationOptions) => Effect.Effect<unknown, Error>
  list: (server: string, options?: McpOperationOptions) => Effect.Effect<readonly McpToolSummary[], Error>
  search: (query: string, options?: McpSearchOptions) => Effect.Effect<readonly McpToolSummary[], Error>
  describe: (tool: string, options?: McpOperationOptions) => Effect.Effect<McpToolDescription, Error>
  call: (tool: string, args: JsonObject, options?: McpOperationOptions) => Effect.Effect<AgentToolResult<unknown>, Error, FileSystem | Path>
  authenticate: (server: string, options?: McpOperationOptions) => Effect.Effect<unknown, Error>
  close: Effect.Effect<void>
}

type McpStatusUpdate = number | readonly McpServerStatus[]

export interface McpManagerCallbacks {
  onStatusChange: (update: McpStatusUpdate) => void
}

interface McpManagerContext {
  callbacks: McpManagerCallbacks
  pi: ExtensionAPI
  policy: McpGatewayPolicy
}

export interface McpGatewayApi {
  readonly configPath: string
  readonly loadConfig: Effect.Effect<McpServerMap, Error, FileSystem | Path>
  readonly createManager: (config: McpServerMap, context: McpManagerContext) => McpGatewayManager | Promise<McpGatewayManager>
  readonly policy: McpGatewayPolicy
}

export class McpGateway extends Context.Service<McpGateway, McpGatewayApi>()('pi-extensions/features/mcp/gateway/McpGateway') {}

const textResult = (text: string, details?: unknown): Effect.Effect<AgentToolResult<unknown>, McpOperationError, FileSystem | Path> =>
  boundGatewayOutput([{ text, type: 'text' }]).pipe(
    Effect.mapError(mcpOperationError),
    Effect.map((bounded) => {
      const resultDetails = isRecord(details) ? { ...details } : {}
      resultDetails.outputTruncated = bounded.details.truncated
      if (isNotNullOrUndefined(bounded.details.fullOutputPath) && isNotEmptyString(bounded.details.fullOutputPath)) {
        resultDetails.fullOutputPath = bounded.details.fullOutputPath
      }
      return { content: bounded.content, details: resultDetails }
    })
  )

const parseArgs = (args: unknown): Effect.Effect<JsonObject, ToolFailure> =>
  Effect.gen(function* () {
    const parsed =
      typeof args === 'string'
        ? yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(args).pipe(
            Effect.mapError((cause) => ToolFailure.make({ cause, message: `mcp args must be valid JSON: ${errorMessage(cause)}` }))
          )
        : args

    if (parsed === undefined) {
      return {}
    }
    if (!isRecord(parsed) || Array.isArray(parsed)) {
      return yield* ToolFailure.make({ message: 'mcp args must be a JSON object, not an array, scalar, or null' })
    }
    return parsed
  })

const compareNames = (left: { name: string }, right: { name: string }): number => left.name.localeCompare(right.name)

const compactDescription = (description: string | undefined): string => {
  if (isNullOrUndefined(description) || isEmptyString(description)) {
    return ''
  }
  const singleLine = description.replaceAll(/\s+/g, ' ').trim()
  return singleLine.length <= 160 ? singleLine : `${singleLine.slice(0, 157)}...`
}

const formatAnnotations = (annotations: McpToolAnnotations | undefined): string => {
  if (annotations === undefined) {
    return ''
  }
  const hints = [
    isTrue(annotations.readOnlyHint) ? 'read-only' : undefined,
    isFalse(annotations.readOnlyHint) ? 'not read-only' : undefined,
    isTrue(annotations.destructiveHint) ? 'destructive' : undefined,
    isFalse(annotations.destructiveHint) ? 'non-destructive' : undefined,
    isTrue(annotations.idempotentHint) ? 'idempotent' : undefined,
    isTrue(annotations.openWorldHint) ? 'open-world' : undefined,
  ].filter((hint): hint is string => hint !== undefined)
  return hints.length > 0 ? ` [${hints.join(', ')}]` : ''
}

const formatTools = (tools: readonly McpToolSummary[], heading: string): string => {
  const sorted = [...tools].toSorted(compareNames)
  if (sorted.length === 0) {
    return `${heading}\n(no tools found)`
  }
  return [
    heading,
    ...sorted.map((tool) => {
      const description = compactDescription(tool.description)
      return `- ${tool.name}${formatAnnotations(tool.annotations)}${isEmptyString(description) ? '' : ` — ${description}`}`
    }),
    '',
    'Call with: mcp({ tool: "<tool-name>", args: { ... } })',
  ].join('\n')
}

const updateUiStatus = (ctx: ExtensionContext, update: McpStatusUpdate): void => {
  if (typeof update === 'number') {
    if (update > 0) {
      status.set(ctx, { text: `MCP: ${update} connected` })
    } else {
      status.clear(ctx)
    }
    return
  }

  const lines = [...update]
    .toSorted(compareNames)
    .map((server) => `MCP ${server.name}: ${server.status === 'needs-auth' ? 'auth needed' : server.status.replaceAll('-', ' ')}`)
  if (lines.length > 0) {
    status.set(ctx, { text: lines.join('\n') })
  } else {
    status.clear(ctx)
  }
}

const validateSelectors = (params: {
  tool?: string
  connect?: string
  describe?: string
  search?: string
  server?: string
  args?: unknown
  regex?: boolean
}): Effect.Effect<void, ToolFailure> => {
  const selectors = [
    params.tool === undefined ? undefined : 'tool',
    params.connect === undefined ? undefined : 'connect',
    params.describe === undefined ? undefined : 'describe',
    params.search === undefined ? undefined : 'search',
  ].filter((selector): selector is string => selector !== undefined)

  if (selectors.length > 1) {
    return ToolFailure.make({ message: `Ambiguous mcp request: choose only one of ${selectors.join(', ')}` })
  }
  if (params.connect !== undefined && params.server !== undefined) {
    return ToolFailure.make({ message: 'Ambiguous mcp request: connect already names the server; omit server' })
  }
  if (params.args !== undefined && params.tool === undefined) {
    return ToolFailure.make({ message: 'mcp args can only be used with tool' })
  }
  if (params.regex !== undefined && params.search === undefined) {
    return ToolFailure.make({ message: 'mcp regex can only be used with search' })
  }
  return Effect.void
}

const errorMessage = (error: unknown): string => {
  if (Schema.is(ToolFailure)(error)) {
    return error.message
  }
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

class McpOperationError extends Data.TaggedError('McpOperationError')<{
  readonly cause: unknown
  readonly message: string
}> {}

const mcpOperationError = (cause: unknown): McpOperationError => new McpOperationError({ cause, message: errorMessage(cause) })

/** Retags a manager failure so the gateway's own error channel stays closed over `McpOperationError`. */
const fromManager = <Value, Services = never>(effect: Effect.Effect<Value, Error, Services>): Effect.Effect<Value, McpOperationError, Services> =>
  effect.pipe(Effect.mapError(mcpOperationError))

/** Wraps the remaining Promise-shaped Pi and dependency calls in the same tagged failure. */
const callManager = <Value>(run: () => Promise<Value>): Effect.Effect<Value, McpOperationError> =>
  Effect.tryPromise({
    catch: mcpOperationError,
    try: run,
  })

type McpSelector =
  | { readonly _tag: 'Call'; readonly tool: string; readonly server: string | undefined; readonly rawArgs: unknown }
  | { readonly _tag: 'Connect'; readonly server: string }
  | { readonly _tag: 'Describe'; readonly tool: string; readonly server: string | undefined }
  | { readonly _tag: 'Search'; readonly query: string; readonly regex: boolean; readonly server: string | undefined }
  | { readonly _tag: 'List'; readonly server: string }
  | { readonly _tag: 'Status' }

/** Validates mutual exclusivity/orphan modifiers (`validateSelectors`) then classifies which operation to dispatch. */
const classifySelector = (params: McpGatewayInput): Effect.Effect<McpSelector, ToolFailure> =>
  Effect.gen(function* () {
    yield* validateSelectors(params)
    if (params.tool !== undefined) {
      return { _tag: 'Call' as const, rawArgs: params.args, server: params.server, tool: params.tool }
    }
    if (params.connect !== undefined) {
      return { _tag: 'Connect' as const, server: params.connect }
    }
    if (params.describe !== undefined) {
      return { _tag: 'Describe' as const, server: params.server, tool: params.describe }
    }
    if (params.search !== undefined) {
      return { _tag: 'Search' as const, query: params.search, regex: params.regex ?? false, server: params.server }
    }
    if (params.server !== undefined) {
      return { _tag: 'List' as const, server: params.server }
    }
    return { _tag: 'Status' as const }
  })

interface McpGatewayStateFields {
  readonly generation: Ref.Ref<number>
  readonly manager: Ref.Ref<Option.Option<McpGatewayManager>>
  readonly initialization: Ref.Ref<Option.Option<Deferred.Deferred<void, McpOperationError>>>
}

const makeState: Effect.Effect<McpGatewayStateFields> = Effect.gen(function* () {
  return {
    generation: yield* Ref.make(0),
    initialization: yield* Ref.make<Option.Option<Deferred.Deferred<void, McpOperationError>>>(Option.none()),
    manager: yield* Ref.make<Option.Option<McpGatewayManager>>(Option.none()),
  }
})

/** Mirrors `if (initialization) { await initialization }` then requires an installed manager. */
const requireManager = (state: McpGatewayStateFields): Effect.Effect<McpGatewayManager, McpOperationError | ToolFailure> =>
  Effect.gen(function* () {
    const pending = yield* Ref.get(state.initialization)
    if (Option.isSome(pending)) {
      yield* Deferred.await(pending.value)
    }
    const current = yield* Ref.get(state.manager)
    if (Option.isNone(current)) {
      return yield* ToolFailure.make({ message: 'MCP is not initialized. Start or reload the Pi session and try again.' })
    }
    return current.value
  })

const dispatchGateway = (
  configPath: string,
  state: McpGatewayStateFields,
  params: McpGatewayInput,
  signal: AbortSignal | undefined
): Effect.Effect<AgentToolResult<unknown>, McpOperationError | ToolFailure, FileSystem | Path> =>
  Effect.gen(function* () {
    const selector = yield* classifySelector(params)
    const manager = yield* requireManager(state)

    return yield* Match.valueTags(selector, {
      Call: (op) =>
        Effect.gen(function* () {
          const args = yield* parseArgs(op.rawArgs)
          return yield* fromManager(manager.call(op.tool, args, { server: op.server, signal }))
        }),

      Connect: (op) =>
        Effect.gen(function* () {
          yield* fromManager(manager.connect(op.server, { signal }))
          return yield* textResult(`Connected MCP server ${op.server}.\nList tools with: mcp({ server: ${jsonText(op.server)} })`, {
            server: op.server,
          })
        }),

      Describe: (op) =>
        Effect.gen(function* () {
          const description = yield* fromManager(manager.describe(op.tool, { server: op.server, signal }))
          const summary = compactDescription(description.description)
          const lines = [
            `${description.name}${formatAnnotations(description.annotations)}`,
            ...(isNotNullOrUndefined(description.server) && isNotEmptyString(description.server) ? [`Server: ${description.server}`] : []),
            ...(isEmptyString(summary) ? [] : [summary]),
            `Input schema: ${jsonText(description.inputSchema ?? {})}`,
            `Call with: mcp({ tool: ${jsonText(description.name)}, args: { ... } })`,
          ]
          return yield* textResult(lines.join('\n'), {
            annotations: description.annotations,
            server: description.server,
            tool: description.name,
          })
        }),

      List: (op) =>
        Effect.gen(function* () {
          const tools = yield* fromManager(manager.list(op.server, { signal }))
          const sorted = [...tools].toSorted(compareNames)
          const capped = sorted.slice(0, LIST_RESULT_LIMIT)
          return yield* textResult(formatTools(capped, `MCP tools on ${op.server} (${capped.length} of ${sorted.length}):`), {
            resultsTruncated: sorted.length > capped.length,
            server: op.server,
            tools: capped.map((tool) => ({ annotations: tool.annotations, name: tool.name, server: tool.server })),
          })
        }),

      Search: (op) =>
        Effect.gen(function* () {
          const matches = yield* fromManager(manager.search(op.query, { limit: SEARCH_FETCH_LIMIT, regex: op.regex, server: op.server, signal }))
          const capped = [...matches].toSorted(compareNames).slice(0, SEARCH_RESULT_LIMIT)
          return yield* textResult(formatTools(capped, `MCP search results (${capped.length}):`), {
            query: op.query,
            regex: op.regex,
            resultsTruncated: matches.length > capped.length,
            server: op.server,
            tools: capped.map((tool) => ({ annotations: tool.annotations, name: tool.name, server: tool.server })),
          })
        }),

      Status: () =>
        Effect.gen(function* () {
          const servers = yield* Effect.sync(() => manager.status())
          const sorted = [...servers].toSorted(compareNames)
          const lines = [
            `MCP config: ${configPath}`,
            ...(sorted.length === 0
              ? ['(no configured servers)']
              : sorted.map(
                  (server) =>
                    `- ${server.name}: ${server.status === 'invalid-config' ? 'invalid config' : server.status}${isNotNullOrUndefined(server.error) && isNotEmptyString(server.error) ? ` — ${server.error}` : ''}`
                )),
            '',
            'List one server with: mcp({ server: "<server-name>" })',
          ]
          return yield* textResult(lines.join('\n'), {
            configPath,
            resultsTruncated: sorted.length > 30,
            serverCount: sorted.length,
            servers: sorted.slice(0, 30).map((server) => ({ name: server.name.slice(0, 128), status: server.status })),
          })
        }),
    })
  })

export interface GatewaySession {
  readonly authenticate: (args: string, ctx: ExtensionCommandContext) => Effect.Effect<void>
  readonly dispatch: (
    params: McpGatewayInput,
    signal: AbortSignal | undefined
  ) => Effect.Effect<AgentToolResult<unknown>, McpOperationError | ToolFailure, FileSystem | Path | McpGateway>
  readonly oauthCompletions: (prefix: string) => { label: string; value: string }[]
  readonly start: (ctx: ExtensionContext) => Effect.Effect<void, McpOperationError, AppServices | McpGateway>
  readonly stop: (ctx: ExtensionContext) => Effect.Effect<void, McpOperationError>
}

/** Owns one gateway lifecycle; its config and manager are supplied by the `McpGateway` service. */
export const makeGatewaySession = (pi: ExtensionAPI): GatewaySession => {
  // oxlint-disable-next-line pi-extensions/no-effect-pi-boundary -- spec [KD-6] §8.3; permanent: synchronous feature registration constructs memory-only state and cannot return an Effect
  const state = Effect.runSync(makeState)

  const startSession = (ctx: ExtensionContext): Effect.Effect<void, McpOperationError, AppServices | McpGateway> =>
    Effect.gen(function* () {
      const gateway = yield* McpGateway
      const generation = yield* Ref.updateAndGet(state.generation, (value) => value + 1)
      const previousManager = yield* Ref.getAndSet(state.manager, Option.none())
      const deferred = yield* Deferred.make<void, McpOperationError>()
      yield* Ref.set(state.initialization, Option.some(deferred))

      yield* Effect.gen(function* () {
        const context = yield* Effect.context()
        if (Option.isSome(previousManager)) {
          yield* previousManager.value.close
        }
        const config = yield* fromManager(gateway.loadConfig)
        const managerCreation = Promise.resolve().then(() =>
          gateway.createManager(config, {
            callbacks: {
              onStatusChange: (update) => {
                // oxlint-disable-next-line pi-extensions/no-effect-pi-boundary -- spec [KD-6] §8.3; permanent: manager synchronous status callback cannot return an Effect
                if (Effect.runSyncWith(context)(Ref.get(state.generation)) === generation) {
                  updateUiStatus(ctx, update)
                }
              },
            },
            pi,
            policy: gateway.policy,
          })
        )
        const candidate = yield* Effect.callback<McpGatewayManager, McpOperationError>((resume) => {
          void managerCreation.then(
            (manager) => resume(Effect.succeed(manager)),
            (error: unknown) => resume(Effect.fail(mcpOperationError(error)))
          )
          // An uncancellable factory promise can settle after activation is interrupted. Its
          // Cancellation finalizer owns that late manager instead of leaking its transports.
          return Effect.promise(() =>
            managerCreation.then(
              (manager) => manager.close,
              () => Effect.void
            )
          ).pipe(Effect.flatten)
        })

        if ((yield* Ref.get(state.generation)) !== generation) {
          yield* candidate.close
          return
        }
        yield* Ref.set(state.manager, Option.some(candidate))
        const servers = yield* Effect.sync(() => candidate.status())
        updateUiStatus(ctx, servers)
        /*
         * Bounded: unbounded fan-out spawns one stdio process per configured server at once.
         * The manager's own lifecycle abort cancels whatever is still in flight on stop.
         */
        yield* Effect.forEach(
          servers.filter((server) => server.status === 'disconnected'),
          (server) => candidate.connect(server.name).pipe(Effect.ignore),
          { concurrency: STARTUP_CONNECT_CONCURRENCY, discard: true }
        ).pipe((connectAll) => Effect.forkDetach(connectAll, { startImmediately: true }))
      }).pipe(Effect.onExit((exit) => Deferred.done(deferred, exit)))
    })

  const stopSession = (ctx: ExtensionContext): Effect.Effect<void, McpOperationError> =>
    Effect.gen(function* () {
      yield* Ref.update(state.generation, (value) => value + 1)
      const pending = yield* Ref.get(state.initialization)
      if (Option.isSome(pending)) {
        yield* Deferred.await(pending.value).pipe(Effect.exit)
      }
      const current = yield* Ref.getAndSet(state.manager, Option.none())
      yield* Effect.ensuring(
        Option.isSome(current) ? current.value.close : Effect.void,
        Effect.gen(function* () {
          yield* Ref.set(state.initialization, Option.none())
          yield* Effect.sync(() => status.clear(ctx))
        })
      )
    })

  const oauthCompletions = (prefix: string): { label: string; value: string }[] => {
    // oxlint-disable-next-line pi-extensions/no-effect-pi-boundary -- spec [KD-6] §8.3; permanent: Pi synchronous command-completion callback cannot return an Effect
    const current = Effect.runSync(Ref.get(state.manager))
    if (Option.isNone(current)) {
      return []
    }
    return current.value
      .oauthServers()
      .filter((server) => server.startsWith(prefix))
      .toSorted((left, right) => left.localeCompare(right))
      .map((server) => ({ label: server, value: server }))
  }

  const authenticate = (args: string, ctx: ExtensionCommandContext): Effect.Effect<void> =>
    Effect.gen(function* () {
      const manager = yield* requireManager(state)
      let server = args.trim()
      if (isEmptyString(server)) {
        const servers = [...manager.oauthServers()].toSorted((left, right) => left.localeCompare(right))
        if (servers.length === 0) {
          ctx.ui.notify('No OAuth-enabled MCP servers are configured.', 'error')
          return
        }
        const [onlyServer] = servers
        if (servers.length === 1 && onlyServer !== undefined) {
          server = onlyServer
        } else {
          const selected = yield* callManager(() => ctx.ui.select('Authenticate MCP server', servers))
          if (isNullOrUndefined(selected) || isEmptyString(selected)) {
            return
          }
          server = selected
        }
      }

      yield* fromManager(manager.authenticate(server))
      ctx.ui.notify(`Authenticated and connected MCP server ${server}.`, 'info')
    }).pipe(
      Effect.catch((error) => {
        ctx.ui.notify(errorMessage(error), 'error')
        return Effect.void
      })
    )

  return {
    authenticate,
    dispatch: (params, signal) =>
      Effect.gen(function* () {
        const gateway = yield* McpGateway
        return yield* dispatchGateway(gateway.configPath, state, params, signal)
      }),
    oauthCompletions,
    start: startSession,
    stop: stopSession,
  }
}

const globalConfigPath = join(homedir(), '.config', 'mcp', 'mcp.json')

/**
 * Creates the process-local MCP gateway. Manager and transport initialization remains deferred
 * until the feature's session activation.
 */
export const makeMcpGateway = (): McpGatewayApi => ({
  configPath: globalConfigPath,
  /*
   * Keep the manager behind the session lifecycle boundary: importing this entrypoint and
   * registering the gateway must not initialize MCP SDK transports or native OAuth storage.
   */
  createManager: (config, { callbacks, pi, policy }) =>
    import('./manager.js').then(
      ({ McpManager: Manager }) =>
        new Manager(config, {
          onStatusChange: callbacks.onStatusChange,
          // oxlint-disable-next-line effecttsgo/async-function -- `openUrl` is handed to the MCP SDK's OAuth provider, which awaits it.
          async openUrl(url: string, signal?: AbortSignal) {
            // Re-checked at the process boundary: `open` dispatches any scheme the OS has registered.
            const result = await pi.exec('/usr/bin/open', [assertOpenableAuthorizationUrl(url).href], { signal })
            if (result.code !== 0) {
              throw new Error(`Could not open the OAuth authorization page: ${result.stderr.trim()}`)
            }
          },
          policy,
        })
    ),
  loadConfig: loadGlobalMcpConfig,
  policy: mcpPolicyFromEnvironment(),
})
