import { type AgentSettledEvent, type ExtensionAPI, type ExtensionContext, type SessionStartEvent } from '@earendil-works/pi-coding-agent'
import { Function } from 'effect'

import { type AppRuntime } from '@/shared/effect/app_services.js'
import { isNullOrUndefined } from '@/shared/utils/predicates.js'

const COMPACTION_THRESHOLD_TOKENS = 300_000

const registerImpl = (pi: ExtensionAPI, _runtime: AppRuntime): void => {
  let armed = true
  let compacting = false
  let sessionGeneration = 0

  const reset = (): void => {
    sessionGeneration += 1
    armed = true
    compacting = false
  }

  const compact = (ctx: ExtensionContext): void => {
    const generation = sessionGeneration
    armed = false
    compacting = true

    try {
      ctx.compact({
        onComplete: () => {
          if (generation === sessionGeneration) {
            compacting = false
          }
        },
        onError: () => {
          if (generation === sessionGeneration) {
            armed = true
            compacting = false
          }
        },
      })
    } catch {
      if (generation === sessionGeneration) {
        armed = true
        compacting = false
      }
    }
  }

  pi.on('session_start', (_event: SessionStartEvent) => {
    reset()
  })

  pi.on('agent_settled', (_event: AgentSettledEvent, ctx: ExtensionContext) => {
    const tokens = ctx.getContextUsage()?.tokens
    if (isNullOrUndefined(tokens)) {
      return
    }
    if (tokens < COMPACTION_THRESHOLD_TOKENS) {
      armed = true
      return
    }
    if (armed && !compacting) {
      compact(ctx)
    }
  })
}

export const register: {
  (runtime: AppRuntime): (pi: ExtensionAPI) => void
  (pi: ExtensionAPI, runtime: AppRuntime): void
} = Function.dual((args) => typeof args[0].on === 'function', registerImpl)
