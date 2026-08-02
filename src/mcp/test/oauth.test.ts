import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import  { type CredentialStore, type OAuthCredentialPayload } from "../keychain.js";
import { KeychainOAuthProvider, createOAuthState, startOAuthCallback } from "../oauth.js";

const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {throw new Error("missing address");}
  const {port} = address;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};

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
    const callback = await startOAuthCallback({ expectedState: "right", port });
    const response = await fetch(`${callback.redirectUrl}?code=code-1&state=right`);

    expect(response.status).toBe(200);
    expect(await callback.waitForCode()).toBe("code-1");
    await callback.close();

    const replacement = await startOAuthCallback({ expectedState: "next", port });
    await replacement.close();
  });

  test("rejects a wrong state without consuming the legitimate callback", async () => {
    const port = await freePort();
    const callback = await startOAuthCallback({ expectedState: "right", port });
    const badResponse = await fetch(`${callback.redirectUrl}?code=bad&state=wrong`);
    expect(badResponse.status).toBe(400);
    const goodResponse = await fetch(`${callback.redirectUrl}?code=good&state=right`);
    expect(goodResponse.status).toBe(200);
    expect(await callback.waitForCode()).toBe("good");
  });

  test("handles OAuth errors, timeout, cancellation, and occupied ports", async () => {
    const errorCallback = await startOAuthCallback({
      expectedState: "state",
      port: await freePort(),
    });
    await fetch(
      `${errorCallback.redirectUrl}?error=access_denied&error_description=nope&state=state`,
    );
    await expect(errorCallback.waitForCode()).rejects.toThrow("access_denied");

    const timeoutCallback = await startOAuthCallback({
      expectedState: "state",
      port: await freePort(),
      timeoutMs: 5,
    });
    await expect(timeoutCallback.waitForCode()).rejects.toThrow("timed out");

    const controller = new AbortController();
    const cancelled = await startOAuthCallback({
      expectedState: "state",
      port: await freePort(),
      signal: controller.signal,
    });
    controller.abort();
    await expect(cancelled.waitForCode()).rejects.toThrow("cancelled");

    const occupiedPort = await freePort();
    const first = await startOAuthCallback({ expectedState: "one", port: occupiedPort });
    await expect(startOAuthCallback({ expectedState: "two", port: occupiedPort })).rejects.toThrow(
      "already in use",
    );
    await first.close();
  });

  test("rejects non-loopback or mismatched redirect URIs", async () => {
    await expect(
      startOAuthCallback({
        expectedState: "state",
        port: 1234,
        redirectUri: "https://example.test/callback",
      }),
    ).rejects.toThrow("loopback");
    await expect(
      startOAuthCallback({
        expectedState: "state",
        port: 1234,
        redirectUri: "http://localhost:5678/callback",
      }),
    ).rejects.toThrow("match callbackPort");
  });
});

describe("Keychain OAuth provider", () => {
  test("does not read credentials during construction and returns static client metadata", async () => {
    const store = new MemoryStore();
    const provider = new KeychainOAuthProvider({
      config: { callbackPort: 3118, clientId: "static-id", clientSecret: "static-secret" },
      serverName: "slack",
      serverUrl: "https://mcp.slack.test/mcp",
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
      config: { callbackPort: 3119 },
      serverName: "remote",
      serverUrl: "https://mcp.example.test/mcp",
      store,
    });

    await provider.saveClientInformation({ client_id: "dynamic-id" });
    await provider.saveTokens({
      access_token: "access",
      refresh_token: "refresh",
      token_type: "Bearer",
    });
    await provider.saveTokens({
      access_token: "refreshed",
      refresh_token: "refresh-2",
      token_type: "Bearer",
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
      config: { callbackPort: 3120 },
      serverName: "remote",
      serverUrl: "https://mcp.example.test/mcp",
      store: new MemoryStore(),
    });
    await expect(provider.redirectToAuthorization(new URL("https://auth.test"))).rejects.toThrow(
      "/mcp-auth",
    );

    const state = createOAuthState();
    const interactive = new KeychainOAuthProvider({
      config: { callbackPort: 3120 },
      interactive: true,
      openUrl: async (url) => {
        opened.push(url);
      },
      serverName: "remote",
      serverUrl: "https://mcp.example.test/mcp",
      state,
      store: new MemoryStore(),
    });
    expect(interactive.state()).toBe(state);
    await interactive.redirectToAuthorization(new URL("https://auth.test/start"));
    expect(opened).toEqual(["https://auth.test/start"]);
  });
});
