import { afterEach, beforeEach } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { tmpdir, userInfo } from 'node:os'

import { promiseFromEffect, describe, expect, it } from '@tests/utils/bun_effect.js'
import { asExtensionContext, asFooterDataProvider, asNarrowed } from '@tests/utils/casts.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { withProcessEnv } from '@tests/utils/process_env.js'
import { runtime } from '@tests/utils/runtime.js'
import { Effect, Exit, FileSystem, Layer, Scope } from 'effect'
import { TestClock } from 'effect/testing'
import { FetchHttpClient } from 'effect/unstable/http'

import { join } from '#shared/utils/path'
import { feature, makeFeature } from '@/features/status_panel/index.js'
import { makePanelController } from '@/features/status_panel/panel.js'
import { columns, formatTokens, progressBar } from '@/features/status_panel/render.js'
import { emptyGitInfoState, emptyModelInfoState } from '@/features/status_panel/state.js'
import { AgentActivityLive, StatusBarLive } from '@/shared/effect/app_services.js'
import { runningAgents } from '@/shared/state/agent_activity.js'
import { azureQuota, consumeSubagentAzureQuota, writeSubagentAzureQuota } from '@/shared/state/azure_quota.js'

beforeEach(() => azureQuota.set(undefined))

afterEach(() => {
  runningAgents.publish([])
  azureQuota.set(undefined)
})

const inMainSession = <Success, Failure, Requirements>(
  use: () => Effect.Effect<Success, Failure, Requirements>
): Effect.Effect<Success, Failure, Requirements> => withProcessEnv('PI_SUBAGENT_OWNER_TOKEN', undefined, use)

type PanelImplementation = typeof feature.implementation

const GIT_READS_PER_REFRESH = 3

/** Real event-loop turns: the git fibers await host promises, which virtual time cannot advance. */
const settle = (until: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 50 && !until(); attempt += 1) {
      yield* Effect.promise(() => Bun.sleep(1))
    }
  })

/** Stands in for the feature coordinator, which owns one closeable scope per activated session. */
const sessionScopes: Scope.Closeable[] = []

const activateSession = (implementation: PanelImplementation, ctx: unknown, reason: 'startup' | 'resume' = 'startup'): Effect.Effect<void> =>
  Effect.promise(() => {
    const scope = Scope.makeUnsafe()
    sessionScopes.push(scope)
    return runtime.runPromise(
      (implementation.activate?.({ reason, type: 'session_start' }, asExtensionContext(ctx)) ?? Effect.void).pipe(
        Effect.provideService(Scope.Scope, scope)
      )
    )
  })

const deactivateSession = (implementation: PanelImplementation, ctx: unknown, reason: 'shutdown' | 'replaced' = 'shutdown'): Effect.Effect<void> =>
  Effect.promise(() =>
    runtime.runPromise(implementation.deactivate?.(asExtensionContext(ctx), reason) ?? Effect.void).then(() => {
      const scope = sessionScopes.pop()
      return scope === undefined ? undefined : runtime.runPromise(Scope.close(scope, Exit.void))
    })
  )

describe('status panel registration', () => {
  it.effect('registers only Azure response forwarding in a subagent', () => {
    const ownerToken = '11111111-1111-4111-8111-111111111111'
    return withProcessEnv('PI_SUBAGENT_OWNER_TOKEN', ownerToken, () =>
      Effect.gen(function* () {
        const { pi, state, emit } = createFakePi()
        let dependencyReads = 0
        const dependencies = {
          get fetchAnthropicQuota() {
            dependencyReads += 1
            return () => Effect.void.pipe(Effect.as(undefined))
          },
        }

        makeFeature(dependencies).implementation.register(pi, runtime)
        yield* Effect.promise(() =>
          emit(
            'after_provider_response',
            { headers: { 'x-ratelimit-limit-tokens': '1000', 'x-ratelimit-remaining-tokens': '250' } },
            { model: { provider: 'azure-openai-responses' } }
          )
        )

        expect(dependencyReads).toBe(0)
        expect([...state.handlers.keys()]).toEqual(['after_provider_response'])
        expect(yield* consumeSubagentAzureQuota(ownerToken)).toBe(75)
      })
    )
  })

  it.effect('claims a quota handoff once across concurrent consumers', () => {
    const temporaryRoot = process.env.PI_SUBAGENT_TEMP_DIR || tmpdir()
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const token = randomUUID()
      yield* writeSubagentAzureQuota(token, 150)
      const directory = join(temporaryRoot, 'pi-codex-subagents', userInfo().username, 'quota')
      const target = join(directory, `${token}.json`)
      if (process.platform !== 'win32') {
        expect((yield* fs.stat(directory)).mode & 0o777).toBe(0o700)
        expect((yield* fs.stat(target)).mode & 0o777).toBe(0o600)
      }
      expect((yield* fs.readDirectory(directory)).some((name) => name.includes('.tmp'))).toBe(false)
      const claimed = yield* Effect.all([consumeSubagentAzureQuota(token), consumeSubagentAzureQuota(token)], { concurrency: 2 })
      expect(claimed.filter((value) => value === 100)).toHaveLength(1)
      expect(claimed.filter((value) => value === undefined)).toHaveLength(1)
      expect(yield* consumeSubagentAzureQuota(token)).toBeUndefined()
      expect(yield* consumeSubagentAzureQuota('invalid')).toBeUndefined()
    })
  })

  it.effect('treats a corrupt quota handoff as absent instead of failing', () => {
    const temporaryRoot = process.env.PI_SUBAGENT_TEMP_DIR || tmpdir()
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const token = randomUUID()
      const directory = join(temporaryRoot, 'pi-codex-subagents', userInfo().username, 'quota')
      yield* fs.makeDirectory(directory, { recursive: true })
      yield* fs.writeFileString(join(directory, `${token}.json`), '{ not json')

      expect(yield* consumeSubagentAzureQuota(token)).toBeUndefined()
      expect((yield* fs.readDirectory(directory)).some((name) => name.startsWith(token))).toBe(false)
    })
  })

  it.effect('registers the normal main-session lifecycle handlers', () =>
    inMainSession(() =>
      Effect.sync(() => {
        const { pi, state } = createFakePi()

        feature.implementation.register(pi, runtime)

        expect([...state.handlers.keys()]).toEqual([
          'model_select',
          'thinking_level_select',
          'agent_start',
          'turn_end',
          'agent_settled',
          'after_provider_response',
        ])
      })
    )
  )
})

describe('status panel formatting', () => {
  it.effect('formats token counts and bounded progress bars', () =>
    Effect.sync(() => {
      expect(formatTokens(999)).toBe('999')
      expect(formatTokens(12_400)).toBe('12k')
      expect(formatTokens(1_250_000)).toBe('1.3M')
      expect(progressBar(-1, 4)).toBe('░░░░')
      expect(progressBar(150, 4)).toBe('▓▓▓▓')
    })
  )

  it.effect('keeps columns within the available width', () =>
    Effect.sync(() => {
      const rendered = columns('a very long branch name', 'model/context', 20)
      expect(Bun.stringWidth(rendered)).toBeLessThanOrEqual(20)
    })
  )

  it.effect('creates independent empty state values', () =>
    Effect.sync(() => {
      expect(emptyModelInfoState().modelId).toBe('no-model')
      expect(emptyGitInfoState()).toEqual({ branch: undefined, changedFiles: 0, pullRequest: undefined })
    })
  )

  it.effect('moves footer information into a bounded right sidebar', () =>
    inMainSession(() =>
      Effect.gen(function* () {
        const { pi } = createFakePi()
        let renderFooter: ((width: number) => string[]) | undefined
        let renderSidebar: ((width: number) => string[]) | undefined
        let hiddenOverlays = 0
        const tui = {
          render: (_width: number) => [],
          requestRender() {
            /* Empty */
          },
          terminal: { columns: 120, rows: 30 },
        }
        const theme = {
          bold: (value: string) => value,
          fg: (_color: string, value: string) => value,
        }
        const footerData = {
          getExtensionStatuses: () => new Map([['long-status', 'a very long extension status']]),
          onBranchChange: () => () => undefined,
        }
        const ui = {
          custom(
            factory: (...args: unknown[]) => { render: (width: number) => string[] },
            options: { onHandle?: (handle: { hide: () => void }) => void }
          ) {
            return promiseFromEffect(
              Effect.callback<void>((resume) => {
                const component = factory(tui, theme, {}, () => resume(Effect.void))
                renderSidebar = (width) => component.render(width)
                options.onHandle?.({
                  hide() {
                    hiddenOverlays += 1
                  },
                })
              })
            )
          },
          setFooter(factory?: (...args: unknown[]) => { render: (width: number) => string[] }) {
            if (factory === undefined) {
              renderFooter = undefined
              return
            }
            const component = factory(tui, theme, footerData)
            renderFooter = (width) => component.render(width)
          },
          setTitle() {
            /* Empty */
          },
        }
        const ctx = {
          cwd: '/a/very/long/project/directory',
          getContextUsage: () => ({ contextWindow: 200_000, percent: 6.2, tokens: 12_345 }),
          mode: 'tui',
          model: { contextWindow: 200_000, id: 'a-very-long-model-name', provider: 'openai' },
          ui,
        }
        feature.implementation.register(pi, runtime)
        yield* activateSession(feature.implementation, ctx, 'startup')

        expect(renderFooter?.(80)).toEqual([])
        tui.terminal.columns = 80
        expect(renderFooter?.(80).join('\n')).toContain('Context:')
        tui.terminal.columns = 120
        if (renderSidebar === undefined) {
          throw new Error('expected a sidebar renderer')
        }
        for (const width of [28, 36, 44]) {
          const lines = renderSidebar(width)
          expect(lines).toHaveLength(30)
          expect(lines.every((line) => Bun.stringWidth(line) <= width)).toBeTrue()
        }
        expect(renderSidebar(44).join('\n')).toContain('AGENT')
        expect(renderSidebar(44).join('\n')).toContain('CONTEXT')
        yield* deactivateSession(feature.implementation, ctx, 'shutdown')
        expect(hiddenOverlays).toBe(1)
      })
    )
  )
})

const quotaLifecycleContext = (mode: 'tui' | 'rpc', provider = 'anthropic') => ({
  cwd: '/project',
  getContextUsage: () => undefined,
  mode,
  model: {
    baseUrl: 'http://127.0.0.1:3456',
    contextWindow: 100_000,
    id: `${provider}-model`,
    provider,
  },
  modelRegistry: {
    getAvailable: () => [
      {
        baseUrl: 'http://127.0.0.1:3456',
        contextWindow: 100_000,
        id: 'claude-model',
        provider: 'anthropic',
      },
    ],
  },
  ui: {
    setFooter() {
      /* Empty */
    },
    setHeader() {
      /* Empty */
    },
    setTitle() {
      /* Empty */
    },
  },
})

describe('status panel quota lifecycle', () => {
  it.effect('does not request Anthropic quota outside TUI mode', () =>
    inMainSession(() =>
      Effect.gen(function* () {
        const { pi, emit } = createFakePi()
        const signals: AbortSignal[] = []
        const panel = makeFeature({
          fetchAnthropicQuota: () =>
            Effect.promise((signal) => {
              signals.push(signal)
              return promiseFromEffect(Effect.never)
            }),
        })
        panel.implementation.register(pi, runtime)
        const ctx = quotaLifecycleContext('rpc')

        yield* activateSession(panel.implementation, ctx, 'startup')
        yield* Effect.promise(() => emit('model_select', { model: ctx.model }, ctx))
        expect(signals).toHaveLength(0)
        yield* deactivateSession(panel.implementation, ctx, 'shutdown')
      })
    )
  )

  it.effect('keeps polling Claude while another provider is active and aborts on shutdown', () =>
    inMainSession(() =>
      Effect.gen(function* () {
        const { pi, emit } = createFakePi()
        const baseUrls: string[] = []
        const signals: AbortSignal[] = []
        const panel = makeFeature({
          fetchAnthropicQuota: (baseUrl) =>
            Effect.promise((signal) => {
              baseUrls.push(baseUrl)
              signals.push(signal)
              return promiseFromEffect(Effect.never)
            }),
        })
        panel.implementation.register(pi, runtime)
        const ctx = quotaLifecycleContext('tui', 'azure-openai-responses')

        yield* activateSession(panel.implementation, ctx, 'startup')
        expect(signals).toHaveLength(1)
        expect(baseUrls).toEqual(['http://127.0.0.1:3456'])

        ctx.model = { ...ctx.model, id: 'openai-model', provider: 'openai' }
        yield* Effect.promise(() => emit('model_select', { model: ctx.model }, ctx))
        if (signals.length === 0) {
          throw new Error('expected a quota request')
        }
        const [signal] = signals
        expect(signal.aborted).toBeFalse()
        expect(signals).toHaveLength(1)

        yield* deactivateSession(panel.implementation, ctx, 'shutdown')
        expect(signal.aborted).toBeTrue()
      })
    )
  )
})

describe('status panel cross-feature sharing', () => {
  it.effect('renders subagents published through the shared AgentActivity singleton, as sub-agents does', () =>
    inMainSession(() =>
      Effect.gen(function* () {
        runningAgents.publish([{ color: 'accent', name: '/scout-shared', profile: 'scout' }])

        const { pi } = createFakePi()
        let renderSidebar: ((width: number) => string[]) | undefined
        const tui = {
          render: (_width: number) => [],
          requestRender() {
            /* Empty */
          },
          terminal: { columns: 120, rows: 30 },
        }
        const theme = {
          bold: (value: string) => value,
          fg: (_color: string, value: string) => value,
        }
        const ui = {
          custom(
            factory: (...args: unknown[]) => { render: (width: number) => string[] },
            options: { onHandle?: (handle: { hide: () => void }) => void }
          ) {
            return promiseFromEffect(
              Effect.callback<void>((resume) => {
                const component = factory(tui, theme, {}, () => resume(Effect.void))
                renderSidebar = (width) => component.render(width)
                options.onHandle?.({
                  hide() {
                    /* Empty */
                  },
                })
              })
            )
          },
          setFooter() {
            /* Empty */
          },
          setTitle() {
            /* Empty */
          },
        }
        const ctx = {
          cwd: '/project',
          getContextUsage: () => undefined,
          mode: 'tui',
          model: { contextWindow: 100_000, id: 'model', provider: 'openai' },
          ui,
        }

        feature.implementation.register(pi, runtime)
        yield* activateSession(feature.implementation, ctx, 'startup')

        if (renderSidebar === undefined) {
          throw new Error('expected a sidebar renderer')
        }
        expect(renderSidebar(44).join('\n')).toContain('/scout-shared')

        yield* deactivateSession(feature.implementation, ctx, 'shutdown')
      })
    )
  )

  it.effect('keeps re-rendering on agent activity after a session restart', () =>
    inMainSession(() =>
      Effect.gen(function* () {
        const { pi } = createFakePi()
        let renders = 0
        const tui = {
          render: (_width: number) => [],
          requestRender() {
            renders += 1
          },
          terminal: { columns: 120, rows: 30 },
        }
        const theme = {
          bold: (value: string) => value,
          fg: (_color: string, value: string) => value,
        }
        const ui = {
          custom(
            factory: (...args: unknown[]) => { render: (width: number) => string[] },
            options: { onHandle?: (handle: { hide: () => void }) => void }
          ) {
            return promiseFromEffect(
              Effect.callback<void>((resume) => {
                factory(tui, theme, {}, () => resume(Effect.void))
                options.onHandle?.({
                  hide() {
                    /* Empty */
                  },
                })
              })
            )
          },
          setFooter() {
            /* Empty */
          },
          setTitle() {
            /* Empty */
          },
        }
        const ctx = {
          cwd: '/project',
          getContextUsage: () => undefined,
          mode: 'tui',
          model: { contextWindow: 100_000, id: 'model', provider: 'openai' },
          ui,
        }

        feature.implementation.register(pi, runtime)
        yield* activateSession(feature.implementation, ctx, 'startup')
        renders = 0
        runningAgents.publish([{ color: 'accent', name: '/first', profile: 'scout' }])
        expect(renders).toBeGreaterThan(0)

        yield* deactivateSession(feature.implementation, ctx, 'replaced')
        renders = 0
        runningAgents.publish([{ color: 'accent', name: '/stale', profile: 'scout' }])
        expect(renders).toBe(0)

        yield* activateSession(feature.implementation, ctx, 'resume')
        renders = 0
        runningAgents.publish([{ color: 'accent', name: '/second', profile: 'scout' }])
        expect(renders).toBeGreaterThan(0)

        yield* deactivateSession(feature.implementation, ctx, 'shutdown')
      })
    )
  )
})

const panelSessionLayer = Layer.mergeAll(AgentActivityLive, StatusBarLive, FetchHttpClient.layer)

const fakeTheme = { bold: (value: string) => value, fg: (_color: string, value: string) => value }

describe('status panel session fibers', () => {
  it.effect('ticks a redraw only while the agent is working and stops when the session ends', () =>
    inMainSession(() =>
      Effect.scoped(
        Effect.gen(function* () {
          const { pi } = createFakePi()
          let renders = 0
          const tui = {
            render: (_width: number) => [],
            requestRender() {
              renders += 1
            },
            terminal: { columns: 120, rows: 30 },
          }
          const ui = {
            custom(
              factory: (...args: unknown[]) => { render: (width: number) => string[] },
              options: { onHandle?: (handle: { hide: () => void }) => void }
            ) {
              return promiseFromEffect(
                Effect.callback<void>((resume) => {
                  factory(tui, fakeTheme, {}, () => resume(Effect.void))
                  options.onHandle?.({
                    hide() {
                      /* Empty */
                    },
                  })
                })
              )
            },
            setFooter() {
              /* Empty */
            },
            setTitle() {
              /* Empty */
            },
          }
          const ctx = asExtensionContext({
            cwd: '/project',
            getContextUsage: () => undefined,
            mode: 'tui',
            model: { contextWindow: 100_000, id: 'model', provider: 'openai' },
            ui,
          })
          const handlers = makePanelController({ dependencies: {}, pi })
          const agentStart = asNarrowed<Parameters<typeof handlers.agentStart>[0], { type: 'agent_start' }>({ type: 'agent_start' })
          const agentSettled = asNarrowed<Parameters<typeof handlers.agentSettled>[0], { type: 'agent_settled' }>({ type: 'agent_settled' })

          yield* handlers.sessionStart({ reason: 'startup', type: 'session_start' }, ctx)
          yield* handlers.agentStart(agentStart, ctx)
          renders = 0
          yield* TestClock.adjust('400 millis')
          const afterFirstTick = renders
          expect(afterFirstTick).toBeGreaterThan(0)
          yield* TestClock.adjust('400 millis')
          expect(renders).toBeGreaterThan(afterFirstTick)

          yield* handlers.agentSettled(agentSettled, ctx)
          const afterSettle = renders
          yield* TestClock.adjust('1200 millis')
          expect(renders).toBe(afterSettle)

          yield* handlers.agentStart(agentStart, ctx)
          yield* TestClock.adjust('400 millis')
          expect(renders).toBeGreaterThan(afterSettle)

          yield* handlers.sessionShutdown({ reason: 'quit', type: 'session_shutdown' }, ctx)
          const afterShutdown = renders
          yield* TestClock.adjust('1200 millis')
          expect(renders).toBe(afterShutdown)
        })
      ).pipe(Effect.provide(panelSessionLayer))
    )
  )

  it.effect('refreshes git information when the footer reports a branch change', () =>
    inMainSession(() =>
      Effect.scoped(
        Effect.gen(function* () {
          const execCalls: string[][] = []
          const { pi } = createFakePi({
            exec: (command: string, args: string[]) => {
              execCalls.push([command, ...args])
              return Promise.resolve({ code: 0, stderr: '', stdout: 'true' })
            },
          })
          let branchChange: (() => void) | undefined
          const tui = {
            render: (_width: number) => [],
            requestRender() {
              /* Empty */
            },
            terminal: { columns: 80, rows: 30 },
          }
          const ui = {
            custom(
              factory: (...args: unknown[]) => { render: (width: number) => string[] },
              options: { onHandle?: (handle: { hide: () => void }) => void }
            ) {
              return promiseFromEffect(
                Effect.callback<void>((resume) => {
                  factory(tui, fakeTheme, {}, () => resume(Effect.void))
                  options.onHandle?.({
                    hide() {
                      /* Empty */
                    },
                  })
                })
              )
            },
            setFooter(factory?: (tui: unknown, theme: unknown, data: unknown) => unknown) {
              factory?.(
                tui,
                fakeTheme,
                asFooterDataProvider({
                  getExtensionStatuses: () => new Map(),
                  onBranchChange: (listener: () => void) => {
                    branchChange = listener
                    return () => undefined
                  },
                })
              )
            },
            setTitle() {
              /* Empty */
            },
          }
          const ctx = asExtensionContext({
            cwd: '/project',
            getContextUsage: () => undefined,
            mode: 'tui',
            model: { contextWindow: 100_000, id: 'model', provider: 'openai' },
            ui,
          })
          const handlers = makePanelController({ dependencies: {}, pi })

          yield* handlers.sessionStart({ reason: 'startup', type: 'session_start' }, ctx)
          yield* settle(() => execCalls.length >= GIT_READS_PER_REFRESH)
          execCalls.length = 0

          expect(branchChange).toBeDefined()
          branchChange?.()
          yield* settle(() => execCalls.length >= GIT_READS_PER_REFRESH)

          expect(execCalls.map(([command, subcommand]) => `${command} ${subcommand}`).toSorted()).toEqual([
            'git branch',
            'git rev-parse',
            'git status',
          ])

          yield* handlers.sessionShutdown({ reason: 'quit', type: 'session_shutdown' }, ctx)
          execCalls.length = 0
          branchChange?.()
          yield* settle(() => execCalls.length > 0)
          expect(execCalls).toEqual([])
        })
      ).pipe(Effect.provide(panelSessionLayer))
    )
  )
})
