import type { SourceState, ScreenerMarketState } from "@stock-autotrader/contracts";
import { localNewYorkParts, marketCollectionWindow } from "../market-context";

/**
 * Quote freshness windows (market-aware).
 *
 * During the US equity session each Core symbol is refreshed about every five
 * minutes; three consecutive missed shard refreshes (~15 min) make a symbol
 * Stale. Outside the session (weekend, holiday, pre-market, overnight) the
 * last session's quotes stay usable (Cached) for up to 7 days — they are
 * never Stale merely because hours pass while the market is closed.
 */
export const QUOTES_SESSION_STALE_AFTER_SECONDS = 15 * 60;
export const QUOTES_OFF_SESSION_STALE_AFTER_SECONDS = 7 * 24 * 60 * 60;

/**
 * Right after the 09:30 ET open the shard sweep needs ~5 minutes to refresh
 * all 5 shards. A previous-session close is still the best available data
 * during that window, so those quotes stay Cached (never Stale) until the
 * grace elapses or the symbol is refreshed by the current session.
 */
export const MARKET_OPEN_QUOTE_GRACE_MINUTES = 10;

/** US equity regular session open (NYSE + NASDAQ): 09:30 America/New_York. */
const SESSION_OPEN_MINUTES_ET = 9 * 60 + 30;

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
 * Whole minutes elapsed since the 09:30 ET session open, in New York time.
 * DST-safe via the shared America/New_York calendar — never hardcoded UTC.
 */
export function minutesSinceSessionOpen(now: Date): number | null {
  const parts = localNewYorkParts(now);
  if (!parts) return null;
  return parts.hour * 60 + parts.minute - SESSION_OPEN_MINUTES_ET;
}

/** True inside the first MARKET_OPEN_QUOTE_GRACE_MINUTES of a NY session day. */
export function withinMarketOpenGrace(now: Date): boolean {
  const minutes = minutesSinceSessionOpen(now);
  return minutes !== null && minutes >= 0 && minutes < MARKET_OPEN_QUOTE_GRACE_MINUTES;
}

const nyDateKey = (year: number, month: number, day: number): string =>
  `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

/** New York calendar date of a timestamp (dst-aware). */
export function nyDateKeyOf(instant: Date): string | null {
  if (!Number.isFinite(instant.getTime())) return null;
  const parts = localNewYorkParts(instant);
  return parts ? nyDateKey(parts.year, parts.month, parts.day) : null;
}

/** True when the quote was collected on an earlier NY session than `now`. */
export function isPriorSessionQuote(updatedAt: string, now: Date): boolean {
  const collectedKey = nyDateKeyOf(new Date(Date.parse(updatedAt)));
  const todayKey = nyDateKeyOf(now);
  return collectedKey !== null && todayKey !== null && collectedKey < todayKey;
}

/**
 * Per-symbol freshness state from the last successful collection timestamp.
 * A symbol with no row, or an unreadable/future row, is Unavailable.
 *
 * Session handling: a current-session refresh is Live while fresh; a
 * previous-session close stays Cached if the market is closed or inside the
 * post-open grace window (the collector has not reached the shard yet), and
 * becomes Stale once the grace elapses without a current-session refresh.
 */
export function quoteState(updatedAt: string | null, now: Date): SourceState {
  if (updatedAt === null) return "Unavailable";
  const collectedMs = Date.parse(updatedAt);
  if (!Number.isFinite(collectedMs)) return "Unavailable";
  const ageSeconds = (now.getTime() - collectedMs) / 1000;
  const market = quotesMarketState(now);
  if (market === "closed") {
    return ageSeconds >= 0 && ageSeconds <= QUOTES_OFF_SESSION_STALE_AFTER_SECONDS ? "Cached" : "Stale";
  }
  if (ageSeconds >= 0 && ageSeconds <= QUOTES_SESSION_STALE_AFTER_SECONDS) return "Live";
  // Market is open but this symbol has not been refreshed in the current
  // session. Right after the open the last close is still the best data —
  // keep it Cached during a short grace window so the shard sweep can catch
  // up (~5 min for all 5 shards); after grace it is genuinely stale. Only a
  // still-valid last-known reading (within the off-session window) qualifies
  // — an ancient row never flashes Cached for ten minutes.
  if (withinMarketOpenGrace(now)
    && isPriorSessionQuote(updatedAt, now)
    && ageSeconds >= 0
    && ageSeconds <= QUOTES_OFF_SESSION_STALE_AFTER_SECONDS) {
    return "Cached";
  }
  return "Stale";
}

/** Per-row state counts over one Screener response (population stats). */
export interface QuoteStateCounts {
  total: number;
  live: number;
  cached: number;
  stale: number;
  unavailable: number;
}

export function countQuoteStates(rows: readonly { state: SourceState }[]): QuoteStateCounts {
  const counts: QuoteStateCounts = { total: rows.length, live: 0, cached: 0, stale: 0, unavailable: 0 };
  for (const row of rows) {
    if (row.state === "Live") counts.live += 1;
    else if (row.state === "Cached") counts.cached += 1;
    else if (row.state === "Unavailable") counts.unavailable += 1;
    else counts.stale += 1; // Stale (and Error) count against freshness
  }
  return counts;
}

/**
 * Collector-level state derived from the real per-stock states — never from a
 * single "last run" timestamp. A shard failing persistently leaves its
 * symbols Stale, so the global state must stop claiming "Live" even though
 * successful shards keep recording fresh timestamps.
 *
 * Market-open grace is not an outage: previous-session quotes inside the
 * grace window are Cached (counted healthy), so the collector reads Live
 * while the sweep catches up.
 */
export function collectorStateFromRows(counts: QuoteStateCounts, market: ScreenerMarketState): SourceState {
  if (counts.live === 0 && counts.cached === 0 && counts.stale === 0) return "Unavailable";
  if (market === "closed") return counts.stale === 0 ? "Cached" : "Stale";
  if (counts.stale > 0) return "Stale";
  // Nothing Stale in an open market, but never-collected symbols also mean the
  // collector is not "Live": partial coverage reads Stale until every symbol
  // is accounted for; a fully empty population stays Unavailable.
  if (counts.unavailable > 0) return counts.live > 0 ? "Stale" : "Unavailable";
  // All 50 accounted for with zero stale: Live once at least one symbol has
  // been refreshed by the current session; all-Cached right at the open (the
  // sweep has not landed yet) reads as Cached — last close is best, never a
  // false outage and never a false Live.
  return counts.live > 0 ? "Live" : "Cached";
}
