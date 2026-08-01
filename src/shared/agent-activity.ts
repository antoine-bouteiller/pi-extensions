import type { ThemeColor } from "@earendil-works/pi-coding-agent";

export interface RunningAgent {
  name: string;
  profile?: string;
  color: ThemeColor;
}

export interface AgentActivityStore {
  list(): readonly RunningAgent[];
  publish(agents: readonly RunningAgent[]): void;
  subscribe(listener: () => void): () => void;
}

export function createAgentActivityStore(): AgentActivityStore {
  let agents: readonly RunningAgent[] = [];
  const listeners = new Set<() => void>();
  return {
    list: () => agents,
    publish(next) {
      agents = [...next];
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Extensions load once per process, so sub-agents and the footer share this instance. */
export const runningAgents = createAgentActivityStore();
