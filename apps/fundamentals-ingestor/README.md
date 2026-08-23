# Simple fundamentals ingestor

The daily job calls Finnhub `stock/metric?metric=all` once per Core Universe
symbol and UPSERTs the direct Stock Detail fundamentals into D1. It never runs
from the Worker request path.

Runtime flow:

```
Finnhub metric=all (50 Core symbols, daily)
  -> VPS fundamentals-ingestor
  -> stock_fundamentals_snapshot
  -> Worker /api/stocks/:symbol/detail
  -> Stock Detail cards
```

The current cards use direct Finnhub values when present:

- Market Cap
- P/E TTM
- ROIC (`series.quarterly.roicTTM`, annual ROIC fallback)
- FCF Margin (`series.quarterly.fcfMargin`, annual fallback)
- Debt/Equity (`series.quarterly.totalDebtToEquity`, metric fallback)

The job also stores `fcf_per_share_ttm` from
`series.quarterly.fcfPerShareTTM` as the starting input for a later simple
per-share DCF. The DCF itself is deliberately not part of this ingestor.

Missing individual metrics are valid NULLs and render as `—` in Stock Detail.
A failed Finnhub request performs no write for that symbol, preserving the
previous D1 snapshot. The existing quote WebSocket remains the only automatic
current-price collector and is not part of this job.

Legacy Edgar adapter code/data may remain in the repository for historical
compatibility, but the daily fundamentals runtime does not call EdgarTools and
does not require `EDGAR_IDENTITY`.

Required EnvironmentFile values are `FINNHUB_API_KEY` and the existing
`CLOUDFLARE_*` D1 credentials. Secret values must not be committed or logged.
Use `--dry-run` for provider validation; it performs no D1 write.

Production code is read from `/opt/stock-autotrader`. The timer remains a daily
23:30 UTC oneshot with a small randomized delay. The installer deliberately
installs/verifies units without enabling or starting the timer; production is
enabled only after a successful manual run and D1 validation.
