import { Context, Effect, Layer, type ManagedRuntime } from 'effect'
import { type Crypto } from 'effect/Crypto'
import { type FileSystem } from 'effect/FileSystem'
import { type Path } from 'effect/Path'
import { type HttpClient } from 'effect/unstable/http'
import { type ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'

import { formatStatusText, publishStatus, type StatusEntry, type StatusItem, statusBar } from '#shared/state/status_bar'

import { type Env } from './env.js'
import { Ui } from './pi_services.js'

interface StatusChannel {
  readonly set: (item: StatusItem) => Effect.Effect<void, never, Ui>
  readonly clear: Effect.Effect<void, never, Ui>
}

/*
 * Reads stay synchronous on purpose: the status panel calls them from TUI paint callbacks, which
 * cannot await. Only the parts that touch Pi's UI are effects.
 */
export interface StatusBarApi {
  readonly has: (key: string) => boolean
  readonly list: () => readonly StatusEntry[]
  readonly subscribe: (listener: () => void) => () => void
  readonly channel: (key: string, defaults?: Partial<StatusItem>) => StatusChannel
}

export class StatusBar extends Context.Service<StatusBar, StatusBarApi>()('pi-extensions/shared/effect/app_services/StatusBar') {}

const statusChannel = (key: string, defaults: Partial<StatusItem> = {}): StatusChannel => ({
  clear: Effect.gen(function* () {
    const ui = yield* Ui
    publishStatus(key, undefined)
    // Guarding on hasUI, never on mode === 'tui', is what keeps RPC mode mirroring as it does today.
    if (yield* ui.hasUI) {
      yield* ui.setStatus(key, undefined)
    }
  }),
  set: (item) =>
    Effect.gen(function* () {
      const ui = yield* Ui
      const entry = { ...defaults, ...item }
      publishStatus(key, entry)
      if (yield* ui.hasUI) {
        yield* ui.setStatus(key, formatStatusText(entry))
      }
    }),
})

/**
 * Deliberately backed by the module-level singletons. Extensions load once per process and Node's
 * module cache is what makes status entries available across ManagedRuntime boundaries. Layer
 * memoisation does not cross runtimes, so constructing fresh stores per runtime would silently
 * give each feature its own empty store.
 */
export const StatusBarLive: Layer.Layer<StatusBar> = Layer.succeed(StatusBar)({
  channel: statusChannel,
  has: statusBar.has,
  list: statusBar.list,
  subscribe: statusBar.subscribe,
})

export type AppServices = FileSystem | Path | Crypto | HttpClient.HttpClient | StatusBar | ChildProcessSpawner | Env

export type AppRuntime = ManagedRuntime.ManagedRuntime<AppServices, never>
