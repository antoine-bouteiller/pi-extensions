import { describe, expect, test } from "bun:test";
import type { ProviderQuota } from "../state";
import { AnthropicQuotaPoller, fetchAnthropicQuota, quotaFromHeaders } from "../provider";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function fakeTimers() {
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  return {
    schedule(callback: () => void) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id as unknown as ReturnType<typeof setInterval>;
    },
    cancel(timer: ReturnType<typeof setInterval>) {
      callbacks.delete(timer as unknown as number);
    },
    tick() {
      for (const callback of callbacks.values()) callback();
    },
    get size() {
      return callbacks.size;
    },
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("Anthropic quota provider", () => {
  test("passes the abort signal and parses usage", async () => {
    const controller = new AbortController();
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const fakeFetch = ((input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedInit = init;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            five_hour: { utilization: 37.5 },
            seven_day: { utilization: 62 },
          }),
          { status: 200 },
        ),
      );
    }) as typeof fetch;

    const quota = await fetchAnthropicQuota(controller.signal, fakeFetch, "test-token");

    expect(requestedUrl).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(requestedInit?.signal).toBe(controller.signal);
    expect(requestedInit?.headers).toEqual({
      Authorization: "Bearer test-token",
      "anthropic-beta": "oauth-2025-04-20",
    });
    expect(quota?.label).toBe("anthropic");
    expect(quota?.percent).toBe(37.5);
    expect(quota?.detail).toContain("Weekly:");
    expect(quota?.detail).toContain("62.0%");
  });

  test("returns null for unsuccessful or malformed usage responses", async () => {
    const unsuccessful = (() =>
      Promise.resolve(new Response(null, { status: 429 }))) as unknown as typeof fetch;
    const malformed = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ five_hour: { utilization: 10 } }), { status: 200 }),
      )) as unknown as typeof fetch;

    expect(await fetchAnthropicQuota(undefined, unsuccessful, "token")).toBeNull();
    expect(await fetchAnthropicQuota(undefined, malformed, "token")).toBeNull();
  });

  test("derives Azure quota only from valid token headers", () => {
    expect(
      quotaFromHeaders("azure-openai", {
        "x-ratelimit-limit-tokens": "1000",
        "x-ratelimit-remaining-tokens": "250",
      }),
    ).toEqual({ label: "azure", percent: 75 });
    expect(quotaFromHeaders("anthropic", {})).toBeNull();
    expect(
      quotaFromHeaders("azure-openai", {
        "x-ratelimit-limit-tokens": "0",
        "x-ratelimit-remaining-tokens": "0",
      }),
    ).toBeNull();
  });
});

describe("Anthropic quota polling lifecycle", () => {
  test("does not overlap requests when a timer fires", async () => {
    const timers = fakeTimers();
    const requests: Array<ReturnType<typeof deferred<ProviderQuota | null>>> = [];
    const poller = new AnthropicQuotaPoller(() => undefined, {
      refreshMs: 10,
      schedule: (callback) => timers.schedule(callback),
      cancel: (timer) => timers.cancel(timer),
      fetchQuota: () => {
        const request = deferred<ProviderQuota | null>();
        requests.push(request);
        return request.promise;
      },
    });

    poller.start();
    expect(requests).toHaveLength(1);
    expect(timers.size).toBe(1);
    timers.tick();
    expect(requests).toHaveLength(1);

    requests[0]!.resolve({ label: "anthropic", percent: 10 });
    await flushPromises();
    timers.tick();
    expect(requests).toHaveLength(2);
    poller.stop();
    expect(timers.size).toBe(0);
  });

  test("aborts stopped generations and ignores their late results", async () => {
    const timers = fakeTimers();
    const requests: Array<{
      signal: AbortSignal;
      result: ReturnType<typeof deferred<ProviderQuota | null>>;
    }> = [];
    const published: Array<ProviderQuota | null> = [];
    const poller = new AnthropicQuotaPoller((quota) => published.push(quota), {
      refreshMs: 10,
      schedule: (callback) => timers.schedule(callback),
      cancel: (timer) => timers.cancel(timer),
      fetchQuota: (signal) => {
        const result = deferred<ProviderQuota | null>();
        requests.push({ signal, result });
        return result.promise;
      },
    });

    poller.start();
    const first = requests[0]!;
    poller.start();
    const second = requests[1]!;
    expect(first.signal.aborted).toBeTrue();
    expect(second.signal.aborted).toBeFalse();
    expect(timers.size).toBe(1);

    second.result.resolve({ label: "anthropic", percent: 20 });
    await flushPromises();
    first.result.resolve({ label: "anthropic", percent: 90 });
    await flushPromises();
    expect(published).toEqual([{ label: "anthropic", percent: 20 }]);

    timers.tick();
    const third = requests[2]!;
    poller.stop();
    expect(third.signal.aborted).toBeTrue();
    expect(timers.size).toBe(0);
  });
});
