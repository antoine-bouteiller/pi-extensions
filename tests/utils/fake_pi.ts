import { type ExtensionAPI, type ToolDefinition as PiToolDefinition } from '@earendil-works/pi-coding-agent'
import { Effect } from 'effect'

import { promiseFromEffect, tryPromiseEffect } from './bun_effect.js'
import { asExtensionApi } from './casts.js'

type EventHandler = (...args: unknown[]) => unknown
export type ToolDefinition = PiToolDefinition
declare const commandDefinitionBrand: unique symbol
export interface CommandDefinition {
  readonly [commandDefinitionBrand]?: never
}

interface ExecOptions {
  readonly cwd?: string
  readonly signal?: AbortSignal
  readonly timeout?: number
}

interface FakePiResult {
  emit: (name: string, event?: unknown, context?: unknown) => Promise<unknown[]>
  pi: ExtensionAPI
  state: FakePiState
}

export interface FakePiState {
  entries: { customType: string; data: unknown }[]
  entryRenderers: Map<string, (...args: unknown[]) => unknown>
  handlers: Map<string, EventHandler[]>
  tools: Map<string, ToolDefinition>
  commands: Map<string, CommandDefinition>
  messageRenderers: string[]
  messages: { message: unknown; options: unknown }[]
  emittedEvents: { name: string; data: unknown }[]
}

export interface FakePiOptions {
  exec?: (command: string, args: string[], options?: ExecOptions) => Promise<{ stdout: string; stderr: string; code: number; killed?: boolean }>
}

export const createFakePi = (options: FakePiOptions = {}): FakePiResult => {
  const state: FakePiState = {
    commands: new Map(),
    emittedEvents: [],
    entries: [],
    entryRenderers: new Map(),
    handlers: new Map(),
    messageRenderers: [],
    messages: [],
    tools: new Map(),
  }

  const target = {
    appendEntry(customType: string, data: unknown) {
      state.entries.push({ customType, data })
    },
    events: {
      emit(name: string, data: unknown) {
        state.emittedEvents.push({ data, name })
      },
      on() {
        /* Empty */
      },
    },
    exec(command: string, args: string[], execOptions?: ExecOptions) {
      const { exec } = options
      return exec === undefined
        ? promiseFromEffect(Effect.succeed({ code: 0, killed: false, stderr: '', stdout: '' }))
        : promiseFromEffect(tryPromiseEffect(() => exec(command, args, execOptions)))
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
    registerEntryRenderer(customType: string, renderer: (...args: unknown[]) => unknown) {
      state.entryRenderers.set(customType, renderer)
    },
    registerFlag() {
      /* Empty */
    },
    registerMessageRenderer(type: string) {
      state.messageRenderers.push(type)
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

  /*
   * No Proxy: a real ExtensionAPI method this fixture does not implement should throw "is not a
   * function" at the call site, not silently no-op and hide the gap.
   */
  const pi = asExtensionApi(target)

  return {
    emit: (name, event = {}, context = {}) =>
      promiseFromEffect(
        Effect.forEach(state.handlers.get(name) ?? [], (handler) => tryPromiseEffect(() => Promise.resolve(handler(event, context))), {
          concurrency: 1,
        })
      ),
    pi,
    state,
  }
}
