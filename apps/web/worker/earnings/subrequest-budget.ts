/**
 * Conservative external-subrequest budget for the Workers Free account limit.
 * Provider retries count as separate external requests.
 */
export const WORKERS_FREE_EXTERNAL_SUBREQUEST_LIMIT = 50;
export const MAX_PROVIDER_ATTEMPTS = 2;
export const MAX_SEC_FILING_LOOKUPS_PER_JOB = 16;
export const MAX_SEC_INDEX_QUARTERS_PER_CALENDAR = 3;

export const MAX_SEC_METADATA_REQUESTS = MAX_PROVIDER_ATTEMPTS;
export const MAX_SEC_FULL_INDEX_REQUESTS = MAX_SEC_INDEX_QUARTERS_PER_CALENDAR * MAX_PROVIDER_ATTEMPTS;
export const MAX_SEC_FILING_REQUESTS = MAX_SEC_FILING_LOOKUPS_PER_JOB * MAX_PROVIDER_ATTEMPTS;
export const MAX_FINNHUB_CALENDAR_REQUESTS = MAX_PROVIDER_ATTEMPTS;
// Kept as a compatibility export for callers/tests that still enumerate the
// optional FMP adapter. Production earnings no longer selects this adapter.
export const MAX_FMP_CALENDAR_REQUESTS = MAX_PROVIDER_ATTEMPTS;
export const MAX_YAHOO_INDEX_REQUESTS = 4;
export const MAX_CNN_SENTIMENT_REQUESTS = 1;

/**
 * Finnhub path: SEC metadata + one bulk Finnhub calendar request + filing enrichment.
 * FMP path: retained only for optional compatibility tests/adapters.
 * SEC path: SEC metadata + up to three quarterly indexes + filing enrichment.
 * The 14:00/19:00 dispatch also includes four Yahoo requests and one CNN request.
 */
export const EXTERNAL_SUBREQUEST_BUDGET = {
  monitorWithFinnhub: MAX_FINNHUB_CALENDAR_REQUESTS + MAX_SEC_FILING_REQUESTS
    + MAX_YAHOO_INDEX_REQUESTS + MAX_CNN_SENTIMENT_REQUESTS,
  monitorWithFmp: MAX_FMP_CALENDAR_REQUESTS + MAX_SEC_FILING_REQUESTS
    + MAX_YAHOO_INDEX_REQUESTS + MAX_CNN_SENTIMENT_REQUESTS,
  dailyWithFinnhub: MAX_SEC_METADATA_REQUESTS + MAX_FINNHUB_CALENDAR_REQUESTS + MAX_SEC_FILING_REQUESTS,
  monitorWithSec: MAX_SEC_METADATA_REQUESTS + MAX_SEC_FULL_INDEX_REQUESTS + MAX_SEC_FILING_REQUESTS
    + MAX_YAHOO_INDEX_REQUESTS + MAX_CNN_SENTIMENT_REQUESTS,
  dailyWithFmp: MAX_SEC_METADATA_REQUESTS + MAX_FMP_CALENDAR_REQUESTS + MAX_SEC_FILING_REQUESTS,
  dailyWithSec: MAX_SEC_METADATA_REQUESTS + MAX_SEC_FULL_INDEX_REQUESTS + MAX_SEC_FILING_REQUESTS,
} as const;

export const MAX_COMBINED_PRODUCTION_INVOCATION_REQUESTS = Math.max(
  EXTERNAL_SUBREQUEST_BUDGET.monitorWithFinnhub,
  EXTERNAL_SUBREQUEST_BUDGET.monitorWithSec,
);

export const MIN_PRODUCTION_INVOCATION_HEADROOM =
  WORKERS_FREE_EXTERNAL_SUBREQUEST_LIMIT - MAX_COMBINED_PRODUCTION_INVOCATION_REQUESTS;
