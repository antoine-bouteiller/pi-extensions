import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { matchesKey, ScrollView, Text, type Component } from '@earendil-works/pi-tui'
import { Context, Effect, Layer } from 'effect'

import { AgentActivity, type AppRuntime } from '#shared/effect/app_services'
import { type FeatureActivationError, type FeaturePlugin } from '#shared/effect/feature'
import { makeCommandHandler, makeToolExecutor, runManagedEffect, runManagedRepeatingEffect } from '#shared/effect/runtime'

import { createPanicEditor, createSubagentsOperator } from './operator.js'
import { SubagentOrchestrator } from './orchestrator.js'
import { SubagentStore, SubagentStoreLive } from './store.js'
import { bindProductionNotificationSink, makeDelegationTools, PARENT_GUIDANCE, type DelegationToolDependencies } from './tools.js'

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
  let runtime: AppRuntime | undefined
  let generation = 0
  let session: string | undefined
  return {
    bootstrap: 'eager',
    id: 'sub-agents',
    implementation: {
      activate: (_event, ctx) => {
        if (isSubagent()) {
          return Effect.void
        }
        const sessionId = ctx.sessionManager.getSessionId()
        return Effect.gen(function* () {
          const orchestrator = yield* SubagentOrchestrator
          yield* orchestrator.initialize
          if (pi !== undefined) {
            bindProductionNotificationSink(pi, sessionId, ++generation, ctx)
          }
          yield* orchestrator.openSession(sessionId)
          session = sessionId
          panic = createPanicEditor({
            ctx,
            hasLiveCurrentSession: () => session === ctx.sessionManager.getSessionId(),
            interruptAll: () =>
              runtime === undefined ? Promise.resolve() : runManagedEffect(runtime, orchestrator.interruptAll(sessionId).pipe(Effect.ignore)),
          })
          panic.install()
        }).pipe(Effect.mapError(activationError))
      },
      deactivate: (_ctx, _reason) => {
        const sessionId = session
        panic?.dispose()
        panic = undefined
        session = undefined
        return sessionId === undefined
          ? Effect.void
          : Effect.service(SubagentOrchestrator).pipe(
              Effect.flatMap((orchestrator) => orchestrator.closeSession(sessionId)),
              Effect.ignore,
              Effect.mapError(activationError)
            )
      },
      register: (registeredPi: ExtensionAPI, registeredRuntime?: AppRuntime): void => {
        const toolRuntime = dependencies.runtime ?? registeredRuntime
        if (toolRuntime === undefined) {
          throw new Error('Sub-agent feature requires an application runtime.')
        }
        pi = registeredPi
        runtime = registeredRuntime
        if (isSubagent()) {
          return
        }
        const execute = makeToolExecutor(toolRuntime)
        const [spawn, wait, waitAll, list, read, send, interrupt] = makeDelegationTools({ ...dependencies, pi, runtime: toolRuntime }, execute)
        registeredPi.registerTool(spawn)
        registeredPi.registerTool(wait)
        registeredPi.registerTool(waitAll)
        registeredPi.registerTool(list)
        registeredPi.registerTool(read)
        registeredPi.registerTool(send)
        registeredPi.registerTool(interrupt)
        registeredPi.on('before_agent_start', (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${PARENT_GUIDANCE}` }))
        if (registeredRuntime !== undefined) {
          registeredPi.registerCommand('subagents', {
            description: 'Inspect sub-agent conversations for the current session.',
            handler: makeCommandHandler(registeredRuntime)((_args, ctx) => {
              const operator = createSubagentsOperator({
                activity: registeredRuntime.runSync(Effect.service(AgentActivity)).list,
                sessionId: ctx.sessionManager.getSessionId(),
                store: Context.get(registeredRuntime.runSync(Effect.scoped(Layer.build(SubagentStoreLive))), SubagentStore),
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
                                  const content = transcript.content()
                                  body.setText(
                                    content.unavailable
                                      ? `${title}\nConversation unavailable: session file could not be read.\n[Back]`
                                      : `${title}\n${content.entries.map((entry) => JSON.stringify(entry)).join('\n')}`
                                  )
                                  tui.requestRender()
                                }
                                const stopRefreshing = runManagedRepeatingEffect(
                                  registeredRuntime,
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

const defaultDependencies: SubagentFeatureDependencies = {
  agentDir: `${Bun.env.HOME ?? '/tmp'}/.pi/agent`,
  childModelView: { authenticated_providers: [], models: [] },
  childModelViewFor: (ctx) => {
    const models = ctx.scopedModels.map(({ model }) => ({ contextWindow: model.contextWindow, model: model.id, provider: model.provider }))
    return { authenticated_providers: [...new Set(models.map((model) => model.provider))], models }
  },
  environment: () => process.env,
}

export const feature = makeFeature(defaultDependencies)
