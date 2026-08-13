-- 0009_earnings_identity_scope.sql — provider-scoped and fiscal-period identity
--
-- The first engine migration created the requested write model. This follow-up
-- makes its uniqueness rules match the provider-neutral identity contract.

DROP INDEX IF EXISTS idx_earnings_events_provider_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_earnings_events_provider_identity
  ON earnings_events (calendar_provider, provider_event_id)
  WHERE calendar_provider IS NOT NULL AND provider_event_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_earnings_events_fiscal_period_identity
  ON earnings_events (
    symbol,
    fiscal_year,
    COALESCE(fiscal_period, 'Q' || fiscal_quarter)
  )
  WHERE fiscal_year IS NOT NULL
    AND (fiscal_period IS NOT NULL OR fiscal_quarter IS NOT NULL);
