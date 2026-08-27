-- FX reference rates for Automatic IV V2.1 instrument/currency normalization.
--
-- The fundamentals-ingestor derives canonical per-share facts (eps, FCF/share,
-- revenue/share, book value/share) per *traded security* and in the quote
-- currency. Three Core symbols are reported by Finnhub in a local currency and
-- need conversion to USD: TSM (TWD), NVO (DKK), ASML (EUR). The ingestor fetches
-- a free daily FX feed server-side and persists last-known-good rates here so a
-- failed fetch never clears a valid rate.
--
-- rate is expressed as number of `counter_currency` units per `base_currency`
-- unit (e.g. base=USD, counter=TWD, rate=31.85 means 31.85 TWD per 1 USD). The
-- division direction used by normalization is therefore `local / rate = USD`.
-- as_of is the source date; updated_at is when the ingestor last refreshed this
-- row (idempotent upsert on (base_currency, counter_currency)).
CREATE TABLE IF NOT EXISTS fx_rates (
  base_currency TEXT NOT NULL,
  counter_currency TEXT NOT NULL,
  rate REAL NOT NULL,
  as_of TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (base_currency, counter_currency)
);