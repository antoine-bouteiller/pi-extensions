/* oxlint-disable typescript/no-unsafe-type-assertion -- single audited location for test-double casts; narrows hand-built fakes onto the real extension interfaces they stand in for */
/* oxlint-disable typescript/no-unnecessary-type-parameters -- these type parameters are intentionally explicit-only: the caller names the target shape, there is nothing to infer */
import { type ExtensionAPI, type ExtensionContext, type ReadonlyFooterDataProvider, type Theme } from '@earendil-works/pi-coding-agent'
import { type TUI } from '@earendil-works/pi-tui'

import { type OAuthCredentialPayload } from '../../src/mcp/keychain.js'
import { type CommandDefinition, type ToolDefinition } from './fake_pi.js'

export const asExtensionApi = (double: object): ExtensionAPI => double as unknown as ExtensionAPI

export const asExtensionContext = (double: object): ExtensionContext => double as unknown as ExtensionContext

export const asFetch = (double: (input: string | URL, init?: RequestInit) => Promise<Response>): typeof fetch => double as unknown as typeof fetch

export const asTui = (double: object): TUI => double as unknown as TUI

export const asTheme = (double: object): Theme => double as unknown as Theme

export const asTool = <Tool>(tool: ToolDefinition | undefined): Tool => tool as unknown as Tool

export const asCommand = <Command>(command: CommandDefinition | undefined): Command => command as unknown as Command

export const asFooterDataProvider = (double: object): ReadonlyFooterDataProvider => double as unknown as ReadonlyFooterDataProvider

export const asOAuthCredentialPayload = (double: {
  serverUrl: string
  tokens?: Record<string, unknown>
  clientInformation?: Record<string, unknown>
}): OAuthCredentialPayload => double as unknown as OAuthCredentialPayload

export const asNarrowed = <Narrow, Wide extends object>(value: Wide): Narrow => value as unknown as Narrow

export const asResult = <Result>(value: unknown): Result => value as Result

export const asError = (value: unknown): Error => {
  if (value instanceof Error) {
    return value
  }
  throw new TypeError('Expected an Error instance')
}
