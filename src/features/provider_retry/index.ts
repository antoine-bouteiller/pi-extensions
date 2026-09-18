import { Effect } from 'effect'

import { type FeaturePlugin } from '#shared/effect/feature'
import { makeEventHandler } from '#shared/effect/runtime'

import { classifyProviderError } from './retry.js'

export const feature = (() => ({
  bootstrap: 'eager',
  id: 'provider-retry',
  implementation: {
    register: (pi, runtime) => {
      let responseStatus: number | undefined
      pi.on(
        'before_provider_request',
        makeEventHandler(runtime)(() =>
          Effect.sync(() => {
            responseStatus = undefined
          })
        )
      )
      pi.on(
        'after_provider_response',
        makeEventHandler(runtime)((event) =>
          Effect.sync(() => {
            responseStatus = event.status
          })
        )
      )
      pi.on(
        'message_end',
        makeEventHandler(runtime)((event) =>
          Effect.sync(() => {
            const result = classifyProviderError(event, responseStatus)
            if (event.message.role === 'assistant') {
              responseStatus = undefined
            }
            return result
          })
        )
      )
    },
  },
  status: { icon: '↻', name: 'retry' },
})) satisfies FeaturePlugin
