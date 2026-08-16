// oxlint-disable-next-line effecttsgo/node-builtin-import -- This test verifies a child Node process.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { text } from 'node:stream/consumers'
import { fileURLToPath } from 'node:url'

import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'

import { getOrCreateProcessRuntime } from '#config/runtime'
import { register as registerStatusPanel } from '#features/status_panel/index'
import { AgentActivity, type AgentActivityApi, type AppRuntime, StatusBarLive } from '#shared/effect/app_services'
import { parseJsonText } from '#shared/utils/json'
import { describe, expect, it } from '#tests/utils/effect'
import { createFakePi } from '#tests/utils/fake_pi'
import { withProcessEnv } from '#tests/utils/process_env'

const sharedActivityScript = (paths: { aggregate: string; activity: string; runtime: string; statusPanel: string }): string => `
  const { Effect } = await import('effect');
  const unwrapModule = module => module.default?.default !== undefined ? module.default : module.default ?? module;
  const { default: piExtensions } = unwrapModule(await import(${JSON.stringify(paths.aggregate)}));
  const { register: registerStatusPanel } = unwrapModule(await import(${JSON.stringify(paths.statusPanel)}));
  const { AgentActivity } = unwrapModule(await import(${JSON.stringify(paths.activity)}));
  const { getOrCreateProcessRuntime } = unwrapModule(await import(${JSON.stringify(paths.runtime)}));

  const createPi = () => {
    const handlers = new Map();
    const pi = {
      events: { emit() {}, on() {} },
      exec() { return Effect.runPromise(Effect.succeed({ code: 0, killed: false, stderr: '', stdout: '' })); },
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
      const sentinelActivity: AgentActivityApi = {
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
      yield* withProcessEnv('PI_SUBAGENT_OWNER_TOKEN', undefined, () =>
        Effect.sync(() => {
          registerStatusPanel(createFakePi().pi, runtime)
          expect(subscriptions).toBe(1)
        })
      ).pipe(Effect.ensuring(Effect.promise(() => runtime.dispose())))
    })
  )

  it.effect(
    'makes AgentActivity observable through aggregate and explicit feature registration',
    () =>
      Effect.gen(function* () {
        const script = sharedActivityScript({
          activity: fileURLToPath(new URL('../../src/shared/effect/app_services.ts', import.meta.url)),
          aggregate: fileURLToPath(new URL('../../src/index.ts', import.meta.url)),
          runtime: fileURLToPath(new URL('../../src/config/runtime.ts', import.meta.url)),
          statusPanel: fileURLToPath(new URL('../../src/features/status_panel/index.ts', import.meta.url)),
        })
        const { PI_SUBAGENT_OWNER_TOKEN: _ownerToken, ...env } = process.env
        const child = spawn(process.execPath, ['--import', 'jiti/register', '--eval', script], {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        const [stdout, stderr, exitCode] = yield* Effect.promise(() =>
          Promise.all([text(child.stdout), text(child.stderr), once(child, 'exit').then(([code]) => code)])
        )

        expect(exitCode, stderr).toBe(0)
        const result = parseJsonText(stdout.trim())
        expect(result).toEqual({
          aggregate: expect.stringContaining('shared-agent'),
          explicit: expect.stringContaining('shared-agent'),
        })
      }),
    10_000
  )
})
