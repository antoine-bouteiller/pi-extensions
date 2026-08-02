import { homedir } from 'node:os'
import { join } from 'node:path'

import { type AgentToolResult, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { createStatusChannel } from '../shared/status_bar.js'
import { loadGlobalMcpConfig } from './config.js'
import { boundGatewayOutput } from './output.js'
import { type McpGatewayPolicy, type McpPolicyRequest, type McpToolAnnotations } from './types.js'

export type { McpGatewayPolicy, McpPolicyOperation, McpPolicyRequest, McpToolAnnotations } from './types.js'

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
    if (request.annotations.readOnlyHint === true && request.annotations.destructiveHint !== true) {
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

export interface McpServerStatus {
  name: string
  status: 'disconnected' | 'connecting' | 'connected' | 'needs-auth' | 'failed' | 'disabled'
  error?: string
}

export interface McpToolSummary {
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

export type McpStatusUpdate = number | readonly McpServerStatus[]

export interface McpManagerCallbacks {
  onStatusChange: (update: McpStatusUpdate) => void
}

export interface McpManagerContext {
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
      ...(details && typeof details === 'object' ? details : {}),
      outputTruncated: bounded.details.truncated,
      ...(bounded.details.fullOutputPath ? { fullOutputPath: bounded.details.fullOutputPath } : {}),
    },
  }
}

const parseArgs = (args: unknown): Record<string, unknown> => {
  let parsed = args
  if (typeof args === 'string') {
    try {
      parsed = JSON.parse(args) as unknown
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`mcp args must be valid JSON: ${reason}`, { cause: error })
    }
  }

  if (parsed === undefined) {
    return {}
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('mcp args must be a JSON object, not an array, scalar, or null')
  }
  return parsed as Record<string, unknown>
}

const compareNames = (left: { name: string }, right: { name: string }): number => left.name.localeCompare(right.name)

const compactDescription = (description: string | undefined): string => {
  if (!description) {
    return ''
  }
  const singleLine = description.replaceAll(/\s+/g, ' ').trim()
  return singleLine.length <= 160 ? singleLine : `${singleLine.slice(0, 157)}...`
}

const formatAnnotations = (annotations: McpToolAnnotations | undefined): string => {
  if (!annotations) {
    return ''
  }
  const hints = [
    annotations.readOnlyHint === true ? 'read-only' : undefined,
    annotations.readOnlyHint === false ? 'not read-only' : undefined,
    annotations.destructiveHint === true ? 'destructive' : undefined,
    annotations.destructiveHint === false ? 'non-destructive' : undefined,
    annotations.idempotentHint === true ? 'idempotent' : undefined,
    annotations.openWorldHint === true ? 'open-world' : undefined,
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
      return `- ${tool.name}${formatAnnotations(tool.annotations)}${description ? ` — ${description}` : ''}`
    }),
    '',
    'Call with: mcp({ tool: "<tool-name>", args: { ... } })',
  ].join('\n')
}

const connectedCount = (update: McpStatusUpdate): number =>
  typeof update === 'number' ? update : update.filter((server) => server.status === 'connected').length

const updateUiStatus = (ctx: ExtensionContext, update: McpStatusUpdate): void => {
  const count = connectedCount(update)
  if (count > 0) {
    status.set(ctx, { text: `MCP: ${count} connected` })
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
}): void => {
  const selectors = [
    params.tool === undefined ? undefined : 'tool',
    params.connect === undefined ? undefined : 'connect',
    params.describe === undefined ? undefined : 'describe',
    params.search === undefined ? undefined : 'search',
  ].filter((selector): selector is string => selector !== undefined)

  if (selectors.length > 1) {
    throw new Error(`Ambiguous mcp request: choose only one of ${selectors.join(', ')}`)
  }
  if (params.connect !== undefined && params.server !== undefined) {
    throw new Error('Ambiguous mcp request: connect already names the server; omit server')
  }
  if (params.args !== undefined && params.tool === undefined) {
    throw new Error('mcp args can only be used with tool')
  }
  if (params.regex !== undefined && params.search === undefined) {
    throw new Error('mcp regex can only be used with search')
  }
}

/** Build the extension with injectable config and manager dependencies for isolated tests. */
export const createMcpExtension = <TConfig>(dependencies: McpGatewayDependencies<TConfig>) =>
  function mcpGateway(pi: ExtensionAPI): void {
    let manager: McpGatewayManager | undefined
    let initialization: Promise<void> | undefined
    let lifecycleGeneration = 0

    const requireManager = async (): Promise<McpGatewayManager> => {
      if (initialization) {
        await initialization
      }
      if (!manager) {
        throw new Error('MCP is not initialized. Start or reload the Pi session and try again.')
      }
      return manager
    }

    pi.registerTool({
      description:
        "Access configured remote MCP capabilities through one lazy gateway. Use Pi's native tools directly whenever possible. Search or describe unfamiliar MCP tools before calling them.",
      async execute(_toolCallId, params, signal) {
        validateSelectors(params)
        const activeManager = await requireManager()

        if (params.tool !== undefined) {
          return activeManager.call(params.tool, parseArgs(params.args), {
            server: params.server,
            signal,
          })
        }

        if (params.connect !== undefined) {
          await activeManager.connect(params.connect, { signal })
          return textResult(`Connected MCP server ${params.connect}.\nList tools with: mcp({ server: ${JSON.stringify(params.connect)} })`, {
            server: params.connect,
          })
        }

        if (params.describe !== undefined) {
          const description = await activeManager.describe(params.describe, {
            server: params.server,
            signal,
          })
          const summary = compactDescription(description.description)
          const lines = [
            `${description.name}${formatAnnotations(description.annotations)}`,
            ...(description.server ? [`Server: ${description.server}`] : []),
            ...(summary ? [summary] : []),
            `Input schema: ${JSON.stringify(description.inputSchema ?? {})}`,
            `Call with: mcp({ tool: ${JSON.stringify(description.name)}, args: { ... } })`,
          ]
          return textResult(lines.join('\n'), {
            annotations: description.annotations,
            server: description.server,
            tool: description.name,
          })
        }

        if (params.search !== undefined) {
          const matches = await activeManager.search(params.search, {
            limit: SEARCH_FETCH_LIMIT,
            regex: params.regex ?? false,
            server: params.server,
            signal,
          })
          const capped = [...matches].toSorted(compareNames).slice(0, SEARCH_RESULT_LIMIT)
          return textResult(formatTools(capped, `MCP search results (${capped.length}):`), {
            query: params.search,
            regex: params.regex ?? false,
            resultsTruncated: matches.length > capped.length,
            server: params.server,
            tools: capped.map((tool) => ({
              annotations: tool.annotations,
              name: tool.name,
              server: tool.server,
            })),
          })
        }

        if (params.server !== undefined) {
          const tools = await activeManager.list(params.server, { signal })
          const sorted = [...tools].toSorted(compareNames)
          const capped = sorted.slice(0, LIST_RESULT_LIMIT)
          return textResult(formatTools(capped, `MCP tools on ${params.server} (${capped.length} of ${sorted.length}):`), {
            resultsTruncated: sorted.length > capped.length,
            server: params.server,
            tools: capped.map((tool) => ({
              annotations: tool.annotations,
              name: tool.name,
              server: tool.server,
            })),
          })
        }

        const servers = [...(await activeManager.status())].toSorted(compareNames)
        const lines = [
          `MCP config: ${dependencies.configPath}`,
          ...(servers.length === 0
            ? ['(no configured servers)']
            : servers.map((server) => `- ${server.name}: ${server.status}${server.error ? ` — ${server.error}` : ''}`)),
          '',
          'List one server with: mcp({ server: "<server-name>" })',
        ]
        return textResult(lines.join('\n'), {
          configPath: dependencies.configPath,
          resultsTruncated: servers.length > 30,
          serverCount: servers.length,
          servers: servers.slice(0, 30).map((server) => ({
            name: server.name.slice(0, 128),
            status: server.status,
          })),
        })
      },
      label: 'MCP Gateway',
      name: 'mcp',
      parameters: McpGatewayParameters,
      promptGuidelines: [
        'Use native Pi tools directly. Use mcp only for capabilities supplied by configured remote MCP servers.',
        'Search and describe unfamiliar MCP tools before calling them; MCP servers connect lazily only when requested.',
      ],
      promptSnippet: 'Search and call configured remote MCP capabilities on demand',
    })

    pi.registerCommand('mcp-auth', {
      description: 'Authenticate an OAuth-enabled MCP server. Usage: /mcp-auth [server]',
      getArgumentCompletions(prefix) {
        if (!manager) {
          return null
        }
        const items = manager
          .oauthServers()
          .filter((server) => server.startsWith(prefix))
          .toSorted((left, right) => left.localeCompare(right))
          .map((server) => ({ label: server, value: server }))
        return items.length > 0 ? items : null
      },
      handler: async (args, ctx) => {
        try {
          const activeManager = await requireManager()
          let server = args.trim()
          if (!server) {
            const servers = [...activeManager.oauthServers()].toSorted((left, right) => left.localeCompare(right))
            if (servers.length === 0) {
              ctx.ui.notify('No OAuth-enabled MCP servers are configured.', 'error')
              return
            }
            const [onlyServer] = servers
            if (servers.length === 1 && onlyServer) {
              server = onlyServer
            } else {
              const selected = await ctx.ui.select('Authenticate MCP server', servers)
              if (!selected) {
                return
              }
              server = selected
            }
          }

          await activeManager.authenticate(server)
          ctx.ui.notify(`Authenticated and connected MCP server ${server}.`, 'info')
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          ctx.ui.notify(reason, 'error')
        }
      },
    })

    pi.on('session_start', (_event, ctx) => {
      const generation = ++lifecycleGeneration
      const previousManager = manager
      manager = undefined

      const start = async () => {
        if (previousManager) {
          await previousManager.close()
        }
        const config = await dependencies.loadConfig()
        const candidate = await dependencies.createManager(config, {
          callbacks: {
            onStatusChange: (update) => {
              if (generation === lifecycleGeneration) {
                updateUiStatus(ctx, update)
              }
            },
          },
          pi,
          policy: dependencies.policy ?? unrestrictedMcpPolicy,
        })

        if (generation !== lifecycleGeneration) {
          await candidate.close()
          return
        }
        manager = candidate
      }

      initialization = start()
      return initialization
    })

    pi.on('session_shutdown', async (_event, ctx) => {
      ++lifecycleGeneration
      try {
        await initialization?.catch(() => undefined)
        const activeManager = manager
        manager = undefined
        if (activeManager) {
          await activeManager.close()
        }
      } finally {
        initialization = undefined
        status.clear(ctx)
      }
    })
  }

const globalConfigPath = join(homedir(), '.config', 'mcp', 'mcp.json')

const productionDependencies: McpGatewayDependencies<Awaited<ReturnType<typeof loadGlobalMcpConfig>>> = {
  configPath: globalConfigPath,
  async createManager(config, { callbacks, pi, policy }) {
    /*
     * Keep the manager behind the session lifecycle boundary: importing this entrypoint and
     * registering the gateway must not initialize MCP SDK transports or native OAuth storage.
     */
    const managerModulePath = './manager.js'
    const { McpManager: Manager } = (await import(managerModulePath)) as {
      McpManager: new (
        loadedConfig: Awaited<ReturnType<typeof loadGlobalMcpConfig>>,
        options: {
          onStatusChange: (update: McpStatusUpdate) => void
          openUrl: (url: string, signal?: AbortSignal) => Promise<void>
          policy: McpGatewayPolicy
        }
      ) => McpGatewayManager
    }
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

export default createMcpExtension(productionDependencies)
