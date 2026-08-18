# Finnhub WebSocket quote ingestor — stock-autotrader
#
# VPS-side component that replaces the per-minute Finnhub REST /quote cron with
# a single Finnhub WebSocket connection feeding Cloudflare D1 `latest_quotes`.
#
# Architecture
#
#   Finnhub WebSocket  ->  VPS systemd service  ->  latest prices in RAM
#   ->  flush ~60s (market hours only, changed symbols only)
#   ->  Cloudflare D1 HTTP API (latest_quotes upsert)
#   ->  Cloudflare Worker /api/screener  ->  Screener
#
# Guarantees / invariants
#
# - Exactly ONE Finnhub WebSocket connection (free tier supports up to 50
#   symbols on a single connection).
# - The Core Universe is loaded exclusively from
#   packages/contracts/src/core-universe.v1.json (never a second list) and
#   validated at startup: exactly 50, unique, non-empty, valid ticker shape.
# - Only valid trade ticks update in-memory state; malformed messages are
#   counted and skipped, unknown symbols are ignored (never written to D1).
# - `latest_quotes` stays at ~50 rows: every flush UPSERTs only symbols whose
#   last price changed since the previous successful flush, on the existing
#   row, never appending rows or snapshots.
# - Race-safe versus the (temporarily still-running) REST collector: writes
#   are guarded with `WHERE excluded.provider_timestamp >=
#   latest_quotes.provider_timestamp`, so a stale REST response can never
#   overwrite a newer WebSocket quote and vice versa.
# - No secrets in logs/stdout/journal: API keys and Cloudflare tokens are
#   read from the environment only and never interpolated into log lines.
#
# Runtime dependencies: websocket-client (see requirements.txt). Everything
# else is Python standard library (urllib for the D1 HTTP API).

__version__ = "1.0.0"
