/* oxlint-disable typescript/no-unsafe-type-assertion -- single audited location for test-double casts; narrows hand-built fakes onto the real extension interfaces they stand in for */
/* oxlint-disable typescript/no-unnecessary-type-parameters -- these type parameters are intentionally explicit-only: the caller names the target shape, there is nothing to infer */
import { type ExtensionAPI, type ExtensionContext, type ReadonlyFooterDataProvider, type Theme } from '@earendil-works/pi-coding-agent'
import { type TUI } from '@earendil-works/pi-tui'

import { type OAuthCredentialPayload } from '@/features/mcp/keychain.js'

import { type CommandDefinition, type ToolDefinition } from './fake_pi.js'

// ExtensionAPI is an opaque host interface; tests implement only the members exercised by the subject.
export const asExtensionApi = (double: object): ExtensionAPI => double as unknown as ExtensionAPI

// ExtensionContext is host-owned and too broad for focused hand-built event contexts.
export const asExtensionContext = (double: object): ExtensionContext => double as unknown as ExtensionContext

// The native fetch type includes members that an injected request function cannot reproduce.
export const asFetch = (double: (input: string | URL, init?: RequestInit) => Promise<Response>): typeof fetch => double as unknown as typeof fetch

// TUI and Theme are opaque host rendering interfaces; tests supply only the rendering surface used.
export const asTui = (double: object): TUI => double as unknown as TUI
export const asTheme = (double: object): Theme => double as unknown as Theme

// Pi erases registered tool and command generics in its registry; callers restore the definition under test.
export const asTool = <Tool>(tool: ToolDefinition | undefined): Tool => tool as unknown as Tool
export const asCommand = <Command>(command: CommandDefinition | undefined): Command => command as unknown as Command

// ReadonlyFooterDataProvider is host-owned; status tests need only its status and branch callbacks.
export const asFooterDataProvider = (double: object): ReadonlyFooterDataProvider => double as unknown as ReadonlyFooterDataProvider

// The SDK credential payload contains opaque OAuth client/token types represented structurally in tests.
export const asOAuthCredentialPayload = (double: {
  serverUrl: string
  tokens?: Record<string, unknown>
  clientInformation?: Record<string, unknown>
}): OAuthCredentialPayload => double as unknown as OAuthCredentialPayload

// SDK and Effect internals expose narrower opaque types than their structural test doubles.
export const asNarrowed = <Narrow, Wide extends object>(value: Wide): Narrow => value as unknown as Narrow

// Dynamic imports and JSON parsing return unknown; the caller owns the immediately asserted result shape.
export const asResult = <Result>(value: unknown): Result => value as Result

export const asError = (value: unknown): Error => {
  if (value instanceof Error) {
    return value
  }
  throw new TypeError('Expected an Error instance')
}
