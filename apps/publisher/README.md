# apps/publisher — Stock Autotrader publisher client

Python, **stdlib-only** VPS client. Runs outside the Cloudflare Worker (no
build step, no dependencies) and does two jobs:

1. Composes the Daily Briefing (X posts + market quotes → validated JSON,
   see `data/brief-spec.v1.md`) and publishes it.
2. Publishes generic normalized events (scans, positions, system status,
   collected X posts) to the Worker's protected ingest endpoint.

All publication is a signed `POST /ingest/events` request
(HMAC-SHA256 over `timestamp.body`, see `publisher/client.py`) — this client
never talks to X or a market-data vendor directly; both arrive as JSON input
already collected elsewhere.

## CLI

```bash
# Compose and (optionally) publish a Daily Briefing
python -m publisher.cli brief --edition pre_market \
  --x-posts x_posts.json --quotes quotes.json --data-dir data --dry-run

python -m publisher.cli brief --edition post_close \
  --x-posts x_posts.json --quotes quotes.json --data-dir data \
  --publish --endpoint https://<host>/ingest/events --secret-file /run/secrets/ingest.key

# Publish collected X posts to the read model (X Search feed)
python -m publisher.cli x-posts --posts x_posts.json \
  --endpoint https://<host>/ingest/events --secret-file /run/secrets/ingest.key

# Legacy generic event publishing (PR #3)
python -m publisher.cli --endpoint https://<host>/ingest/events \
  --secret-file /run/secrets/ingest.key --file events.json
```

`--secret` and `--secret-file` are mutually exclusive; exactly one is
required whenever `--publish` is used. `--dry-run` (the default for `brief`)
never touches the network.

## Data

`data/` holds versioned, checked-in snapshots the pipeline treats as ground
truth for membership/composition: the tracked X account registry
(`accounts.v1.json`) and the S&P 500 / Nasdaq-100 universe
(`sp500.v1.json`, `nasdaq100.v1.json`). `scripts/extract_universe.py`
regenerates the universe files. `fixtures/` holds sample inputs used by the
tests below.

## Tests

```bash
npm run test -w @stock-autotrader/publisher
# equivalently:
python3 -m unittest discover -s tests -v
```

`tests/e2e_smoke.py`, `tests/regression_b1b2.py` and `tests/regression_b3.py`
are standalone regression/smoke scripts in addition to the `unittest` suite.
