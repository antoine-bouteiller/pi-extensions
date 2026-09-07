import { getAgentDir, ModelRuntime, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Context, Effect, Layer } from 'effect'

import { AgentActivity, type AppRuntime } from '#shared/effect/app_services'
import { type EnvApi, processEnvironment } from '#shared/effect/env'
import { type FeatureActivationError, type FeatureOptions, type FeaturePlugin } from '#shared/effect/feature'
import { makeCommandHandler, makeEventHandler, makeToolExecutor, runManagedEffect, runManagedRepeatingEffect } from '#shared/effect/runtime'

import { PROFILE_ORDER, PROFILE_REGISTRY, resolveProfileWithRegistry, type ProfileKey, type ProfileResolution, toChildModel } from './model.js'
import { createPanicEditor, createSubagentsOperator } from './operator.js'
import { SubagentOrchestrator, type SubagentOrchestratorApi } from './orchestrator.js'
import { getOrCreateSubagentRuntime, type SubagentRuntime } from './runtime.js'
import { loadSubagentSettings } from './settings.js'
import { SubagentStore, SubagentStoreLive } from './store.js'
import {
  admission,
  bindProductionNotificationSink,
  isChildModelViewResolutionTimeoutError,
  clearProductionNotificationSink,
  makeDelegationTools,
  PARENT_GUIDANCE,
  type DelegationToolDependencies,
} from './tools.js'
import { createTranscriptOverlay } from './transcript.js'

interface SubagentFeatureDependencies extends Omit<DelegationToolDependencies, 'pi' | 'runtime'> {
  readonly isSubagent?: () => boolean
  readonly runtime?: DelegationToolDependencies['runtime']
}

const hasMessage = (value: unknown): value is { readonly message: string } =>
  typeof value === 'object' && value !== null && 'message' in value && typeof value.message === 'string'

const activationError = (error: unknown): FeatureActivationError => ({
  _tag: 'SubagentActivationError',
  reason: hasMessage(error) ? error.message : String(error),
})
const failureMessage = (error: unknown): string => {
  const cause = typeof error === 'object' && error !== null && 'cause' in error ? error.cause : error
  if (hasMessage(cause)) {
    return cause.message
  }
  if (hasMessage(error)) {
    return error.message
  }
  return String(error)
}
const DELEGATION_TOOL_NAMES = [
  'spawn_agent',
  'wait_agent',
  'wait_all_agents',
  'list_agents',
  'read_agent_response',
  'send_message',
  'interrupt_agent',
] as const
const isDelegationToolName = (name: string): boolean => DELEGATION_TOOL_NAMES.some((candidate) => candidate === name)
const truncate = (text: string, maximumLength: number): string => {
  if (text.length <= maximumLength) {
    return text
  }
  return maximumLength <= 1 ? text.slice(0, maximumLength) : `${text.slice(0, maximumLength - 1)}…`
}
const preflightNotice = (unresolved: readonly (readonly [ProfileKey, Extract<ProfileResolution, { readonly ok: false }>['error']])[]): string => {
  const heading = 'Sub-agent profiles unavailable (configuration resolution only; provider reachability and child extension loading are not checked):'
  const prefixes = unresolved.map(([key, error]) => `${key}: ${error.code} — `)
  const separatorLength = unresolved.length
  const messageBudget = Math.max(0, 4096 - heading.length - separatorLength - prefixes.reduce((total, prefix) => total + prefix.length, 0))
  const messageShare = Math.floor(messageBudget / unresolved.length)
  return [heading, ...unresolved.map(([, error], index) => `${prefixes[index]}${truncate(error.message, messageShare)}`)].join('\n')
}

export const feature = ((options: FeatureOptions<SubagentFeatureDependencies> = {}) => {
  const environment = options.environment ?? processEnvironment
  const dependencies = options.dependencies ?? defaultDependencies(environment)
  const isSubagent = dependencies.isSubagent ?? (() => environment.get('PI_SUBAGENT') === '1')
  const toolDependencies = { ...dependencies, subagents: dependencies.subagents ?? {} }
  const loadSettings = (ctx: ExtensionContext) =>
    dependencies.subagents === undefined
      ? loadSubagentSettings({ agentDir: dependencies.agentDir, cwd: ctx.cwd, model: ctx.model, projectTrusted: ctx.isProjectTrusted() }).pipe(
          Effect.tap((settings) =>
            Effect.sync(() => {
              toolDependencies.subagents = settings
            })
          ),
          Effect.asVoid
        )
      : Effect.void
  let pi: ExtensionAPI | undefined
  let panic: ReturnType<typeof createPanicEditor> | undefined
  let orchestrationRuntime: SubagentRuntime | undefined
  let orchestrator: SubagentOrchestratorApi | undefined
  let session: string | undefined
  let notificationBinding: { readonly generation: number; readonly session: string } | undefined
  let delegationToolsEnabled = false
  let delegationToolsRegistered = false
  let registeredProfileKeys: readonly ProfileKey[] = []
  let lastPreflight: string | undefined
  let registerDelegationTools: ((keys: readonly ProfileKey[]) => void) | undefined
  const preflight = (ctx: ExtensionContext) => {
    const activePi = pi
    if (activePi === undefined) {
      return Effect.fail({ _tag: 'SubagentRegistrationError', message: 'Sub-agent feature has not been registered.' })
    }
    return admission(ctx, Object.assign(toolDependencies, { pi: activePi })).pipe(
      Effect.map((snapshot) => PROFILE_ORDER.map((key) => [key, resolveProfileWithRegistry(key, snapshot, PROFILE_REGISTRY)] as const)),
      Effect.catch((error) => {
        const cause = typeof error === 'object' && error !== null && 'cause' in error ? error.cause : error
        const message = failureMessage(error)
        const code = isChildModelViewResolutionTimeoutError(cause) ? 'startup_timeout' : 'missing_model'
        return Effect.succeed(PROFILE_ORDER.map((key) => [key, { error: { code, message }, ok: false } satisfies ProfileResolution] as const))
      }),
      Effect.tap((results) =>
        Effect.sync(() => {
          const resolved = results.flatMap(([key, resolution]) => (resolution.ok ? [key] : []))
          const unresolved = results.flatMap(([key, resolution]) => (resolution.ok ? [] : [[key, resolution.error] as const]))
          const signature = results
            .map(([key, resolution]) => (resolution.ok ? `${key}:ok` : `${key}:${resolution.error.code}:${resolution.error.message}`))
            .join('\n')
          if (resolved.length > 0 && registerDelegationTools !== undefined) {
            registerDelegationTools(resolved)
          } else if (resolved.length === 0 && delegationToolsEnabled) {
            activePi.setActiveTools(activePi.getActiveTools().filter((name) => !isDelegationToolName(name)))
            delegationToolsEnabled = false
          }
          if (unresolved.length === 0) {
            lastPreflight = signature
          } else if (lastPreflight !== signature) {
            activePi.sendMessage({ content: preflightNotice(unresolved), customType: 'subagent-preflight', display: true }, { triggerTurn: false })
            lastPreflight = signature
          }
        })
      ),
      Effect.asVoid
    )
  }
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
          ? Effect.fail(activationError({ _tag: 'SubagentRegistrationError', message: 'Sub-agent feature has not been registered.' }))
          : Effect.gen(function* () {
              yield* loadSettings(ctx)
              yield* preflight(ctx)
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
        if (pi !== registeredPi) {
          delegationToolsEnabled = false
          delegationToolsRegistered = false
          registeredProfileKeys = []
          lastPreflight = undefined
        }
        pi = registeredPi
        if (isSubagent()) {
          return
        }
        orchestrationRuntime = toolRuntime
        const execute = makeToolExecutor(toolRuntime)
        registerDelegationTools = (keys) => {
          const changed = keys.join(',') !== registeredProfileKeys.join(',')
          if (!changed && delegationToolsRegistered) {
            registeredPi.setActiveTools([...new Set([...registeredPi.getActiveTools(), ...DELEGATION_TOOL_NAMES])])
            delegationToolsEnabled = true
            return
          }
          const [spawn, ...rest] = makeDelegationTools(Object.assign(toolDependencies, { pi: registeredPi, runtime: toolRuntime }), execute, keys)
          registeredPi.registerTool(spawn)
          if (!delegationToolsRegistered) {
            for (const tool of rest) {
              registeredPi.registerTool(tool)
            }
            registeredPi.on('before_agent_start', (event) =>
              delegationToolsEnabled ? { systemPrompt: `${event.systemPrompt}\n\n${PARENT_GUIDANCE}` } : { systemPrompt: event.systemPrompt }
            )
            delegationToolsRegistered = true
          }
          registeredPi.setActiveTools([...new Set([...registeredPi.getActiveTools(), ...DELEGATION_TOOL_NAMES])])
          delegationToolsEnabled = true
          registeredProfileKeys = [...keys]
        }
        if (registeredRuntime !== undefined) {
          const applicationRuntime = registeredRuntime
          registeredPi.on(
            'model_select',
            makeEventHandler(applicationRuntime)((_event, ctx) => loadSettings(ctx).pipe(Effect.andThen(preflight(ctx))))
          )
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
                              (tui, theme, keybindings, done) => {
                                const overlay = createTranscriptOverlay({
                                  content: transcript.content,
                                  cwd: ctx.cwd,
                                  expanded: ctx.ui.getToolsExpanded(),
                                  keybindings,
                                  onClose: done,
                                  theme,
                                  title,
                                  tui,
                                })
                                const stopRefreshing = runManagedRepeatingEffect(
                                  applicationRuntime,
                                  transcript.refresh.pipe(
                                    Effect.tap(() => Effect.sync(overlay.refresh)),
                                    Effect.ignore
                                  ),
                                  '500 millis'
                                )
                                overlay.refresh()
                                return { ...overlay, dispose: stopRefreshing }
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
    suppressInChild: true,
  }
}) satisfies FeaturePlugin<SubagentFeatureDependencies>

const defaultDependencies = (env: EnvApi): SubagentFeatureDependencies => ({
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
  environment: () => env.all,
})
