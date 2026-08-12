import { fileURLToPath } from 'node:url'

import { NodeFileSystem, NodePath } from '@effect/platform-node'
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

type Manifest = Record<(typeof MANIFEST_KEYS)[number], string[]>

interface FeatureReport {
  exportsDefault: boolean
  exportsRegister: boolean
  manifest: Manifest
}

interface RegistrationReport {
  aggregate: Manifest
  features: Record<string, FeatureReport>
  registryNames: string[]
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
    }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)))
  )

const toFeatureName = (directory: string): string => directory.replaceAll('_', '-')

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
    if (exportsRegister) {
      module.register(fixture.pi, runtime);
    }
    report.features[directory] = {
      exportsDefault: module.default !== undefined,
      exportsRegister,
      manifest: snapshot(fixture.state),
    };
  }

  const { features } = await import(${JSON.stringify(PATHS.registry)});
  report.registryNames = features.map(feature => feature.name);
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

const mergedManifest = (features: Record<string, FeatureReport>): Manifest => {
  const manifests = Object.values(features).map((feature) => feature.manifest)
  const collect = (key: keyof Manifest): string[] => manifests.flatMap((manifest) => manifest[key])
  return { commands: collect('commands'), handlers: collect('handlers'), messageRenderers: collect('messageRenderers'), tools: collect('tools') }
}

const registrationCount = (manifest: Manifest): number => MANIFEST_KEYS.reduce((total, key) => total + manifest[key].length, 0)

describe('registration', () => {
  it.effect('the registry wires every feature directory exactly once', () =>
    Effect.gen(function* () {
      const { registryNames } = yield* Effect.promise(() => registrationReport())
      const directories = yield* Effect.promise(() => featureDirectories())

      expect(registryNames.toSorted()).toEqual(directories.map(toFeatureName).toSorted())
      expect(new Set(registryNames).size).toBe(registryNames.length)
    })
  )

  it.effect('every feature exposes only a named register entrypoint that registers something', () =>
    Effect.gen(function* () {
      const { features } = yield* Effect.promise(() => registrationReport())

      for (const [directory, feature] of Object.entries(features)) {
        expect(feature.exportsRegister, directory).toBeTrue()
        expect(feature.exportsDefault, directory).toBeFalse()
        expect(registrationCount(feature.manifest), directory).toBeGreaterThan(0)
      }
    })
  )

  it.effect('the packaged entrypoint registers exactly what the features register on their own', () =>
    Effect.gen(function* () {
      const { aggregate, features } = yield* Effect.promise(() => registrationReport())
      const merged = mergedManifest(features)

      for (const key of MANIFEST_KEYS) {
        expect(aggregate[key].toSorted(), key).toEqual(merged[key].toSorted())
      }
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
