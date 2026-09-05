import { CustomEditor, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { matchesKey } from '@earendil-works/pi-tui'
import { Effect, Path } from 'effect'

import { lstatHostFile, readOwnerOnlyFile } from '#shared/effect/bun_host_file_system'
import { type RunningAgent } from '#shared/state/agent_activity'

import { type AgentTurnRecord, type SubagentRecord, type SubagentStoreApi } from './store.js'

/**
 * The public activity projection is deliberately separate from durable records.  The
 * orchestrator calls this only after the worker is ready, and removes the entry when
 * that ready turn settles or its session closes.
 */
export interface ActivityProjection {
  readonly closeSession: (sessionId: string) => Effect.Effect<void>
  readonly list: () => readonly RunningAgent[]
  readonly publishReady: (agent: RunningAgent) => Effect.Effect<void>
  readonly remove: (agentId: string) => Effect.Effect<void>
  readonly updateActivity: (agentId: string, lastActivityAt: number) => Effect.Effect<void>
}

export interface ActivityProjectionOptions {
  readonly publish: (agents: readonly RunningAgent[]) => Effect.Effect<void>
}

export const createActivityProjection = ({ publish }: ActivityProjectionOptions): ActivityProjection => {
  let agents: readonly RunningAgent[] = []
  const flush = (): Effect.Effect<void> => publish(agents)
  return {
    closeSession: (sessionId) =>
      Effect.sync(() => {
        agents = agents.filter((agent) => agent.sessionId !== sessionId)
      }).pipe(Effect.andThen(flush)),
    list: () => agents,
    publishReady: (agent) => {
      if (agent.state !== 'running' || agent.agentId === undefined || agent.sessionId === undefined || agent.lastActivityAt === undefined) {
        return Effect.void
      }
      return Effect.sync(() => {
        if (agents.some((current) => current.agentId === agent.agentId)) {
          return false
        }
        agents = [...agents, agent]
        return true
      }).pipe(Effect.flatMap((added) => (added ? flush() : Effect.void)))
    },
    remove: (agentId) =>
      Effect.sync(() => {
        const next = agents.filter((agent) => agent.agentId !== agentId)
        if (next.length === agents.length) {
          return false
        }
        agents = next
        return true
      }).pipe(Effect.flatMap((removed) => (removed ? flush() : Effect.void))),
    updateActivity: (agentId, lastActivityAt) =>
      Effect.sync(() => {
        let changed = false
        agents = agents.map((agent) => {
          if (agent.agentId !== agentId) {
            return agent
          }
          changed = true
          return { ...agent, lastActivityAt }
        })
        return changed
      }).pipe(Effect.flatMap((changed) => (changed ? flush() : Effect.void))),
  }
}

interface SubagentListRow {
  readonly agentId: string
  readonly lastActivityAt?: number
  readonly profile: string
  readonly status: SubagentRecord['status']
  readonly taskName: string
}

export interface TranscriptContent {
  readonly text: string
  readonly turns: readonly AgentTurnRecord[]
  readonly unavailable: boolean
}

type TranscriptRead = 'unchanged' | { readonly content: TranscriptContent; readonly stamp?: string }

interface TranscriptOverlay {
  readonly content: () => TranscriptContent
  readonly refresh: Effect.Effect<TranscriptContent, never, Path.Path>
}

export interface SubagentsOperator {
  readonly list: Effect.Effect<readonly SubagentListRow[]>
  readonly open: (agentId: string) => TranscriptOverlay
}

export interface SubagentsOperatorOptions {
  readonly activity: () => readonly RunningAgent[]
  readonly sessionId: string
  readonly store: SubagentStoreApi
}

const unavailableTranscript: TranscriptContent = { text: '', turns: [], unavailable: true }
const completeLines = (bytes: Uint8Array): string => {
  const text = new TextDecoder().decode(bytes)
  return text.endsWith('\n') ? text : text.slice(0, Math.max(0, text.lastIndexOf('\n') + 1))
}

/** Durable records select conversations; activity can only decorate their live rows. */
export const createSubagentsOperator = ({ activity, sessionId, store }: SubagentsOperatorOptions): SubagentsOperator => {
  const recordFor = (agentId: string): Effect.Effect<SubagentRecord | undefined> =>
    store.readRecord(agentId).pipe(Effect.orElseSucceed(() => undefined))
  const readTranscript = (agentId: string, lastStamp: string | undefined): Effect.Effect<TranscriptRead, never, Path.Path> =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      return yield* recordFor(agentId).pipe(
        Effect.flatMap((record) => {
          if (record === undefined || record.session !== sessionId) {
            return Effect.succeed<TranscriptRead>({ content: unavailableTranscript })
          }
          return lstatHostFile(record.sessionPath).pipe(
            Effect.flatMap((info) => {
              const stamp = `${info.mtimeMs}:${info.size}`
              return stamp === lastStamp
                ? Effect.succeed<TranscriptRead>('unchanged')
                : readOwnerOnlyFile({
                    maxBytes: 10 * 1024 * 1024,
                    path: record.sessionPath,
                    root: path.dirname(record.sessionPath),
                  }).pipe(Effect.map((file) => ({ content: { text: completeLines(file.bytes), turns: record.turns, unavailable: false }, stamp })))
            }),
            Effect.orElseSucceed<TranscriptRead>(() => ({ content: unavailableTranscript }))
          )
        })
      )
    })
  return {
    list: store.listRecords.pipe(
      Effect.orElseSucceed(() => []),
      Effect.map((records) => {
        const live = new Map(
          activity().flatMap((agent) =>
            agent.sessionId === sessionId && agent.state === 'running' && agent.agentId !== undefined ? [[agent.agentId, agent]] : []
          )
        )
        return records.flatMap(({ agentId, record }) => {
          if (record.session !== sessionId) {
            return []
          }
          const running = record.status === 'running' ? live.get(agentId) : undefined
          return [{ agentId, lastActivityAt: running?.lastActivityAt, profile: record.profile.key, status: record.status, taskName: record.taskName }]
        })
      })
    ),
    open: (agentId) => {
      let current = unavailableTranscript
      let stamp: string | undefined
      return {
        content: () => current,
        refresh: Effect.suspend(() =>
          readTranscript(agentId, stamp).pipe(
            Effect.map((read) => {
              if (read === 'unchanged') {
                return current
              }
              const { content: next, stamp: nextStamp } = read
              stamp = nextStamp
              if (!next.unavailable) {
                current = next
              } else if (current.text.length === 0 && current.turns.length === 0) {
                current = next
              } else {
                current = { ...current, unavailable: true }
              }
              return current
            })
          )
        ),
      }
    },
  }
}

export interface PanicEditorOptions {
  readonly ctx: ExtensionContext
  readonly hasLiveCurrentSession: () => boolean
  readonly interruptAll: () => Promise<void>
}

export interface PanicEditor {
  readonly dispose: () => void
  readonly install: () => void
}

/** Installs the idle-only Escape guard without taking over host cancellation. */
export const createPanicEditor = ({ ctx, hasLiveCurrentSession, interruptAll }: PanicEditorOptions): PanicEditor => {
  let installed = false
  let installations = 0
  let previous: ReturnType<typeof ctx.ui.getEditorComponent>
  let installedFactory: NonNullable<ReturnType<typeof ctx.ui.getEditorComponent>> | undefined
  const install = (): void => {
    if (installed) {
      return
    }
    installed = true
    installations += 1
    const installation = installations
    const previousFactory = ctx.ui.getEditorComponent()
    previous = previousFactory
    installedFactory = (tui, theme, keybindings) => {
      const editor = previousFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings)
      const handleInput = editor.handleInput.bind(editor)
      editor.handleInput = (data: string): void => {
        if (installed && installations === installation && matchesKey(data, 'escape') && ctx.isIdle() && hasLiveCurrentSession()) {
          void interruptAll()
          return
        }
        handleInput(data)
      }
      return editor
    }
    ctx.ui.setEditorComponent(installedFactory)
  }
  return {
    dispose() {
      if (!installed) {
        return
      }
      installed = false
      if (ctx.ui.getEditorComponent() === installedFactory) {
        ctx.ui.setEditorComponent(previous)
      }
      installedFactory = undefined
    },
    install,
  }
}
