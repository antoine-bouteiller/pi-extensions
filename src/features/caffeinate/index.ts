import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Effect } from 'effect'

import { type AppRuntime } from '#shared/effect/app_services'
import { type FeaturePlugin } from '#shared/effect/feature'

import { makeKeepAwake, productionDependencies, type CaffeinateDependencies } from './keep_awake.js'

type EagerFeaturePlugin = Extract<FeaturePlugin, { readonly bootstrap: 'eager' }>

export const makeFeature = (dependencies: CaffeinateDependencies = productionDependencies) => {
  const keepAwake = makeKeepAwake(dependencies)

  return {
    bootstrap: 'eager',
    id: 'caffeinate',
    implementation: {
      deactivate: (_ctx: ExtensionContext, _reason) => Effect.promise(() => keepAwake.stop()).pipe(Effect.ignore),
      register: (pi: ExtensionAPI, _runtime: AppRuntime): void => {
        if (dependencies.isSubagent) {
          return
        }

        pi.on('agent_start', keepAwake.start)
        pi.on('agent_settled', (_event, ctx) => (ctx.isIdle() ? keepAwake.stop() : undefined))
      },
    },
    status: { icon: '☕', name: 'caffeinate' },
  } satisfies EagerFeaturePlugin
}

export const feature = makeFeature()
