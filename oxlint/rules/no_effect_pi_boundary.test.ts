import { RuleTester } from 'oxlint/plugins-dev'

import { noEffectPiBoundaryRule } from './no_effect_pi_boundary.ts'

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })
const at = (filename: string, code: string) => ({ code, filename })

tester.run('pi-extensions/no-effect-pi-boundary', noEffectPiBoundaryRule, {
  invalid: [
    { ...at('src/features/example/tool.ts', 'pi.registerTool({});'), errors: [{ messageId: 'piRegistration' }] },
    { ...at('src/config/other.ts', 'import { Effect as Fx } from "effect"; Fx.runSync(effect);'), errors: [{ messageId: 'runtimeEntry' }] },
    { ...at('src/config/other.ts', 'import { Effect } from "effect"; Effect.runPromiseExit(effect);'), errors: [{ messageId: 'runtimeEntry' }] },
    { ...at('src/index.ts', 'pi.on("message", () => {});'), errors: [{ messageId: 'piRegistration' }] },
    { ...at('src/features/example/index.ts', 'pi.on("session_start", () => {});'), errors: [{ messageId: 'lifecycleRegistration' }] },
    {
      ...at('src/features/example/index.ts', 'const event = "session_start"; pi.on(event, () => {});'),
      errors: [{ messageId: 'lifecycleRegistration' }],
    },
    {
      ...at('src/config/other.ts', 'import { makeToolExecutor } from "#shared/effect/runtime"; makeToolExecutor(runtime);'),
      errors: [{ messageId: 'bridgeLocation' }],
    },
    {
      ...at(
        'src/config/feature_coordinator.ts',
        'import { makeToolExecutor as makeEventHandler } from "#shared/effect/runtime"; makeEventHandler(runtime);'
      ),
      errors: [{ messageId: 'bridgeLocation' }],
    },
    {
      ...at('src/shared/other.ts', 'import { ManagedRuntime } from "effect"; ManagedRuntime["make"](layer);'),
      errors: [{ messageId: 'runtimeConstruction' }],
    },
    {
      ...at('src/features/example/index.ts', 'import { Effect } from "effect"; Effect["runSync"](effect);'),
      errors: [{ messageId: 'runtimeEntry' }],
    },
    {
      ...at('src/config/other.ts', 'runtime.runFork(effect); this.runtime["runPromise"](effect); runtime.runCallback(effect);'),
      errors: [{ messageId: 'runtimeEntry' }, { messageId: 'runtimeEntry' }, { messageId: 'runtimeEntry' }],
    },
    { ...at('src/config/runtime.ts', 'import gateway from "#features/mcp/gateway";'), errors: [{ messageId: 'featureRuntimeImport' }] },
    { ...at('src/another/place.ts', 'pi.registerCommand({});'), errors: [{ messageId: 'piRegistration' }] },
    {
      ...at('src/config/other.ts', 'input!.pi.registerTool({}); (input as Input).pi["registerCommand"]({});'),
      errors: [{ messageId: 'piRegistration' }, { messageId: 'piRegistration' }],
    },
    {
      ...at('src/config/other.ts', 'this!.pi.on("session_start", () => {}); (this as { pi: Pi }).pi["on"]("session_shutdown", () => {});'),
      errors: [{ messageId: 'lifecycleRegistration' }, { messageId: 'lifecycleRegistration' }],
    },
    {
      ...at('src/features/example/tool.ts', 'input.pi.registerTool({}); input.pi["on"]("session_start", () => {});'),
      errors: [{ messageId: 'piRegistration' }, { messageId: 'lifecycleRegistration' }],
    },
    { ...at('src/features/example/tool.ts', 'pi!.registerTool({});'), errors: [{ messageId: 'piRegistration' }] },
    { ...at('src/config/other.ts', 'runtime!.runPromise(effect);'), errors: [{ messageId: 'runtimeEntry' }] },
    {
      ...at('src/config/other.ts', 'import { Effect } from "effect"; (Effect as typeof Effect).runPromise(effect);'),
      errors: [{ messageId: 'runtimeEntry' }],
    },
    {
      ...at(
        'src/config/other.ts',
        'import { makeToolExecutor } from "#shared/effect/runtime"; (makeToolExecutor as typeof makeToolExecutor)(runtime);'
      ),
      errors: [{ messageId: 'bridgeLocation' }],
    },
    {
      ...at('src/config/other.ts', 'import { makeToolExecutor } from "../shared/effect/runtime"; makeToolExecutor(runtime);'),
      errors: [{ messageId: 'bridgeLocation' }],
    },
    { ...at('src/config/other.ts', 'const event = "message"; pi.on(event, () => {});'), errors: [{ messageId: 'lifecycleRegistration' }] },
    {
      ...at('src/config/other.ts', 'this!.runtime.runPromise(effect); (this as { runtime: Runtime }).runtime.runPromise(effect);'),
      errors: [{ messageId: 'runtimeEntry' }, { messageId: 'runtimeEntry' }],
    },
    {
      ...at(
        'src/config/other.ts',
        'pi["registerTool" as const]({}); runtime["runPromise" as const](effect); import { Effect, ManagedRuntime } from "effect"; Effect["runPromise" as const](effect); ManagedRuntime["make" as const](layer);'
      ),
      errors: [{ messageId: 'piRegistration' }, { messageId: 'runtimeEntry' }, { messageId: 'runtimeEntry' }, { messageId: 'runtimeConstruction' }],
    },
    {
      ...at('src/config/other.ts', 'import { Effect } from "effect"; (<typeof Effect>Effect).runPromise(effect);'),
      errors: [{ messageId: 'runtimeEntry' }],
    },
    { ...at('src/config/other.ts', '(runtime?.runPromise)(effect);'), errors: [{ messageId: 'runtimeEntry' }] },
    { ...at('src/config/other.ts', '((runtime! as Runtime)).runPromise(effect);'), errors: [{ messageId: 'runtimeEntry' }] },
    {
      ...at(
        'src/config/runtime.ts',
        'const gateway = import("#features/mcp/gateway"); async function load() { return await import("#features/mcp/gateway"); }'
      ),
      errors: [{ messageId: 'featureRuntimeImport' }, { messageId: 'featureRuntimeImport' }],
    },
    { ...at('src/config/runtime.ts', 'export { gateway } from "#features/mcp/gateway";'), errors: [{ messageId: 'featureRuntimeImport' }] },
  ],
  valid: [
    at('src/features/example/index.ts', 'pi.registerTool({}); pi.on("message", () => {});'),
    at('src/features/example/index.ts', 'import { makeToolExecutor } from "#shared/effect/runtime"; makeToolExecutor(runtime);'),
    at('src/config/feature_coordinator.ts', 'pi.on("session_start", () => {});'),
    at('src/config/feature_coordinator.ts', 'input!.pi.on("session_start", () => {}); (input as Input).pi["on"]("session_shutdown", () => {});'),
    at('src/config/feature_coordinator.ts', 'this!.pi.on("session_start", () => {}); (this as { pi: Pi }).pi["on"]("session_shutdown", () => {});'),
    at('src/features/example/index.ts', 'input.pi.registerTool({}); input.pi["registerCommand"]({});'),
    at('src/other.ts', 'client.pi.registerTool({}); api.registerTool({});'),
    at('src/config/feature_coordinator.ts', 'import { makeEventHandler } from "#shared/effect/runtime"; makeEventHandler(runtime);'),
    at('src/config/feature_coordinator.ts', 'import { makeEventHandler as handler } from "#shared/effect/runtime"; handler(runtime);'),
    at('src/config/runtime.ts', 'import { ManagedRuntime } from "effect"; ManagedRuntime.make(layer);'),
    at('src/features/sub_agents/runtime.ts', 'import { ManagedRuntime } from "effect"; ManagedRuntime.make(layer);'),
    at('src/shared/effect/runtime.ts', 'import { Effect } from "effect"; Effect.runPromise(effect);'),
    at('src/shared/effect/runtime.ts', 'runtime.runPromise(effect); this.runtime["runSync"](effect);'),
    at('src/features/example/index.ts', 'client.runPromise(effect); other.registerTool({});'),
    at('src/other.ts', 'const Effect = { runSync() {} }; Effect.runSync();'),
    at('src/other.ts', 'import { Effect } from "effect"; function local(Effect: { runSync(): void }) { Effect.runSync(); }'),
    at('src/other.ts', 'const makeToolExecutor = () => {}; makeToolExecutor();'),
    at('src/other.ts', 'import { Effect } from "./animation"; Effect.runTransition();'),
    at('src/other.ts', 'import { makeEventHandler } from "./events"; makeEventHandler(runtime);'),
    at('src/other.ts', 'import { ManagedRuntime } from "./runtime"; ManagedRuntime.make(layer);'),
    at('src/other.ts', 'import { makeToolExecutor } from "./tools"; makeToolExecutor(runtime);'),
    at('src/other.ts', 'import { makeCommandHandler } from "./commands"; makeCommandHandler(runtime);'),
    at('/workspace/pi-extensions/src/shared/effect/runtime.ts', 'runtime.runPromise(effect);'),
    at(String.raw`C:\workspace\pi-extensions\src\shared\effect\runtime.ts`, 'runtime.runPromise(effect);'),
  ],
})
