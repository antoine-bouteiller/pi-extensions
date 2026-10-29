import { fileURLToPath } from 'node:url'

import { type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Clock, Effect, Option, Scope, Semaphore } from 'effect'
import { Crypto } from 'effect/Crypto'
import { FileSystem } from 'effect/FileSystem'
import { Path } from 'effect/Path'
import { type Static, type TSchema, Type } from 'typebox'
import { Value } from 'typebox/value'

import { type EnvApi } from '#shared/effect/env'
import { jsonText, parseJsonText } from '#shared/utils/json'

import { type OpenRequest, type Peer, type PeerBackend, peerError } from './peers.js'

const PresenceSchema = Type.Object({
  block_id: Type.String({ minLength: 1 }),
  cwd: Type.String(),
  inbox: Type.String({ minLength: 1 }),
  pid: Type.Integer(),
  rex_session: Type.String({ minLength: 1 }),
  session_file: Type.Optional(Type.String()),
})
type Presence = Static<typeof PresenceSchema>
const InboxMessageSchema = Type.Object({ text: Type.String() })
const SessionsSchema = Type.Object({ sessions: Type.Array(Type.Object({ label: Type.Optional(Type.String()), session_id: Type.String() })) })
const StatusSchema = Type.Object({
  records: Type.Array(Type.Object({ effective_app: Type.Optional(Type.String()), id: Type.Optional(Type.String()), state: Type.String() })),
})
const CreatedWindowSchema = Type.Object({ block_ids: Type.Array(Type.String(), { minItems: 1 }) })
const CreatedSessionSchema = Type.Object({
  initial_windows: Type.Array(Type.Object({ block_ids: Type.Array(Type.String(), { minItems: 1 }) }), { minItems: 1 }),
  session_id: Type.String(),
})

const INBOX_INTERVAL = '1 second'
const PRESENCE_POLL = '250 millis'
const PRESENCE_TIMEOUT = '30 seconds'

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const parseOrUndefined = (text: string): unknown => {
  try {
    return parseJsonText(text)
  } catch {
    return undefined
  }
}
/** Exit 3 with `not found` is how Rex reports a missing block or session. */
const isNotFound = (result: { code: number; stderr: string }) => result.code === 3 && result.stderr.includes('not found')

/** The block foreground process is often a wrapper, so a peer is live only when its own recorded pid still runs. */
const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

/**
 * Any blocked record wins, since an open dialog is the state worth surfacing; otherwise Pi's root record; otherwise unknown.
 *
 * @internal
 */
export const rexStatus = (records: Static<typeof StatusSchema>['records']): string => {
  if (records.some((record) => record.state === 'blocked')) {
    return 'blocked'
  }
  const root = records.find((record) => record.id === undefined)
  return root?.effective_app === 'pi' ? root.state : 'unknown'
}

const failed = (result: { stderr: string }) => peerError(result.stderr.trim().slice(0, 2000) || 'Rex command failed or timed out.')

const writeAtomically = (file: string, value: unknown) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const crypto = yield* Crypto
    const pending = `${file}.${yield* crypto.randomUUIDv4()}.tmp`
    yield* fs.writeFileString(pending, jsonText(value))
    yield* fs.rename(pending, file)
  }).pipe(Effect.mapError((error) => peerError(error.message)))

const writeInbox = (directory: string, text: string) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto
    const now = yield* Clock.currentTimeMillis
    yield* writeAtomically(`${directory}/${String(now).padStart(13, '0')}-${yield* crypto.randomUUIDv4()}.json`, { text })
  }).pipe(Effect.mapError((error) => (error._tag === 'PeerError' ? error : peerError(error.message))))

export interface RexOptions {
  readonly agentDir: string
  readonly alive?: (pid: number) => boolean
}

export const makeRexBackend = (pi: ExtensionAPI, environment: EnvApi, options: RexOptions): PeerBackend => {
  const rex = environment.all.REX_BIN_DIR === undefined ? 'rex' : `${environment.all.REX_BIN_DIR}/rex`
  const alive = options.alive ?? processAlive
  const block = environment.all.REX_BLOCK ?? ''
  const session = environment.all.REX_SESSION ?? ''
  const root = `${options.agentDir}/peers/rex`
  const presenceFile = (blockId: string) => `${root}/presence/${blockId.replaceAll(':', '_')}.json`
  /** Keyed by parent session and target directory. */
  const sessions = new Map<string, string>()
  const placement = Semaphore.makeUnsafe(1)
  let inbox: string | undefined

  const exec = (cwd: string, args: string[]) =>
    Effect.tryPromise({
      catch: (error) => peerError(errorMessage(error)),
      try: () => pi.exec(rex, args, { cwd, timeout: 40_000 }),
    })
  const request = <Schema extends TSchema>(cwd: string, args: string[], schema: Schema) =>
    Effect.gen(function* () {
      const result = yield* exec(cwd, args)
      if (result.code !== 0 || result.killed) {
        return yield* failed(result)
      }
      const value = parseOrUndefined(result.stdout)
      if (!Value.Check(schema, value)) {
        return yield* peerError('Rex returned an unexpected response.')
      }
      return value
    })

  const readPresence = (blockId: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem
      const text = yield* fs.readFileString(presenceFile(blockId)).pipe(Effect.option)
      if (Option.isNone(text)) {
        return Option.none<Presence>()
      }
      const record = parseOrUndefined(text.value)
      return Value.Check(PresenceSchema, record) && record.block_id === blockId ? Option.some(record) : Option.none<Presence>()
    })

  /** None when the record's process or block is gone. */
  const livePeer = (cwd: string, record: Presence, labels?: ReadonlyMap<string, string>) =>
    Effect.gen(function* () {
      if (!alive(record.pid)) {
        return Option.none<Peer>()
      }
      const inspected = yield* exec(cwd, ['block', 'inspect', '-s', record.rex_session, record.block_id, '--json'])
      if (isNotFound(inspected)) {
        return Option.none<Peer>()
      }
      if (inspected.code !== 0 || inspected.killed) {
        return yield* failed(inspected)
      }
      const { records } = yield* request(cwd, ['block', 'call', '-s', record.rex_session, '-b', record.block_id, 'program_status'], StatusSchema)
      return Option.some<Peer>({
        cwd: record.cwd,
        group: labels?.get(record.rex_session) ?? record.rex_session,
        id: record.block_id,
        status: rexStatus(records),
      })
    })

  const drain = (ctx: ExtensionContext, directory: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem
      const crypto = yield* Crypto
      const names = yield* fs.readDirectory(directory)
      for (const name of names.filter((candidate) => candidate.endsWith('.json')).toSorted()) {
        const file = `${directory}/${name}`
        const claimed = `${file}.${yield* crypto.randomUUIDv4()}.claimed`
        const renamed = yield* fs.rename(file, claimed).pipe(
          Effect.as(true),
          Effect.catchIf(
            (error) => error.reason._tag === 'NotFound',
            () => Effect.succeed(false)
          )
        )
        if (!renamed) {
          continue
        }
        const message = parseOrUndefined(yield* fs.readFileString(claimed))
        if (Value.Check(InboxMessageSchema, message)) {
          if (ctx.isIdle()) {
            pi.sendUserMessage(message.text)
          } else {
            pi.sendUserMessage(message.text, { deliverAs: 'steer' })
          }
        }
        yield* fs.remove(claimed, { force: true })
      }
    })

  const caller = () =>
    Effect.gen(function* () {
      const own = yield* readPresence(block)
      if (block === '' || session === '' || Option.isNone(own) || own.value.pid !== process.pid || own.value.rex_session !== session) {
        return yield* peerError('Rex does not identify this block as the current Pi session.')
      }
      return { group: session, id: block, status: 'working' } satisfies Peer
    })

  const openWindow = (ctx: ExtensionContext, label: string, directory: string | undefined, command: string[]) =>
    Effect.gen(function* () {
      const path = yield* Path
      const target = directory ?? ctx.cwd
      const inSession = (rexSession: string) =>
        exec(ctx.cwd, ['window', 'new', '-s', rexSession, label, '--focus=false', '-c', target, '--json', '--', ...command])
      const createSession = (key: string) =>
        request(ctx.cwd, ['new', path.basename(target), '-c', target, '--window', label, '--json', '--', ...command], CreatedSessionSchema).pipe(
          Effect.tap((created) => Effect.sync(() => sessions.set(key, created.session_id))),
          Effect.map((created) => ({ block: created.initial_windows[0]?.block_ids[0] ?? '', session: created.session_id }))
        )
      const known = directory === undefined ? session : sessions.get(`${ctx.sessionManager.getSessionFile()}\n${directory}`)
      const key = `${ctx.sessionManager.getSessionFile()}\n${directory}`
      if (known === undefined) {
        return yield* createSession(key)
      }
      const result = yield* inSession(known)
      if (directory !== undefined && isNotFound(result)) {
        return yield* createSession(key)
      }
      if (result.code !== 0 || result.killed) {
        return yield* failed(result)
      }
      const created = parseOrUndefined(result.stdout)
      if (!Value.Check(CreatedWindowSchema, created)) {
        return yield* peerError('Rex returned an unexpected response.')
      }
      return { block: created.block_ids[0] ?? '', session: known }
    })

  const awaitPresence = (blockId: string, expectedInbox: string) =>
    readPresence(blockId).pipe(
      Effect.flatMap((record) =>
        Option.isSome(record) && record.value.inbox === expectedInbox && alive(record.value.pid)
          ? Effect.succeed(true)
          : Effect.sleep(PRESENCE_POLL).pipe(Effect.as(false))
      ),
      Effect.repeat({ until: (found) => found }),
      Effect.timeoutOption(PRESENCE_TIMEOUT),
      Effect.map(Option.isSome)
    )

  return {
    activate: (ctx) =>
      Effect.gen(function* () {
        if (ctx.mode !== 'tui' || block === '' || session === '') {
          return
        }
        const fs = yield* FileSystem
        const crypto = yield* Crypto
        inbox ??= environment.all.PI_REX_INBOX ?? `${root}/inbox/${process.pid}-${yield* crypto.randomUUIDv4()}`
        const directory = inbox
        yield* fs.makeDirectory(directory, { recursive: true })
        yield* fs.makeDirectory(`${root}/presence`, { recursive: true })
        const sessionFile = ctx.sessionManager.getSessionFile()
        yield* writeAtomically(presenceFile(block), {
          block_id: block,
          cwd: ctx.cwd,
          inbox: directory,
          pid: process.pid,
          rex_session: session,
          ...(sessionFile !== undefined && { session_file: sessionFile }),
        } satisfies Presence)
        const scope = yield* Scope.Scope
        yield* Scope.addFinalizer(
          scope,
          Effect.gen(function* () {
            const own = yield* readPresence(block)
            if (Option.isSome(own) && own.value.pid === process.pid) {
              yield* fs.remove(presenceFile(block), { force: true })
            }
            // Non-recursive: messages that arrived during a session switch stay for the next activation.
            yield* fs.remove(directory)
          }).pipe(Effect.ignore, Effect.provideService(FileSystem, fs))
        )
        yield* Effect.forkIn(drain(ctx, directory).pipe(Effect.ignore, Effect.andThen(Effect.sleep(INBOX_INTERVAL)), Effect.forever), scope)
      }).pipe(Effect.mapError((error) => (error._tag === 'PeerError' ? error : peerError(error.message)))),
    caller,
    inspect: (cwd, id) =>
      Effect.gen(function* () {
        const record = yield* readPresence(id)
        return Option.isNone(record) ? Option.none<Peer>() : yield* livePeer(cwd, record.value)
      }),
    list: (ctx) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem
        const { sessions: listed } = yield* request(ctx.cwd, ['ls', '--json'], SessionsSchema)
        const labels = new Map(listed.map((entry) => [entry.session_id, entry.label ?? entry.session_id]))
        const names = yield* fs.readDirectory(`${root}/presence`).pipe(Effect.orElseSucceed(() => [] as string[]))
        const records = yield* Effect.forEach(names.filter((name) => name.endsWith('.json')).toSorted(), (name) =>
          fs.readFileString(`${root}/presence/${name}`).pipe(
            Effect.map((text) => parseOrUndefined(text)),
            Effect.orElseSucceed(() => undefined)
          )
        )
        const peers = yield* Effect.forEach(
          records.filter((record): record is Presence => Value.Check(PresenceSchema, record)),
          (record) => livePeer(ctx.cwd, record, labels)
        )
        return peers.flatMap((peer) => (Option.isSome(peer) ? [peer.value] : []))
      }),
    name: 'rex',
    open: (ctx, openRequest: OpenRequest, signal) =>
      Effect.gen(function* () {
        yield* caller()
        const fs = yield* FileSystem
        const crypto = yield* Crypto
        const label = openRequest.name ?? `${openRequest.provider}/${openRequest.model}`
        const opened = `${root}/inbox/open-${yield* crypto.randomUUIDv4().pipe(Effect.mapError((error) => peerError(error.message)))}`
        yield* fs.makeDirectory(opened, { recursive: true }).pipe(Effect.mapError((error) => peerError(error.message)))
        yield* writeInbox(opened, openRequest.text)
        const command = [
          'env',
          `PI_REX_INBOX=${opened}`,
          'pi',
          '--provider',
          openRequest.provider,
          '--model',
          openRequest.model,
          ...(openRequest.thinking === undefined ? [] : ['--thinking', openRequest.thinking]),
          '--extension',
          fileURLToPath(new URL('../../index.ts', import.meta.url)),
        ]
        const created = yield* placement
          .withPermits(1)(
            Effect.gen(function* () {
              if (signal?.aborted === true) {
                return yield* peerError('Cancelled before creating a tab.')
              }
              return yield* openWindow(ctx, label, openRequest.directory, command)
            })
          )
          .pipe(Effect.tapError(() => fs.remove(opened, { recursive: true }).pipe(Effect.ignore)))
        yield* exec(ctx.cwd, ['block', 'rename', '-s', created.session, created.block, label]).pipe(Effect.ignore)
        if (!(yield* awaitPresence(created.block, opened))) {
          return yield* peerError(`Tab ${created.block} was created and remains open. Pi did not report itself within 30 seconds.`)
        }
        return { group: created.session, id: created.block, status: 'unknown' } satisfies Peer
      }),
    submit: (_ctx, to, text) =>
      Effect.gen(function* () {
        const record = yield* readPresence(to.id)
        if (Option.isNone(record)) {
          return yield* peerError('The target agent is gone.')
        }
        return record.value.inbox
      }).pipe(Effect.flatMap((target) => writeInbox(target, text))),
  }
}
