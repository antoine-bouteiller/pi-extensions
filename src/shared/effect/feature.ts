import { type ExtensionAPI, type ExtensionContext, type SessionStartEvent } from '@earendil-works/pi-coding-agent'
import { type Effect, type Scope } from 'effect'

import { type AppRuntime, type AppServices } from './app_services.js'
import { type HandlerServices } from './runtime.js'

export interface FeaturePreflightError {
  readonly _tag: string
  readonly reason?: string
}

export interface FeatureActivationError {
  readonly _tag: string
  readonly reason?: string
}

export interface FeatureStatusMetadata {
  readonly icon: string
  readonly name: string
}

export interface FeatureIdentity {
  readonly id: string
  readonly suppressInChild?: boolean
  readonly status: FeatureStatusMetadata
}

type StopReason = 'shutdown' | 'replaced'

export interface FeatureImplementation {
  readonly register: (pi: ExtensionAPI, runtime: AppRuntime) => void
  readonly activate?: (
    event: SessionStartEvent,
    ctx: ExtensionContext
  ) => Effect.Effect<void, FeatureActivationError, AppServices | HandlerServices | Scope.Scope>
  readonly deactivate?: (ctx: ExtensionContext, reason: StopReason) => Effect.Effect<void, FeatureActivationError, AppServices | HandlerServices>
}

export type FeaturePlugin =
  | (FeatureIdentity & { readonly bootstrap: 'eager'; readonly implementation: FeatureImplementation })
  | (FeatureIdentity & {
      readonly bootstrap: 'background'
      readonly prepare: Effect.Effect<FeatureImplementation, FeaturePreflightError, AppServices>
    })
