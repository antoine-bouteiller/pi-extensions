import { fileURLToPath } from 'node:url'

import { BunFileSystem, BunPath } from '@effect/platform-bun'
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { asResult } from '@tests/utils/casts.js'
import { Effect, FileSystem, Layer, Path } from 'effect'

/*
 * These are package contracts, not an inventory: every expectation is derived from the feature
 * folders on disk, so adding or removing a feature never requires editing this file.
 */

const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/

const MANIFEST_KEYS = ['commands', 'handlers', 'messageRenderers', 'tools'] as const
const T009_FEATURES = new Set([
  'auto_theme',
  'background_poll',
  'claude_code',
  'mcp',
  'prompt_rewind',
  'rules',
  'safety_guard',
  'status_panel',
  'sub_agents',
])
const APPROVED_BACKGROUND_FEATURES = new Set(['comment_checker', 'meridian_session_affinity'])

type Manifest = Record<(typeof MANIFEST_KEYS)[number], string[]>

interface DescriptorMetadata {
  bootstrap: 'background' | 'eager'
  id: string
  status: { icon: string; name: string }
}

interface FeatureReport {
  descriptor?: DescriptorMetadata
  exportsDefault: boolean
  exportsFeature: boolean
  exportsRegister: boolean
  manifest: Manifest
}

interface RegistrationReport {
  aggregate: Manifest
  features: Record<string, FeatureReport>
  registry: DescriptorMetadata[]
}

const PATHS = {
  entrypoint: fileURLToPath(new URL('../src/index.ts', import.meta.url)),
  fakePi: fileURLToPath(new URL('utils/fake_pi.ts', import.meta.url)),
  featuresDir: fileURLToPath(new URL('../src/features', import.meta.url)).replace(/\/$/, ''),
  registry: fileURLToPath(new URL('../src/config/features.ts', import.meta.url)),
  runtime: fileURLToPath(new URL('../src/config/runtime.ts', import.meta.url)),
}

const featureDirectories = (): Promise<string[]> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const names = yield* fs.readDirectory(PATHS.featuresDir)
      const entries = yield* Effect.forEach(
        names,
        (name) => fs.stat(path.join(PATHS.featuresDir, name)).pipe(Effect.map((info) => ({ info, name }))),
        {}
      )
      return entries
        .filter(({ info }) => info.type === 'Directory')
        .map(({ name }) => name)
        .toSorted()
    }).pipe(Effect.provide(Layer.merge(BunFileSystem.layer, BunPath.layer)))
  )

const reportScript = (directories: string[]): string => `
  const { createFakePi } = await import(${JSON.stringify(PATHS.fakePi)});

  const snapshot = state => ({
    commands: [...state.commands.keys()],
    handlers: [...state.handlers.entries()].flatMap(([event, handlers]) => handlers.map(() => event)),
    messageRenderers: [...state.messageRenderers],
    tools: [...state.tools.keys()],
  });

  const report = { features: {} };

  const { default: piExtensions } = await import(${JSON.stringify(PATHS.entrypoint)});
  const aggregate = createFakePi();
  piExtensions(aggregate.pi);
  report.aggregate = snapshot(aggregate.state);

  const { getOrCreateProcessRuntime } = await import(${JSON.stringify(PATHS.runtime)});
  const runtime = getOrCreateProcessRuntime();
  for (const directory of ${JSON.stringify(directories)}) {
    const module = await import(${JSON.stringify(PATHS.featuresDir)} + '/' + directory + '/index.js');
    const fixture = createFakePi();
    const exportsRegister = typeof module.register === 'function';
    const exportsFeature = module.feature?.bootstrap === 'eager' || module.feature?.bootstrap === 'background';
    if (exportsRegister === exportsFeature) {
      throw new Error('Feature ' + directory + ' must export exactly one registration entrypoint');
    }
    const register = exportsRegister ? module.register : module.feature?.bootstrap === 'eager' ? module.feature.implementation.register : undefined;
    if (typeof register === 'function') {
      register(fixture.pi, runtime);
    }
    report.features[directory] = {
      descriptor: exportsFeature ? { bootstrap: module.feature.bootstrap, id: module.feature.id, status: module.feature.status } : undefined,
      exportsDefault: module.default !== undefined,
      exportsFeature,
      exportsRegister,
      manifest: snapshot(fixture.state),
    };
  }

  const { features } = await import(${JSON.stringify(PATHS.registry)});
  report.registry = features.map(feature => ({ bootstrap: feature.bootstrap, id: feature.id, status: feature.status }));
  console.log(JSON.stringify(report));
`

/*
 * Registering sub_agents touches the real agent directory and pollutes Bun's shared module cache
 * for the specs that mock it, so the whole report is collected in a throwaway child process.
 */
const collectReport = (): Promise<RegistrationReport> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { PI_SUBAGENT_OWNER_TOKEN: _ownerToken, ...env } = process.env
      const script = reportScript(yield* Effect.promise(featureDirectories))
      const child = Bun.spawn([process.execPath, '--eval', script], { env, stderr: 'pipe', stdout: 'pipe' })
      return yield* Effect.all(
        [
          Effect.promise(() => new Response(child.stdout).text()),
          Effect.promise(() => new Response(child.stderr).text()),
          Effect.promise(() => child.exited),
        ],
        { concurrency: 'unbounded' }
      )
    })
  ).then(([stdout, stderr, exitCode]) => {
    expect(exitCode, stderr).toBe(0)
    return asResult<RegistrationReport>(JSON.parse(stdout.trim()))
  })

let pending: Promise<RegistrationReport> | undefined
const registrationReport = (): Promise<RegistrationReport> => (pending ??= collectReport())

type FeatureReports = Record<string, FeatureReport>

const mergedManifest = (features: FeatureReports) => {
  const manifests = Object.values(features).map((feature) => feature.manifest)
  const collect = (key: keyof Manifest): string[] => manifests.flatMap((manifest) => manifest[key])
  return { commands: collect('commands'), handlers: collect('handlers'), messageRenderers: collect('messageRenderers'), tools: collect('tools') }
}

const registrationCount = (manifest: Manifest): number => MANIFEST_KEYS.reduce((total, key) => total + manifest[key].length, 0)

const registryImports = (source: string) =>
  [...source.matchAll(/^import \{ feature as (?<name>\w+) \} from '#features\/(?<directory>[^/]+)\/index'$/gm)].map((match) => {
    const { directory, name } = match.groups ?? {}
    if (directory === undefined || name === undefined) {
      throw new Error('Malformed feature descriptor import')
    }
    return { directory, name }
  })

const registryEntries = (source: string) =>
  /export const features = \[(?<entries>[\s\S]*?)\] satisfies readonly FeaturePlugin\[\]/
    .exec(source)
    ?.groups?.entries?.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'))
    .map((line) => line.replace(/,$/, ''))

describe('registration', () => {
  it.effect('the registry has one explicitly imported descriptor per enabled entry in config order', () =>
    Effect.gen(function* () {
      const { features, registry } = yield* Effect.promise(() => registrationReport())
      const source = yield* Effect.promise(() => Bun.file(PATHS.registry).text())
      const imports = registryImports(source)
      const entries = registryEntries(source)

      const expected = imports.map(({ directory }) => {
        const descriptor = features[directory]?.descriptor
        if (descriptor === undefined) {
          throw new Error(`Enabled feature ${directory} has no descriptor`)
        }
        return descriptor
      })

      expect(entries).toEqual(imports.map(({ name }) => name))
      expect(registry).toHaveLength(imports.length)
      expect(registry).toEqual(expected)
    })
  )

  it('treats a commented descriptor import and matching array item as disabled', () => {
    const fixture = `import { feature as enabled } from '#features/enabled/index'
// import { feature as disabled } from '#features/disabled/index'

export const features = [
  enabled,
  // disabled,
] satisfies readonly FeaturePlugin[]`

    expect(registryImports(fixture)).toEqual([{ directory: 'enabled', name: 'enabled' }])
    expect(registryEntries(fixture)).toEqual(['enabled'])
  })

  it.effect('enabled descriptors have unique identity and status metadata', () =>
    Effect.gen(function* () {
      const { registry } = yield* Effect.promise(() => registrationReport())
      const identities = registry.map(({ bootstrap, id, status }) => [bootstrap, id, `feature:${id}`, status.icon, status.name])

      expect(new Set(registry.map(({ id }) => id)).size).toBe(registry.length)
      expect(new Set(registry.map(({ id }) => `feature:${id}`)).size).toBe(registry.length)
      expect(new Set(registry.map(({ status }) => status.icon)).size).toBe(registry.length)
      expect(new Set(registry.map(({ status }) => status.name)).size).toBe(registry.length)
      expect(identities.every(([bootstrap]) => bootstrap === 'eager' || bootstrap === 'background')).toBeTrue()
    })
  )

  it.effect('every feature exposes a named register entrypoint or descriptor with its expected pre-session manifest', () =>
    Effect.gen(function* () {
      const { features } = yield* Effect.promise(() => registrationReport())

      for (const [directory, feature] of Object.entries(features)) {
        expect(feature.exportsRegister !== feature.exportsFeature, directory).toBeTrue()
        expect(feature.exportsDefault, directory).toBeFalse()
        if (APPROVED_BACKGROUND_FEATURES.has(directory)) {
          expect(feature.descriptor?.bootstrap, directory).toBe('background')
          expect(registrationCount(feature.manifest), directory).toBe(0)
        } else if (directory !== 'auto_theme') {
          expect(registrationCount(feature.manifest), directory).toBeGreaterThan(0)
        }
      }
    })
  )

  it.effect('T-009 through T-011 descriptors expose exact bootstrap metadata', () =>
    Effect.gen(function* () {
      const { features } = yield* Effect.promise(() => registrationReport())
      const descriptors = Object.fromEntries(
        Object.entries(features)
          .filter(
            ([directory, feature]) =>
              (T009_FEATURES.has(directory) || APPROVED_BACKGROUND_FEATURES.has(directory)) && feature.descriptor !== undefined
          )
          .map(([directory, feature]) => [directory, feature.descriptor])
      )

      expect(descriptors).toEqual({
        auto_theme: { bootstrap: 'eager', id: 'auto-theme', status: { icon: '🎨', name: 'auto-theme' } },
        background_poll: { bootstrap: 'eager', id: 'background-poll', status: { icon: '⏳', name: 'background-poll' } },
        claude_code: { bootstrap: 'eager', id: 'claude-code', status: { icon: '🤖', name: 'claude-code' } },
        comment_checker: { bootstrap: 'background', id: 'comment-checker', status: { icon: '💬', name: 'comment-checker' } },
        mcp: { bootstrap: 'eager', id: 'mcp', status: { icon: '🔌', name: 'mcp' } },
        meridian_session_affinity: {
          bootstrap: 'background',
          id: 'meridian-session-affinity',
          status: { icon: '🧭', name: 'meridian' },
        },
        prompt_rewind: { bootstrap: 'eager', id: 'prompt-rewind', status: { icon: '↩️', name: 'prompt-rewind' } },
        rules: { bootstrap: 'eager', id: 'rules', status: { icon: '📜', name: 'rules' } },
        safety_guard: { bootstrap: 'eager', id: 'safety-guard', status: { icon: '🛡️', name: 'cmd-guard' } },
        status_panel: { bootstrap: 'eager', id: 'status-panel', status: { icon: '📊', name: 'status-panel' } },
        sub_agents: { bootstrap: 'eager', id: 'sub-agents', status: { icon: '👥', name: 'sub-agents' } },
      })
    })
  )

  it.effect('the packaged entrypoint eagerly registers only enabled eager descriptors in config order', () =>
    Effect.gen(function* () {
      const { aggregate, features, registry } = yield* Effect.promise(() => registrationReport())
      const enabledEager = new Set(registry.filter(({ bootstrap }) => bootstrap === 'eager').map(({ id }) => id))
      const eagerFeatures = Object.fromEntries(
        Object.entries(features).filter(([, feature]) => feature.descriptor?.bootstrap === 'eager' && enabledEager.has(feature.descriptor.id))
      )
      const merged = mergedManifest(eagerFeatures)

      for (const key of ['commands', 'messageRenderers', 'tools'] as const) {
        expect(aggregate[key].toSorted(), key).toEqual(merged[key].toSorted())
      }
      expect(aggregate.handlers.toSorted()).toEqual([...merged.handlers, 'session_start', 'session_shutdown'].toSorted())
      expect(aggregate.handlers).toContain('resources_discover')
    })
  )

  /*
   * Asserted on the merged per-feature manifests rather than the aggregate: Pi keys tools and
   * commands by name, so a collision between two features is silently deduped in the aggregate.
   */
  it.effect('tool, command, and message renderer names are unique across features and well formed', () =>
    Effect.gen(function* () {
      const { features } = yield* Effect.promise(() => registrationReport())
      const merged = mergedManifest(features)

      for (const key of ['commands', 'messageRenderers', 'tools'] as const) {
        expect(merged[key].toSorted(), key).toEqual([...new Set(merged[key])].toSorted())
      }
      for (const tool of merged.tools) {
        expect(tool, tool).toMatch(SNAKE_CASE)
      }
      for (const command of merged.commands) {
        expect(command, command).toMatch(KEBAB_CASE)
      }
    })
  )
})
