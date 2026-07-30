import type { ProviderQuota } from "./state";
import { progressBar } from "./render";

export type QuotaFetcher = (
  baseUrl: string,
  signal: AbortSignal,
) => Promise<ProviderQuota | null>;

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
  private baseUrl = "";

  constructor(
    onQuota: (quota: ProviderQuota | null) => void,
    options: AnthropicQuotaPollerOptions,
  ) {
    this.onQuota = onQuota;
    this.refreshMs = options.refreshMs;
    this.fetchQuota =
      options.fetchQuota ?? ((baseUrl, signal) => fetchAnthropicQuota(baseUrl, signal));
    this.schedule = options.schedule ?? setInterval;
    this.cancel = options.cancel ?? clearInterval;
  }

  start(baseUrl: string) {
    this.stop();
    this.baseUrl = baseUrl;
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
      const quota = await this.fetchQuota(this.baseUrl, request.signal);
      if (generation === this.generation && !request.signal.aborted) this.onQuota(quota);
    } catch {
      // A stopped poll normally rejects when its AbortSignal is handled by fetch.
    } finally {
      if (this.request === request) this.request = undefined;
    }
  }
}

/** One usage window as reported by the gateway, with `utilization` as a 0..1 fraction. */
interface GatewayQuotaWindow {
  type?: string;
  utilization?: number;
  resetsAt?: number;
}

interface GatewayQuotaProfile {
  id?: string;
  isActive?: boolean;
  windows?: GatewayQuotaWindow[];
}

interface GatewayQuotaResponse {
  profiles?: GatewayQuotaProfile[];
  activeProfile?: string;
}

function activeProfile(usage: GatewayQuotaResponse): GatewayQuotaProfile | undefined {
  const profiles = usage.profiles ?? [];
  return (
    profiles.find((profile) => profile.isActive) ??
    profiles.find((profile) => profile.id === usage.activeProfile) ??
    profiles[0]
  );
}

function formatReset(resetsAt: number | undefined): string {
  if (typeof resetsAt !== "number") return "";
  const minutes = Math.max(0, Math.round((resetsAt - Date.now()) / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

/**
 * Reads quota from the gateway the anthropic provider is pointed at, which owns the
 * subscription credentials. Upstream `/api/oauth/usage` is not reachable through it.
 */
export async function fetchAnthropicQuota(
  baseUrl: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ProviderQuota | null> {
  if (!baseUrl) return null;
  try {
    const endpoint = `${baseUrl.replace(/\/+$/, "")}/v1/usage/quota/all`;
    const response = await fetchImpl(endpoint, { signal });
    if (!response.ok) return null;
    const profile = activeProfile((await response.json()) as GatewayQuotaResponse);
    if (!profile) return null;
    const windows = profile.windows ?? [];
    const session = windows.find((window) => window.type === "five_hour");
    const weekly = windows.find((window) => window.type === "seven_day");
    if (typeof session?.utilization !== "number" || typeof weekly?.utilization !== "number")
      return null;
    const sessionPercent = session.utilization * 100;
    const weeklyPercent = weekly.utilization * 100;
    return {
      label: "anthropic",
      percent: sessionPercent,
      detail: `${formatReset(session.resetsAt)}  Weekly: ${progressBar(weeklyPercent, 10)} ${weeklyPercent.toFixed(1)}%`,
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
