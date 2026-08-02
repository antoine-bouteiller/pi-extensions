import { describe, expect, test } from "bun:test";
import  { type ProviderQuota } from "../state";
import { AnthropicQuotaPoller, fetchAnthropicQuota, quotaFromHeaders } from "../provider";

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const fakeTimers = () => {
  let nextId = 1;
  const handlers = new Map<number, () => void>();
  return {
    cancel(timer: ReturnType<typeof setInterval>) {
      handlers.delete(timer as unknown as number);
    },
    schedule(handler: () => void) {
      const id = nextId++;
      handlers.set(id, handler);
      return id as unknown as ReturnType<typeof setInterval>;
    },
    get size() {
      return handlers.size;
    },
    tick() {
      for (const handler of handlers.values()) {handler();}
    },
  };
};

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const gatewayResponse = (profiles: unknown) =>
  Promise.resolve(Response.json(profiles, { status: 200 }));

describe("Anthropic quota provider", () => {
  test("passes the abort signal and converts gateway fractions to percentages", async () => {
    const controller = new AbortController();
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const fakeFetch = ((input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedInit = init;
      return gatewayResponse({
        activeProfile: "default",
        profiles: [
          {
            id: "default",
            isActive: true,
            windows: [
              { resetsAt: Date.now() + 90 * 60_000, type: "five_hour", utilization: 0.375 },
              { resetsAt: Date.now() + 102 * 60 * 60_000, type: "seven_day", utilization: 0.62 },
              { type: "seven_day_fable", utilization: 0.02 },
            ],
          },
        ],
      });
    }) as typeof fetch;

    const quota = await fetchAnthropicQuota("http://127.0.0.1:3456", controller.signal, fakeFetch);
    if (!quota) {throw new Error("expected a quota");}
    const {windows} = quota;
    if (!windows) {throw new Error("expected quota windows");}

    expect(requestedUrl).toBe("http://127.0.0.1:3456/v1/usage/quota/all");
    expect(requestedInit?.signal).toBe(controller.signal);
    expect(quota.label).toBe("anthropic");
    expect(quota.percent).toBe(37.5);
    expect(quota.detail).toContain("1h 30m");
    expect(quota.detail).toContain("Weekly:");
    expect(quota.detail).toContain("62.0%");
    expect(windows.map((window) => window.label)).toEqual(["Session", "Weekly"]);
    expect(windows[0]?.percent).toBeCloseTo(37.5);
    expect(windows[0]?.resetsIn).toBe("1h 30m");
    expect(windows[1]?.percent).toBeCloseTo(62);
    expect(windows[1]?.resetsIn).toBe("4d 6h");
  });

  test("reads the active profile rather than the first one", async () => {
    const fakeFetch = (() =>
      gatewayResponse({
        activeProfile: "work",
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
      })) as unknown as typeof fetch;

    const quota = await fetchAnthropicQuota("http://gateway", undefined, fakeFetch);
    expect(quota?.percent).toBe(50);
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
      Promise.resolve(new Response(undefined, { status: 404 }))) as unknown as typeof fetch;
    const malformed = (() =>
      gatewayResponse({
        profiles: [{ isActive: true, windows: [{ type: "five_hour", utilization: 0.1 }] }],
      })) as unknown as typeof fetch;
    const empty = (() => gatewayResponse({ profiles: [] })) as unknown as typeof fetch;

    expect(await fetchAnthropicQuota("", undefined, unusable)).toBeUndefined();
    expect(await fetchAnthropicQuota("http://gateway", undefined, unsuccessful)).toBeUndefined();
    expect(await fetchAnthropicQuota("http://gateway", undefined, malformed)).toBeUndefined();
    expect(await fetchAnthropicQuota("http://gateway", undefined, empty)).toBeUndefined();
  });

  test("derives Azure quota only from valid token headers", () => {
    expect(
      quotaFromHeaders("azure-openai", {
        "x-ratelimit-limit-tokens": "1000",
        "x-ratelimit-remaining-tokens": "250",
      }),
    ).toEqual({ label: "azure", percent: 75 });
    expect(quotaFromHeaders("anthropic", {})).toBeUndefined();
    expect(
      quotaFromHeaders("azure-openai", {
        "x-ratelimit-limit-tokens": "0",
        "x-ratelimit-remaining-tokens": "0",
      }),
    ).toBeUndefined();
  });
});

describe("Anthropic quota polling lifecycle", () => {
  test("does not overlap requests when a timer fires", async () => {
    const timers = fakeTimers();
    const requests: ReturnType<typeof deferred<ProviderQuota | undefined>>[] = [];
    const poller = new AnthropicQuotaPoller(() => undefined, {
      cancel: (timer) => timers.cancel(timer),
      fetchQuota: () => {
        const request = deferred<ProviderQuota | undefined>();
        requests.push(request);
        return request.promise;
      },
      refreshMs: 10,
      schedule: (callback) => timers.schedule(callback),
    });

    poller.start("http://gateway");
    expect(requests).toHaveLength(1);
    expect(timers.size).toBe(1);
    timers.tick();
    expect(requests).toHaveLength(1);

    const [firstRequest] = requests;
    if (!firstRequest) {throw new Error("expected a pending request");}
    firstRequest.resolve({ label: "anthropic", percent: 10 });
    await flushPromises();
    timers.tick();
    expect(requests).toHaveLength(2);
    poller.stop();
    expect(timers.size).toBe(0);
  });

  test("aborts stopped generations and ignores their late results", async () => {
    const timers = fakeTimers();
    const requests: {
      baseUrl: string;
      signal: AbortSignal;
      result: ReturnType<typeof deferred<ProviderQuota | undefined>>;
    }[] = [];
    const published: (ProviderQuota | undefined)[] = [];
    const poller = new AnthropicQuotaPoller((quota) => published.push(quota), {
      cancel: (timer) => timers.cancel(timer),
      fetchQuota: (baseUrl, signal) => {
        const result = deferred<ProviderQuota | undefined>();
        requests.push({ baseUrl, result, signal });
        return result.promise;
      },
      refreshMs: 10,
      schedule: (callback) => timers.schedule(callback),
    });

    poller.start("http://gateway");
    const [first] = requests;
    if (!first) {throw new Error("expected a pending request");}
    poller.start("http://gateway");
    const [, second] = requests;
    if (!second) {throw new Error("expected a second pending request");}
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
    const third = requests.at(2);
    if (!third) {throw new Error("expected a third pending request");}
    poller.stop();
    expect(third.signal.aborted).toBeTrue();
    expect(timers.size).toBe(0);
  });
});
