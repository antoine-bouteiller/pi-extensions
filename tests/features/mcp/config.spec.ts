/* oxlint-disable no-template-curly-in-string -- Fixtures intentionally contain literal MCP environment placeholders. */
import { describe, expect, it } from '@tests/utils/bun_effect.js'
import { Effect, FileSystem, Path } from 'effect'

import { loadMcpConfigFile, parseMcpConfig, parseMcpConfigEffect, parseMcpConfigText } from '@/features/mcp/config.js'
import { envLayer } from '@/shared/effect/env.js'
import { jsonText, parseJsonText } from '@/shared/utils/json.js'

const temporaryPath = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'pi-mcp-config-test-' })
    return path.join(directory, name)
  })

describe('global MCP config parsing', () => {
  it.effect('parses the five configured server shapes without changing their names', () =>
    Effect.sync(() => {
      /*
       * Parsed from JSON text so declaration order survives: the assertion below
       * pins that parsing preserves file order instead of sorting server names.
       */
      const servers = parseMcpConfig(
        parseJsonText(`{
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
  )

  it.effect('validates and copies stdio arguments, environment, and working directory', () =>
    Effect.sync(() => {
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
  )

  it.effect('accepts unauthenticated HTTP and validates string headers', () =>
    Effect.sync(() => {
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
  )

  it.effect('substitutes environment variables in string values without expanding keys or replacements', () =>
    Effect.sync(() => {
      const input = {
        mcpServers: {
          '${SERVER}': {
            headers: { Authorization: 'Bearer ${TOKEN}', 'X-${HEADER}': '${TOKEN}/${TOKEN}' },
            oauth: { client_id: '${CLIENT}', client_secret: '${TOKEN}' },
            url: 'https://${HOST}/mcp',
          },
          local: {
            args: ['${TOKEN}', '${EMPTY}', '$TOKEN', '${TOKEN:-fallback}'],
            command: '${BIN}/server',
            cwd: '${BIN}',
            env: { EMPTY: '${EMPTY}', TOKEN: '${TOKEN}' },
          },
        },
      }
      const token = 'quoted"\\\n$&${NESTED}'
      const parsed = parseMcpConfigText(jsonText(input), 'fixture.json', {
        BIN: '/opt/bin',
        CLIENT: 'client-id',
        EMPTY: '',
        HOST: 'example.test',
        TOKEN: token,
      })
      expect(parsed).toEqual({
        '${SERVER}': {
          headers: { Authorization: `Bearer ${token}`, 'X-${HEADER}': `${token}/${token}` },
          oauth: { clientId: 'client-id', clientSecret: token },
          type: 'http',
          url: 'https://example.test/mcp',
        },
        local: {
          args: [token, '', '$TOKEN', '${TOKEN:-fallback}'],
          command: '/opt/bin/server',
          cwd: '/opt/bin',
          env: { EMPTY: '', TOKEN: token },
          type: 'stdio',
        },
      })
      expect(input.mcpServers['${SERVER}'].headers.Authorization).toBe('Bearer ${TOKEN}')
    })
  )

  it.effect('isolates missing variables and validates substituted values', () =>
    Effect.gen(function* () {
      const input = {
        mcpServers: {
          credentials: { url: '${CREDENTIAL_URL}' },
          empty: { command: '${EMPTY}' },
          missing: { headers: { Authorization: 'Bearer ${MISSING}' }, url: 'https://example.test' },
          prototype: { command: '${toString}' },
          valid: { command: 'server' },
        },
      }
      const environment = { CREDENTIAL_URL: 'https://user:secret@example.test', EMPTY: '' }
      const expected = {
        credentials: { invalid: true },
        empty: { invalid: true },
        missing: { invalid: true },
        prototype: { invalid: true },
        valid: { command: 'server', type: 'stdio' },
      } as const
      expect(parseMcpConfig(input, environment)).toEqual(expected)
      expect(yield* parseMcpConfigEffect(input).pipe(Effect.provide(envLayer(environment)))).toEqual(expected)
    })
  )

  it.effect('normalizes Slack OAuth snake_case aliases', () =>
    Effect.sync(() => {
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
  )

  it.effect('marks duplicate OAuth aliases as invalid config', () =>
    Effect.sync(() => {
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
  )

  it.effect('accepts disabled transports and disabled placeholders', () =>
    Effect.sync(() => {
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
  )

  it.effect('requires root and mcpServers objects', () =>
    Effect.sync(() => {
      // A parsed JSON null, so the rejection of real null config values stays covered.
      const jsonNull = parseJsonText('null')
      for (const input of [jsonNull, [], {}, { mcpServers: [] }, { mcpServers: jsonNull }]) {
        expect(() => parseMcpConfig(input)).toThrow('mcpServers')
      }
    })
  )

  it.effect('keeps valid siblings when transports, discriminators, arrays, or maps are invalid', () =>
    Effect.sync(() => {
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
  )

  it.effect('isolates malformed, non-http, and credential-bearing URLs as invalid config', () =>
    Effect.sync(() => {
      expect(
        parseMcpConfig({
          mcpServers: {
            credentials: { url: 'https://user:secret@x.test/mcp' },
            fileScheme: { url: 'file:///etc/passwd' },
            loopback: { url: 'http://127.0.0.1:8080/mcp' },
            notAUrl: { url: 'not a url' },
            valid: { url: 'https://x.test/mcp' },
          },
        })
      ).toEqual({
        credentials: { invalid: true },
        fileScheme: { invalid: true },
        loopback: { type: 'http', url: 'http://127.0.0.1:8080/mcp' },
        notAUrl: { invalid: true },
        valid: { type: 'http', url: 'https://x.test/mcp' },
      })
    })
  )

  it.effect('accepts http and https URLs alike', () =>
    Effect.sync(() => {
      expect(
        parseMcpConfig({
          mcpServers: {
            namedLoopback: { url: 'http://localhost:8080/mcp' },
            remotePlaintext: { url: 'http://mcp.example.test/mcp' },
            secure: { url: 'https://mcp.example.test/mcp' },
          },
        })
      ).toEqual({
        namedLoopback: { type: 'http', url: 'http://localhost:8080/mcp' },
        remotePlaintext: { type: 'http', url: 'http://mcp.example.test/mcp' },
        secure: { type: 'http', url: 'https://mcp.example.test/mcp' },
      })
    })
  )

  it.effect('tolerates unknown root fields and marks unsupported nested fields invalid', () =>
    Effect.gen(function* () {
      expect(yield* parseMcpConfigEffect({ futureRootField: true, mcpServers: { broken: { command: 42 }, local: { command: 'server' } } })).toEqual({
        broken: { invalid: true },
        local: { command: 'server', type: 'stdio' },
      })
      expect(parseMcpConfig({ mcpServers: { local: { command: 42, resources: true } } })).toEqual({ local: { invalid: true } })
    })
  )

  it.effect('does not silently widen unsupported server or OAuth fields', () =>
    Effect.sync(() => {
      expect(
        parseMcpConfig({
          mcpServers: {
            local: { command: 'server', resources: true },
            remote: { oauth: { tokenFile: '/tmp/token' }, url: 'https://x.test' },
          },
        })
      ).toEqual({ local: { invalid: true }, remote: { invalid: true } })
    })
  )

  it.effect('returns an empty map when a requested config file is absent', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* temporaryPath('missing.json')
        expect(yield* loadMcpConfigFile(path)).toEqual({})
      })
    )
  )

  it.effect('loads JSON from a supplied test path', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* temporaryPath('mcp.json')
        yield* fs.writeFileString(path, '{"mcpServers":{"local":{"command":"${MCP_COMMAND}"}}}')
        expect(yield* loadMcpConfigFile(path).pipe(Effect.provide(envLayer({ MCP_COMMAND: 'server' })))).toEqual({
          local: { command: 'server', type: 'stdio' },
        })
      })
    )
  )

  it.effect('does not swallow malformed JSON', () =>
    Effect.scoped(
      Effect.gen(function* () {
        expect(() => parseMcpConfigText('{ nope', 'fixture.json')).toThrow('fixture.json: contains malformed JSON')
        const fs = yield* FileSystem.FileSystem
        const path = yield* temporaryPath('malformed.json')
        yield* fs.writeFileString(path, '{ nope')
        const failure = yield* Effect.flip(loadMcpConfigFile(path))
        expect(failure.message).toContain('contains malformed JSON')
      })
    )
  )
})
