import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Effect } from 'effect'

import { type ProcessRuntime } from '#config/runtime'
import { nodeFileSystem, nodePath } from '#shared/effect/node_services'
import { asResult } from '#tests/utils/casts'
import { describe, expect, it } from '#tests/utils/effect'
import { createFakePi, type FakePiState } from '#tests/utils/fake_pi'

/*
 * These are package contracts, not an inventory: every expectation is derived from the feature
 * folders on disk, so adding or removing a feature never requires editing this file.
 */

const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/

const MANIFEST_KEYS = ['commands', 'handlers', 'messageRenderers', 'tools'] as const

type Manifest = Record<(typeof MANIFEST_KEYS)[number], string[]>

interface FeatureModule {
  default?: unknown
  register?: (pi: ExtensionAPI, runtime: ProcessRuntime) => void
}

const FEATURES_DIR = nodePath.resolve(import.meta.dirname, '../src/features')

const toFeatureName = (directory: string): string => directory.replaceAll('_', '-')

const snapshot = (state: FakePiState) =>
  ({
    commands: [...state.commands.keys()],
    handlers: [...state.handlers.entries()].flatMap(([event, handlers]) => handlers.map(() => event)),
    messageRenderers: [...state.messageRenderers],
    tools: [...state.tools.keys()],
  }) satisfies Manifest

const registrationCount = (manifest: Manifest): number => MANIFEST_KEYS.reduce((total, key) => total + manifest[key].length, 0)

const mergedManifest = (manifests: Manifest[]) => {
  const collect = (key: keyof Manifest): string[] => manifests.flatMap((manifest) => manifest[key])
  return {
    commands: collect('commands'),
    handlers: collect('handlers'),
    messageRenderers: collect('messageRenderers'),
    tools: collect('tools'),
  } satisfies Manifest
}

// Features register differently inside a subagent, so this worker must look like a top-level Pi run.
delete process.env.PI_SUBAGENT_OWNER_TOKEN

const { getOrCreateProcessRuntime } = await import('#config/runtime')
const { default: piExtensions } = await import('../src/index')

const runtime = getOrCreateProcessRuntime()
const features = await Effect.runPromise(
  Effect.gen(function* () {
    const names = yield* nodeFileSystem.readDirectory(FEATURES_DIR)
    const entries = yield* Effect.forEach(
      names,
      (name) => nodeFileSystem.stat(nodePath.join(FEATURES_DIR, name)).pipe(Effect.map((info) => ({ info, name }))),
      {}
    )
    return yield* Effect.forEach(
      entries.filter(({ info }) => info.type === 'Directory').map(({ name }) => name),
      (directory) =>
        Effect.promise(() => import(nodePath.join(FEATURES_DIR, directory, 'index.ts'))).pipe(
          Effect.map((imported) => {
            const module = asResult<FeatureModule>(imported)
            const fixture = createFakePi()
            module.register?.(fixture.pi, runtime)
            return {
              directory,
              exportsDefault: module.default !== undefined,
              exportsRegister: typeof module.register === 'function',
              manifest: snapshot(fixture.state),
            }
          })
        ),
      {}
    )
  })
)
const aggregate = createFakePi()
piExtensions(aggregate.pi)
const merged = mergedManifest(features.map((feature) => feature.manifest))

describe('registration', () => {
  it.effect('the registry wires every feature directory exactly once', () =>
    Effect.gen(function* () {
      const { features: registry } = yield* Effect.promise(() => import('#config/features'))
      const registryNames = registry.map((feature) => feature.name)

      expect(registryNames.toSorted()).toEqual(features.map((feature) => toFeatureName(feature.directory)).toSorted())
      expect(new Set(registryNames).size).toBe(registryNames.length)
    })
  )

  it.effect('every feature exposes only a named register entrypoint that registers something', () =>
    Effect.sync(() => {
      for (const feature of features) {
        expect(feature.exportsRegister, feature.directory).toBe(true)
        expect(feature.exportsDefault, feature.directory).toBe(false)
        expect(registrationCount(feature.manifest), feature.directory).toBeGreaterThan(0)
      }
    })
  )

  it.effect('the packaged entrypoint registers exactly what the features register on their own', () =>
    Effect.sync(() => {
      const aggregated = snapshot(aggregate.state)
      for (const key of MANIFEST_KEYS) {
        expect(aggregated[key].toSorted(), key).toEqual(merged[key].toSorted())
      }
    })
  )

  /*
   * Asserted on the merged per-feature manifests rather than the aggregate: Pi keys tools and
   * commands by name, so a collision between two features is silently deduped in the aggregate.
   */
  it.effect('tool, command, and message renderer names are unique across features and well formed', () =>
    Effect.sync(() => {
      for (const key of ['commands', 'messageRenderers', 'tools'] as const) {
        expect(merged[key].toSorted(), key).toEqual([...new Set(merged[key])].toSorted())
      }
      for (const tool of merged.tools) {
        expect(tool, tool).toMatch(SNAKE_CASE)
      }
      for (const command of merged.commands) {
        expect(command, command).toMatch(KEBAB_CASE)
      }
      for (const feature of features) {
        expect(feature.directory, feature.directory).toMatch(SNAKE_CASE)
      }
    })
  )
})
