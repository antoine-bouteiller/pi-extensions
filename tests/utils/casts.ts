import { type ExtensionAPI, type ExtensionContext, type ReadonlyFooterDataProvider, type Theme } from '@earendil-works/pi-coding-agent'
import { type TUI } from '@earendil-works/pi-tui'

import { type CommandDefinition, type ToolDefinition } from './fake_pi.js'

const requireObject = (value: unknown, expected: string): object | Function => {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') {
    throw new TypeError(`Expected ${expected} test double to be an object or function`)
  }
  return value
}

// ExtensionAPI is an opaque host interface; tests implement only the members exercised by the subject.
export const asExtensionApi = (double: unknown): ExtensionAPI => requireObject(double, 'ExtensionAPI') as ExtensionAPI

// ExtensionContext is host-owned and too broad for focused hand-built event contexts.
export const asExtensionContext = (double: unknown): ExtensionContext => requireObject(double, 'ExtensionContext') as ExtensionContext

// The native fetch type includes members that an injected request function cannot reproduce.
export const asFetch = (double: (input: string | URL, init?: RequestInit) => Promise<Response>): typeof fetch => double as typeof fetch

// TUI and Theme are opaque host rendering interfaces; tests supply only the rendering surface used.
export const asTui = (double: unknown): TUI => requireObject(double, 'TUI') as TUI
export const asTheme = (double: unknown): Theme => requireObject(double, 'Theme') as Theme

// Pi erases registered tool and command generics in its registry; callers restore the definition under test.
export const asTool = <Tool>(tool: ToolDefinition | undefined): Tool => requireObject(tool, 'tool') as Tool
export const asCommand = <Command>(command: CommandDefinition | undefined): Command => requireObject(command, 'command') as Command

// ReadonlyFooterDataProvider is host-owned; status tests need only its status and branch callbacks.
export const asFooterDataProvider = (double: unknown): ReadonlyFooterDataProvider =>
  requireObject(double, 'ReadonlyFooterDataProvider') as ReadonlyFooterDataProvider

// SDK and Effect internals expose narrower opaque types than their structural test doubles.
export const asNarrowed = <Narrow, Wide extends object>(value: Wide): Narrow => requireObject(value, 'value') as Narrow

// Dynamic imports and JSON parsing return unknown; callers explicitly own the immediately asserted result shape.
export const asResult = <Result>(value: unknown): Result => value as Result

export const asError = (value: unknown): Error => {
  if (value instanceof Error) {
    return value
  }
  throw new TypeError('Expected an Error instance')
}
