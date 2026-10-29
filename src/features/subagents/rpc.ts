import { type Cause, Deferred, Effect, Exit, Queue, Schema, Stream } from 'effect'
import { ChildProcess } from 'effect/process'
import { type Static, Type } from 'typebox'
import { Value } from 'typebox/value'

import { jsonText, parseJsonText } from '#shared/utils/json'

export class RpcError extends Schema.TaggedError<RpcError, { readonly brand: unique symbol }>()('RpcError', {
  message: Schema.String,
}) {}

const ResponseSchema = Type.Object({
  data: Type.Optional(Type.Unknown()),
  error: Type.Optional(Type.String()),
  id: Type.String(),
  success: Type.Boolean(),
  type: Type.Literal('response'),
})
export type RpcResponse = Static<typeof ResponseSchema>

export type RpcCommand =
  | { readonly type: 'get_state' }
  | { readonly type: 'prompt'; readonly message: string; readonly streamingBehavior: 'steer' }
  | { readonly type: 'clear_queue' }
  | { readonly type: 'abort' }
  | {
      readonly type: 'extension_ui_response'
      readonly id: string
      readonly value?: string
      readonly confirmed?: boolean
      readonly cancelled?: true
    }

const STDERR_TAIL = 2000
const encoder = new TextEncoder()

const parseLine = (line: string): unknown => {
  try {
    return parseJsonText(line)
  } catch {
    return undefined
  }
}

export interface RpcChild {
  /** Sends a record without waiting; dropped once stdin is closed. */
  readonly send: (record: RpcCommand) => Effect.Effect<void>
  /** Sends a command and waits for its response. */
  readonly request: (record: Exclude<RpcCommand, { readonly type: 'extension_ui_response' }>) => Effect.Effect<RpcResponse, RpcError>
  /** Closes stdin, which Pi's RPC mode treats as an orderly shutdown request. */
  readonly closeStdin: Effect.Effect<void>
  /** The exit code, or undefined when a signal ended the process. */
  readonly exited: Effect.Effect<number | undefined>
  readonly stderrTail: () => string
}

/**
 * Starts `command` speaking Pi's RPC protocol in the current scope. Closing the scope closes stdin,
 * then the spawner sends SIGTERM after 5 seconds and SIGKILL 5 seconds later.
 */
export const startRpc = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string
    readonly env: Readonly<Record<string, string | undefined>>
    readonly onRecord: (record: unknown) => Effect.Effect<void>
  }
) =>
  Effect.gen(function* () {
    const input = yield* Queue.unbounded<Uint8Array, Cause.Done>()
    const exit = yield* Deferred.make<number | undefined>()
    const pending = new Map<string, Deferred.Deferred<RpcResponse, RpcError>>()
    let nextId = 0
    let stderr = ''
    let open = true

    const closeStdin = Effect.suspend(() => {
      open = false
      return Queue.end(input)
    }).pipe(Effect.asVoid)

    const handle = yield* ChildProcess.make(command, [...args], {
      cwd: options.cwd,
      env: { ...options.env },
      extendEnv: false,
      forceKillAfter: '5 seconds',
      killSignal: 'SIGTERM',
      stdin: Stream.fromQueue(input),
    }).pipe(Effect.mapError((error) => RpcError.make({ message: error.message })))

    const dispatch = (line: string) =>
      Effect.suspend(() => {
        const record = parseLine(line.endsWith('\r') ? line.slice(0, -1) : line)
        const waiter = Value.Check(ResponseSchema, record) ? pending.get(record.id) : undefined
        if (waiter !== undefined && Value.Check(ResponseSchema, record)) {
          pending.delete(record.id)
          return Deferred.succeed(waiter, record).pipe(Effect.asVoid)
        }
        return options.onRecord(record)
      })

    // Split on LF only: U+2028 and U+2029 are valid inside JSON strings.
    const decoder = new TextDecoder()
    let buffered = ''
    yield* handle.stdout.pipe(
      Stream.runForEach((chunk) =>
        Effect.suspend(() => {
          buffered += decoder.decode(chunk, { stream: true })
          const lines = buffered.split('\n')
          buffered = lines.pop() ?? ''
          return Effect.forEach(lines, dispatch, { discard: true })
        })
      ),
      Effect.ignore,
      Effect.forkScoped
    )
    const stderrDecoder = new TextDecoder()
    yield* handle.stderr.pipe(
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          stderr = (stderr + stderrDecoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL)
        })
      ),
      Effect.ignore,
      Effect.forkScoped
    )
    yield* handle.exitCode.pipe(
      Effect.exit,
      Effect.flatMap((result) =>
        Effect.suspend(() => {
          open = false
          const failure = RpcError.make({ message: 'The agent process exited.' })
          const waiters = [...pending.values()]
          pending.clear()
          return Effect.forEach(waiters, (waiter) => Deferred.fail(waiter, failure), { discard: true }).pipe(
            Effect.andThen(Deferred.succeed(exit, Exit.isSuccess(result) ? result.value : undefined))
          )
        })
      ),
      Effect.forkScoped
    )

    // Registered last so it runs first on scope close: the spawner's own finalizer then signals only a child that ignored EOF.
    yield* Effect.addFinalizer(() => closeStdin.pipe(Effect.andThen(Deferred.await(exit).pipe(Effect.timeoutOption('5 seconds'))), Effect.asVoid))

    const send = (record: RpcCommand | (RpcCommand & { readonly id: string })) =>
      Effect.suspend(() => (open ? Queue.offer(input, encoder.encode(`${jsonText(record)}\n`)) : Effect.void)).pipe(Effect.asVoid)

    return {
      closeStdin,
      exited: Deferred.await(exit),
      request: (record) =>
        Effect.gen(function* () {
          if (!open) {
            return yield* RpcError.make({ message: 'The agent process exited.' })
          }
          const id = `req-${++nextId}`
          const waiter = yield* Deferred.make<RpcResponse, RpcError>()
          pending.set(id, waiter)
          yield* send({ ...record, id })
          return yield* Deferred.await(waiter)
        }),
      send,
      stderrTail: () => stderr,
    } satisfies RpcChild
  })
