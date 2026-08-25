import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Effect } from 'effect'

import { type AppRuntime } from '#shared/effect/app_services'
import { type FeaturePlugin } from '#shared/effect/feature'
import { makeCommandHandler, makeToolExecutor } from '#shared/effect/runtime'

import { makeGatewaySession, makeMcpGateway, McpGateway, McpGatewayParameters, type McpGatewayApi } from './gateway.js'

type EagerFeaturePlugin = Extract<FeaturePlugin, { readonly bootstrap: 'eager' }>
export type McpGatewayFactory = () => McpGatewayApi

export const makeFeature = (makeGateway: McpGatewayFactory = makeMcpGateway) => {
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
        const currentSession = makeGatewaySession(pi)
        session = currentSession

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
            'MCP servers connect at session start; remote tool schemas stay out of model context until surfaced through this gateway.',
          ],
          promptSnippet: 'Search and call configured remote MCP capabilities on demand',
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
  } satisfies EagerFeaturePlugin
}

export const feature = makeFeature()
