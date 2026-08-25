import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Effect } from 'effect'

import { type AppRuntime } from '#shared/effect/app_services'
import { type FeaturePlugin } from '#shared/effect/feature'
import { makeEventHandler } from '#shared/effect/runtime'

import { makeKeepAwake, productionDependencies, type CaffeinateDependencies } from './keep_awake.js'

type EagerFeaturePlugin = Extract<FeaturePlugin, { readonly bootstrap: 'eager' }>

export const makeFeature = (dependencies: CaffeinateDependencies = productionDependencies) => {
  const keepAwake = makeKeepAwake(dependencies)

  return {
    bootstrap: 'eager',
    id: 'caffeinate',
    implementation: {
      deactivate: (_ctx: ExtensionContext, _reason) => keepAwake.stop,
      register: (pi: ExtensionAPI, runtime: AppRuntime): void => {
        if (dependencies.isSubagent) {
          return
        }

        pi.on(
          'agent_start',
          makeEventHandler(runtime)(() => keepAwake.start)
        )
        pi.on(
          'agent_settled',
          makeEventHandler(runtime)((_event, ctx) => (ctx.isIdle() ? keepAwake.stop : Effect.void))
        )
      },
    },
    status: { icon: '☕', name: 'caffeinate' },
  } satisfies EagerFeaturePlugin
}

export const feature = makeFeature()
