import { type ThemeColor } from '@earendil-works/pi-coding-agent'

import { createObservableStore } from './store'

export interface RunningAgent {
  name: string
  profile?: string
  color: ThemeColor
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
