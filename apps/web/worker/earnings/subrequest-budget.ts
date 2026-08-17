/**
 * Conservative external-subrequest budget for the Workers Free account limit.
 * Provider retries count as separate external requests.
 */
export const WORKERS_FREE_EXTERNAL_SUBREQUEST_LIMIT = 50;
export const MAX_PROVIDER_ATTEMPTS = 2;
export const MAX_SEC_FILING_LOOKUPS_PER_JOB = 16;
export const MAX_SEC_INDEX_QUARTERS_PER_CALENDAR = 3;

/**
 * Bounded Finnhub Company Profile 2 enrichment budget (one symbol per
 * request). Maintenance-only after the external production bootstrap: the
 * Worker never tries to fill the full Core set in one run. Failures stay
 * non-critical diagnostics, but the request count is still part of the real
 * daily worst-case budget (retries included via MAX_PROVIDER_ATTEMPTS).
 */
export const MAX_FINNHUB_PROFILE_REQUESTS_PER_JOB = 2;

/**
 * Targeted historical recovery budget: one symbol-scoped Finnhub calendar
 * request per symbol, only for active Core symbols whose recent reported
 * history is missing from the bulk response. Maintenance-only: heavy
 * backfills are deliberately handled outside the Worker (VPS/Hermes).
 * Verified against production: the symbol-scoped query is the only endpoint
 * that returns MSFT/AAPL late-July events (bulk caps at ~1500 rows).
 */
export const MAX_HISTORICAL_RECOVERY_SYMBOLS_PER_JOB = 2;

/**
 * Conservative inter-request pacing for Finnhub calls sharing the free-tier
 * 60 calls/minute budget with the production monitor. 1100ms keeps the
 * calendar run well under the free-tier rate limit — the 2026-08-16
 * production probe observed HTTP 429 when calls were burst, and zero 429s
 * at this spacing.
 */
export const FINNHUB_RATE_PACING_MS = 1100;

export const MAX_SEC_METADATA_REQUESTS = MAX_PROVIDER_ATTEMPTS;
export const MAX_SEC_FULL_INDEX_REQUESTS = MAX_SEC_INDEX_QUARTERS_PER_CALENDAR * MAX_PROVIDER_ATTEMPTS;
export const MAX_SEC_FILING_REQUESTS = MAX_SEC_FILING_LOOKUPS_PER_JOB * MAX_PROVIDER_ATTEMPTS;
export const MAX_FINNHUB_CALENDAR_REQUESTS = MAX_PROVIDER_ATTEMPTS;
// Kept as a compatibility export for callers/tests that still enumerate the
// optional FMP adapter. Production earnings no longer selects this adapter.
export const MAX_FMP_CALENDAR_REQUESTS = MAX_PROVIDER_ATTEMPTS;
export const MAX_YAHOO_INDEX_REQUESTS = 4;
export const MAX_CNN_SENTIMENT_REQUESTS = 1;

/** Retried worst-case cost of the maintenance recovery pass. */
export const MAX_HISTORICAL_RECOVERY_REQUESTS =
  MAX_HISTORICAL_RECOVERY_SYMBOLS_PER_JOB * MAX_PROVIDER_ATTEMPTS;

/** Retried worst-case cost of the maintenance profile enrichment pass. */
export const MAX_FINNHUB_PROFILE_REQUESTS =
  MAX_FINNHUB_PROFILE_REQUESTS_PER_JOB * MAX_PROVIDER_ATTEMPTS;

/**
 * Real daily calendar worst case for the production Finnhub path. Every
 * external call that can fire inside the same `0 6 * * *` invocation is
 * counted, including best-effort recovery/profile enrichment and retries.
 *
 * SEC metadata + bulk Finnhub calendar + SEC filing lookups + targeted
 * recovery + company profile enrichment.
 */
export const REAL_DAILY_WORST_CASE_EXTERNAL_SUBREQUESTS =
  MAX_SEC_METADATA_REQUESTS
  + MAX_FINNHUB_CALENDAR_REQUESTS
  + MAX_SEC_FILING_REQUESTS
  + MAX_HISTORICAL_RECOVERY_REQUESTS
  + MAX_FINNHUB_PROFILE_REQUESTS;

/**
 * Finnhub path: SEC metadata + one bulk Finnhub calendar request + filing enrichment.
 * FMP path: retained only for optional compatibility tests/adapters.
 * SEC path: SEC metadata + up to three quarterly indexes + filing enrichment.
 * The 14:00/19:00 dispatch also includes four Yahoo requests and one CNN request.
 *
 * Daily paths include recovery + profile maintenance so the budget map cannot
 * silently drop best-effort Finnhub work that still consumes subrequests.
 */
export const EXTERNAL_SUBREQUEST_BUDGET = {
  monitorWithFinnhub: MAX_FINNHUB_CALENDAR_REQUESTS + MAX_SEC_FILING_REQUESTS
    + MAX_YAHOO_INDEX_REQUESTS + MAX_CNN_SENTIMENT_REQUESTS,
  monitorWithFmp: MAX_FMP_CALENDAR_REQUESTS + MAX_SEC_FILING_REQUESTS
    + MAX_YAHOO_INDEX_REQUESTS + MAX_CNN_SENTIMENT_REQUESTS,
  dailyWithFinnhub: REAL_DAILY_WORST_CASE_EXTERNAL_SUBREQUESTS,
  monitorWithSec: MAX_SEC_METADATA_REQUESTS + MAX_SEC_FULL_INDEX_REQUESTS + MAX_SEC_FILING_REQUESTS
    + MAX_YAHOO_INDEX_REQUESTS + MAX_CNN_SENTIMENT_REQUESTS,
  dailyWithFmp: MAX_SEC_METADATA_REQUESTS + MAX_FMP_CALENDAR_REQUESTS + MAX_SEC_FILING_REQUESTS
    + MAX_HISTORICAL_RECOVERY_REQUESTS + MAX_FINNHUB_PROFILE_REQUESTS,
  dailyWithSec: MAX_SEC_METADATA_REQUESTS + MAX_SEC_FULL_INDEX_REQUESTS + MAX_SEC_FILING_REQUESTS
    + MAX_HISTORICAL_RECOVERY_REQUESTS + MAX_FINNHUB_PROFILE_REQUESTS,
} as const;

export const MAX_COMBINED_PRODUCTION_INVOCATION_REQUESTS = Math.max(
  EXTERNAL_SUBREQUEST_BUDGET.monitorWithFinnhub,
  EXTERNAL_SUBREQUEST_BUDGET.monitorWithSec,
  EXTERNAL_SUBREQUEST_BUDGET.dailyWithFinnhub,
);

export const MIN_PRODUCTION_INVOCATION_HEADROOM =
  WORKERS_FREE_EXTERNAL_SUBREQUEST_LIMIT - MAX_COMBINED_PRODUCTION_INVOCATION_REQUESTS;
