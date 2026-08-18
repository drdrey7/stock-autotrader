import type { QuoteObservation } from "@stock-autotrader/contracts";
import { FinnhubRequestGate, fetchJsonWithRetry } from "../earnings/providers";
import { FINNHUB_RATE_PACING_MS } from "../earnings/subrequest-budget";
import { QUOTES_BOUNDED_CONCURRENCY } from "./budget";
import type { QuoteProvider, QuoteResult } from "./provider";

const FINNHUB_QUOTE_URL = "https://finnhub.io/api/v1/quote";
const PROVIDER_TIMEOUT_MS = 8_000;

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Sleeper = (milliseconds: number) => Promise<void>;

const defaultSleep: Sleeper = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

const finiteNumber = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};

const positiveOrNull = (value: unknown): number | null => {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
};

/**
 * Normalize one Finnhub /quote payload into the provider-neutral internal
 * shape. Returns null for a malformed/incomplete quote (caller records a
 * warning). Finnhub field vocabulary ("c","d","dp","pc",…) never leaves this
 * adapter.
 */
export function normalizeFinnhubQuote(
  symbol: string,
  payload: unknown,
): QuoteObservation | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw = payload as Record<string, unknown>;
  const price = positiveOrNull(raw.c);
  const changeAbs = finiteNumber(raw.d);
  const changePct = finiteNumber(raw.dp);
  const providerTimestamp = finiteNumber(raw.t);
  if (price === null) return null;
  if (changeAbs === null || changePct === null) return null;
  if (providerTimestamp === null || providerTimestamp <= 0) return null;
  const asOf = new Date(providerTimestamp * 1000).toISOString();
  if (!Number.isFinite(Date.parse(asOf))) return null;
  return {
    symbol,
    price,
    changeAbs,
    changePct,
    dayHigh: positiveOrNull(raw.h),
    dayLow: positiveOrNull(raw.l),
    dayOpen: positiveOrNull(raw.o),
    previousClose: positiveOrNull(raw.pc),
    asOf,
    provider: "finnhub-quote",
  };
}

const isRateLimited = (message: string): boolean => message.includes("HTTP 429");

/**
 * Bounded-concurrency mapper. QUOTES_BOUNDED_CONCURRENCY is deliberately 1
 * (serial): the shared FinnhubRequestGate (1100 ms) must pace individual
 * requests, and concurrency > 1 makes its synchronized wake-up fire requests
 * in bursts. Serial means every request lands 1.1 s apart and the collector
 * never presents a 5-at-once burst to the provider (a 429 trigger observed in
 * production at 10 req/min).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Finnhub REST quote adapter. One bounded subrequest per symbol on the
 * existing FinnhubRequestGate (1100ms free-tier pacing), kept out of URLs and
 * logs via the X-Finnhub-Token header — the same safe channel the earnings
 * adapters use.
 */
export class FinnhubQuoteProvider implements QuoteProvider {
  readonly name = "finnhub-quote";
  private readonly gate: FinnhubRequestGate;

  constructor(
    private readonly apiKey: string,
    private readonly fetcher: Fetcher = fetch,
    private readonly sleeper: Sleeper = defaultSleep,
    private readonly timeoutMs = PROVIDER_TIMEOUT_MS,
    gate?: FinnhubRequestGate,
  ) {
    if (!apiKey.trim()) throw new Error("FINNHUB_API_KEY is not configured");
    this.gate = gate ?? new FinnhubRequestGate(FINNHUB_RATE_PACING_MS, sleeper);
  }

  private async fetchOne(symbol: string): Promise<QuoteObservation> {
    const url = new URL(FINNHUB_QUOTE_URL);
    url.searchParams.set("symbol", symbol);
    const payload = await fetchJsonWithRetry(
      this.fetcher,
      url,
      {
        headers: {
          Accept: "application/json",
          // Keep the token out of URLs, logs and downstream request metadata.
          "X-Finnhub-Token": this.apiKey,
        },
      },
      this.sleeper,
      this.timeoutMs,
      () => this.gate.beforeAttempt(),
      // No retry on HTTP 429: a rate limit is per-minute budget exhaustion —
      // retrying within the same window only amplifies the pressure. The
      // symbol degrades for this run and the next cron tick recovers; the
      // last-known-good quote stays in D1 untouched.
      true,
    );
    const observation = normalizeFinnhubQuote(symbol, payload);
    if (observation === null) throw new Error("malformed Finnhub quote response");
    return observation;
  }

  /**
   * Implements QuoteProvider.collect, deliberately declaring fewer params:
   * `collectedAt` is part of the provider contract for callers, but Finnhub
   * /quote returns its own authoritative source timestamp (`t`) so the
   * adapter has no need for the collection instant. Extra interface args are
   * ignored at runtime (JS).
   */
  async collect(symbols: readonly string[]): Promise<QuoteResult> {
    const results = await mapWithConcurrency(symbols, QUOTES_BOUNDED_CONCURRENCY, async (symbol) => {
      try {
        return { kind: "ok" as const, observation: await this.fetchOne(symbol) };
      } catch (error) {
        const message = errorMessage(error).slice(0, 180);
        return { kind: "warn" as const, symbol, message, rateLimited: isRateLimited(message) };
      }
    });

    const observations: QuoteObservation[] = [];
    const warnings: string[] = [];
    let rateLimited = false;
    for (const result of results) {
      if (result.kind === "ok") {
        observations.push(result.observation);
      } else {
        warnings.push(`${result.symbol}: ${result.message}`);
        if (result.rateLimited) rateLimited = true;
      }
    }
    return { observations, warnings, rateLimited };
  }
}
