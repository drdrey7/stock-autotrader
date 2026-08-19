/**
 * LIVE 200-week SMA computation — combines the precomputed historical basis
 * (technical_metrics, maintained weekly by apps/history-ingestor) with the
 * current Finnhub WebSocket quote at read time.
 *
 * Formula (PR2 spec §7):
 *   SMA200W live = (sum of the 199 completed split-adjusted weekly closes
 *                   immediately preceding the quote's trading week
 *                   + the current/latest quote price) / 200
 *
 * The 199-week basis is anchored to the quote's OWN trading week (derived
 * from latest_quotes.provider_timestamp in America/New_York), so:
 *   - the current week is NEVER in the 199 basis (no double count),
 *   - it works during market hours, post-close, weekends, Monday pre-open,
 *     holidays and early-close days,
 *   - an incomplete current-week bucket is never treated as completed.
 *
 * technical_metrics stores sum_199 = the 199 closes ending at the anchor
 * week L plus anchor_close = L's close. At read time:
 *   - quote week == L      -> basis = closed_sma_200w * 200 - anchor_close
 *     (the quote's own week was already stored as completed history; the 199
 *     closes STRICTLY BEFORE it come from the true 200-week basis — never a
 *     naive sum_199 - anchor_close, which would only supply 198 prior closes)
 *   - quote week == L + 1  -> basis = sum_199 (normal live case)
 *   - quote week > L + 1   -> data gap (maintenance behind): never fabricate
 *   - quote week < L       -> quote older than the basis: inconsistent
 *
 * Same-week (delta 0) requires a genuine 200 completed-week basis; with only
 * 199 completed weeks it honestly reports NotEnoughHistory (there is no way
 * to obtain 199 closes strictly before L from 199 stored weeks).
 *
 * Distance: (current_price / sma200w - 1) * 100, full precision; rounding is
 * display-only. State on the RAW value: < 0 Below; 0..3 Near; > 3 Above
 * (exactly +3.00 is Near).
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

/** 199 completed weeks are required BEFORE the quote's week. */
const MIN_BASIS_WEEKS = 199;

export function computeLiveSma200w(
  quote: QuoteInput | null,
  metrics: TechnicalMetricsRow | null,
  latestSplitEffectiveDates: Map<string, string> | null = null,
): LiveSmaResult {
  const historyWeeks = metrics?.completed_weeks_available ?? null;
  const asOf = metrics?.historical_data_as_of ?? null;

  // No metrics row at all -> nothing to combine with.
  if (!metrics || metrics.anchor_week === null) {
    return { sma200w: null, distanceToSma200wPct: null, sma200wState: "Unavailable", sma200wHistoryWeeks: historyWeeks, sma200wAsOf: asOf };
  }
  // Less than the required history -> honest NotEnoughHistory, never a wrong SMA.
  if ((metrics.completed_weeks_available ?? 0) < MIN_BASIS_WEEKS) {
    return { sma200w: null, distanceToSma200wPct: null, sma200wState: "NotEnoughHistory", sma200wHistoryWeeks: historyWeeks, sma200wAsOf: asOf };
  }
  if (metrics.sum_199 === null || metrics.anchor_close === null) {
    return { sma200w: null, distanceToSma200wPct: null, sma200wState: "Unavailable", sma200wHistoryWeeks: historyWeeks, sma200wAsOf: asOf };
  }
  // No current quote -> do not fabricate a live SMA.
  if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) {
    return { sma200w: null, distanceToSma200wPct: null, sma200wState: "Unavailable", sma200wHistoryWeeks: historyWeeks, sma200wAsOf: asOf };
  }

  // P1 Symmetric split scale guard: the quote and the metrics basis MUST be
  // on the same side of any split. If one is pre-split and the other post-
  // split, the SMA would be catastrophically wrong — report Unavailable until
  // the daily due-split reconciliation synchronizes them.
  //
  // Two failure modes:
  //   A) quote post-split + metrics pre-split (basis on wrong scale)
  //   B) quote pre-split + metrics post-split (Monday-effective split:
  //      maintenance recalculated basis post-split at 05:10 UTC, but the
  //      latest Finnhub quote is still Friday's pre-split close)
  //
  // Per-symbol: NVDA's split state does NOT affect AAPL's SMA.
  if (latestSplitEffectiveDates && metrics.calculated_at && metrics.symbol) {
    const latestSplitEffectiveDate = latestSplitEffectiveDates.get(metrics.symbol);
    if (latestSplitEffectiveDate) {
      try {
        const splitEffective = new Date(latestSplitEffectiveDate + "T00:00:00.000Z");
        const metricsCalculated = new Date(metrics.calculated_at);
        const quoteTime = new Date(quote.provider_timestamp);
        const quoteAfterSplit = quoteTime >= splitEffective;
        const metricsAfterSplit = metricsCalculated >= splitEffective;
        // Mismatch: one is post-split, the other is pre-split.
        if (quoteAfterSplit !== metricsAfterSplit) {
          return { sma200w: null, distanceToSma200wPct: null, sma200wState: "Unavailable", sma200wHistoryWeeks: historyWeeks, sma200wAsOf: asOf };
        }
      } catch {
        // Invalid date format — disable the guard rather than crash.
      }
    }
  }

  const quoteWeek = isoWeekOfNyInstant(new Date(quote.provider_timestamp));
  const anchorWeek = isoWeekOfDateKey(metrics.anchor_week);
  if (!quoteWeek || !anchorWeek) {
    return { sma200w: null, distanceToSma200wPct: null, sma200wState: "Unavailable", sma200wHistoryWeeks: historyWeeks, sma200wAsOf: asOf };
  }

  // The 199 completed weeks strictly before the quote's week.
  let basis: number;
  const delta = weekDiffDays(quoteWeek, anchorWeek) / 7; // weeks ahead of the anchor
  if (delta === 1) {
    // Normal live case: quote is one week past the anchor -> basis = sum_199.
    basis = metrics.sum_199;
  } else if (delta === 0) {
    // The quote's own week L is already stored as completed history, so the
    // 199 closes STRICTLY BEFORE it must not include L's close. A naive
    // `sum_199 - anchor_close` would only supply 198 prior closes + the quote
    // (199 observations total) — wrong. Use the true 200 completed-week basis:
    //   prior_199_sum = closed_sma_200w * 200 - anchor_close
    // This is only honest when a genuine 200-week basis exists; exactly 199
    // completed weeks cannot produce 199 closes strictly before L, so that
    // case must report NotEnoughHistory instead of fabricating a value.
    if (metrics.closed_sma_200w === null) {
      return { sma200w: null, distanceToSma200wPct: null, sma200wState: "NotEnoughHistory", sma200wHistoryWeeks: historyWeeks, sma200wAsOf: asOf };
    }
    basis = metrics.closed_sma_200w * 200 - metrics.anchor_close;
  } else {
    // delta > 1: maintenance data gap (missing completed weeks) — the basis
    // would be wrong. delta < 0: quote older than the basis — inconsistent.
    // Never fabricate a value.
    return { sma200w: null, distanceToSma200wPct: null, sma200wState: "Unavailable", sma200wHistoryWeeks: historyWeeks, sma200wAsOf: asOf };
  }

  const sma200w = (basis + quote.price) / 200;
  const distance = (quote.price / sma200w - 1) * 100;
  let state: Sma200wState;
  // The +3.00 boundary is inclusive ("Near" at exactly 3.00). Raw floats can
  // land a hair above 3.0 for an exact 3.00 input (e.g. 103/100 in IEEE754),
  // so a tiny epsilon keeps the classifier honest at the boundary without
  // weakening real Above readings.
  if (distance < 0) state = "Below";
  else if (distance <= 3 + 1e-9) state = "Near";
  else state = "Above";

  return { sma200w, distanceToSma200wPct: distance, sma200wState: state, sma200wHistoryWeeks: historyWeeks, sma200wAsOf: asOf };
}
