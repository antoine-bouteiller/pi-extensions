import { type ThemeColor } from '@earendil-works/pi-coding-agent'

import { createObservableStore } from './store.js'

export interface RunningAgent {
  readonly agentId?: string
  readonly color: ThemeColor
  readonly lastActivityAt?: number
  readonly name: string
  readonly profile?: string
  readonly sessionId?: string
  readonly state?: 'running'
}

export interface AgentActivityStore {
  list: () => readonly RunningAgent[]
  publish: (agents: readonly RunningAgent[]) => void
  subscribe: (listener: () => void) => () => void
}

export const createAgentActivityStore = (): AgentActivityStore => {
  const store = createObservableStore<readonly RunningAgent[]>([])
  return {
    list: store.get,
    publish: (agents) => store.set([...agents]),
    subscribe: store.subscribe,
  }
}

/** Extensions load once per process, so sub-agents and the status panel share this instance. */
export const runningAgents = createAgentActivityStore()
