import { z } from "zod";
import { isoTimestampSchema } from "./primitives";
import { sourceStateValues } from "./source-health";

/**
 * Provider-neutral latest-quote observation (Screener PR1).
 *
 * Field names deliberately never leak provider vocabulary (Finnhub "c"/"d"/
 * "dp"/"pc" stay inside the adapter). `asOf` is the provider's own source
 * timestamp for the quote; consumers that need collection time keep it
 * separately (ScreenerRow.updatedAt).
 */
export const quoteObservationSchema = z.object({
  symbol: z.string().regex(/^[A-Z][A-Z0-9-]{0,11}$/),
  price: z.number().positive().finite(),
  changeAbs: z.number().finite(),
  changePct: z.number().finite(),
  dayHigh: z.number().positive().finite().nullable(),
  dayLow: z.number().positive().finite().nullable(),
  dayOpen: z.number().positive().finite().nullable(),
  previousClose: z.number().positive().finite().nullable(),
  asOf: isoTimestampSchema,
  provider: z.string().trim().min(1).max(128),
});
export type QuoteObservation = z.infer<typeof quoteObservationSchema>;

/**
 * Live 200-week SMA position states (Screener PR2).
 *
 * Computed on the RAW distance value (display rounding never feeds the
 * classifier): distance < 0 -> Below; 0 <= distance <= 3 -> Near;
 * distance > 3 -> Above. "NotEnoughHistory" when fewer than 199 completed
 * weeks precede the quote's trading week; "Unavailable" when the quote or
 * the metrics basis is missing/inconsistent — a live SMA is never fabricated.
 */
export const sma200wStateValues = ["Above", "Near", "Below", "NotEnoughHistory", "Unavailable"] as const;
export type Sma200wState = (typeof sma200wStateValues)[number];

/**
 * The precomputed historical basis row (technical_metrics in D1, maintained
 * by apps/history-ingestor). sum_199 = the 199 most recent completed
 * split-adjusted closes ending at anchor_week; anchor_close = the
 * split-adjusted close of anchor_week (one-row correction term the Worker
 * uses when the quote's own week is already stored as completed history).
 */
export const technicalMetricsRowSchema = z.object({
  symbol: z.string().regex(/^[A-Z][A-Z0-9-]{0,11}$/),
  anchor_week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  completed_weeks_available: z.number().int().nonnegative(),
  sum_199: z.number().finite().nullable(),
  anchor_close: z.number().positive().finite().nullable(),
  closed_sma_200w: z.number().positive().finite().nullable(),
  historical_data_as_of: isoTimestampSchema.nullable(),
  calculated_at: isoTimestampSchema,
  status: z.enum(["ok", "limited", "not_enough_history", "no_data"]),
  source: z.string().trim().min(1).max(128),
});
export type TechnicalMetricsRow = z.infer<typeof technicalMetricsRowSchema>;

/**
 * One Core Universe symbol combined with its latest quote state.
 * `state` reuses the project's shared freshness vocabulary
 * (Live / Cached / Stale / Unavailable / Error).
 */
export const screenerSupportLevelSchema = z.object({
  level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  price: z.number().positive().finite(),
  method: z.string().trim().min(1).max(128),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  triggered: z.boolean().nullable(),
});
export type ScreenerSupportLevel = z.infer<typeof screenerSupportLevelSchema>;

/**
 * Raw D1 row shape for `stock_support_levels`. Validated at the storage
 * boundary so downstream code (API/Worker) only ever sees well-formed rows.
 * Mirrors the validation `sma/storage.ts` applies via `technicalMetricsRowSchema`.
 */
export const supportLevelRowSchema = z.object({
  symbol: z.string().regex(/^[A-Z][A-Z0-9-]{0,11}$/),
  method: z.string().trim().min(1).max(128),
  level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  price: z.number().positive().finite(),
  as_of_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type SupportLevelRow = z.infer<typeof supportLevelRowSchema>;

/** Intrinsic value per symbol exposed on the Screener. base is the primary IV; low/high optional. */
export const screenerIntrinsicValueSchema = z.object({
  low: z.number().positive().finite().nullable(),
  base: z.number().positive().finite(),
  high: z.number().positive().finite().nullable(),
  method: z.string().trim().min(1).max(128),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  distancePct: z.number().finite().nullable(),
})
  .refine((v) => v.low === null || v.low <= v.base, "low must be <= base")
  .refine((v) => v.high === null || v.base <= v.high, "base must be <= high");
export type ScreenerIntrinsicValue = z.infer<typeof screenerIntrinsicValueSchema>;

/** Raw D1 row shape for `stock_intrinsic_values`. Validated at the storage boundary. */
export const intrinsicValueRowSchema = z.object({
  symbol: z.string().regex(/^[A-Z][A-Z0-9-]{0,11}$/),
  method: z.string().trim().min(1).max(128),
  low_value: z.number().positive().finite().nullable(),
  base_value: z.number().positive().finite(),
  high_value: z.number().positive().finite().nullable(),
  as_of_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})
  .refine((v) => v.low_value === null || v.low_value <= v.base_value, {
    message: "low_value must be <= base_value",
  })
  .refine((v) => v.high_value === null || v.base_value <= v.high_value, {
    message: "base_value must be <= high_value",
  });
export type IntrinsicValueRow = z.infer<typeof intrinsicValueRowSchema>;

export const screenerRowSchema = z.object({
  symbol: z.string().regex(/^[A-Z][A-Z0-9-]{0,11}$/),
  company: z.string().nullable(),
  price: z.number().positive().finite().nullable(),
  changeAbs: z.number().finite().nullable(),
  changePct: z.number().finite().nullable(),
  dayHigh: z.number().positive().finite().nullable(),
  dayLow: z.number().positive().finite().nullable(),
  dayOpen: z.number().positive().finite().nullable(),
  previousClose: z.number().positive().finite().nullable(),
  provider: z.string().trim().min(1).max(128).nullable(),
  asOf: isoTimestampSchema.nullable(),
  updatedAt: isoTimestampSchema.nullable(),
  state: z.enum(sourceStateValues),
  // Live 200-week SMA (Screener PR2). sma200w/distance are null whenever the
  // value cannot be computed honestly (no quote, no metrics basis, data gap);
  // sma200wState then reports NotEnoughHistory or Unavailable. Numeric
  // values are raw (full precision) — display rounding is a client concern.
  sma200w: z.number().positive().finite().nullable(),
  distanceToSma200wPct: z.number().finite().nullable(),
  sma200wState: z.enum(sma200wStateValues).nullable(),
  sma200wHistoryWeeks: z.number().int().nonnegative().nullable(),
  sma200wAsOf: isoTimestampSchema.nullable(),
  // Manual support levels S1-S4 (Screener PR). Ordered S1 -> S4, max 4
  // unique levels, price > 0. triggered is derived by the Worker (never
  // persisted): currentPrice <= supportPrice, or null when price is null.
  // Empty array when the support table is unavailable — never fatal.
  supportLevels: z.array(screenerSupportLevelSchema).max(4),
  // Manual intrinsic value (Screener PR). base is the primary IV. low/high
  // are optional/null in v1 (prepared for Stock Detail Page). distancePct is
  // the % distance from current price to base IV, computed in runtime by the
  // Worker (never persisted). Null when the stock has no manual IV or when
  // split-safety invalidates it.
  intrinsicValue: screenerIntrinsicValueSchema.nullable(),
  // Company logo URL (reused from Earnings). Joined from earnings_universe at
  // read time. Null when the company has not been enriched yet; the frontend
  // falls back to a deterministic ticker icon in that case.
  logoUrl: z.string().url().nullable(),
});
export type ScreenerRow = z.infer<typeof screenerRowSchema>;

/**
 * Per-stock state population counts for one Screener response. `stale` also
 * absorbs rows in the Error state (a failed symbol keeps its last-known
 * quote and reads as stale/failed). Used to derive the global collector state
 * so a persistently failing shard cannot hide behind healthy shards.
 */
export const screenerQuoteCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  live: z.number().int().nonnegative(),
  cached: z.number().int().nonnegative(),
  stale: z.number().int().nonnegative(),
  unavailable: z.number().int().nonnegative(),
});
export type ScreenerQuoteCounts = z.infer<typeof screenerQuoteCountsSchema>;

/**
 * Collector-level freshness for the Screener API. `state` is market-aware:
 * during a live session a missed refresh becomes Stale; while the market is
 * closed the last session's data stays Cached (never Stale just because
 * hours pass overnight/weekend). The state is derived from the real per-stock
 * states (see `counts`), never from a single collection timestamp.
 */
export const screenerQuotesHealthSchema = z.object({
  state: z.enum(sourceStateValues),
  provider: z.string().trim().min(1).max(128),
  lastSuccessAt: isoTimestampSchema.nullable(),
  lastAttemptAt: isoTimestampSchema.nullable(),
  error: z.string().trim().max(500).nullable(),
  counts: screenerQuoteCountsSchema,
});
export type ScreenerQuotesHealth = z.infer<typeof screenerQuotesHealthSchema>;

export const screenerMarketStateValues = ["regular", "post_close", "closed"] as const;
export type ScreenerMarketState = (typeof screenerMarketStateValues)[number];

export const screenerApiResponseSchema = z.object({
  universe: z.object({
    version: z.number().int().positive(),
    total: z.number().int().nonnegative(),
  }),
  marketState: z.enum(screenerMarketStateValues),
  quotes: screenerQuotesHealthSchema,
  rows: z.array(screenerRowSchema),
  asOf: isoTimestampSchema.nullable(),
});
export type ScreenerApiResponse = z.infer<typeof screenerApiResponseSchema>;
