import { fileURLToPath } from 'node:url'

import { type ExtensionAPI, type ExtensionContext, getAgentDir } from '@earendil-works/pi-coding-agent'
import { Data, Effect, Semaphore } from 'effect'
import { Crypto } from 'effect/Crypto'
import { Type, type Static, type TSchema } from 'typebox'
import { Value } from 'typebox/value'

import { type EnvApi } from '#shared/effect/env'
import { jsonText, parseJsonText } from '#shared/utils/json'

import { loadHerdrSettings } from './settings.js'

const text = Type.String({ maxLength: 32_768, minLength: 1 })
export const SpawnAgentParams = Type.Object({
  message: text,
  model: Type.String({ description: 'Exact provider/model-id, for example azure-openai-responses/gpt-6-sol.', maxLength: 256, minLength: 1 }),
})
export const SendMessageParams = Type.Object({ message: text, pane_id: Type.String({ minLength: 1 }) })
export const ClosePaneParams = Type.Object({ pane_id: Type.String({ minLength: 1 }) })

const PaneSchema = Type.Object({
  agent: Type.Optional(Type.String()),
  agent_session: Type.Optional(Type.Object({ agent: Type.String(), kind: Type.String(), value: Type.String() })),
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
type Pane = Static<typeof PaneSchema>
type Target = Static<typeof TargetSchema>
interface OwnedPane {
  readonly owner: string
  target: Target
}
export interface HerdrResult {
  readonly pane_id: string
  readonly status: 'started' | 'sent' | 'closed'
  readonly model?: string
}
export class HerdrError extends Data.TaggedError('HerdrError')<{ readonly message: string }> {}

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
const checkedMessage = (message: string): string => {
  const controls = message.match(/\p{Cc}/gu)?.some((character) => character !== '\n' && character !== '\t') === true
  if (message.trim().length === 0 || controls) {
    throw fail('Messages must contain text and no terminal control characters (except newline and tab).')
  }
  return message
}
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const cancelled = (signal?: AbortSignal): boolean => signal?.aborted === true

export const makeHerdrHandlers = (pi: ExtensionAPI, environment: EnvApi, loadSettings = loadHerdrSettings) => {
  const owned = new Map<string, OwnedPane>()
  const agentTabs = new Map<string, string[]>()
  const allocation = Semaphore.makeUnsafe(1)
  let startupSession: string | undefined

  const request = <Schema extends TSchema>(cwd: string, args: string[], schema: Schema): Effect.Effect<Static<Schema>, HerdrError> =>
    Effect.gen(function* () {
      const result = yield* Effect.tryPromise({
        catch: (error) => fail(errorMessage(error)),
        try: () => pi.exec('herdr', args, { cwd, timeout: 40_000 }),
      })
      if (result.code !== 0 || result.killed) {
        return yield* fail(result.stderr.trim().slice(0, 2000) || 'Herdr command failed or timed out. Inspect Herdr before retrying a mutation.')
      }
      return yield* Effect.try({
        catch: (error) => fail(errorMessage(error)),
        try: () => decode(schema, decode(Type.Object({ result: Type.Unknown() }), parseJsonText(result.stdout)).result),
      })
    })

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
      const { pane } = yield* request(cwd, ['pane', 'get', target.pane_id], Type.Object({ pane: PaneSchema }))
      if (
        pane.pane_id !== target.pane_id ||
        pane.terminal_id !== target.terminal_id ||
        sessionFile(pane) !== target.session_file ||
        (target.session_file === undefined && pane.agent !== undefined)
      ) {
        return yield* fail('The target pane no longer contains the original session. Inspect it in Herdr.')
      }
      return undefined
    })

  const availableModels = (ctx: ExtensionContext) =>
    Effect.gen(function* () {
      const settings = yield* loadSettings({ agentDir: getAgentDir(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() }).pipe(
        Effect.mapError((error) => fail(error.message))
      )
      return ctx.modelRegistry
        .getAvailable()
        .map((model) => `${model.provider}/${model.id}`)
        .filter((model) => settings.allowedModels.includes(model))
    })

  const submit = (ctx: ExtensionContext, from: Pane, to: Target, message: string) =>
    request(ctx.cwd, ['agent', 'prompt', to.pane_id, `Message from Pi pane ${from.pane_id}:\n\n${message}`], Type.Object({ agent: PaneSchema }))

  return {
    availableModels,
    close: (params: Static<typeof ClosePaneParams>, ctx: ExtensionContext, signal?: AbortSignal) =>
      Effect.gen(function* () {
        const from = yield* caller(ctx, signal)
        const record = owned.get(params.pane_id)
        if (record === undefined || record.owner !== from.session || params.pane_id === from.pane.pane_id) {
          return yield* fail('Only panes spawned by this Pi session can be closed.')
        }
        yield* verify(ctx.cwd, record.target)
        if (cancelled(signal)) {
          return yield* fail('Cancelled before closing the pane.')
        }
        yield* request(ctx.cwd, ['pane', 'close', params.pane_id], Type.Object({ type: Type.Literal('ok') }))
        owned.delete(params.pane_id)
        return { pane_id: params.pane_id, status: 'closed' } satisfies HerdrResult
      }),
    send: (params: Static<typeof SendMessageParams>, ctx: ExtensionContext, signal?: AbortSignal) =>
      Effect.gen(function* () {
        const message = yield* Effect.try({ catch: (error) => fail(errorMessage(error)), try: () => checkedMessage(params.message) })
        const from = yield* caller(ctx, signal)
        let target = owned.get(params.pane_id)?.owner === from.session ? owned.get(params.pane_id)?.target : undefined
        if (target === undefined && startupSession === from.session && environment.all.PI_HERDR_PARENT !== undefined) {
          const parent = yield* Effect.try({
            catch: (error) => fail(errorMessage(error)),
            try: () => decode(TargetSchema, parseJsonText(environment.all.PI_HERDR_PARENT ?? '')),
          })
          if (parent.pane_id === params.pane_id) {
            target = parent
          }
        }
        if (target?.session_file === undefined) {
          return yield* fail("Messages may target only this session's spawned agents or its original parent.")
        }
        yield* verify(ctx.cwd, target)
        if (cancelled(signal)) {
          return yield* fail('Cancelled before sending the message.')
        }
        yield* submit(ctx, from.pane, target, message)
        return { pane_id: params.pane_id, status: 'sent' } satisfies HerdrResult
      }),
    spawn: (params: Static<typeof SpawnAgentParams>, ctx: ExtensionContext, signal?: AbortSignal) =>
      Effect.gen(function* () {
        const message = yield* Effect.try({ catch: (error) => fail(errorMessage(error)), try: () => checkedMessage(params.message) })
        const slash = params.model.indexOf('/')
        const provider = params.model.slice(0, slash)
        const model = params.model.slice(slash + 1)
        if (slash < 1 || !/^[a-zA-Z0-9_-]+$/.test(provider) || !/^[^-\s][^\s]*$/.test(model) || /\p{Cc}/u.test(model)) {
          return yield* fail('model must be an exact provider/model-id.')
        }
        const models = yield* availableModels(ctx)
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
        const record: OwnedPane = { owner: parent.session, target: targetFrom(pane) }
        owned.set(pane.pane_id, record)
        return yield* Effect.gen(function* () {
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
              '--extension',
              fileURLToPath(new URL('../../index.ts', import.meta.url)),
              '--append-system-prompt',
              `You are a delegated agent. Complete only the initial task; do not delegate further. Before ending, use send_message with pane_id ${parent.pane.pane_id} to report your concise conclusion or failure. Include evidence/checks and blockers; use a temporary handoff file for detailed reviews or large results and send its path. This report file is allowed even for a read-only task; other read-only restrictions still apply. Do not wait for acknowledgment. If delivery fails, retain your result and explain the failure rather than choosing another recipient.`,
            ],
            Type.Object({ agent: PaneSchema })
          )
          if (agent.pane_id !== pane.pane_id || agent.terminal_id !== pane.terminal_id || sessionFile(agent) === undefined) {
            return yield* fail('Herdr did not start the expected Pi session in the new pane.')
          }
          record.target = targetFrom(agent)
          if (cancelled(signal)) {
            return yield* fail('Cancelled after starting Pi; the initial message was not submitted.')
          }
          yield* submit(ctx, parent.pane, record.target, message)
          return { model: params.model, pane_id: pane.pane_id, status: 'started' } satisfies HerdrResult
        }).pipe(Effect.mapError((error) => fail(`Pane ${pane.pane_id} was created and remains open. ${error.message}`)))
      }),
    startSession: (ctx: ExtensionContext) =>
      Effect.sync(() => {
        startupSession ??= ctx.sessionManager.getSessionFile()
      }),
  }
}
