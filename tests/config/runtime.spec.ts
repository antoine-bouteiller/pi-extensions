import { fileURLToPath } from 'node:url'

import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { createFakePi } from '@tests/utils/fake_pi.js'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'

import { getOrCreateProcessRuntime } from '@/config/runtime.js'
import { register as registerStatusPanel } from '@/features/status_panel/index.js'
import { AgentActivity, type AgentActivityShape, type AppRuntime, StatusBarLive } from '@/shared/effect/app_services.js'

const sharedActivityScript = (paths: { aggregate: string; activity: string; runtime: string; statusPanel: string }): string => `
  const { Effect } = await import('effect');
  const { default: piExtensions } = await import(${JSON.stringify(paths.aggregate)});
  const { register: registerStatusPanel } = await import(${JSON.stringify(paths.statusPanel)});
  const { AgentActivity } = await import(${JSON.stringify(paths.activity)});
  const { getOrCreateProcessRuntime } = await import(${JSON.stringify(paths.runtime)});

  const createPi = () => {
    const handlers = new Map();
    const pi = {
      events: { emit() {}, on() {} },
      async exec() { return { code: 0, killed: false, stderr: '', stdout: '' }; },
      getActiveTools: () => [], getAllTools: () => [], getThinkingLevel: () => 'off',
      on(name, handler) { const list = handlers.get(name) || []; list.push(handler); handlers.set(name, list); },
      registerCommand() {}, registerEntryRenderer() {}, registerFlag() {}, registerMessageRenderer() {},
      registerProvider() {}, registerShortcut() {}, registerTool() {}, sendMessage() {}, setActiveTools() {},
    };
    return { handlers, pi };
  };

  const panelContext = () => {
    let renderSidebar;
    const tui = { render: () => [], requestRender() {}, terminal: { columns: 120, rows: 30 } };
    const theme = { bold: value => value, fg: (_color, value) => value };
    const ctx = {
      cwd: '/project', getContextUsage: () => undefined, mode: 'tui',
      model: { contextWindow: 100000, id: 'model', provider: 'openai' },
      ui: {
        custom(factory, options) { return new Promise(resolve => { const component = factory(tui, theme, {}, resolve); renderSidebar = width => component.render(width); options.onHandle?.({ hide() {} }); }); },
        setFooter() {}, setTitle() {},
      },
    };
    return { ctx, render: () => renderSidebar(44).join('\\n') };
  };

  const aggregate = createPi();
  piExtensions(aggregate.pi);
  const aggregateStarts = aggregate.handlers.get('session_start') || [];
  if (aggregateStarts.length !== 7 || !aggregateStarts[5]) throw new Error('aggregate status-panel handler missing');
  const aggregatePanel = panelContext();
  await aggregateStarts[5]({}, aggregatePanel.ctx);

  const explicit = createPi();
  registerStatusPanel(explicit.pi, getOrCreateProcessRuntime());
  const explicitStart = explicit.handlers.get('session_start')?.[0];
  if (!explicitStart) throw new Error('explicit feature registration status-panel handler missing');
  const explicitPanel = panelContext();
  await explicitStart({}, explicitPanel.ctx);

  const runtime = getOrCreateProcessRuntime();
  await runtime.runPromise(AgentActivity.pipe(Effect.flatMap(activity => activity.publish([{ color: 'accent', name: 'shared-agent', profile: 'scout' }]))));
  console.log(JSON.stringify({ aggregate: aggregatePanel.render(), explicit: explicitPanel.render() }));
`

describe('process-wide runtime', () => {
  it.effect('memoises to one instance across repeated lookups', () =>
    Effect.sync(() => {
      expect(getOrCreateProcessRuntime()).toBe(getOrCreateProcessRuntime())
    })
  )

  it.effect('uses the runtime supplied to a feature register function', () =>
    Effect.gen(function* () {
      let subscriptions = 0
      const sentinelActivity: AgentActivityShape = {
        list: () => [],
        publish: () => Effect.void,
        subscribe: () => {
          subscriptions += 1
          return () => undefined
        },
      }
      const runtime: AppRuntime = ManagedRuntime.make(
        Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, FetchHttpClient.layer, StatusBarLive, Layer.succeed(AgentActivity)(sentinelActivity))
      )
      // oxlint-disable-next-line effecttsgo/process-env-in-effect -- This test must use the real process environment observed by the feature.
      const originalOwnerToken = process.env.PI_SUBAGENT_OWNER_TOKEN
      // oxlint-disable-next-line effecttsgo/process-env-in-effect -- This test must use the real process environment observed by the feature.
      delete process.env.PI_SUBAGENT_OWNER_TOKEN
      try {
        registerStatusPanel(createFakePi().pi, runtime)
        expect(subscriptions).toBe(1)
      } finally {
        if (originalOwnerToken === undefined) {
          // oxlint-disable-next-line effecttsgo/process-env-in-effect -- This test must use the real process environment observed by the feature.
          delete process.env.PI_SUBAGENT_OWNER_TOKEN
        } else {
          // oxlint-disable-next-line effecttsgo/process-env-in-effect -- This test must use the real process environment observed by the feature.
          process.env.PI_SUBAGENT_OWNER_TOKEN = originalOwnerToken
        }
        yield* Effect.promise(() => runtime.dispose())
      }
    })
  )

  it.effect('makes AgentActivity observable through aggregate and explicit feature registration', () =>
    Effect.gen(function* () {
      const script = sharedActivityScript({
        activity: fileURLToPath(new URL('../../src/shared/effect/app_services.ts', import.meta.url)),
        aggregate: fileURLToPath(new URL('../../src/index.ts', import.meta.url)),
        runtime: fileURLToPath(new URL('../../src/config/runtime.ts', import.meta.url)),
        statusPanel: fileURLToPath(new URL('../../src/features/status_panel/index.ts', import.meta.url)),
      })
      const { PI_SUBAGENT_OWNER_TOKEN: _ownerToken, ...env } = process.env
      const child = Bun.spawn([process.execPath, '--eval', script], { env, stderr: 'pipe', stdout: 'pipe' })
      const [stdout, stderr, exitCode] = yield* Effect.promise(() =>
        Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      )

      expect(exitCode, stderr).toBe(0)
      // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- This test exercises native JSON fixture or process behavior; schema decoding would change the boundary under test.
      const result: unknown = JSON.parse(stdout.trim())
      expect(result).toEqual({
        aggregate: expect.stringContaining('shared-agent'),
        explicit: expect.stringContaining('shared-agent'),
      })
    })
  )
})
