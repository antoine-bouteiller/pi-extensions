import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Effect } from 'effect'
import { Type } from 'typebox'

import { type AppRuntime } from '#shared/effect/app_services'
import { type FeatureDescriptor, type FeatureOptions, type FeaturePlugin } from '#shared/effect/feature'
import { makeCommandHandler, makeToolExecutor } from '#shared/effect/runtime'
import { type JsonObject } from '#shared/utils/json'
import { isRecord } from '#shared/utils/records'

import {
  makeGatewaySession,
  makeMcpGateway,
  McpGateway,
  McpGatewayParameters,
  renderMcpCall,
  renderMcpResult,
  type McpGatewayApi,
} from './gateway.js'

type EagerFeaturePlugin = Extract<FeatureDescriptor, { readonly bootstrap: 'eager' }>
type McpGatewayFactory = () => McpGatewayApi

export const feature = ((options: FeatureOptions<McpGatewayFactory> = {}) => {
  const makeGateway = options.dependencies ?? makeMcpGateway
  // Feature ownership deliberately creates exactly one gateway for this enabled process.
  const gateway = makeGateway()
  let session: ReturnType<typeof makeGatewaySession> | undefined

  const provideGateway = <Value, Error, Requirements>(effect: Effect.Effect<Value, Error, Requirements | McpGateway>) =>
    effect.pipe(Effect.provideService(McpGateway, gateway))

  const activate = (_event: unknown, ctx: Parameters<NonNullable<EagerFeaturePlugin['implementation']['activate']>>[1]) =>
    session === undefined ? Effect.void : provideGateway(session.start(ctx))

  const deactivate = (ctx: Parameters<NonNullable<EagerFeaturePlugin['implementation']['deactivate']>>[0], _reason: 'shutdown' | 'replaced') =>
    session === undefined ? Effect.void : provideGateway(session.stop(ctx))

  return {
    bootstrap: 'eager',
    id: 'mcp',
    implementation: {
      activate,
      deactivate,
      register: (pi: ExtensionAPI, runtime: AppRuntime): void => {
        const currentSession = makeGatewaySession(pi, (tool, server) => {
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(tool.name)) {
            throw new Error(`MCP tool ${tool.name} needs a provider-compatible name of at most 64 characters`)
          }
          if (!isRecord(tool.inputSchema) || tool.inputSchema.type !== 'object') {
            throw new Error(`MCP tool ${tool.name} has no object input schema`)
          }
          pi.registerTool({
            description: tool.description ?? `Call ${tool.name} on MCP server ${server}.`,
            execute: makeToolExecutor(runtime)(({ params, signal }) =>
              provideGateway(currentSession.dispatch({ args: params, server, tool: tool.name }, signal))
            ),
            label: tool.name,
            name: tool.name,
            parameters: Type.Unsafe<JsonObject>(tool.inputSchema),
            renderCall: (params, theme) => renderMcpCall({ args: params, server, tool: tool.name }, theme),
            renderResult: renderMcpResult,
          })
        })
        session = currentSession

        pi.on('before_agent_start', (event) => {
          const inventory = currentSession.serverInventory()
          return inventory.length === 0 ? undefined : { systemPrompt: `${event.systemPrompt}\n\n${inventory}` }
        })

        pi.registerTool({
          description:
            "Access configured remote MCP capabilities through one lazy gateway. Use Pi's native tools directly whenever possible. Search or describe unfamiliar MCP tools before calling them.",
          /*
           * Interruption stays enabled -- unlike the cooperative tools -- because a cancelled call can
           * otherwise block indefinitely on paths that never touch a manager operation, such as waiting
           * for gateway initialization or spilling oversized output.
           */
          execute: makeToolExecutor(runtime)(({ params, signal }) => provideGateway(currentSession.dispatch(params, signal))),
          label: 'MCP Gateway',
          name: 'mcp',
          parameters: McpGatewayParameters,
          promptGuidelines: [
            'Use native Pi tools directly. Use mcp only for capabilities supplied by configured remote MCP servers.',
            'Only MCP tools selected by mcp.directTools in Pi settings.json are loaded up front; use mcp to search, list, describe, and call the others on demand.',
          ],
          promptSnippet: 'Search and call configured remote MCP capabilities on demand',
          renderCall: renderMcpCall,
          renderResult: renderMcpResult,
        })

        pi.registerCommand('mcp-auth', {
          description: 'Authenticate an OAuth-enabled MCP server. Usage: /mcp-auth [server]',
          getArgumentCompletions: (prefix) => {
            const items = currentSession.oauthCompletions(prefix)
            return items.length > 0 ? items : null
          },
          handler: makeCommandHandler(runtime)((args, ctx) => provideGateway(currentSession.authenticate(args, ctx))),
        })
      },
    },
    status: { icon: '🔌', name: 'mcp' },
  }
}) satisfies FeaturePlugin<McpGatewayFactory>
