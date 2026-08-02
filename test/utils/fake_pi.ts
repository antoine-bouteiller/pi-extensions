import { type ExtensionAPI } from '@earendil-works/pi-coding-agent'

type EventHandler = (...args: unknown[]) => unknown
export type ToolDefinition = { name: string } & Record<string, unknown>
export type CommandDefinition = Record<string, unknown>

export interface FakePiState {
  handlers: Map<string, EventHandler[]>
  tools: Map<string, ToolDefinition>
  commands: Map<string, CommandDefinition>
  messages: { message: unknown; options: unknown }[]
  emittedEvents: { name: string; data: unknown }[]
}

export interface FakePiOptions {
  exec?: (
    command: string,
    args: string[],
    options?: Record<string, unknown>
  ) => Promise<{ stdout: string; stderr: string; code: number; killed?: boolean }>
}

export const createFakePi = (
  options: FakePiOptions = {}
): {
  pi: ExtensionAPI
  state: FakePiState
  emit: (name: string, event?: unknown, context?: unknown) => Promise<unknown[]>
} => {
  const state: FakePiState = {
    commands: new Map(),
    emittedEvents: [],
    handlers: new Map(),
    messages: [],
    tools: new Map(),
  }

  const target = {
    events: {
      emit(name: string, data: unknown) {
        state.emittedEvents.push({ data, name })
      },
      on() {
        /* Empty */
      },
    },
    async exec(command: string, args: string[], execOptions?: Record<string, unknown>) {
      return options.exec ? options.exec(command, args, execOptions) : { code: 0, killed: false, stderr: '', stdout: '' }
    },
    getActiveTools: () => [],
    getAllTools: () => [],
    getThinkingLevel: () => 'off',
    on(name: string, handler: EventHandler) {
      const handlers = state.handlers.get(name) ?? []
      handlers.push(handler)
      state.handlers.set(name, handlers)
    },
    registerCommand(name: string, command: CommandDefinition) {
      state.commands.set(name, command)
    },
    registerEntryRenderer() {
      /* Empty */
    },
    registerFlag() {
      /* Empty */
    },
    registerMessageRenderer() {
      /* Empty */
    },
    registerProvider() {
      /* Empty */
    },
    registerShortcut() {
      /* Empty */
    },
    registerTool(tool: ToolDefinition) {
      state.tools.set(tool.name, tool)
    },
    sendMessage(message: unknown, messageOptions: unknown) {
      state.messages.push({ message, options: messageOptions })
    },
    setActiveTools() {
      /* Empty */
    },
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- single audited cast: the Proxy forwards every ExtensionAPI member dynamically.
  const pi = new Proxy(target, {
    get(object, property, receiver) {
      if (Reflect.has(object, property)) {
        return Reflect.get(object, property, receiver)
      }
      return () => undefined
    },
  }) as unknown as ExtensionAPI

  return {
    async emit(name, event = {}, context = {}) {
      const results: unknown[] = []
      for (const handler of state.handlers.get(name) ?? []) {
        results.push(await handler(event, context))
      }
      return results
    },
    pi,
    state,
  }
}
