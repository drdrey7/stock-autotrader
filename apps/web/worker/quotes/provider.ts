import type { QuoteObservation } from "@stock-autotrader/contracts";

/**
 * QuoteProvider contract (Screener PR1).
 *
 * The rest of the system depends on this interface — never on Finnhub or any
 * concrete adapter. A QuoteProvider normalizes external payloads into
 * provider-neutral QuoteObservation tuples (price, changeAbs, changePct,
 * day high/low/open, previousClose, asOf, provider). Swapping Finnhub for
 * another provider must not touch the D1 schema, the API or the frontend.
 *
 * `collect` never throws for a per-symbol failure: valid observations are
 * returned alongside warnings describing the symbols that failed, so a
 * partial provider response can never destroy the whole invocation.
 */
export interface QuoteResult {
  observations: QuoteObservation[];
  /** Per-symbol failure descriptions, bounded and prefix-trimmed. */
  warnings: string[];
  /** True when a rate limit (429) was observed during this collection. */
  rateLimited: boolean;
}

export interface QuoteProvider {
  readonly name: string;
  collect(symbols: readonly string[], collectedAt: string): Promise<QuoteResult>;
}
