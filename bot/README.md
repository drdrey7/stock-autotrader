# bot — Stock Autotrader VPS runtime

Private runtime foundation. Runs on a VPS (not deployed to Cloudflare), holds
its own local state, and publishes validated public events to the
`apps/web` Worker's signed ingest endpoint. No broker, no live trading.

## Current status

- **Implemented:** scheduler wiring (APScheduler, `America/New_York`), health
  checks, the CSV-based market-data validation/staleness pipeline
  (`bot/market_data/`), local SQLite state ledger, and publication of market
  snapshots to the ingest endpoint.
- **Not yet implemented:** the scan/signal engine. `pre_market_scan` and
  `post_close_scan` are registered on their real cron schedules but currently
  resolve to no-op handlers (see `bot/scheduler.py`) — they log and return.
  Screening, strategy evaluation, and shadow-position tracking are future
  work; the earnings calendar is instead served by a separate, already-live
  engine that runs inside the Cloudflare Worker (see the root `README.md`).

## Install

```bash
cd bot
pip install -e ".[dev]"
```

## CLI

```bash
python -m bot smoke            # validate runtime config/wiring, no side effects
python -m bot health           # print a JSON health report
python -m bot run              # start the scheduler (blocking)
python -m bot market-data       # validate + cache the CSV market-data snapshot
python -m bot market-data --publish   # also publish the snapshot via signed ingest
python -m bot alert "message"  # print an alert line (a Hermes cron delivers it to Telegram)
```

## Configuration

Copy `.env.example` to `.env` and fill in values; `.env` is gitignored.
Settings are loaded via `pydantic-settings` (`bot/config.py`) — see the
example file for the full list (timezone, cron schedules, market-data
thresholds, `INGEST_URL`/`INGEST_SECRET`).

## Tests

```bash
python -m pytest bot/tests -v
# or, matching CI:
python3 -m unittest discover -s tests -v
```

## Docker

```bash
cd bot
docker compose up --build
```

Builds from the repo root (`bot/Dockerfile`) so it can also install
`apps/publisher` on `PYTHONPATH`; runtime state lives on a bind-mounted
volume (`bot/data`). No ports are exposed — this is a private, outbound-only
runtime.
