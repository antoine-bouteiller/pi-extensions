import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type EventHandler = (...args: unknown[]) => unknown;
type ToolDefinition = { name: string } & Record<string, unknown>;
type CommandDefinition = Record<string, unknown>;

export interface FakePiState {
  handlers: Map<string, EventHandler[]>;
  tools: Map<string, ToolDefinition>;
  commands: Map<string, CommandDefinition>;
  messages: Array<{ message: unknown; options: unknown }>;
  emittedEvents: Array<{ name: string; data: unknown }>;
}

export interface FakePiOptions {
  exec?: (
    command: string,
    args: string[],
    options?: Record<string, unknown>,
  ) => Promise<{ stdout: string; stderr: string; code: number; killed?: boolean }>;
}

export function createFakePi(options: FakePiOptions = {}): {
  pi: ExtensionAPI;
  state: FakePiState;
  emit: (name: string, event?: unknown, context?: unknown) => Promise<unknown[]>;
} {
  const state: FakePiState = {
    handlers: new Map(),
    tools: new Map(),
    commands: new Map(),
    messages: [],
    emittedEvents: [],
  };

  const target = {
    registerTool(tool: ToolDefinition) {
      state.tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: CommandDefinition) {
      state.commands.set(name, command);
    },
    registerMessageRenderer() {},
    registerEntryRenderer() {},
    registerShortcut() {},
    registerFlag() {},
    registerProvider() {},
    on(name: string, handler: EventHandler) {
      const handlers = state.handlers.get(name) ?? [];
      handlers.push(handler);
      state.handlers.set(name, handlers);
    },
    events: {
      on() {},
      emit(name: string, data: unknown) {
        state.emittedEvents.push({ name, data });
      },
    },
    async exec(command: string, args: string[], execOptions?: Record<string, unknown>) {
      return options.exec
        ? options.exec(command, args, execOptions)
        : { stdout: "", stderr: "", code: 0, killed: false };
    },
    sendMessage(message: unknown, messageOptions: unknown) {
      state.messages.push({ message, options: messageOptions });
    },
    getThinkingLevel: () => "off",
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools() {},
  };

  const pi = new Proxy(target, {
    get(object, property, receiver) {
      if (Reflect.has(object, property)) return Reflect.get(object, property, receiver);
      return () => undefined;
    },
  }) as unknown as ExtensionAPI;

  return {
    pi,
    state,
    async emit(name, event = {}, context = {}) {
      const results: unknown[] = [];
      for (const handler of state.handlers.get(name) ?? []) {
        results.push(await handler(event, context));
      }
      return results;
    },
  };
}
