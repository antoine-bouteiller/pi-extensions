import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Function } from 'effect'

import { type AppRuntime } from '@/shared/effect/app_services.js'

import { makeGatewaySession, McpGatewayParameters, productionDependencies, type McpGatewayDependencies } from './gateway.js'

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
      const session = makeGatewaySession({ dependencies, pi })

      pi.registerTool({
        description:
          "Access configured remote MCP capabilities through one lazy gateway. Use Pi's native tools directly whenever possible. Search or describe unfamiliar MCP tools before calling them.",
        execute: async (_toolCallId, params, signal) => runtime.runPromise(session.dispatch(params, signal ?? undefined)),
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
        getArgumentCompletions: (prefix) => {
          const items = session.oauthCompletions(prefix)
          return items.length > 0 ? items : null
        },
        handler: async (args, ctx) => runtime.runPromise(session.authenticate(args, ctx)),
      })

      pi.on('session_start', (_event, ctx) => runtime.runPromise(session.start(ctx)))
      pi.on('session_shutdown', (_event, ctx) => runtime.runPromise(session.stop(ctx)))
    }
)

export const register: {
  (runtime: AppRuntime): (pi: ExtensionAPI) => void
  (pi: ExtensionAPI, runtime: AppRuntime): void
} = Function.dual(
  (args) => typeof args[0].on === 'function',
  (pi: ExtensionAPI, runtime: AppRuntime): void => createMcpExtension(productionDependencies, runtime)(pi)
)
