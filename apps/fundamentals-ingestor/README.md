# Simple fundamentals ingestor

The daily job fetches Finnhub's direct reference metrics and EdgarTools'
normalized accounting inputs, then UPSERTs one current input row per Core
Universe symbol into D1. It also keeps at most five annual input rows per
symbol for later Stock Detail and valuation work. It never runs from the
Worker request path.

Each run checks the latest relevant SEC filing accession. If the accession
already stored for a symbol is unchanged, EdgarTools statements are not
reprocessed; Finnhub market fields are still checked daily. A new accession
refreshes only the accounting inputs required by Stock Detail. The accession
is internal ingestion metadata and is not exposed by the Worker or Earnings UI.
Market Cap, P/E, beta, EPS, and dividend yield are stored directly from
Finnhub when available. The quote pipeline remains the sole price source;
this job does not derive market values or attach a quote timestamp to Finnhub
metrics.

Required EnvironmentFile values are `FINNHUB_API_KEY`, the existing
`CLOUDFLARE_*` D1 credentials, and `EDGAR_IDENTITY`. Secret values must not be
committed or logged. Use `--dry-run` for provider validation; it performs no
D1 write.

Install the Python requirements into the VPS service environment before
enabling the timer. The unit installer deliberately does not enable or start
the timer. Production runs once at 23:30 UTC with a small randomized delay;
provider failures preserve the previous valid snapshot for the next run.
