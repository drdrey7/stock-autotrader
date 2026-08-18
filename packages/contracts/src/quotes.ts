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
 * One Core Universe symbol combined with its latest quote state.
 * `state` reuses the project's shared freshness vocabulary
 * (Live / Cached / Stale / Unavailable / Error).
 */
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
