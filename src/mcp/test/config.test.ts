import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpConfigFile, parseMcpConfig, parseMcpConfigText } from "../config";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function temporaryPath(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-mcp-config-test-"));
  temporaryDirectories.push(directory);
  return join(directory, name);
}

describe("global MCP config parsing", () => {
  test("parses the five configured server shapes without changing their names", () => {
    const servers = parseMcpConfig({
      mcpServers: {
        fff: { command: "/nix/store/example/bin/fff-mcp" },
        linear: { type: "http", url: "https://mcp.linear.app/mcp" },
        nixos: { command: "uvx", args: ["mcp-nixos"] },
        slack: {
          type: "http",
          url: "https://mcp.slack.com/mcp",
          oauth: { clientId: "client-id", callbackPort: 3118 },
        },
        "dbx-mcp": { command: "dbx-mcp-server" },
      },
    });

    expect(Object.keys(servers)).toEqual(["fff", "linear", "nixos", "slack", "dbx-mcp"]);
    expect(servers).toEqual({
      fff: { type: "stdio", command: "/nix/store/example/bin/fff-mcp" },
      linear: { type: "http", url: "https://mcp.linear.app/mcp" },
      nixos: { type: "stdio", command: "uvx", args: ["mcp-nixos"] },
      slack: {
        type: "http",
        url: "https://mcp.slack.com/mcp",
        oauth: { clientId: "client-id", callbackPort: 3118 },
      },
      "dbx-mcp": { type: "stdio", command: "dbx-mcp-server" },
    });
  });

  test("validates and copies stdio arguments, environment, and working directory", () => {
    const input = {
      mcpServers: {
        local: {
          type: "stdio",
          command: "node",
          args: ["server.js", "--quiet"],
          env: { MODE: "test", EMPTY: "" },
          cwd: "/work/server",
        },
      },
    };

    const parsed = parseMcpConfig(input);
    expect(parsed.local).toEqual({
      type: "stdio",
      command: "node",
      args: ["server.js", "--quiet"],
      env: { MODE: "test", EMPTY: "" },
      cwd: "/work/server",
    });
    expect(parsed.local).not.toBe(input.mcpServers.local);
  });

  test("accepts unauthenticated HTTP and validates string headers", () => {
    expect(
      parseMcpConfig({
        mcpServers: {
          remote: {
            url: "https://example.test/mcp",
            headers: { Authorization: "Bearer public-fixture", "X-Test": "yes" },
          },
        },
      }),
    ).toEqual({
      remote: {
        type: "http",
        url: "https://example.test/mcp",
        headers: { Authorization: "Bearer public-fixture", "X-Test": "yes" },
      },
    });
  });

  test("normalizes Slack OAuth snake_case aliases", () => {
    expect(
      parseMcpConfig({
        mcpServers: {
          slack: {
            url: "https://mcp.slack.com/mcp",
            oauth: {
              client_id: "client-id",
              client_secret: "client-secret",
              scope: "channels:read",
              callback_port: 3118,
              redirect_uri: "http://127.0.0.1:3118/callback",
            },
          },
        },
      }).slack,
    ).toEqual({
      type: "http",
      url: "https://mcp.slack.com/mcp",
      oauth: {
        clientId: "client-id",
        clientSecret: "client-secret",
        scope: "channels:read",
        callbackPort: 3118,
        redirectUri: "http://127.0.0.1:3118/callback",
      },
    });
  });

  test("rejects duplicate OAuth aliases with a precise path", () => {
    expect(() =>
      parseMcpConfig({
        mcpServers: {
          slack: {
            url: "https://mcp.slack.com/mcp",
            oauth: { clientId: "one", client_id: "two" },
          },
        },
      }),
    ).toThrow("mcpServers.slack.oauth.clientId");
  });

  test("accepts disabled transports and disabled placeholders", () => {
    expect(
      parseMcpConfig({
        mcpServers: {
          local: { command: "server", disabled: true },
          remote: { url: "https://example.test/mcp", disabled: true },
          later: { disabled: true },
        },
      }),
    ).toEqual({
      local: { type: "stdio", command: "server", disabled: true },
      remote: { type: "http", url: "https://example.test/mcp", disabled: true },
      later: { disabled: true },
    });
  });

  test("requires root and mcpServers objects", () => {
    for (const input of [null, [], {}, { mcpServers: [] }, { mcpServers: null }]) {
      expect(() => parseMcpConfig(input)).toThrow("mcpServers");
    }
  });

  test("rejects conflicting transports and discriminator mismatches", () => {
    expect(() =>
      parseMcpConfig({ mcpServers: { mixed: { command: "server", url: "https://x.test" } } }),
    ).toThrow("mcpServers.mixed");
    expect(() =>
      parseMcpConfig({ mcpServers: { local: { type: "http", command: "server" } } }),
    ).toThrow("mcpServers.local.type");
    expect(() =>
      parseMcpConfig({ mcpServers: { remote: { type: "stdio", url: "https://x.test" } } }),
    ).toThrow("mcpServers.remote.type");
    expect(() => parseMcpConfig({ mcpServers: { active: {} } })).toThrow("mcpServers.active");
  });

  test("rejects non-string arrays and maps at the offending field", () => {
    expect(() =>
      parseMcpConfig({ mcpServers: { local: { command: "server", args: ["ok", 1] } } }),
    ).toThrow("mcpServers.local.args.1");
    expect(() =>
      parseMcpConfig({ mcpServers: { local: { command: "server", env: { TOKEN: 1 } } } }),
    ).toThrow("mcpServers.local.env.TOKEN");
    expect(() =>
      parseMcpConfig({
        mcpServers: { remote: { url: "https://x.test", headers: { "X-Test": false } } },
      }),
    ).toThrow("mcpServers.remote.headers.X-Test");
  });

  test("rejects unsupported fields instead of silently widening the format", () => {
    expect(() =>
      parseMcpConfig({ mcpServers: { local: { command: "server", resources: true } } }),
    ).toThrow("mcpServers.local.resources");
    expect(() =>
      parseMcpConfig({
        mcpServers: { remote: { url: "https://x.test", oauth: { tokenFile: "/tmp/token" } } },
      }),
    ).toThrow("mcpServers.remote.oauth.tokenFile");
  });

  test("returns an empty map when a requested config file is absent", async () => {
    const path = await temporaryPath("missing.json");
    expect(await loadMcpConfigFile(path)).toEqual({});
  });

  test("loads JSON from a supplied test path", async () => {
    const path = await temporaryPath("mcp.json");
    await writeFile(path, JSON.stringify({ mcpServers: { local: { command: "server" } } }));
    expect(await loadMcpConfigFile(path)).toEqual({
      local: { type: "stdio", command: "server" },
    });
  });

  test("does not swallow malformed JSON", async () => {
    expect(() => parseMcpConfigText("{ nope", "fixture.json")).toThrow(
      "fixture.json: contains malformed JSON",
    );
    const path = await temporaryPath("malformed.json");
    await writeFile(path, "{ nope");
    await expect(loadMcpConfigFile(path)).rejects.toThrow("contains malformed JSON");
  });
});
