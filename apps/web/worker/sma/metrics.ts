/**
 * LIVE 200-week SMA computation — combines the precomputed historical basis
 * (technical_metrics, maintained weekly by apps/history-ingestor) with the
 * current Finnhub WebSocket quote at read time.
 */

import type { Sma200wState, TechnicalMetricsRow } from "@stock-autotrader/contracts";
import { isoWeekOfDateKey, isoWeekOfNyInstant, weekDiffDays } from "./weeks";

export interface QuoteInput {
  price: number;
  provider_timestamp: string;
}

export interface LiveSmaResult {
  sma200w: number | null;
  distanceToSma200wPct: number | null;
  sma200wState: Sma200wState;
  sma200wHistoryWeeks: number | null;
  sma200wAsOf: string | null;
}

export type QuoteHistoryScaleState = "safe" | "mismatch" | "unknown";

/**
 * Shared split-scale guard for any feature that combines a current quote with
 * the split-adjusted historical basis. A Monday-effective split can leave the
 * latest quote on Friday's pre-split scale while maintenance has already
 * recalculated historical metrics onto the post-split scale. The inverse is
 * also possible while reconciliation catches up.
 *
 * `safe` means both observations are on the same side of the latest split (or
 * the symbol has no split). `mismatch` means combining them is unsafe.
 * `unknown` is conservative metadata for a split-bearing symbol when either
 * timestamp cannot establish compatibility.
 */
export function quoteHistoryScaleState(
  quote: QuoteInput | null,
  metrics: TechnicalMetricsRow | null,
  latestSplitEffectiveDates: Map<string, string> | null = null,
): QuoteHistoryScaleState {
  const symbol = metrics?.symbol;
  const latestSplitEffectiveDate = symbol && latestSplitEffectiveDates
    ? latestSplitEffectiveDates.get(symbol)
    : undefined;
  if (!latestSplitEffectiveDate) return "safe";
  if (!quote || !metrics?.calculated_at) return "unknown";

  const splitMs = Date.parse(`${latestSplitEffectiveDate}T00:00:00.000Z`);
  const metricsMs = Date.parse(metrics.calculated_at);
  const quoteMs = Date.parse(quote.provider_timestamp);
  if (![splitMs, metricsMs, quoteMs].every(Number.isFinite)) return "unknown";
  return (quoteMs >= splitMs) === (metricsMs >= splitMs) ? "safe" : "mismatch";
}

/** 199 completed weeks are required BEFORE the quote's week. */
const MIN_BASIS_WEEKS = 199;

export function computeLiveSma200w(
  quote: QuoteInput | null,
  metrics: TechnicalMetricsRow | null,
  latestSplitEffectiveDates: Map<string, string> | null = null,
): LiveSmaResult {
  const historyWeeks = metrics?.completed_weeks_available ?? null;
  const asOf = metrics?.historical_data_as_of ?? null;

  if (!metrics || metrics.anchor_week === null) {
    return { sma200w: null, distanceToSma200wPct: null, sma200wState: "Unavailable", sma200wHistoryWeeks: historyWeeks, sma200wAsOf: asOf };
  }
  if ((metrics.completed_weeks_available ?? 0) < MIN_BASIS_WEEKS) {
    return { sma200w: null, distanceToSma200wPct: null, sma200wState: "NotEnoughHistory", sma200wHistoryWeeks: historyWeeks, sma200wAsOf: asOf };
  }
  if (metrics.sum_199 === null || metrics.anchor_close === null) {
    return { sma200w: null, distanceToSma200wPct: null, sma200wState: "Unavailable", sma200wHistoryWeeks: historyWeeks, sma200wAsOf: asOf };
  }
  if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) {
    return { sma200w: null, distanceToSma200wPct: null, sma200wState: "Unavailable", sma200wHistoryWeeks: historyWeeks, sma200wAsOf: asOf };
  }

  // The same guard is exported for Stock Detail current-price presentation so
  // Screener SMA and chart serving cannot diverge on split-scale safety.
  if (quoteHistoryScaleState(quote, metrics, latestSplitEffectiveDates) === "mismatch") {
    return { sma200w: null, distanceToSma200wPct: null, sma200wState: "Unavailable", sma200wHistoryWeeks: historyWeeks, sma200wAsOf: asOf };
  }

  const quoteWeek = isoWeekOfNyInstant(new Date(quote.provider_timestamp));
  const anchorWeek = isoWeekOfDateKey(metrics.anchor_week);
  if (!quoteWeek || !anchorWeek) {
    return { sma200w: null, distanceToSma200wPct: null, sma200wState: "Unavailable", sma200wHistoryWeeks: historyWeeks, sma200wAsOf: asOf };
  }

  let basis: number;
  const delta = weekDiffDays(quoteWeek, anchorWeek) / 7;
  if (delta === 1) {
    basis = metrics.sum_199;
  } else if (delta === 0) {
    if (metrics.closed_sma_200w === null) {
      return { sma200w: null, distanceToSma200wPct: null, sma200wState: "NotEnoughHistory", sma200wHistoryWeeks: historyWeeks, sma200wAsOf: asOf };
    }
    basis = metrics.closed_sma_200w * 200 - metrics.anchor_close;
  } else {
    return { sma200w: null, distanceToSma200wPct: null, sma200wState: "Unavailable", sma200wHistoryWeeks: historyWeeks, sma200wAsOf: asOf };
  }

  const sma200w = (basis + quote.price) / 200;
  const distance = (quote.price / sma200w - 1) * 100;
  let state: Sma200wState;
  if (distance < 0) state = "Below";
  else if (distance <= 3 + 1e-9) state = "Near";
  else state = "Above";

  return { sma200w, distanceToSma200wPct: distance, sma200wState: state, sma200wHistoryWeeks: historyWeeks, sma200wAsOf: asOf };
}
