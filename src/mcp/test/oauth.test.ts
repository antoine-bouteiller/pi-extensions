import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import type { CredentialStore, OAuthCredentialPayload } from "../keychain.js";
import { KeychainOAuthProvider, createOAuthState, startOAuthCallback } from "../oauth.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

class MemoryStore implements CredentialStore {
  value?: OAuthCredentialPayload;
  reads = 0;
  async get(_name: string, url: string) {
    this.reads += 1;
    return this.value?.serverUrl === url ? structuredClone(this.value) : undefined;
  }
  async set(_name: string, value: OAuthCredentialPayload) {
    this.value = structuredClone(value);
  }
  async delete() {
    this.value = undefined;
  }
}

describe("OAuth callback", () => {
  test("accepts a matching callback and releases the port", async () => {
    const port = await freePort();
    const callback = await startOAuthCallback({ port, expectedState: "right" });
    const response = await fetch(`${callback.redirectUrl}?code=code-1&state=right`);

    expect(response.status).toBe(200);
    expect(await callback.waitForCode()).toBe("code-1");
    await callback.close();

    const replacement = await startOAuthCallback({ port, expectedState: "next" });
    await replacement.close();
  });

  test("rejects a wrong state without consuming the legitimate callback", async () => {
    const port = await freePort();
    const callback = await startOAuthCallback({ port, expectedState: "right" });
    expect((await fetch(`${callback.redirectUrl}?code=bad&state=wrong`)).status).toBe(400);
    expect((await fetch(`${callback.redirectUrl}?code=good&state=right`)).status).toBe(200);
    expect(await callback.waitForCode()).toBe("good");
  });

  test("handles OAuth errors, timeout, cancellation, and occupied ports", async () => {
    const errorCallback = await startOAuthCallback({
      port: await freePort(),
      expectedState: "state",
    });
    await fetch(
      `${errorCallback.redirectUrl}?error=access_denied&error_description=nope&state=state`,
    );
    await expect(errorCallback.waitForCode()).rejects.toThrow("access_denied");

    const timeoutCallback = await startOAuthCallback({
      port: await freePort(),
      expectedState: "state",
      timeoutMs: 5,
    });
    await expect(timeoutCallback.waitForCode()).rejects.toThrow("timed out");

    const controller = new AbortController();
    const cancelled = await startOAuthCallback({
      port: await freePort(),
      expectedState: "state",
      signal: controller.signal,
    });
    controller.abort();
    await expect(cancelled.waitForCode()).rejects.toThrow("cancelled");

    const occupiedPort = await freePort();
    const first = await startOAuthCallback({ port: occupiedPort, expectedState: "one" });
    await expect(startOAuthCallback({ port: occupiedPort, expectedState: "two" })).rejects.toThrow(
      "already in use",
    );
    await first.close();
  });

  test("rejects non-loopback or mismatched redirect URIs", async () => {
    await expect(
      startOAuthCallback({
        port: 1234,
        redirectUri: "https://example.test/callback",
        expectedState: "state",
      }),
    ).rejects.toThrow("loopback");
    await expect(
      startOAuthCallback({
        port: 1234,
        redirectUri: "http://localhost:5678/callback",
        expectedState: "state",
      }),
    ).rejects.toThrow("match callbackPort");
  });
});

describe("Keychain OAuth provider", () => {
  test("does not read credentials during construction and returns static client metadata", async () => {
    const store = new MemoryStore();
    const provider = new KeychainOAuthProvider({
      serverName: "slack",
      serverUrl: "https://mcp.slack.test/mcp",
      config: { clientId: "static-id", clientSecret: "static-secret", callbackPort: 3118 },
      store,
    });

    expect(store.reads).toBe(0);
    expect(await provider.clientInformation()).toEqual({
      client_id: "static-id",
      client_secret: "static-secret",
    });
    expect(provider.clientMetadata.redirect_uris).toEqual(["http://localhost:3118/callback"]);
  });

  test("persists dynamic registration and refresh token updates without losing either", async () => {
    const store = new MemoryStore();
    const provider = new KeychainOAuthProvider({
      serverName: "remote",
      serverUrl: "https://mcp.example.test/mcp",
      config: { callbackPort: 3119 },
      store,
    });

    await provider.saveClientInformation({ client_id: "dynamic-id" });
    await provider.saveTokens({
      access_token: "access",
      token_type: "Bearer",
      refresh_token: "refresh",
    });
    await provider.saveTokens({
      access_token: "refreshed",
      token_type: "Bearer",
      refresh_token: "refresh-2",
    });

    expect(await provider.clientInformation()).toEqual({ client_id: "dynamic-id" });
    expect(await provider.tokens()).toMatchObject({
      access_token: "refreshed",
      refresh_token: "refresh-2",
    });
    expect(store.value?.serverUrl).toBe("https://mcp.example.test/mcp");
  });

  test("opens the browser only in an explicit interactive flow", async () => {
    const opened: string[] = [];
    const provider = new KeychainOAuthProvider({
      serverName: "remote",
      serverUrl: "https://mcp.example.test/mcp",
      config: { callbackPort: 3120 },
      store: new MemoryStore(),
    });
    await expect(provider.redirectToAuthorization(new URL("https://auth.test"))).rejects.toThrow(
      "/mcp-auth",
    );

    const state = createOAuthState();
    const interactive = new KeychainOAuthProvider({
      serverName: "remote",
      serverUrl: "https://mcp.example.test/mcp",
      config: { callbackPort: 3120 },
      store: new MemoryStore(),
      interactive: true,
      state,
      openUrl: async (url) => {
        opened.push(url);
      },
    });
    expect(interactive.state()).toBe(state);
    await interactive.redirectToAuthorization(new URL("https://auth.test/start"));
    expect(opened).toEqual(["https://auth.test/start"]);
  });
});
