import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Effect, Path } from 'effect'
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'

import { type AppRuntime } from '#shared/effect/app_services'
import { type FeatureImplementation, type FeaturePlugin, type FeaturePreflightError } from '#shared/effect/feature'
import { makeEventHandler } from '#shared/effect/runtime'

import { makeCheckerHandler, makeCommentCheckerRunner, type CheckerRunner } from './checker.js'

export interface CommentCheckerDependencies {
  readonly makeRunner?: (executable: string) => CheckerRunner
  readonly which: (executable: string) => string | null | undefined
}

type BackgroundFeaturePlugin = Extract<FeaturePlugin, { readonly bootstrap: 'background' }>
type SpawnerBackgroundFeaturePlugin = Omit<BackgroundFeaturePlugin, 'prepare'> & {
  readonly prepare: Effect.Effect<FeatureImplementation, FeaturePreflightError, Path.Path | ChildProcessSpawner>
}
type TestBackgroundFeaturePlugin = Omit<BackgroundFeaturePlugin, 'prepare'> & {
  readonly prepare: Effect.Effect<FeatureImplementation, FeaturePreflightError, Path.Path>
}
type TestCommentCheckerDependencies = CommentCheckerDependencies & {
  readonly makeRunner: (executable: string) => CheckerRunner
}

const preflightError = () => ({ _tag: 'CommentCheckerUnavailable' }) as const

const productionDependencies: CommentCheckerDependencies = { which: Bun.which }

export function makeFeature(dependencies: TestCommentCheckerDependencies): TestBackgroundFeaturePlugin
export function makeFeature(dependencies?: CommentCheckerDependencies): SpawnerBackgroundFeaturePlugin
export function makeFeature(dependencies: CommentCheckerDependencies = productionDependencies): BackgroundFeaturePlugin {
  return {
    bootstrap: 'background',
    id: 'comment-checker',
    prepare: Effect.gen(function* () {
      const path = yield* Path.Path
      const executable = yield* Effect.try({
        catch: preflightError,
        try: () => dependencies.which('comment-checker'),
      })
      if (executable === undefined || executable === null || !path.isAbsolute(executable)) {
        return yield* Effect.fail(preflightError())
      }
      let runner: CheckerRunner
      if (dependencies.makeRunner === undefined) {
        const spawner = yield* ChildProcessSpawner
        runner = makeCommentCheckerRunner(executable, (command) => spawner.spawn(command))
      } else {
        runner = dependencies.makeRunner(executable)
      }
      return {
        register: (pi: ExtensionAPI, runtime: AppRuntime): void => {
          pi.on('tool_result', makeEventHandler(runtime)(makeCheckerHandler(runner)))
        },
      }
    }),
    status: { icon: '💬', name: 'comment-checker' },
  } satisfies BackgroundFeaturePlugin
}

export const feature = makeFeature()
