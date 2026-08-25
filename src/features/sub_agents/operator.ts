import { CustomEditor, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { matchesKey } from '@earendil-works/pi-tui'
import { Effect } from 'effect'

import { readOwnerOnlyFile } from '#shared/effect/bun_host_file_system'
import { bunPath } from '#shared/effect/bun_services'
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

interface TranscriptContent {
  readonly entries: readonly unknown[]
  readonly turns: readonly AgentTurnRecord[]
  readonly unavailable: boolean
}

interface TranscriptOverlay {
  readonly content: () => TranscriptContent
  readonly refresh: Effect.Effect<TranscriptContent>
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

const unavailableTranscript: TranscriptContent = { entries: [], turns: [], unavailable: true }
const completeJsonLines = (bytes: Uint8Array): readonly unknown[] => {
  const text = new TextDecoder().decode(bytes)
  const complete = text.endsWith('\n') ? text : text.slice(0, Math.max(0, text.lastIndexOf('\n') + 1))
  return complete.split('\n').flatMap((line) => {
    if (line.length === 0) {
      return []
    }
    try {
      return [JSON.parse(line)]
    } catch {
      return []
    }
  })
}

/** Durable records select conversations; activity can only decorate their live rows. */
export const createSubagentsOperator = ({ activity, sessionId, store }: SubagentsOperatorOptions): SubagentsOperator => {
  const recordFor = (agentId: string): Effect.Effect<SubagentRecord | undefined> =>
    store.readRecord(agentId).pipe(Effect.orElseSucceed(() => undefined))
  const readTranscript = (agentId: string): Effect.Effect<TranscriptContent> =>
    recordFor(agentId).pipe(
      Effect.flatMap((record) => {
        if (record === undefined || record.session !== sessionId) {
          return Effect.succeed(unavailableTranscript)
        }
        return readOwnerOnlyFile({
          maxBytes: 10 * 1024 * 1024,
          path: record.sessionPath,
          root: bunPath.dirname(record.sessionPath),
        }).pipe(
          Effect.map((file) => ({ entries: completeJsonLines(file.bytes), turns: record.turns, unavailable: false })),
          Effect.orElseSucceed(() => unavailableTranscript)
        )
      })
    )
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
      return {
        content: () => current,
        refresh: Effect.suspend(() =>
          readTranscript(agentId).pipe(
            Effect.map((next) => {
              if (!next.unavailable) {
                current = next
              } else if (current.entries.length === 0 && current.turns.length === 0) {
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
  const previous = ctx.ui.getEditorComponent()
  let installed = false
  const install = (): void => {
    if (installed) {
      return
    }
    installed = true
    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      class PanicEditorComponent extends CustomEditor {
        override handleInput(data: string): void {
          if (matchesKey(data, 'escape') && ctx.isIdle() && hasLiveCurrentSession()) {
            void interruptAll()
            return
          }
          super.handleInput(data)
        }
      }
      return new PanicEditorComponent(tui, theme, keybindings)
    })
  }
  return {
    dispose() {
      if (!installed) {
        return
      }
      installed = false
      ctx.ui.setEditorComponent(previous)
    },
    install,
  }
}
