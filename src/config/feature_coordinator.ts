import { type ExtensionAPI, type ExtensionContext, type SessionStartEvent, type SessionShutdownEvent } from '@earendil-works/pi-coding-agent'
import { Cause, Effect, Exit, Fiber, Result, Schema, Scope, Semaphore } from 'effect'

import { type AppRuntime, type AppServices, StatusBar } from '#shared/effect/app_services'
import { type FeatureImplementation, type FeaturePlugin } from '#shared/effect/feature'
import { type HandlerServices, makeEventHandler } from '#shared/effect/runtime'

type SafeReason =
  | 'activation failed'
  | 'activation defect'
  | 'deactivation failed'
  | 'deactivation defect'
  | 'preflight failed'
  | 'preflight defect'
  | 'registration failed; restart required'
export type FeatureHealth = { readonly _tag: 'checking' } | { readonly _tag: 'healthy' } | { readonly _tag: 'error'; readonly reason: SafeReason }
type Registration = 'unregistered' | 'registered' | 'poisoned'
interface FeatureRecord {
  readonly plugin: FeaturePlugin
  implementation?: FeatureImplementation
  registration: Registration
  health: FeatureHealth
}
interface Session {
  readonly key: string
  readonly generation: number
  phase: 'starting' | 'active' | 'stopping'
  teardownStarted: boolean
  readonly scope: Scope.Closeable
  readonly ctx: ExtensionContext
  readonly fibers: Fiber.Fiber<void, unknown>[]
}

export interface FeatureCoordinator {
  readonly install: () => void
}

const reason = (cause: Cause.Cause<unknown>, typed: SafeReason, defect: SafeReason): SafeReason =>
  Result.isSuccess(Cause.findFail(cause)) ? typed : defect

const configurationError = (message: string): never => {
  throw new Error(`Invalid feature configuration: ${message}`)
}

const FeatureStatusInput = Schema.Struct({ icon: Schema.optional(Schema.Unknown), name: Schema.optional(Schema.Unknown) })
const FeatureDescriptorInput = Schema.Struct({
  bootstrap: Schema.optional(Schema.Unknown),
  id: Schema.optional(Schema.Unknown),
  implementation: Schema.optional(Schema.Unknown),
  prepare: Schema.optional(Schema.Unknown),
  status: Schema.optional(Schema.Unknown),
})
const decodeFeatureDescriptor = (input: unknown) => {
  try {
    return Schema.decodeUnknownSync(FeatureDescriptorInput)(input)
  } catch {
    return configurationError('feature must be an object')
  }
}
const decodeFeatureStatus = (input: unknown, id: string) => {
  try {
    return Schema.decodeUnknownSync(FeatureStatusInput)(input)
  } catch {
    return configurationError(`${id} status must contain string icon and name`)
  }
}
const requireString = (value: unknown, message: string): string => (typeof value === 'string' ? value : configurationError(message))

const validateIdentity = (feature: unknown, id: unknown, ids: Set<string>, descriptors: Set<unknown>): string => {
  if (descriptors.has(feature)) {
    configurationError('duplicate descriptor')
  }
  descriptors.add(feature)
  const featureId = requireString(id, 'id must be a nonempty unique string')
  if (featureId.trim().length === 0 || ids.has(featureId)) {
    configurationError('id must be a nonempty unique string')
  }
  ids.add(featureId)
  return featureId
}

const validateStatus = (value: unknown, id: string): void => {
  const status = decodeFeatureStatus(value, id)
  const icon = requireString(status.icon, `${id} status must contain string icon and name`)
  const name = requireString(status.name, `${id} status must contain string icon and name`)
  if (icon.trim().length === 0 || name.trim().length === 0) {
    configurationError(`${id} status metadata must be nonempty`)
  }
}

const hasImplementationCallbacks = (value: Partial<FeatureImplementation>): value is FeatureImplementation =>
  typeof value.register === 'function' &&
  (value.activate === undefined || typeof value.activate === 'function') &&
  (value.deactivate === undefined || typeof value.deactivate === 'function')

const validateImplementation = (value: unknown, id: string): FeatureImplementation => {
  const message = `${id} implementation requires register and optional activate/deactivate functions`
  if (typeof value !== 'object' || value === null) {
    return configurationError(message)
  }
  try {
    const implementation = value as Partial<FeatureImplementation>
    if (!hasImplementationCallbacks(implementation)) {
      return configurationError(message)
    }
    return implementation
  } catch {
    return configurationError(message)
  }
}

const validateEager = (implementation: unknown, hasPrepare: boolean, id: string): void => {
  if (hasPrepare) {
    configurationError(`${id} eager descriptor requires an implementation with register and no prepare`)
  }
  validateImplementation(implementation, id)
}

const validateBackground = (prepare: unknown, hasImplementation: boolean, id: string): void => {
  if (hasImplementation || !Effect.isEffect(prepare)) {
    configurationError(`${id} background descriptor requires an Effect prepare and no implementation`)
  }
  if (id !== 'comment-checker' && id !== 'meridian-session-affinity') {
    configurationError(`${id} may not bootstrap in background`)
  }
}

const validate = (features: readonly unknown[]): void => {
  const ids = new Set<string>()
  const descriptors = new Set<unknown>()
  for (const feature of features) {
    const input = decodeFeatureDescriptor(feature)
    const id = validateIdentity(feature, input.id, ids, descriptors)
    validateStatus(input.status, id)
    if (input.bootstrap === 'eager') {
      validateEager(input.implementation, Object.hasOwn(input, 'prepare'), id)
    } else if (input.bootstrap === 'background') {
      validateBackground(input.prepare, Object.hasOwn(input, 'implementation'), id)
    } else {
      configurationError(`${id} bootstrap must be eager or background`)
    }
  }
}

/** Only unhealthy features earn a status slot; healthy and in-flight ones stay silent. */
const statusItem = (record: FeatureRecord) => {
  if (record.health._tag !== 'error') {
    return undefined
  }
  const { icon, name } = record.plugin.status
  return { icon, text: `${name}: ${record.health.reason}`, tone: 'error' as const }
}

const publish = (record: FeatureRecord): Effect.Effect<void, never, AppServices | HandlerServices> =>
  Effect.gen(function* () {
    const status = yield* StatusBar
    const channel = status.channel(`feature:${record.plugin.id}`)
    const item = statusItem(record)
    yield* item === undefined ? channel.clear : channel.set(item)
  }).pipe(Effect.ignoreCause)

export const makeFeatureCoordinator = (input: {
  readonly pi: ExtensionAPI
  readonly runtime: AppRuntime
  readonly features: readonly FeaturePlugin[]
}): FeatureCoordinator => {
  validate(input.features)
  const records: FeatureRecord[] = input.features.map((plugin) => ({
    health: { _tag: 'checking' },
    implementation: plugin.bootstrap === 'eager' ? plugin.implementation : undefined,
    plugin,
    registration: 'unregistered',
  }))
  const lifecycle = Semaphore.makeUnsafe(1)
  let installed = false
  let nextGeneration = 0
  let session: Session | undefined
  const current = (candidate: Session, stopping = false) =>
    session === candidate && candidate.generation === nextGeneration && (candidate.phase !== 'stopping' || stopping)

  const setHealth = (record: FeatureRecord, health: FeatureHealth) => {
    record.health = health
    return publish(record)
  }

  const activate = (candidate: Session, record: FeatureRecord, event: SessionStartEvent): Effect.Effect<void, never, AppServices | HandlerServices> =>
    Effect.gen(function* () {
      const { implementation } = record
      if (!current(candidate) || record.registration !== 'registered' || implementation === undefined) {
        return
      }
      if (implementation.activate !== undefined) {
        const activation = implementation.activate
        const fiber = yield* Effect.forkIn(
          Effect.suspend(() => activation(event, candidate.ctx)).pipe(Effect.provideService(Scope.Scope, candidate.scope)),
          candidate.scope
        )
        candidate.fibers.push(fiber)
        const exit = yield* Fiber.await(fiber)
        candidate.fibers.splice(candidate.fibers.indexOf(fiber), 1)
        if (Exit.isFailure(exit)) {
          if (current(candidate)) {
            yield* setHealth(record, { _tag: 'error', reason: reason(exit.cause, 'activation failed', 'activation defect') })
          }
          return
        }
      }
      if (current(candidate)) {
        yield* setHealth(record, { _tag: 'healthy' })
      }
    })

  const prepare = (candidate: Session, record: FeatureRecord, event: SessionStartEvent): Effect.Effect<void, never, AppServices | HandlerServices> =>
    Effect.gen(function* () {
      if (record.plugin.bootstrap !== 'background') {
        return
      }
      const exit = yield* Effect.exit(record.plugin.prepare)
      if (Exit.isFailure(exit)) {
        if (current(candidate)) {
          yield* setHealth(record, { _tag: 'error', reason: reason(exit.cause, 'preflight failed', 'preflight defect') })
        }
        return
      }
      const validation = yield* Effect.exit(Effect.sync(() => validateImplementation(exit.value, record.plugin.id)))
      if (Exit.isFailure(validation)) {
        if (current(candidate)) {
          yield* setHealth(record, { _tag: 'error', reason: 'preflight defect' })
        }
        return
      }
      if (!current(candidate) || record.registration !== 'unregistered') {
        return
      }
      record.implementation = validation.value
      const registered = yield* Effect.exit(Effect.sync(() => validation.value.register(input.pi, input.runtime)))
      if (Exit.isFailure(registered)) {
        record.registration = 'poisoned'
        if (current(candidate)) {
          yield* setHealth(record, { _tag: 'error', reason: 'registration failed; restart required' })
        }
        return
      }
      record.registration = 'registered'
      yield* activate(candidate, record, event)
    })

  const requestStop = (candidate: Session): Effect.Effect<void> =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        if (session === candidate) {
          candidate.phase = 'stopping'
          yield* Fiber.interruptAll(candidate.fibers)
        }
      })
    )

  const stop = (candidate: Session, why: 'shutdown' | 'replaced'): Effect.Effect<void, never, AppServices | HandlerServices> =>
    Effect.uninterruptibleMask(() =>
      Effect.gen(function* () {
        if (session !== candidate || candidate.teardownStarted) {
          return
        }
        candidate.teardownStarted = true
        candidate.phase = 'stopping'
        yield* Fiber.interruptAll(candidate.fibers)
        for (const record of records) {
          const deactivation = record.implementation?.deactivate
          if (record.registration !== 'registered' || deactivation === undefined) {
            continue
          }
          const exit = yield* Effect.exit(Effect.suspend(() => deactivation(candidate.ctx, why)))
          if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause) && current(candidate, true)) {
            yield* setHealth(record, { _tag: 'error', reason: reason(exit.cause, 'deactivation failed', 'deactivation defect') })
          }
        }
        yield* Effect.exit(Scope.close(candidate.scope, Exit.void))
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (session === candidate) {
              session = undefined
            }
          })
        )
      )
    )

  const start = (event: SessionStartEvent, ctx: ExtensionContext): Effect.Effect<void, never, AppServices | HandlerServices> =>
    Effect.gen(function* () {
      const key = ctx.sessionManager.getSessionId()
      if (typeof key !== 'string' || key.length === 0) {
        return
      }
      const ticket = ++nextGeneration
      const active = session
      if (active !== undefined) {
        yield* requestStop(active)
      }
      yield* lifecycle.withPermits(1)(
        Effect.gen(function* () {
          if (ticket !== nextGeneration) {
            return
          }
          if (session !== undefined) {
            yield* stop(session, 'replaced')
          }
          if (ticket !== nextGeneration) {
            return
          }
          const candidate: Session = {
            ctx,
            fibers: [],
            generation: ticket,
            key,
            phase: 'starting',
            scope: yield* Scope.make('sequential'),
            teardownStarted: false,
          }
          session = candidate
          for (const record of records) {
            if (ticket !== nextGeneration) {
              return
            }
            yield* setHealth(
              record,
              record.registration === 'poisoned' ? { _tag: 'error', reason: 'registration failed; restart required' } : { _tag: 'checking' }
            )
          }
          if (ticket !== nextGeneration) {
            return
          }
          for (const record of records) {
            if (record.registration === 'registered') {
              yield* activate(candidate, record, event)
            }
          }
          for (const record of records) {
            if (record.plugin.bootstrap === 'background' && record.registration === 'unregistered' && current(candidate)) {
              candidate.fibers.push(yield* Effect.forkIn(prepare(candidate, record, event), candidate.scope))
            }
          }
          if (current(candidate)) {
            candidate.phase = 'active'
          }
        })
      )
    })

  const end = (_event: SessionShutdownEvent, ctx: ExtensionContext): Effect.Effect<void, never, AppServices | HandlerServices> =>
    Effect.gen(function* () {
      const candidate = session
      if (candidate === undefined || ctx.sessionManager.getSessionId() !== candidate.key) {
        return
      }
      yield* requestStop(candidate)
      yield* lifecycle.withPermits(1)(stop(candidate, 'shutdown'))
    })

  return {
    install: () => {
      if (installed) {
        return
      }
      installed = true
      for (const record of records) {
        const { implementation } = record
        if (record.plugin.bootstrap !== 'eager' || implementation === undefined) {
          continue
        }
        try {
          implementation.register(input.pi, input.runtime)
          record.registration = 'registered'
        } catch {
          record.registration = 'poisoned'
          record.health = { _tag: 'error', reason: 'registration failed; restart required' }
        }
      }
      input.pi.on('session_start', makeEventHandler(input.runtime)(start))
      input.pi.on('session_shutdown', makeEventHandler(input.runtime)(end))
    },
  }
}

export const registerFeatures = (pi: ExtensionAPI, runtime: AppRuntime, features: readonly FeaturePlugin[]): void =>
  makeFeatureCoordinator({ features, pi, runtime }).install()
