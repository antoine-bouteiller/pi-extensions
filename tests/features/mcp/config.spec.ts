import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NodeFileSystem } from '@effect/platform-node'
import { Effect } from 'effect'

import { loadMcpConfigFile as loadMcpConfigFileEffect, parseMcpConfig, parseMcpConfigEffect, parseMcpConfigText } from '@/features/mcp/config.js'

const loadMcpConfigFile = (path: string) => Effect.runPromise(Effect.provide(loadMcpConfigFileEffect(path), NodeFileSystem.layer))

const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

const temporaryPath = async (name: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-mcp-config-test-'))
  temporaryDirectories.push(directory)
  return join(directory, name)
}

describe('global MCP config parsing', () => {
  test('parses the five configured server shapes without changing their names', () => {
    /*
     * Parsed from JSON text so declaration order survives: the assertion below
     * pins that parsing preserves file order instead of sorting server names.
     */
    const servers = parseMcpConfig(
      JSON.parse(`{
        "mcpServers": {
          "fff": { "command": "/nix/store/example/bin/fff-mcp" },
          "linear": { "type": "http", "url": "https://mcp.linear.app/mcp" },
          "nixos": { "command": "uvx", "args": ["mcp-nixos"] },
          "slack": {
            "type": "http",
            "url": "https://mcp.slack.com/mcp",
            "oauth": { "clientId": "client-id", "callbackPort": 3118 }
          },
          "dbx-mcp": { "command": "dbx-mcp-server" }
        }
      }`)
    )

    expect(Object.keys(servers)).toEqual(['fff', 'linear', 'nixos', 'slack', 'dbx-mcp'])
    expect(servers).toEqual({
      'dbx-mcp': { command: 'dbx-mcp-server', type: 'stdio' },
      fff: { command: '/nix/store/example/bin/fff-mcp', type: 'stdio' },
      linear: { type: 'http', url: 'https://mcp.linear.app/mcp' },
      nixos: { args: ['mcp-nixos'], command: 'uvx', type: 'stdio' },
      slack: {
        oauth: { callbackPort: 3118, clientId: 'client-id' },
        type: 'http',
        url: 'https://mcp.slack.com/mcp',
      },
    })
  })

  test('validates and copies stdio arguments, environment, and working directory', () => {
    const input = {
      mcpServers: {
        local: {
          args: ['server.js', '--quiet'],
          command: 'node',
          cwd: '/work/server',
          env: { EMPTY: '', MODE: 'test' },
          type: 'stdio',
        },
      },
    }

    const parsed = parseMcpConfig(input)
    expect(parsed.local).toEqual({
      args: ['server.js', '--quiet'],
      command: 'node',
      cwd: '/work/server',
      env: { EMPTY: '', MODE: 'test' },
      type: 'stdio',
    })
    expect(parsed.local).not.toBe(input.mcpServers.local)
  })

  test('accepts unauthenticated HTTP and validates string headers', () => {
    expect(
      parseMcpConfig({
        mcpServers: {
          remote: {
            headers: { Authorization: 'Bearer public-fixture', 'X-Test': 'yes' },
            url: 'https://example.test/mcp',
          },
        },
      })
    ).toEqual({
      remote: {
        headers: { Authorization: 'Bearer public-fixture', 'X-Test': 'yes' },
        type: 'http',
        url: 'https://example.test/mcp',
      },
    })
  })

  test('normalizes Slack OAuth snake_case aliases', () => {
    expect(
      parseMcpConfig({
        mcpServers: {
          slack: {
            oauth: {
              callback_port: 3118,
              client_id: 'client-id',
              client_name: 'Claude Code',
              client_secret: 'client-secret',
              redirect_uri: 'http://127.0.0.1:3118/callback',
              scope: 'channels:read',
            },
            url: 'https://mcp.slack.com/mcp',
          },
        },
      }).slack
    ).toEqual({
      oauth: {
        callbackPort: 3118,
        clientId: 'client-id',
        clientName: 'Claude Code',
        clientSecret: 'client-secret',
        redirectUri: 'http://127.0.0.1:3118/callback',
        scope: 'channels:read',
      },
      type: 'http',
      url: 'https://mcp.slack.com/mcp',
    })
  })

  test('marks duplicate OAuth aliases as invalid config', () => {
    expect(
      parseMcpConfig({
        mcpServers: {
          slack: {
            oauth: { client_id: 'two', clientId: 'one' },
            url: 'https://mcp.slack.com/mcp',
          },
        },
      })
    ).toEqual({ slack: { invalid: true } })
  })

  test('accepts disabled transports and disabled placeholders', () => {
    expect(
      parseMcpConfig({
        mcpServers: {
          later: { disabled: true },
          local: { command: 'server', disabled: true },
          remote: { disabled: true, url: 'https://example.test/mcp' },
        },
      })
    ).toEqual({
      later: { disabled: true },
      local: { command: 'server', disabled: true, type: 'stdio' },
      remote: { disabled: true, type: 'http', url: 'https://example.test/mcp' },
    })
  })

  test('requires root and mcpServers objects', () => {
    // A parsed JSON null, so the rejection of real null config values stays covered.
    const jsonNull = JSON.parse('null') as unknown
    for (const input of [jsonNull, [], {}, { mcpServers: [] }, { mcpServers: jsonNull }]) {
      expect(() => parseMcpConfig(input)).toThrow('mcpServers')
    }
  })

  test('keeps valid siblings when transports, discriminators, arrays, or maps are invalid', () => {
    expect(
      parseMcpConfig({
        mcpServers: {
          active: {},
          local: { args: ['ok', 1], command: 'server' },
          mixed: { command: 'server', url: 'https://x.test' },
          remote: { headers: { 'X-Test': false }, url: 'https://x.test' },
          valid: { command: 'server' },
          wrongType: { type: 'stdio', url: 'https://x.test' },
        },
      })
    ).toEqual({
      active: { invalid: true },
      local: { invalid: true },
      mixed: { invalid: true },
      remote: { invalid: true },
      valid: { command: 'server', type: 'stdio' },
      wrongType: { invalid: true },
    })
  })

  test('tolerates unknown root fields and marks unsupported nested fields invalid', async () => {
    expect(
      await Effect.runPromise(parseMcpConfigEffect({ futureRootField: true, mcpServers: { broken: { command: 42 }, local: { command: 'server' } } }))
    ).toEqual({
      broken: { invalid: true },
      local: { command: 'server', type: 'stdio' },
    })
    expect(parseMcpConfig({ mcpServers: { local: { command: 42, resources: true } } })).toEqual({ local: { invalid: true } })
  })

  test('does not silently widen unsupported server or OAuth fields', () => {
    expect(
      parseMcpConfig({
        mcpServers: {
          local: { command: 'server', resources: true },
          remote: { oauth: { tokenFile: '/tmp/token' }, url: 'https://x.test' },
        },
      })
    ).toEqual({ local: { invalid: true }, remote: { invalid: true } })
  })

  test('returns an empty map when a requested config file is absent', async () => {
    const path = await temporaryPath('missing.json')
    expect(await loadMcpConfigFile(path)).toEqual({})
  })

  test('loads JSON from a supplied test path', async () => {
    const path = await temporaryPath('mcp.json')
    await writeFile(path, JSON.stringify({ mcpServers: { local: { command: 'server' } } }))
    expect(await loadMcpConfigFile(path)).toEqual({
      local: { command: 'server', type: 'stdio' },
    })
  })

  test('does not swallow malformed JSON', async () => {
    expect(() => parseMcpConfigText('{ nope', 'fixture.json')).toThrow('fixture.json: contains malformed JSON')
    const path = await temporaryPath('malformed.json')
    await writeFile(path, '{ nope')
    expect(loadMcpConfigFile(path)).rejects.toThrow('contains malformed JSON')
  })
})
