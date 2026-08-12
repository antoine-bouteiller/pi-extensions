import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { createFakePi } from '@tests/utils/fake_pi.js'
import { runtime } from '@tests/utils/runtime.js'

import { register as statusPanel } from '@/features/status_panel/index.js'
import { columns, formatTokens, progressBar } from '@/features/status_panel/render.js'
import { emptyGitInfoState, emptyModelInfoState } from '@/features/status_panel/state.js'
import { runningAgents } from '@/shared/state/agent_activity.js'
import { azureQuota, consumeSubagentAzureQuota } from '@/shared/state/azure_quota.js'

const originalOwnerToken = process.env.PI_SUBAGENT_OWNER_TOKEN

beforeEach(() => {
  delete process.env.PI_SUBAGENT_OWNER_TOKEN
  azureQuota.set(undefined)
})

afterEach(() => {
  runningAgents.publish([])
  azureQuota.set(undefined)
  if (originalOwnerToken === undefined) {
    delete process.env.PI_SUBAGENT_OWNER_TOKEN
  } else {
    process.env.PI_SUBAGENT_OWNER_TOKEN = originalOwnerToken
  }
})

describe('status panel registration', () => {
  test('registers only Azure response forwarding in a subagent', async () => {
    const ownerToken = '11111111-1111-4111-8111-111111111111'
    process.env.PI_SUBAGENT_OWNER_TOKEN = ownerToken
    const { pi, state, emit } = createFakePi()
    let dependencyReads = 0
    const dependencies = {
      get fetchAnthropicQuota() {
        dependencyReads += 1
        return async () => undefined
      },
    }

    statusPanel(pi, runtime, dependencies)
    await emit(
      'after_provider_response',
      { headers: { 'x-ratelimit-limit-tokens': '1000', 'x-ratelimit-remaining-tokens': '250' } },
      { model: { provider: 'azure-openai-responses' } }
    )

    expect(dependencyReads).toBe(0)
    expect([...state.handlers.keys()]).toEqual(['after_provider_response'])
    expect(consumeSubagentAzureQuota(ownerToken)).toBe(75)
  })

  test('registers the normal main-session lifecycle handlers', () => {
    const { pi, state } = createFakePi()

    statusPanel(pi, runtime)

    expect([...state.handlers.keys()]).toEqual([
      'session_start',
      'model_select',
      'thinking_level_select',
      'agent_start',
      'turn_end',
      'agent_settled',
      'after_provider_response',
      'session_shutdown',
    ])
  })
})

describe('status panel formatting', () => {
  test('formats token counts and bounded progress bars', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(12_400)).toBe('12k')
    expect(formatTokens(1_250_000)).toBe('1.3M')
    expect(progressBar(-1, 4)).toBe('░░░░')
    expect(progressBar(150, 4)).toBe('▓▓▓▓')
  })

  test('keeps columns within the available width', () => {
    const rendered = columns('a very long branch name', 'model/context', 20)
    expect(Bun.stringWidth(rendered)).toBeLessThanOrEqual(20)
  })

  test('creates independent empty state values', () => {
    expect(emptyModelInfoState().modelId).toBe('no-model')
    expect(emptyGitInfoState()).toEqual({ branch: undefined, changedFiles: 0, pullRequest: undefined })
  })

  test('moves footer information into a bounded right sidebar', async () => {
    const { pi, emit } = createFakePi()
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
        return new Promise<void>((resolve) => {
          const component = factory(tui, theme, {}, resolve)
          renderSidebar = (width) => component.render(width)
          options.onHandle?.({
            hide() {
              hiddenOverlays += 1
            },
          })
        })
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
    statusPanel(pi, runtime)
    await emit('session_start', {}, ctx)

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
    await emit('session_shutdown', {}, ctx)
    expect(hiddenOverlays).toBe(1)
  })
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
  test('does not request Anthropic quota outside TUI mode', async () => {
    const { pi, emit } = createFakePi()
    const signals: AbortSignal[] = []
    statusPanel(pi, runtime, {
      fetchAnthropicQuota: (_baseUrl, signal) => {
        signals.push(signal)
        return new Promise(() => undefined)
      },
    })
    const ctx = quotaLifecycleContext('rpc')

    await emit('session_start', {}, ctx)
    await emit('model_select', { model: ctx.model }, ctx)
    expect(signals).toHaveLength(0)
    await emit('session_shutdown', {}, ctx)
  })

  test('keeps polling Claude while another provider is active and aborts on shutdown', async () => {
    const { pi, emit } = createFakePi()
    const baseUrls: string[] = []
    const signals: AbortSignal[] = []
    statusPanel(pi, runtime, {
      fetchAnthropicQuota: (baseUrl, signal) => {
        baseUrls.push(baseUrl)
        signals.push(signal)
        return new Promise(() => undefined)
      },
    })
    const ctx = quotaLifecycleContext('tui', 'azure-openai-responses')

    await emit('session_start', {}, ctx)
    expect(signals).toHaveLength(1)
    expect(baseUrls).toEqual(['http://127.0.0.1:3456'])

    ctx.model = { ...ctx.model, id: 'openai-model', provider: 'openai' }
    await emit('model_select', { model: ctx.model }, ctx)
    if (signals.length === 0) {
      throw new Error('expected a quota request')
    }
    const [signal] = signals
    expect(signal.aborted).toBeFalse()
    expect(signals).toHaveLength(1)

    await emit('session_shutdown', {}, ctx)
    expect(signal.aborted).toBeTrue()
  })
})

describe('status panel cross-feature sharing', () => {
  test('renders subagents published through the shared AgentActivity singleton, as sub-agents does', async () => {
    runningAgents.publish([{ color: 'accent', name: '/scout-shared', profile: 'scout' }])

    const { pi, emit } = createFakePi()
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
        return new Promise<void>((resolve) => {
          const component = factory(tui, theme, {}, resolve)
          renderSidebar = (width) => component.render(width)
          options.onHandle?.({
            hide() {
              /* Empty */
            },
          })
        })
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

    statusPanel(pi, runtime)
    await emit('session_start', {}, ctx)

    if (renderSidebar === undefined) {
      throw new Error('expected a sidebar renderer')
    }
    expect(renderSidebar(44).join('\n')).toContain('/scout-shared')

    await emit('session_shutdown', {}, ctx)
  })
})
