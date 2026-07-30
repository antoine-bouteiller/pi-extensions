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

function gatewayResponse(profiles: unknown) {
  return Promise.resolve(new Response(JSON.stringify(profiles), { status: 200 }));
}

describe("Anthropic quota provider", () => {
  test("passes the abort signal and converts gateway fractions to percentages", async () => {
    const controller = new AbortController();
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const fakeFetch = ((input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedInit = init;
      return gatewayResponse({
        profiles: [
          {
            id: "default",
            isActive: true,
            windows: [
              { type: "five_hour", utilization: 0.375, resetsAt: Date.now() + 90 * 60_000 },
              { type: "seven_day", utilization: 0.62 },
              { type: "seven_day_fable", utilization: 0.02 },
            ],
          },
        ],
        activeProfile: "default",
      });
    }) as typeof fetch;

    const quota = await fetchAnthropicQuota("http://127.0.0.1:3456", controller.signal, fakeFetch);

    expect(requestedUrl).toBe("http://127.0.0.1:3456/v1/usage/quota/all");
    expect(requestedInit?.signal).toBe(controller.signal);
    expect(quota?.label).toBe("anthropic");
    expect(quota?.percent).toBe(37.5);
    expect(quota?.detail).toContain("1h 30m");
    expect(quota?.detail).toContain("Weekly:");
    expect(quota?.detail).toContain("62.0%");
  });

  test("reads the active profile rather than the first one", async () => {
    const fakeFetch = (() =>
      gatewayResponse({
        profiles: [
          { id: "other", isActive: false, windows: [{ type: "five_hour", utilization: 0.1 }] },
          {
            id: "work",
            isActive: true,
            windows: [
              { type: "five_hour", utilization: 0.5 },
              { type: "seven_day", utilization: 0.25 },
            ],
          },
        ],
        activeProfile: "work",
      })) as unknown as typeof fetch;

    expect((await fetchAnthropicQuota("http://gateway", undefined, fakeFetch))?.percent).toBe(50);
  });

  test("strips trailing slashes from the configured base URL", async () => {
    let requestedUrl = "";
    const fakeFetch = ((input: string | URL | Request) => {
      requestedUrl = String(input);
      return gatewayResponse({ profiles: [] });
    }) as typeof fetch;

    await fetchAnthropicQuota("http://127.0.0.1:3456/", undefined, fakeFetch);
    expect(requestedUrl).toBe("http://127.0.0.1:3456/v1/usage/quota/all");
  });

  test("returns null without a base URL, and for unsuccessful or malformed responses", async () => {
    const unusable = (() => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch;
    const unsuccessful = (() =>
      Promise.resolve(new Response(null, { status: 404 }))) as unknown as typeof fetch;
    const malformed = (() =>
      gatewayResponse({
        profiles: [{ isActive: true, windows: [{ type: "five_hour", utilization: 0.1 }] }],
      })) as unknown as typeof fetch;
    const empty = (() => gatewayResponse({ profiles: [] })) as unknown as typeof fetch;

    expect(await fetchAnthropicQuota("", undefined, unusable)).toBeNull();
    expect(await fetchAnthropicQuota("http://gateway", undefined, unsuccessful)).toBeNull();
    expect(await fetchAnthropicQuota("http://gateway", undefined, malformed)).toBeNull();
    expect(await fetchAnthropicQuota("http://gateway", undefined, empty)).toBeNull();
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

    poller.start("http://gateway");
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
      baseUrl: string;
      signal: AbortSignal;
      result: ReturnType<typeof deferred<ProviderQuota | null>>;
    }> = [];
    const published: Array<ProviderQuota | null> = [];
    const poller = new AnthropicQuotaPoller((quota) => published.push(quota), {
      refreshMs: 10,
      schedule: (callback) => timers.schedule(callback),
      cancel: (timer) => timers.cancel(timer),
      fetchQuota: (baseUrl, signal) => {
        const result = deferred<ProviderQuota | null>();
        requests.push({ baseUrl, signal, result });
        return result.promise;
      },
    });

    poller.start("http://gateway");
    const first = requests[0]!;
    poller.start("http://gateway");
    const second = requests[1]!;
    expect(first.signal.aborted).toBeTrue();
    expect(second.signal.aborted).toBeFalse();
    expect(timers.size).toBe(1);

    expect(second.baseUrl).toBe("http://gateway");
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
