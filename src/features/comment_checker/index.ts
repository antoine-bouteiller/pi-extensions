import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Effect, Path } from 'effect'

import { type AppRuntime } from '#shared/effect/app_services'
import { type FeaturePlugin } from '#shared/effect/feature'
import { makeEventHandler } from '#shared/effect/runtime'

import { makeCheckerHandler, makeCommentCheckerRunner, type CheckerRunner } from './checker.js'

export interface CommentCheckerDependencies {
  readonly makeRunner?: (executable: string) => CheckerRunner
  readonly which: (executable: string) => string | null | undefined
}

type BackgroundFeaturePlugin = Extract<FeaturePlugin, { readonly bootstrap: 'background' }>

const preflightError = () => ({ _tag: 'CommentCheckerUnavailable' }) as const

const productionDependencies: CommentCheckerDependencies = {
  makeRunner: makeCommentCheckerRunner,
  which: Bun.which,
}

export const makeFeature = (dependencies: CommentCheckerDependencies = productionDependencies) =>
  ({
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
      return {
        register: (pi: ExtensionAPI, runtime: AppRuntime): void => {
          pi.on('tool_result', makeEventHandler(runtime)(makeCheckerHandler((dependencies.makeRunner ?? makeCommentCheckerRunner)(executable))))
        },
      }
    }),
    status: { icon: '💬', name: 'comment-checker' },
  }) satisfies BackgroundFeaturePlugin

export const feature = makeFeature()
