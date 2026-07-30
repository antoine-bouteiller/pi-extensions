import type { ProviderQuota } from "./state";
import { progressBar } from "./render";

export type QuotaFetcher = (signal: AbortSignal) => Promise<ProviderQuota | null>;

type TimerHandle = ReturnType<typeof setInterval>;

interface AnthropicQuotaPollerOptions {
  refreshMs: number;
  fetchQuota?: QuotaFetcher;
  schedule?: (callback: () => void, delay: number) => TimerHandle;
  cancel?: (timer: TimerHandle) => void;
}

/** Polls one request at a time and prevents an old session's result from being published. */
export class AnthropicQuotaPoller {
  private readonly fetchQuota: QuotaFetcher;
  private readonly onQuota: (quota: ProviderQuota | null) => void;
  private readonly refreshMs: number;
  private readonly schedule: (callback: () => void, delay: number) => TimerHandle;
  private readonly cancel: (timer: TimerHandle) => void;
  private generation = 0;
  private timer: TimerHandle | undefined;
  private request: AbortController | undefined;

  constructor(
    onQuota: (quota: ProviderQuota | null) => void,
    options: AnthropicQuotaPollerOptions,
  ) {
    this.onQuota = onQuota;
    this.refreshMs = options.refreshMs;
    this.fetchQuota = options.fetchQuota ?? ((signal) => fetchAnthropicQuota(signal));
    this.schedule = options.schedule ?? setInterval;
    this.cancel = options.cancel ?? clearInterval;
  }

  start() {
    this.stop();
    const generation = this.generation;
    void this.refresh(generation);
    this.timer = this.schedule(() => void this.refresh(generation), this.refreshMs);
  }

  stop() {
    this.generation += 1;
    if (this.timer !== undefined) this.cancel(this.timer);
    this.timer = undefined;
    this.request?.abort();
    this.request = undefined;
  }

  private async refresh(generation: number) {
    if (generation !== this.generation || this.request) return;
    const request = new AbortController();
    this.request = request;
    try {
      const quota = await this.fetchQuota(request.signal);
      if (generation === this.generation && !request.signal.aborted) this.onQuota(quota);
    } catch {
      // A stopped poll normally rejects when its AbortSignal is handled by fetch.
    } finally {
      if (this.request === request) this.request = undefined;
    }
  }
}

export async function fetchAnthropicQuota(
  signal?: AbortSignal,
  fetchImpl: typeof fetch = globalThis.fetch,
  token = process.env.ANTHROPIC_OAUTH_TOKEN,
): Promise<ProviderQuota | null> {
  if (!token) return null;
  try {
    const response = await fetchImpl("https://api.anthropic.com/api/oauth/usage", {
      signal,
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    });
    if (!response.ok) return null;
    const usage = (await response.json()) as {
      five_hour?: { utilization?: number; resets_at?: string };
      seven_day?: { utilization?: number };
    };
    const current = usage.five_hour?.utilization;
    const weekly = usage.seven_day?.utilization;
    if (typeof current !== "number" || typeof weekly !== "number") return null;
    const resetAt = usage.five_hour?.resets_at;
    const minutes = resetAt
      ? Math.max(0, Math.round((Date.parse(resetAt) - Date.now()) / 60_000))
      : 0;
    const duration = resetAt
      ? minutes >= 60
        ? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
        : `${minutes}m`
      : "";
    return {
      label: "anthropic",
      percent: current,
      detail: `${duration}  Weekly: ${progressBar(weekly, 10)} ${weekly.toFixed(1)}%`,
    };
  } catch {
    return null;
  }
}

export function quotaFromHeaders(
  provider: string,
  headers: Record<string, string>,
): ProviderQuota | null {
  if (!provider.startsWith("azure")) return null;
  const limit = Number(headers["x-ratelimit-limit-tokens"]);
  const remaining = Number(headers["x-ratelimit-remaining-tokens"]);
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining)) return null;
  return { label: "azure", percent: ((limit - remaining) / limit) * 100 };
}
