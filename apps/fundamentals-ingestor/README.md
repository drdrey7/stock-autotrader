# Simple fundamentals ingestor

The daily job fetches Finnhub's direct market metrics and EdgarTools' normalized
financial statements, calculates only the five Stock Detail cards, and UPSERTs
one current row per Core Universe symbol into D1. It never runs from the
Worker request path.

Each run checks the latest relevant SEC filing accession. If the accession
already stored for a symbol is unchanged, EdgarTools statements are not
reprocessed; Finnhub market fields are still checked daily. A new accession
refreshes only the accounting inputs required by Stock Detail. The accession
is internal ingestion metadata and is not exposed by the Worker or Earnings UI.

Required EnvironmentFile values are `FINNHUB_API_KEY`, the existing
`CLOUDFLARE_*` D1 credentials, and `EDGAR_IDENTITY`. Secret values must not be
committed or logged. Use `--dry-run` for provider validation; it performs no
D1 write.

Install the Python requirements into the VPS service environment before
enabling the timer. The unit installer deliberately does not enable or start
the timer.
