import { z } from "zod";
import { isoTimestampSchema, marketDateSchema } from "./primitives";
import { sourceStateValues } from "./source-health";
import {
  screenerMarketStateValues,
  screenerSupportLevelSchema,
  sma200wStateValues,
} from "./quotes";

const stockSymbolSchema = z.string().regex(/^[A-Z][A-Z0-9-]{0,11}$/);
const nullablePositiveNumber = z.number().positive().finite().nullable();
const MAX_PLAUSIBLE_PRICE_TO_BOOK = 10;

export const stockDetailQuoteScaleStateValues = ["safe", "mismatch", "unknown"] as const;
export type StockDetailQuoteScaleState = (typeof stockDetailQuoteScaleStateValues)[number];

export const stockDetailLinePointSchema = z.object({
  time: marketDateSchema,
  value: z.number().positive().finite(),
});
export type StockDetailLinePoint = z.infer<typeof stockDetailLinePointSchema>;

export const stockDetailPricePointSchema = z.object({
  time: marketDateSchema,
  open: z.number().positive().finite(),
  high: z.number().positive().finite(),
  low: z.number().positive().finite(),
  close: z.number().positive().finite(),
  volume: z.number().int().nonnegative(),
});
export type StockDetailPricePoint = z.infer<typeof stockDetailPricePointSchema>;

export const stockDetailIntrinsicValueSchema = z.object({
  low: nullablePositiveNumber,
  base: z.number().positive().finite(),
  high: nullablePositiveNumber,
  method: z.string().trim().min(1).max(128),
  asOf: marketDateSchema,
  /** (intrinsicValue / currentPrice - 1) * 100. Null without a usable quote. */
  upsidePct: z.number().finite().nullable(),
})
  .refine((value) => value.low === null || value.low <= value.base, "low must be <= base")
  .refine((value) => value.high === null || value.base <= value.high, "base must be <= high");
export type StockDetailIntrinsicValue = z.infer<typeof stockDetailIntrinsicValueSchema>;

/**
 * Canonical automatic valuation scenarios computed by the serving Worker from
 * persisted fundamentals. This is separate from the manual D1 row so callers
 * can show both while still honoring a deterministic selected-IV priority.
 */
export const stockDetailAutomaticIntrinsicValueSchema = z.object({
  bear: z.number().positive().finite(),
  base: z.number().positive().finite(),
  bull: z.number().positive().finite(),
  method: z.enum(["P/E", "P/B", "P/FCF"]),
  bearMultiple: z.number().positive().finite(),
  baseMultiple: z.number().positive().finite(),
  bullMultiple: z.number().positive().finite(),
  bearUpsidePct: z.number().finite().nullable(),
  baseUpsidePct: z.number().finite().nullable(),
  bullUpsidePct: z.number().finite().nullable(),
})
  .refine((value) => value.bear <= value.base && value.base <= value.bull, "automatic IV scenarios must be ordered")
  .refine(
    (value) => value.bearMultiple <= value.baseMultiple && value.baseMultiple <= value.bullMultiple,
    "automatic IV multiples must be ordered",
  );
export type StockDetailAutomaticIntrinsicValue = z.infer<typeof stockDetailAutomaticIntrinsicValueSchema>;

/**
 * Stock Detail fundamentals exposed to the browser. `priceToBook` is an
 * internal bank-valuation input, not a visible card. Omit missing or implausible
 * values so stale/unit-mismatched accounting data can never reach the P/B model.
 */
export const stockDetailFundamentalsSchema = z.object({
  marketCap: z.string().trim().min(1).nullable(),
  peTtm: z.number().finite().nullable(),
  /** Market cap / shareholders' equity. Used by bank P/B valuation. */
  priceToBook: z.number().positive().finite().nullable().optional(),
  roicPct: z.number().finite().nullable(),
  fcfMarginPct: z.number().finite().nullable(),
  debtToEquity: z.number().finite().nullable(),
}).transform((fundamentals) => {
  if (
    fundamentals.priceToBook === null
    || fundamentals.priceToBook === undefined
    || fundamentals.priceToBook > MAX_PLAUSIBLE_PRICE_TO_BOOK
  ) {
    delete fundamentals.priceToBook;
  }
  return fundamentals;
});

/**
 * Public, provider-neutral Stock Detail read model.
 *
 * The page request is serving-only: data collection happens independently and
 * this response is composed exclusively from persisted D1 state.
 */
export const stockDetailApiResponseSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: isoTimestampSchema,
  symbol: stockSymbolSchema,
  company: z.object({
    name: z.string().trim().min(1).max(256).nullable(),
    exchange: z.string().trim().min(1).max(128).nullable(),
    sector: z.string().trim().min(1).max(256).nullable(),
    logoUrl: z.string().url().nullable(),
  }),
  quote: z.object({
    price: nullablePositiveNumber,
    changeAbs: z.number().finite().nullable(),
    changePct: z.number().finite().nullable(),
    provider: z.string().trim().min(1).max(128).nullable(),
    asOf: isoTimestampSchema.nullable(),
    updatedAt: isoTimestampSchema.nullable(),
    state: z.enum(sourceStateValues),
    marketState: z.enum(screenerMarketStateValues),
    /** Whether the persisted quote is on the same split scale as chart/history. */
    scaleState: z.enum(stockDetailQuoteScaleStateValues),
  }),
  valuation: z.object({
    /** Legacy/manual D1 valuation. Kept separate for explicit user priority. */
    intrinsicValue: stockDetailIntrinsicValueSchema.nullable(),
    /** New canonical automatic scenarios; optional only for rolling-deploy compatibility. */
    automatic: stockDetailAutomaticIntrinsicValueSchema.nullable().optional(),
    /** Manual first, otherwise Automatic Base; optional only for rolling-deploy compatibility. */
    selectedIntrinsicValue: stockDetailIntrinsicValueSchema.nullable().optional(),
  }),
  fundamentals: stockDetailFundamentalsSchema,
  technical: z.object({
    sma200w: nullablePositiveNumber,
    distanceToSma200wPct: z.number().finite().nullable(),
    sma200wState: z.enum(sma200wStateValues),
    sma200wHistoryWeeks: z.number().int().nonnegative().nullable(),
    sma200wAsOf: isoTimestampSchema.nullable(),
    supports: z.array(screenerSupportLevelSchema).max(4),
    sma200wHistory: z.array(stockDetailLinePointSchema),
  }),
  chart: z.object({
    interval: z.literal("1w"),
    priceHistory: z.array(stockDetailPricePointSchema),
    /** Reserved for a future canonical historical-IV series. Empty in v1. */
    intrinsicValueHistory: z.array(stockDetailLinePointSchema),
  }),
  freshness: z.object({
    quoteAsOf: isoTimestampSchema.nullable(),
    historyAsOf: isoTimestampSchema.nullable(),
    valuationAsOf: marketDateSchema.nullable(),
    technicalAsOf: isoTimestampSchema.nullable(),
  }),
});
export type StockDetailApiResponse = z.infer<typeof stockDetailApiResponseSchema>;
