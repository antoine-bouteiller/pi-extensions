import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { type ManagedRuntime } from 'effect'

import { type AppServices } from '#shared/effect/app_services'

import { makeGatewaySession, McpGatewayParameters, type McpGateway } from './gateway.js'

type McpRuntime = ManagedRuntime.ManagedRuntime<AppServices | McpGateway, never>

export const register = (pi: ExtensionAPI, runtime: McpRuntime): void => {
  const session = makeGatewaySession(pi)

  pi.registerTool({
    description:
      "Access configured remote MCP capabilities through one lazy gateway. Use Pi's native tools directly whenever possible. Search or describe unfamiliar MCP tools before calling them.",
    /*
     * The signal reaches `runPromise` as well as the manager: without it a cancelled call can
     * still block indefinitely on paths that never touch a manager operation, such as waiting
     * for gateway initialization or spilling oversized output.
     */
    execute: async (_toolCallId, params, signal) =>
      runtime.runPromise(session.dispatch(params, signal ?? undefined), signal === null ? undefined : { signal }),
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
