import type { SourceState } from "@stock-autotrader/contracts";
import { marketCollectionWindow } from "../market-context";
import type { ScreenerMarketState } from "@stock-autotrader/contracts";

/**
 * Quote freshness windows (market-aware).
 *
 * During a live US session each Core symbol is refreshed about every five
 * minutes; three consecutive missed shard refreshes (~15 min) make a symbol
 * Stale. Outside the session (weekend, holiday, pre-market, overnight) the
 * last session's quotes stay usable (Cached) for up to 7 days — they are
 * never Stale merely because hours pass while the market is closed.
 */
export const QUOTES_SESSION_STALE_AFTER_SECONDS = 15 * 60;
export const QUOTES_OFF_SESSION_STALE_AFTER_SECONDS = 7 * 24 * 60 * 60;

export function quotesMarketState(now: Date): ScreenerMarketState {
  const window = marketCollectionWindow(now);
  if (window === "regular") return "regular";
  if (window === "post_close") return "post_close";
  return "closed";
}

export function quoteStaleAfterSeconds(now: Date): number {
  return quotesMarketState(now) === "closed"
    ? QUOTES_OFF_SESSION_STALE_AFTER_SECONDS
    : QUOTES_SESSION_STALE_AFTER_SECONDS;
}

/**
 * Per-symbol freshness state from the last successful collection timestamp.
 * A symbol with no row, or an unreadable/future row, is Unavailable.
 */
export function quoteState(updatedAt: string | null, now: Date): SourceState {
  if (updatedAt === null) return "Unavailable";
  const collectedMs = Date.parse(updatedAt);
  if (!Number.isFinite(collectedMs)) return "Unavailable";
  const ageSeconds = (now.getTime() - collectedMs) / 1000;
  if (quotesMarketState(now) === "closed") {
    return ageSeconds >= 0 && ageSeconds <= QUOTES_OFF_SESSION_STALE_AFTER_SECONDS ? "Cached" : "Stale";
  }
  return ageSeconds >= 0 && ageSeconds <= QUOTES_SESSION_STALE_AFTER_SECONDS ? "Live" : "Stale";
}

/**
 * Collector-level state derived from the last successful run. Mirrors the
 * project's ageOverridesError rule (PR #56): a persisted error must never pin
 * fresh data to Cached — the age gate wins.
 */
export function quotesCollectorState(lastSuccessAt: string | null, now: Date): SourceState {
  if (lastSuccessAt === null) return "Unavailable";
  const lastSuccessMs = Date.parse(lastSuccessAt);
  if (!Number.isFinite(lastSuccessMs) || lastSuccessMs > now.getTime()) return "Unavailable";
  if (quotesMarketState(now) === "closed") {
    return (now.getTime() - lastSuccessMs) / 1000 <= QUOTES_OFF_SESSION_STALE_AFTER_SECONDS ? "Cached" : "Stale";
  }
  return (now.getTime() - lastSuccessMs) / 1000 <= QUOTES_SESSION_STALE_AFTER_SECONDS ? "Live" : "Stale";
}
