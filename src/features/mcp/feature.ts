import { homedir } from 'node:os'
import { join } from 'node:path'

import { type AgentToolResult, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Data, Deferred, Effect, Function, Match, Option, Ref } from 'effect'
import { Type, type Static } from 'typebox'

import { type AppRuntime } from '@/shared/effect/app_services.js'
import { ToolFailure } from '@/shared/effect/errors.js'
import { createStatusChannel } from '@/shared/state/status_bar.js'
import { isEmptyString, isFalse, isNotEmptyString, isNotNullOrUndefined, isNullOrUndefined, isTrue } from '@/shared/utils/predicates.js'
import { isRecord } from '@/shared/utils/records.js'

import { loadGlobalMcpConfig } from './config.js'
import { boundGatewayOutput } from './output.js'
import { type McpGatewayPolicy, type McpPolicyRequest, type McpServerStatus as McpServerStatusValue, type McpToolAnnotations } from './types.js'

const SEARCH_RESULT_LIMIT = 30
const SEARCH_FETCH_LIMIT = SEARCH_RESULT_LIMIT + 1
const LIST_RESULT_LIMIT = 30
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

const McpGatewayParameters = Type.Object({
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
  inputSchema?: unknown
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
  status: () => readonly McpServerStatus[] | Promise<readonly McpServerStatus[]>
  oauthServers: () => readonly string[]
  connect: (server: string, options?: McpOperationOptions) => Promise<unknown>
  list: (server: string, options?: McpOperationOptions) => Promise<readonly McpToolSummary[]>
  search: (query: string, options?: McpSearchOptions) => Promise<readonly McpToolSummary[]>
  describe: (tool: string, options?: McpOperationOptions) => Promise<McpToolDescription>
  call: (tool: string, args: Record<string, unknown>, options?: McpOperationOptions) => Promise<AgentToolResult<unknown>>
  authenticate: (server: string, options?: McpOperationOptions) => Promise<unknown>
  close: () => Promise<void>
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

export interface McpGatewayDependencies<TConfig = unknown> {
  configPath: string
  loadConfig: () => Promise<TConfig>
  createManager: (config: TConfig, context: McpManagerContext) => McpGatewayManager | Promise<McpGatewayManager>
  /** Defaults to unrestricted. Production selects this from PI_SUBAGENT_READONLY. */
  policy?: McpGatewayPolicy
}

const textResult = async (text: string, details?: unknown): Promise<AgentToolResult<unknown>> => {
  const bounded = await boundGatewayOutput([{ text, type: 'text' }])
  return {
    content: bounded.content,
    details: {
      ...(details !== undefined && typeof details === 'object' ? details : {}),
      outputTruncated: bounded.details.truncated,
      ...(isNotNullOrUndefined(bounded.details.fullOutputPath) && isNotEmptyString(bounded.details.fullOutputPath)
        ? { fullOutputPath: bounded.details.fullOutputPath }
        : {}),
    },
  }
}

const parseArgs = (args: unknown): Effect.Effect<Record<string, unknown>, ToolFailure> =>
  Effect.gen(function* () {
    const parsed =
      typeof args === 'string'
        ? yield* Effect.try({
            catch: (cause) => ToolFailure.make({ cause, message: `mcp args must be valid JSON: ${errorMessage(cause)}` }),
            try: () => JSON.parse(args) as unknown,
          })
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
  if (error instanceof ToolFailure) {
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

/** Wraps manager and gateway Promise calls in a tagged failure while preserving their cause. */
const callManager = <Value>(run: () => Promise<Value>): Effect.Effect<Value, McpOperationError> =>
  Effect.tryPromise({
    catch: (cause) => new McpOperationError({ cause, message: errorMessage(cause) }),
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

interface McpGatewayStateShape {
  readonly generation: Ref.Ref<number>
  readonly manager: Ref.Ref<Option.Option<McpGatewayManager>>
  readonly initialization: Ref.Ref<Option.Option<Deferred.Deferred<void, McpOperationError>>>
}

const makeState: Effect.Effect<McpGatewayStateShape> = Effect.gen(function* () {
  return {
    generation: yield* Ref.make(0),
    initialization: yield* Ref.make<Option.Option<Deferred.Deferred<void, McpOperationError>>>(Option.none()),
    manager: yield* Ref.make<Option.Option<McpGatewayManager>>(Option.none()),
  }
})

/** Mirrors `if (initialization) { await initialization }` then requires an installed manager. */
const requireManager = (state: McpGatewayStateShape): Effect.Effect<McpGatewayManager, McpOperationError | ToolFailure> =>
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
  state: McpGatewayStateShape,
  params: McpGatewayInput,
  signal: AbortSignal | undefined
): Effect.Effect<AgentToolResult<unknown>, McpOperationError | ToolFailure> =>
  Effect.gen(function* () {
    const selector = yield* classifySelector(params)
    const manager = yield* requireManager(state)

    return yield* Match.valueTags(selector, {
      Call: (op) =>
        Effect.gen(function* () {
          const args = yield* parseArgs(op.rawArgs)
          return yield* callManager(() => manager.call(op.tool, args, { server: op.server, signal }))
        }),

      Connect: (op) =>
        Effect.gen(function* () {
          yield* callManager(() => manager.connect(op.server, { signal }))
          return yield* callManager(() =>
            textResult(`Connected MCP server ${op.server}.\nList tools with: mcp({ server: ${JSON.stringify(op.server)} })`, { server: op.server })
          )
        }),

      Describe: (op) =>
        Effect.gen(function* () {
          const description = yield* callManager(() => manager.describe(op.tool, { server: op.server, signal }))
          const summary = compactDescription(description.description)
          const lines = [
            `${description.name}${formatAnnotations(description.annotations)}`,
            ...(isNotNullOrUndefined(description.server) && isNotEmptyString(description.server) ? [`Server: ${description.server}`] : []),
            ...(isEmptyString(summary) ? [] : [summary]),
            `Input schema: ${JSON.stringify(description.inputSchema ?? {})}`,
            `Call with: mcp({ tool: ${JSON.stringify(description.name)}, args: { ... } })`,
          ]
          return yield* callManager(() =>
            textResult(lines.join('\n'), {
              annotations: description.annotations,
              server: description.server,
              tool: description.name,
            })
          )
        }),

      List: (op) =>
        Effect.gen(function* () {
          const tools = yield* callManager(() => manager.list(op.server, { signal }))
          const sorted = [...tools].toSorted(compareNames)
          const capped = sorted.slice(0, LIST_RESULT_LIMIT)
          return yield* callManager(() =>
            textResult(formatTools(capped, `MCP tools on ${op.server} (${capped.length} of ${sorted.length}):`), {
              resultsTruncated: sorted.length > capped.length,
              server: op.server,
              tools: capped.map((tool) => ({ annotations: tool.annotations, name: tool.name, server: tool.server })),
            })
          )
        }),

      Search: (op) =>
        Effect.gen(function* () {
          const matches = yield* callManager(() =>
            manager.search(op.query, { limit: SEARCH_FETCH_LIMIT, regex: op.regex, server: op.server, signal })
          )
          const capped = [...matches].toSorted(compareNames).slice(0, SEARCH_RESULT_LIMIT)
          return yield* callManager(() =>
            textResult(formatTools(capped, `MCP search results (${capped.length}):`), {
              query: op.query,
              regex: op.regex,
              resultsTruncated: matches.length > capped.length,
              server: op.server,
              tools: capped.map((tool) => ({ annotations: tool.annotations, name: tool.name, server: tool.server })),
            })
          )
        }),

      Status: () =>
        Effect.gen(function* () {
          const servers = yield* callManager(() => Promise.resolve(manager.status()))
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
          return yield* callManager(() =>
            textResult(lines.join('\n'), {
              configPath,
              resultsTruncated: sorted.length > 30,
              serverCount: sorted.length,
              servers: sorted.slice(0, 30).map((server) => ({ name: server.name.slice(0, 128), status: server.status })),
            })
          )
        }),
    })
  })

/** Build feature registration with injectable config and manager dependencies for isolated tests. */
// oxlint-disable-next-line effecttsgo/missing-pipeable-signature -- The generic dependency type is inferred from the data-first argument.
export const createMcpExtension: {
  (runtime: AppRuntime): <TConfig>(dependencies: McpGatewayDependencies<TConfig>) => (pi: ExtensionAPI) => void
  <TConfig>(dependencies: McpGatewayDependencies<TConfig>, runtime: AppRuntime): (pi: ExtensionAPI) => void
} = Function.dual<
  (runtime: AppRuntime) => <TConfig>(dependencies: McpGatewayDependencies<TConfig>) => (pi: ExtensionAPI) => void,
  <TConfig>(dependencies: McpGatewayDependencies<TConfig>, runtime: AppRuntime) => (pi: ExtensionAPI) => void
>(
  2,
  <TConfig>(dependencies: McpGatewayDependencies<TConfig>, runtime: AppRuntime) =>
    function mcpGateway(pi: ExtensionAPI): void {
      const state = Effect.runSync(makeState)

      const startSession = (ctx: ExtensionContext): Effect.Effect<void, McpOperationError> =>
        Effect.gen(function* () {
          const generation = yield* Ref.updateAndGet(state.generation, (value) => value + 1)
          const previousManager = yield* Ref.getAndSet(state.manager, Option.none())
          const deferred = yield* Deferred.make<void, McpOperationError>()
          yield* Ref.set(state.initialization, Option.some(deferred))

          yield* Effect.gen(function* () {
            const context = yield* Effect.context()
            if (Option.isSome(previousManager)) {
              yield* callManager(() => previousManager.value.close())
            }
            const config = yield* callManager(() => dependencies.loadConfig())
            const candidate = yield* callManager(() =>
              Promise.resolve(
                dependencies.createManager(config, {
                  callbacks: {
                    onStatusChange: (update) => {
                      if (Effect.runSyncWith(context)(Ref.get(state.generation)) === generation) {
                        updateUiStatus(ctx, update)
                      }
                    },
                  },
                  pi,
                  policy: dependencies.policy ?? unrestrictedMcpPolicy,
                })
              )
            )

            if ((yield* Ref.get(state.generation)) !== generation) {
              yield* callManager(() => candidate.close())
              return
            }
            yield* Ref.set(state.manager, Option.some(candidate))
            const servers = yield* callManager(() => Promise.resolve(candidate.status()))
            updateUiStatus(ctx, servers)
            void Promise.allSettled(servers.filter((server) => server.status === 'disconnected').map((server) => candidate.connect(server.name)))
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
            Option.isSome(current) ? callManager(() => current.value.close()) : Effect.void,
            Effect.gen(function* () {
              yield* Ref.set(state.initialization, Option.none())
              yield* Effect.sync(() => status.clear(ctx))
            })
          )
        })

      pi.registerTool({
        description:
          "Access configured remote MCP capabilities through one lazy gateway. Use Pi's native tools directly whenever possible. Search or describe unfamiliar MCP tools before calling them.",
        async execute(_toolCallId, params, signal) {
          return runtime.runPromise(dispatchGateway(dependencies.configPath, state, params, signal))
        },
        label: 'MCP Gateway',
        name: 'mcp',
        parameters: McpGatewayParameters,
        promptGuidelines: [
          'Use native Pi tools directly. Use mcp only for capabilities supplied by configured remote MCP servers.',
          'MCP servers connect at session start; remote tool schemas stay out of model context until surfaced through this gateway.',
        ],
        promptSnippet: 'Search and call configured remote MCP capabilities on demand',
      })

      pi.registerCommand('mcp-auth', {
        description: 'Authenticate an OAuth-enabled MCP server. Usage: /mcp-auth [server]',
        getArgumentCompletions(prefix) {
          const current = Effect.runSync(Ref.get(state.manager))
          if (Option.isNone(current)) {
            return null
          }
          const items = current.value
            .oauthServers()
            .filter((server) => server.startsWith(prefix))
            .toSorted((left, right) => left.localeCompare(right))
            .map((server) => ({ label: server, value: server }))
          return items.length > 0 ? items : null
        },
        handler: async (args, ctx) => {
          await runtime.runPromise(
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

              yield* callManager(() => manager.authenticate(server))
              ctx.ui.notify(`Authenticated and connected MCP server ${server}.`, 'info')
            }).pipe(
              Effect.catch((error) => {
                ctx.ui.notify(errorMessage(error), 'error')
                return Effect.void
              })
            )
          )
        },
      })

      pi.on('session_start', (_event, ctx) => runtime.runPromise(startSession(ctx)))

      pi.on('session_shutdown', (_event, ctx) => runtime.runPromise(stopSession(ctx)))
    }
)

const globalConfigPath = join(homedir(), '.config', 'mcp', 'mcp.json')

const productionDependencies: McpGatewayDependencies<Awaited<ReturnType<typeof loadGlobalMcpConfig>>> = {
  configPath: globalConfigPath,
  async createManager(config, { callbacks, pi, policy }) {
    /*
     * Keep the manager behind the session lifecycle boundary: importing this entrypoint and
     * registering the gateway must not initialize MCP SDK transports or native OAuth storage.
     */
    const { McpManager: Manager } = await import('./manager.js')
    return new Manager(config, {
      onStatusChange: callbacks.onStatusChange,
      async openUrl(url: string, signal?: AbortSignal) {
        const result = await pi.exec('/usr/bin/open', [url], { signal })
        if (result.code !== 0) {
          throw new Error(`Could not open the OAuth authorization page: ${result.stderr.trim()}`)
        }
      },
      policy,
    })
  },
  loadConfig: loadGlobalMcpConfig,
  policy: mcpPolicyFromEnvironment(),
}

export const register: {
  (runtime: AppRuntime): (pi: ExtensionAPI) => void
  (pi: ExtensionAPI, runtime: AppRuntime): void
} = Function.dual(
  (args) => typeof args[0].on === 'function',
  (pi: ExtensionAPI, runtime: AppRuntime): void => createMcpExtension(productionDependencies, runtime)(pi)
)
