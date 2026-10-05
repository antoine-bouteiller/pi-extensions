import { fileURLToPath } from 'node:url'

import { type ExtensionAPI, type ExtensionContext, getAgentDir } from '@earendil-works/pi-coding-agent'
import { Data, Effect, Option, Scope, Semaphore } from 'effect'
import { Crypto } from 'effect/Crypto'
import { FileSystem } from 'effect/FileSystem'
import { Type, type Static, type TSchema } from 'typebox'
import { Value } from 'typebox/value'

import { type EnvApi } from '#shared/effect/env'
import { jsonText, parseJsonText } from '#shared/utils/json'
import { truncateOutput, truncationNotice } from '#shared/utils/tool_output'

import { loadHerdrSettings } from './settings.js'

const text = Type.String({ maxLength: 32_768, minLength: 1 })
const paneId = Type.String({ minLength: 1 })
export const SpawnAgentParams = Type.Object({
  message: text,
  model: Type.String({ description: 'Exact provider/model-id, for example azure-openai-responses/gpt-6-sol.', maxLength: 256, minLength: 1 }),
  name: Type.Optional(
    Type.String({
      description: 'Short pane label shown in Herdr and in result notifications, for example "Review auth".',
      maxLength: 64,
      minLength: 1,
      pattern: '^[^\\s\\x00-\\x1f\\x7f-\\x9f-][^\\x00-\\x1f\\x7f-\\x9f]*$',
    })
  ),
  thinking: Type.Optional(
    Type.Union(
      [
        Type.Literal('off'),
        Type.Literal('minimal'),
        Type.Literal('low'),
        Type.Literal('medium'),
        Type.Literal('high'),
        Type.Literal('xhigh'),
        Type.Literal('max'),
      ],
      { description: 'Thinking level for the child.' }
    )
  ),
  tools: Type.Optional(
    Type.Array(Type.String({ maxLength: 64, pattern: '^[a-zA-Z0-9_][a-zA-Z0-9_.:-]*$' }), {
      description: 'Tool allowlist for the child, for example ["read","grep","find","ls"] for read-only work. Omit to keep all tools.',
      maxItems: 64,
      minItems: 1,
    })
  ),
})
export const SendMessageParams = Type.Object({ message: text, pane_id: paneId })
export const PaneParams = Type.Object({ pane_id: paneId })
export const ListAgentsParams = Type.Object({})

const PaneSchema = Type.Object({
  agent: Type.Optional(Type.String()),
  agent_session: Type.Optional(Type.Object({ agent: Type.String(), kind: Type.String(), value: Type.String() })),
  agent_status: Type.Optional(Type.String()),
  pane_id: Type.String({ minLength: 1 }),
  tab_id: Type.String({ minLength: 1 }),
  terminal_id: Type.String({ minLength: 1 }),
  workspace_id: Type.String({ minLength: 1 }),
})
const TargetSchema = Type.Object({
  pane_id: Type.String({ minLength: 1 }),
  session_file: Type.Optional(Type.String({ minLength: 1 })),
  terminal_id: Type.String({ minLength: 1 }),
})
const LayoutSchema = Type.Object({
  layout: Type.Object({
    panes: Type.Array(Type.Object({ pane_id: Type.String(), rect: Type.Object({ height: Type.Number(), width: Type.Number() }) })),
  }),
})
const ExitSchema = Type.Object({
  errorMessage: Type.Optional(Type.String()),
  request_id: Type.Optional(Type.String()),
  text: Type.String(),
  type: Type.Union([Type.Literal('done'), Type.Literal('error'), Type.Literal('aborted')]),
})
const SpawnEntrySchema = Type.Object({
  awaiting: Type.Boolean(),
  model: Type.String(),
  name: Type.Optional(Type.String()),
  owner: Type.String(),
  pane_id: Type.String(),
  request_id: Type.Optional(Type.String()),
  target: TargetSchema,
})
const ClosedEntrySchema = Type.Object({ pane_id: Type.String() })
type Pane = Static<typeof PaneSchema>
type Target = Static<typeof TargetSchema>
type Exit = Static<typeof ExitSchema>
interface OwnedPane {
  readonly owner: string
  readonly model: string
  readonly name?: string
  target: Target
  /** False until `agent start` has recorded the child session, so the watcher ignores a pane that is still starting. */
  ready: boolean
  /** A spawn or follow-up has not produced a result yet; only then is an unannounced exit worth reporting. */
  awaiting: boolean
  request_id?: string
  blocked: boolean
}
export interface HerdrResult {
  readonly pane_id: string
  readonly status: 'started' | 'sent' | 'closed' | 'interrupted'
  readonly model?: string
}
export interface AgentSummary {
  readonly pane_id: string
  readonly model: string
  readonly name?: string
  readonly status: string
  readonly awaiting_result: boolean
}
export interface ResultDetails {
  readonly pane_id: string
  readonly model: string
  readonly name?: string
  readonly status: Exit['type'] | 'exited' | 'blocked'
}
export interface ListResult {
  readonly agents: readonly AgentSummary[]
}
export class HerdrError extends Data.TaggedError('HerdrError')<{ readonly message: string }> {}

/** @internal */
export const SPAWN_ENTRY = 'herdr-agent'
/** @internal */
export const CLOSED_ENTRY = 'herdr-agent-closed'
const STATE_ENTRY = 'herdr-agent-state'
/** @internal */
export const RESULT_MESSAGE = 'herdr-agent-result'
const WATCH_INTERVAL = '3 seconds'
const RESULT_LIMITS = { maxBytes: 50 * 1024, maxLines: 2000 }

const fail = (message: string) => new HerdrError({ message })
const decode = <Schema extends TSchema>(schema: Schema, value: unknown): Static<Schema> => {
  if (!Value.Check(schema, value)) {
    throw fail('Herdr returned an unexpected response.')
  }
  return value
}
const sessionFile = (pane: Pane): string | undefined =>
  pane.agent === 'pi' && pane.agent_session?.agent === 'pi' && pane.agent_session.kind === 'path' ? pane.agent_session.value : undefined
const targetFrom = (pane: Pane): Target => ({ pane_id: pane.pane_id, session_file: sessionFile(pane), terminal_id: pane.terminal_id })
const matches = (pane: Pane, target: Target): boolean =>
  pane.pane_id === target.pane_id &&
  pane.terminal_id === target.terminal_id &&
  sessionFile(pane) === target.session_file &&
  (target.session_file !== undefined || pane.agent === undefined)
const exitFile = (session: string) => `${session}.exit`
const resultsDirectory = (session: string) => `${exitFile(session)}.d`
const checkedMessage = (message: string): string => {
  const controls = message.match(/\p{Cc}/gu)?.some((character) => character !== '\n' && character !== '\t') === true
  if (message.trim().length === 0 || controls) {
    throw fail('Messages must contain text and no terminal control characters (except newline and tab).')
  }
  return message
}
const parseJsonOrUndefined = (contents: string): unknown => {
  try {
    return parseJsonText(contents)
  } catch {
    return undefined
  }
}
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const cancelled = (signal?: AbortSignal): boolean => signal?.aborted === true
const label = (paneIdValue: string, record: OwnedPane) =>
  record.name === undefined ? `pane ${paneIdValue}` : `"${record.name}" (pane ${paneIdValue})`

/** Renaming first means a result written concurrently by the child lands in a fresh file instead of being deleted unread. */
const claim = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem
    const crypto = yield* Crypto
    const claimed = `${file}.${yield* crypto.randomUUIDv4}`
    const renamed = yield* fs.rename(file, claimed).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => error.reason._tag === 'NotFound',
        () => Effect.succeed(false)
      )
    )
    if (!renamed) {
      return Option.none<Exit>()
    }
    const contents = yield* fs.readFileString(claimed).pipe(Effect.ensuring(fs.remove(claimed, { force: true }).pipe(Effect.ignore)))
    const exit = parseJsonOrUndefined(contents)
    return Option.some<Exit>(
      Value.Check(ExitSchema, exit) ? exit : { errorMessage: 'The agent wrote an unreadable result file.', text: '', type: 'error' }
    )
  })

const reportedRequest = (ctx: ExtensionContext): string | undefined => {
  const input = ctx.sessionManager.getBranch().findLast((candidate) => candidate.type === 'message' && candidate.message.role === 'user')
  if (input?.type !== 'message' || input.message.role !== 'user') {
    return undefined
  }
  const content =
    typeof input.message.content === 'string'
      ? input.message.content
      : input.message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
  return /^Message from Pi pane \S+ \[herdr-request:(?<id>[^\]]+)\]:/.exec(content)?.groups?.id
}

const CHILD_PROMPT =
  'You are a delegated agent. Complete only the initial task; you cannot delegate. Whenever you stop, your final response is delivered to the parent agent automatically, and the parent may send follow-up messages. End with a concise conclusion or failure, including evidence/checks and blockers. For detailed reviews or large results, write a temporary handoff file and include its absolute path in your final response; this file is allowed even for a read-only task, but other read-only restrictions still apply.'

export const makeHerdrHandlers = (pi: ExtensionAPI, environment: EnvApi, loadSettings = loadHerdrSettings) => {
  const owned = new Map<string, OwnedPane>()
  const agentTabs = new Map<string, string[]>()
  const allocation = Semaphore.makeUnsafe(1)
  const delivery = Semaphore.makeUnsafe(1)
  let startupSession: string | undefined
  let lastReported: string | undefined
  const isChild = environment.all.PI_HERDR_PARENT !== undefined

  const run = (cwd: string, args: string[]): Effect.Effect<string, HerdrError> =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        catch: (error) => fail(errorMessage(error)),
        try: () => pi.exec('herdr', args, { cwd, timeout: 40_000 }),
      })
      if (result.code !== 0 || result.killed) {
        return yield* fail(result.stderr.trim().slice(0, 2000) || 'Herdr command failed or timed out. Inspect Herdr before retrying a mutation.')
      }
      return result.stdout
    })

  const request = <Schema extends TSchema>(cwd: string, args: string[], schema: Schema): Effect.Effect<Static<Schema>, HerdrError> =>
    run(cwd, args).pipe(
      Effect.flatMap((stdout) =>
        Effect.try({
          catch: (error) => fail(errorMessage(error)),
          try: () => decode(schema, decode(Type.Object({ result: Type.Unknown() }), parseJsonText(stdout)).result),
        })
      )
    )

  /** None when Herdr reports the pane as gone; other failures stay errors so callers can retry. */
  const inspect = (cwd: string, id: string) =>
    request(cwd, ['pane', 'get', id], Type.Object({ pane: PaneSchema })).pipe(
      Effect.map(({ pane }) => Option.some(pane)),
      Effect.catchIf(
        (error) => error.message.includes('pane_not_found'),
        () => Effect.succeedNone
      )
    )

  const caller = (ctx: ExtensionContext, signal?: AbortSignal) =>
    Effect.gen(function* () {
      if (cancelled(signal)) {
        return yield* fail('Cancelled before contacting Herdr.')
      }
      if (environment.all.HERDR_ENV !== '1') {
        return yield* fail('These tools require Pi to run inside Herdr.')
      }
      const { pane } = yield* request(ctx.cwd, ['pane', 'current', '--current'], Type.Object({ pane: PaneSchema }))
      const session = ctx.sessionManager.getSessionFile()
      if (session === undefined || sessionFile(pane) !== session) {
        return yield* fail('Herdr does not identify this pane as the current Pi session.')
      }
      return { pane, session }
    })

  const verify = (cwd: string, target: Target) =>
    Effect.gen(function* () {
      const pane = yield* inspect(cwd, target.pane_id)
      if (Option.isNone(pane) || !matches(pane.value, target)) {
        return yield* fail('The target pane no longer contains the original session. Inspect it in Herdr.')
      }
      return pane.value
    })

  const ownedBy = (session: string, id: string, current: Pane) => {
    const record = owned.get(id)
    return record === undefined || record.owner !== session || id === current.pane_id ? undefined : record
  }

  const availableModels = (ctx: ExtensionContext) =>
    Effect.gen(function* () {
      const settings = yield* loadSettings({ agentDir: getAgentDir(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() }).pipe(
        Effect.mapError((error) => fail(error.message))
      )
      const models = ctx.modelRegistry
        .getAvailable()
        .map((model) => `${model.provider}/${model.id}`)
        .filter((model) => settings.allowedModels.includes(model))
      return {
        models,
        notes: models.flatMap((model) => (settings.modelNotes[model] === undefined ? [] : [`${model}: ${settings.modelNotes[model]}`])),
      }
    })

  const submit = (ctx: ExtensionContext, from: Pane, to: Target, message: string, requestId: string) =>
    request(
      ctx.cwd,
      ['agent', 'prompt', to.pane_id, `Message from Pi pane ${from.pane_id} [herdr-request:${requestId}]:\n\n${message}`],
      Type.Object({ agent: PaneSchema })
    )

  const persist = (id: string, record: OwnedPane) =>
    pi.appendEntry(STATE_ENTRY, {
      awaiting: record.awaiting,
      model: record.model,
      name: record.name,
      owner: record.owner,
      pane_id: id,
      request_id: record.request_id,
      target: record.target,
    })

  const forget = (id: string) => {
    owned.delete(id)
    pi.appendEntry(CLOSED_ENTRY, { pane_id: id } satisfies Static<typeof ClosedEntrySchema>)
  }

  const notify = (content: string, details: ResultDetails) =>
    Effect.sync(() => {
      pi.sendMessage({ content, customType: RESULT_MESSAGE, details, display: true }, { deliverAs: 'steer', triggerTurn: true })
    })

  const deliver = (id: string, record: OwnedPane, exit: Exit) => {
    if (exit.request_id === record.request_id) {
      record.awaiting = false
      persist(id, record)
    }
    const headline = { aborted: 'was interrupted', done: 'finished', error: 'failed' }[exit.type]
    const bounded = truncateOutput(exit.text.trim() || '(no final text)', RESULT_LIMITS)
    const failure = exit.errorMessage === undefined ? '' : `\nError: ${exit.errorMessage}`
    return notify(
      `Agent ${label(id, record)} ${headline} (${record.model}).${failure}\n\n${bounded.content}${bounded.truncated ? truncationNotice(bounded) : ''}`,
      { model: record.model, name: record.name, pane_id: id, status: exit.type }
    )
  }

  const check = (cwd: string, id: string, record: OwnedPane) =>
    Effect.gen(function* () {
      const session = record.target.session_file
      if (session !== undefined) {
        const fs = yield* FileSystem
        const directory = resultsDirectory(session)
        const files = yield* fs.readDirectory(directory).pipe(
          Effect.catchIf(
            (error) => error.reason._tag === 'NotFound',
            () => Effect.succeed([] as string[])
          )
        )
        for (const file of [
          exitFile(session),
          ...files
            .filter((name) => name.endsWith('.json'))
            .toSorted()
            .map((name) => `${directory}/${name}`),
        ]) {
          const exit = yield* claim(file)
          if (Option.isSome(exit)) {
            yield* deliver(id, record, exit.value)
          }
        }
      }
      const pane = yield* inspect(cwd, id)
      if (owned.get(id) !== record) {
        return
      }
      if (Option.isNone(pane) || !matches(pane.value, record.target)) {
        forget(id)
        if (record.awaiting) {
          yield* notify(`Agent ${label(id, record)} exited or its pane was closed before reporting a result. Inspect it in Herdr.`, {
            model: record.model,
            name: record.name,
            pane_id: id,
            status: 'exited',
          })
        }
        return
      }
      const blocked = pane.value.agent_status === 'blocked'
      if (blocked && !record.blocked) {
        yield* notify(`Agent ${label(id, record)} is blocked waiting for input in Herdr. Inspect it there; do not answer its approval dialogs.`, {
          model: record.model,
          name: record.name,
          pane_id: id,
          status: 'blocked',
        })
      }
      record.blocked = blocked
    })

  const watch = (ctx: ExtensionContext) =>
    Effect.gen(function* () {
      const session = ctx.sessionManager.getSessionFile()
      const due = [...owned].filter(([, record]) => record.owner === session && record.ready)
      yield* Effect.forEach(due, ([id, record]) => check(ctx.cwd, id, record).pipe(Effect.ignore), { discard: true })
    }).pipe(delivery.withPermits(1))

  const restore = (ctx: ExtensionContext) =>
    Effect.sync(() => {
      const session = ctx.sessionManager.getSessionFile()
      if (session === undefined) {
        return
      }
      const entries = new Map<string, Static<typeof SpawnEntrySchema>>()
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type !== 'custom') {
          continue
        }
        if (
          (entry.customType === SPAWN_ENTRY || entry.customType === STATE_ENTRY) &&
          Value.Check(SpawnEntrySchema, entry.data) &&
          entry.data.owner === session
        ) {
          entries.set(entry.data.pane_id, entry.data)
        } else if (entry.customType === CLOSED_ENTRY && Value.Check(ClosedEntrySchema, entry.data)) {
          entries.delete(entry.data.pane_id)
        }
      }
      for (const entry of entries.values()) {
        if (owned.has(entry.pane_id)) {
          continue
        }
        owned.set(entry.pane_id, {
          awaiting: entry.awaiting,
          blocked: false,
          model: entry.model,
          name: entry.name,
          owner: session,
          ready: true,
          request_id: entry.request_id,
          target: entry.target,
        })
      }
    })

  /** Child side: publish the final assistant message of a settled run where the parent's watcher looks for it. */
  const report = (ctx: ExtensionContext) =>
    Effect.gen(function* () {
      const session = ctx.sessionManager.getSessionFile()
      if (!isChild || session === undefined || session !== startupSession) {
        return
      }
      const entry = ctx.sessionManager.getBranch().findLast((candidate) => candidate.type === 'message' && candidate.message.role === 'assistant')
      if (entry === undefined || entry.type !== 'message' || entry.message.role !== 'assistant' || entry.id === lastReported) {
        return
      }
      const { message } = entry
      const body = message.content
        .flatMap((part) => (part.type === 'text' ? [part.text] : []))
        .join('\n')
        .trim()
      const exit: Exit =
        message.stopReason === 'error'
          ? { errorMessage: message.errorMessage ?? 'The provider request failed.', text: body, type: 'error' }
          : { text: body, type: message.stopReason === 'aborted' ? 'aborted' : 'done' }
      exit.request_id = reportedRequest(ctx)
      const fs = yield* FileSystem
      const directory = resultsDirectory(session)
      yield* fs.makeDirectory(directory, { recursive: true })
      const file = `${directory}/${String(ctx.sessionManager.getBranch().indexOf(entry)).padStart(12, '0')}-${entry.id}.json`
      const pending = `${file}.tmp`
      yield* fs.writeFileString(pending, jsonText(exit))
      yield* fs.rename(pending, file)
      lastReported = entry.id
    })

  return {
    activate: (ctx: ExtensionContext) =>
      Effect.gen(function* () {
        startupSession ??= ctx.sessionManager.getSessionFile()
        if (isChild || environment.all.HERDR_ENV !== '1') {
          return
        }
        yield* restore(ctx).pipe(Effect.ignore)
        const scope = yield* Scope.Scope
        yield* Effect.forkIn(Effect.forever(Effect.sleep(WATCH_INTERVAL).pipe(Effect.andThen(watch(ctx)))), scope)
      }),
    availableModels,
    close: (params: Static<typeof PaneParams>, ctx: ExtensionContext, signal?: AbortSignal) =>
      Effect.gen(function* () {
        const from = yield* caller(ctx, signal)
        const record = ownedBy(from.session, params.pane_id, from.pane)
        if (record === undefined) {
          return yield* fail('Only panes spawned by this Pi session can be closed.')
        }
        yield* verify(ctx.cwd, record.target)
        if (cancelled(signal)) {
          return yield* fail('Cancelled before closing the pane.')
        }
        yield* request(ctx.cwd, ['pane', 'close', params.pane_id], Type.Object({ type: Type.Literal('ok') }))
        forget(params.pane_id)
        return { pane_id: params.pane_id, status: 'closed' } satisfies HerdrResult
      }).pipe(delivery.withPermits(1)),
    interrupt: (params: Static<typeof PaneParams>, ctx: ExtensionContext, signal?: AbortSignal) =>
      Effect.gen(function* () {
        const from = yield* caller(ctx, signal)
        const record = ownedBy(from.session, params.pane_id, from.pane)
        if (record?.target.session_file === undefined) {
          return yield* fail('Only running agents spawned by this Pi session can be interrupted.')
        }
        yield* verify(ctx.cwd, record.target)
        if (cancelled(signal)) {
          return yield* fail('Cancelled before interrupting the agent.')
        }
        yield* run(ctx.cwd, ['pane', 'send-keys', params.pane_id, 'Escape'])
        return { pane_id: params.pane_id, status: 'interrupted' } satisfies HerdrResult
      }),
    isChild,
    list: (ctx: ExtensionContext, signal?: AbortSignal) =>
      Effect.gen(function* () {
        const from = yield* caller(ctx, signal)
        const agents = yield* Effect.forEach(
          [...owned].filter(([, record]) => record.owner === from.session),
          ([id, record]) =>
            inspect(ctx.cwd, id).pipe(
              Effect.map((pane) => {
                if (Option.isNone(pane)) {
                  return 'gone'
                }
                return matches(pane.value, record.target) ? (pane.value.agent_status ?? 'unknown') : 'replaced'
              }),
              Effect.orElseSucceed(() => 'unavailable'),
              Effect.map((status): AgentSummary => ({
                awaiting_result: record.awaiting,
                model: record.model,
                pane_id: id,
                status: record.ready ? status : 'starting',
                ...(record.name !== undefined && { name: record.name }),
              }))
            )
        )
        return { agents } satisfies ListResult
      }),
    /** One watcher pass; exposed so tests need not drive the forked loop through the clock. */
    poll: watch,
    report,
    send: (params: Static<typeof SendMessageParams>, ctx: ExtensionContext, signal?: AbortSignal) =>
      Effect.gen(function* () {
        const message = yield* Effect.try({ catch: (error) => fail(errorMessage(error)), try: () => checkedMessage(params.message) })
        const from = yield* caller(ctx, signal)
        const record = ownedBy(from.session, params.pane_id, from.pane)
        if (record?.target.session_file === undefined) {
          return yield* fail("Messages may target only this session's spawned agents.")
        }
        yield* verify(ctx.cwd, record.target)
        if (cancelled(signal)) {
          return yield* fail('Cancelled before sending the message.')
        }
        const crypto = yield* Crypto
        const requestId = yield* crypto.randomUUIDv4.pipe(Effect.mapError((error) => fail(error.message)))
        yield* submit(ctx, from.pane, record.target, message, requestId)
        record.request_id = requestId
        record.awaiting = true
        persist(params.pane_id, record)
        return { pane_id: params.pane_id, status: 'sent' } satisfies HerdrResult
      }).pipe(delivery.withPermits(1)),
    spawn: (params: Static<typeof SpawnAgentParams>, ctx: ExtensionContext, signal?: AbortSignal) =>
      Effect.gen(function* () {
        const message = yield* Effect.try({ catch: (error) => fail(errorMessage(error)), try: () => checkedMessage(params.message) })
        const slash = params.model.indexOf('/')
        const provider = params.model.slice(0, slash)
        const model = params.model.slice(slash + 1)
        if (slash < 1 || !/^[a-zA-Z0-9_-]+$/.test(provider) || !/^[^-\s][^\s]*$/.test(model) || /\p{Cc}/u.test(model)) {
          return yield* fail('model must be an exact provider/model-id.')
        }
        if (!Value.Check(SpawnAgentParams, params)) {
          return yield* fail('name must be a single-line label, thinking a supported level, and tools a list of tool names.')
        }
        const { models } = yield* availableModels(ctx)
        if (!models.includes(params.model)) {
          return yield* fail(
            models.length === 0
              ? 'No allowed models are available. Configure herdr.allowedModels in settings.json with available provider/model-id values.'
              : `Model ${params.model} is not allowed or available. Choose one of: ${models.join(', ')}.`
          )
        }
        const parent = yield* caller(ctx, signal)
        const crypto = yield* Crypto
        const id = yield* crypto.randomUUIDv4.pipe(Effect.mapError((error) => fail(error.message)))
        const pane = yield* allocation.withPermits(1)(
          Effect.gen(function* () {
            const tabs = agentTabs.get(parent.session) ?? []
            let split: string[] | undefined
            if (tabs.length > 0) {
              const { panes } = yield* request(
                ctx.cwd,
                ['pane', 'list', '--workspace', parent.pane.workspace_id],
                Type.Object({ panes: Type.Array(PaneSchema) })
              )
              const tabId = tabs.find((candidateId) => {
                const count = panes.filter((candidate) => candidate.tab_id === candidateId).length
                return candidateId !== parent.pane.tab_id && count > 0 && count < 4
              })
              const anchor = panes.find((candidate) => candidate.tab_id === tabId)
              if (anchor !== undefined) {
                const { layout } = yield* request(ctx.cwd, ['pane', 'layout', '--pane', anchor.pane_id], LayoutSchema)
                const largest = layout.panes.reduce<(typeof layout.panes)[number] | undefined>(
                  (best, candidate) =>
                    best === undefined || candidate.rect.width * candidate.rect.height > best.rect.width * best.rect.height ? candidate : best,
                  undefined
                )
                if (largest === undefined) {
                  return yield* fail('The Agents tab has no panes in the Herdr layout.')
                }
                split = ['pane', 'split', '--pane', largest.pane_id, '--direction', largest.rect.width >= largest.rect.height * 2 ? 'right' : 'down']
              }
            }
            if (cancelled(signal)) {
              return yield* fail('Cancelled before creating a pane.')
            }
            const args = ['--cwd', ctx.cwd, '--no-focus', '--env', `PI_HERDR_PARENT=${jsonText(targetFrom(parent.pane))}`]
            if (split !== undefined) {
              const created = yield* request(ctx.cwd, [...split, ...args], Type.Object({ pane: PaneSchema }))
              return created.pane
            }
            const created = yield* request(
              ctx.cwd,
              ['tab', 'create', '--workspace', parent.pane.workspace_id, '--label', 'Agents', ...args],
              Type.Object({ root_pane: PaneSchema })
            )
            agentTabs.set(parent.session, [...tabs, created.root_pane.tab_id])
            return created.root_pane
          })
        )
        const record: OwnedPane = {
          awaiting: true,
          blocked: false,
          model: params.model,
          owner: parent.session,
          ready: false,
          target: targetFrom(pane),
          ...(params.name !== undefined && { name: params.name }),
        }
        owned.set(pane.pane_id, record)
        return yield* Effect.gen(function* () {
          if (params.name !== undefined) {
            yield* run(ctx.cwd, ['pane', 'rename', pane.pane_id, params.name]).pipe(Effect.ignore)
          }
          if (cancelled(signal)) {
            return yield* fail('Cancelled after creating the pane.')
          }
          const { agent } = yield* request(
            ctx.cwd,
            [
              'agent',
              'start',
              `pi-${id.slice(0, 8)}`,
              '--kind',
              'pi',
              '--pane',
              pane.pane_id,
              '--',
              '--provider',
              provider,
              '--model',
              model,
              ...(params.thinking === undefined ? [] : ['--thinking', params.thinking]),
              ...(params.tools === undefined ? [] : ['--tools', params.tools.join(',')]),
              '--extension',
              fileURLToPath(new URL('../../index.ts', import.meta.url)),
              '--append-system-prompt',
              CHILD_PROMPT,
            ],
            Type.Object({ agent: PaneSchema })
          )
          if (agent.pane_id !== pane.pane_id || agent.terminal_id !== pane.terminal_id || sessionFile(agent) === undefined) {
            return yield* fail('Herdr did not start the expected Pi session in the new pane.')
          }
          record.target = targetFrom(agent)
          record.ready = true
          record.request_id = id
          pi.appendEntry(SPAWN_ENTRY, {
            awaiting: record.awaiting,
            model: record.model,
            owner: record.owner,
            pane_id: pane.pane_id,
            request_id: record.request_id,
            target: record.target,
            ...(record.name !== undefined && { name: record.name }),
          } satisfies Static<typeof SpawnEntrySchema>)
          if (cancelled(signal)) {
            return yield* fail('Cancelled after starting Pi; the initial message was not submitted.')
          }
          yield* submit(ctx, parent.pane, record.target, message, id)
          return { model: params.model, pane_id: pane.pane_id, status: 'started' } satisfies HerdrResult
        }).pipe(Effect.mapError((error) => fail(`Pane ${pane.pane_id} was created and remains open. ${error.message}`)))
      }),
  }
}
