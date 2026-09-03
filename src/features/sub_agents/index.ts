import { getAgentDir, ModelRuntime, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { matchesKey, ScrollView, Text, type Component } from '@earendil-works/pi-tui'
import { Context, Effect, Layer } from 'effect'

import { AgentActivity, type AppRuntime } from '#shared/effect/app_services'
import { type FeatureActivationError, type FeaturePlugin } from '#shared/effect/feature'
import { makeCommandHandler, makeToolExecutor, runManagedEffect, runManagedRepeatingEffect } from '#shared/effect/runtime'

import { toChildModel } from './model.js'
import { createPanicEditor, createSubagentsOperator } from './operator.js'
import { SubagentOrchestrator, type SubagentOrchestratorApi } from './orchestrator.js'
import { getOrCreateSubagentRuntime, type SubagentRuntime } from './runtime.js'
import { SubagentStore, SubagentStoreLive } from './store.js'
import {
  bindProductionNotificationSink,
  clearProductionNotificationSink,
  makeDelegationTools,
  PARENT_GUIDANCE,
  type DelegationToolDependencies,
} from './tools.js'

export interface SubagentFeatureDependencies extends Omit<DelegationToolDependencies, 'pi' | 'runtime'> {
  readonly isSubagent?: () => boolean
  readonly runtime?: DelegationToolDependencies['runtime']
}

type EagerFeaturePlugin = Extract<FeaturePlugin, { readonly bootstrap: 'eager' }>

const activationError = (error: unknown): FeatureActivationError => ({
  _tag: 'SubagentActivationError',
  reason: error instanceof Error ? error.message : String(error),
})

export const makeFeature = (dependencies: SubagentFeatureDependencies) => {
  const isSubagent = dependencies.isSubagent ?? (() => Bun.env.PI_SUBAGENT === '1')
  let pi: ExtensionAPI | undefined
  let panic: ReturnType<typeof createPanicEditor> | undefined
  let orchestrationRuntime: SubagentRuntime | undefined
  let orchestrator: SubagentOrchestratorApi | undefined
  let session: string | undefined
  let notificationBinding: { readonly generation: number; readonly session: string } | undefined
  return {
    bootstrap: 'eager',
    id: 'sub-agents',
    implementation: {
      activate: (_event, ctx) => {
        if (isSubagent()) {
          return Effect.void
        }
        const sessionId = ctx.sessionManager.getSessionId()
        const runtime = orchestrationRuntime
        return runtime === undefined
          ? Effect.fail(activationError(new Error('Sub-agent feature has not been registered.')))
          : Effect.gen(function* () {
              const activeOrchestrator = yield* Effect.tryPromise(() => runManagedEffect(runtime, Effect.service(SubagentOrchestrator)))
              orchestrator = activeOrchestrator
              yield* activeOrchestrator.initialize
              const notificationGeneration = yield* activeOrchestrator.openSession(sessionId)
              session = sessionId
              if (pi !== undefined) {
                bindProductionNotificationSink(pi, sessionId, notificationGeneration, ctx)
                notificationBinding = { generation: notificationGeneration, session: sessionId }
              }
              panic = createPanicEditor({
                ctx,
                hasLiveCurrentSession: () => activeOrchestrator.hasLiveChildren(sessionId),
                interruptAll: () => runManagedEffect(runtime, activeOrchestrator.interruptAll(sessionId).pipe(Effect.ignore)),
              })
              panic.install()
            }).pipe(Effect.mapError(activationError))
      },
      deactivate: (_ctx, _reason) => {
        const sessionId = session
        const binding = notificationBinding
        panic?.dispose()
        panic = undefined
        session = undefined
        notificationBinding = undefined
        const runtime = orchestrationRuntime
        const activeOrchestrator = orchestrator
        const unbind = Effect.sync(() => binding && clearProductionNotificationSink(binding.session, binding.generation))
        return sessionId === undefined || runtime === undefined || activeOrchestrator === undefined
          ? unbind
          : unbind.pipe(
              Effect.andThen(Effect.tryPromise(() => runManagedEffect(runtime, activeOrchestrator.closeSession(sessionId)))),
              Effect.mapError(activationError)
            )
      },
      register: (registeredPi: ExtensionAPI, registeredRuntime?: AppRuntime): void => {
        const toolRuntime = dependencies.runtime ?? (registeredRuntime === undefined ? undefined : getOrCreateSubagentRuntime())
        if (toolRuntime === undefined) {
          throw new Error('Sub-agent feature requires an application runtime.')
        }
        pi = registeredPi
        if (isSubagent()) {
          return
        }
        orchestrationRuntime = toolRuntime
        const execute = makeToolExecutor(toolRuntime)
        const tools = makeDelegationTools({ ...dependencies, pi, runtime: toolRuntime }, execute)

        for (const tool of tools) {
          registeredPi.registerTool(tool)
        }
        registeredPi.on('before_agent_start', (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${PARENT_GUIDANCE}` }))
        if (registeredRuntime !== undefined) {
          const applicationRuntime = registeredRuntime
          registeredPi.registerCommand('subagents', {
            description: 'Inspect sub-agent conversations for the current session.',
            handler: makeCommandHandler(applicationRuntime)((_args, ctx) => {
              const operator = createSubagentsOperator({
                activity: applicationRuntime.runSync(Effect.service(AgentActivity)).list,
                sessionId: ctx.sessionManager.getSessionId(),
                store: Context.get(applicationRuntime.runSync(Effect.scoped(Layer.build(SubagentStoreLive))), SubagentStore),
              })
              return operator.list.pipe(
                Effect.flatMap((rows) =>
                  Effect.promise(() =>
                    ctx.ui.select(
                      'Sub-agents',
                      rows.map((row) => `${row.taskName} (${row.status})`)
                    )
                  ).pipe(
                    Effect.flatMap((selection) => {
                      const index = rows.findIndex((row) => `${row.taskName} (${row.status})` === selection)
                      if (index === -1) {
                        return Effect.void
                      }
                      const row = rows[index]
                      const transcript = operator.open(row.agentId)
                      const title = `${row.taskName} · ${row.status}`
                      return transcript.refresh.pipe(
                        Effect.flatMap(() =>
                          Effect.promise(() =>
                            ctx.ui.custom<void>(
                              (tui, _theme, _keybindings, done) => {
                                const body = new Text()
                                const scroll = new ScrollView(body, { follow: 'end', scrollbar: 'auto' })
                                const render = (): void => {
                                  body.setText(renderTranscriptContent(title, transcript.content()))
                                  tui.requestRender()
                                }
                                const stopRefreshing = runManagedRepeatingEffect(
                                  applicationRuntime,
                                  transcript.refresh.pipe(
                                    Effect.tap(() => Effect.sync(render)),
                                    Effect.ignore
                                  ),
                                  '500 millis'
                                )
                                render()
                                return {
                                  dispose: () => {
                                    stopRefreshing()
                                  },
                                  handleInput: (data) => {
                                    if (data === '\u001b' || data === 'q') {
                                      done()
                                    } else if (matchesKey(data, 'up')) {
                                      scroll.scrollBy(-1)
                                    } else if (matchesKey(data, 'down')) {
                                      scroll.scrollBy(1)
                                    } else if (matchesKey(data, 'pageUp')) {
                                      scroll.scrollBy(-Math.max(1, scroll.viewportHeight - 1))
                                    } else if (matchesKey(data, 'pageDown')) {
                                      scroll.scrollBy(Math.max(1, scroll.viewportHeight - 1))
                                    }
                                  },
                                  invalidate: () => scroll.invalidate(),
                                  render: (width) => scroll.render(width),
                                } satisfies Component & { readonly dispose: () => void }
                              },
                              { overlay: true, overlayOptions: { maxHeight: '80%', width: '80%' } }
                            )
                          )
                        ),
                        Effect.asVoid
                      )
                    })
                  )
                )
              )
            }),
          })
        }
      },
    },
    status: { icon: '🧑‍🤝‍🧑', name: 'sub-agents' },
  } satisfies EagerFeaturePlugin
}

export const renderTranscriptContent = (
  title: string,
  content: { readonly entries: readonly unknown[]; readonly turns: readonly { readonly result: unknown }[]; readonly unavailable: boolean }
): string => {
  if (content.unavailable) {
    return `${title}\nConversation unavailable: session file could not be read.\n[Back]`
  }
  const transcript = content.entries.map((entry) => JSON.stringify(entry))
  const turns = content.turns.map(({ result }) => JSON.stringify(result))
  return [title, ...transcript, ...(turns.length === 0 ? [] : ['Durable turn outcomes:', ...turns])].join('\n')
}

const defaultDependencies: SubagentFeatureDependencies = {
  agentDir: getAgentDir(),
  childModelView: { authenticated_providers: [], models: [] },
  childModelViewFor: (_ctx, environment) => {
    const agentDir = getAgentDir()
    const childEnvironment = Object.fromEntries(Object.entries(environment).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])))
    return ModelRuntime.create({ authPath: `${agentDir}/auth.json`, modelsPath: `${agentDir}/models.json` }).then((runtime) => {
      const models = runtime.getAvailableSnapshot()
      return Promise.all(
        [...new Set(models.map((model) => model.provider))].map((provider) =>
          runtime.getAuth(provider, { env: childEnvironment }).then((auth) => ({ authenticated: auth !== undefined, provider }))
        )
      ).then((authenticated) => ({
        authenticated_providers: authenticated.flatMap(({ authenticated: configured, provider }) => (configured ? [provider] : [])),
        models: models.map(toChildModel),
      }))
    })
  },
  environment: () => process.env,
}

export const feature = makeFeature(defaultDependencies)
