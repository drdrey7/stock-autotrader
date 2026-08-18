# quote-ingestor — Finnhub WebSocket → D1 (stock-autotrader)

VPS-side WebSocket ingestor that replaces the per-minute Finnhub REST `/quote`
cron as the ONLY automatic quotes collector.

```
Finnhub WebSocket (50 Core symbols, 1 connection)
   -> VPS systemd service (stock-autotrader-finnhub-ws)
   -> latest prices in RAM
   -> flush ~60s, market hours only (America/New_York 09:30–16:00), changed only
   -> Cloudflare D1 HTTP API -> latest_quotes (50 rows, UPSERT)
   -> Cloudflare Worker /api/screener -> Screener
```

The VPS serves nothing to browsers; the site is fully independent of it. If the
VPS is offline, the site keeps serving the last D1 snapshot and `/api/screener`
reports state accordingly (`Stale` after the freshness threshold).

## Install / deploy

- Code is read from this repo path: `/home/hermes/projects/stock-autotrader/apps/quote-ingestor`
  (the systemd service runs `python3 -m quote_ingestor` with this as its
  `WorkingDirectory`). Updating the Service requires a `systemctl restart`
  after pulling new code.
- Unit file: `deploy/stock-autotrader-finnhub-ws.service` → `/etc/systemd/system/`.
- Root installer (used once, no secrets inside): `deploy/install-finnhub-ws-root.sh`
  — copies env sources from `~/.secrets/stock-autotrader/` into
  `/etc/stock-autotrader/{finnhub.env,cloudflare.env}` (chmod 600), installs the
  unit, `daemon-reload`, `enable`. It NEVER starts the service.
- Unit update/self-check helper (root-owned): `/usr/local/sbin/stock-autotrader-finnhub-ws-install`
  (embeds a canonical unit; flags `--check | --enable | --disable | <install>`).
- A restrictive `sudoers.d` ruleset grants `hermes` NOPASSWD **only** for:
  `systemctl daemon-reload`, `systemctl start|stop|restart|status|enable|disable
  stock-autotrader-finnhub-ws.service`, service-scoped `journalctl -u …`, and the
  helper above. No general `systemctl *`, no global journalctl, no
  bash/python/chmod/chown/ALL.

## Environment (secrets, chmod 600, owner hermes)

`/etc/stock-autotrader/finnhub.env`:
```
FINNHUB_API_KEY=<key>
```
`/etc/stock-autotrader/cloudflare.env`:
```
CLOUDFLARE_API_TOKEN=<token>      # D1 HTTP API (account Worker token, D1 scope)
CLOUDFLARE_ACCOUNT_ID=<account_id>
CLOUDFLARE_D1_DATABASE_ID=<db_id>
```
No secret is ever printed/versioned: logs report only booleans and var names.

## Operating

```bash
sudo systemctl status  stock-autotrader-finnhub-ws.service   # state
sudo systemctl restart stock-autotrader-finnhub-ws.service   # after code/unit change
sudo systemctl stop    stock-autotrader-finnhub-ws.service   # stop (graceful SIGTERM)
sudo systemctl start   stock-autotrader-finnhub-ws.service   # start
sudo journalctl -u stock-autotrader-finnhub-ws.service -n 200  # logs (JSON lines)
/usr/local/sbin/stock-autotrader-finnhub-ws-install --check   # unit == canonical
```

`Restart=on-failure` (5s), starts on boot (`systemctl enable`), graceful SIGTERM
(final flush best-effort), journald logging, hardened unit (NoNewPrivileges,
ProtectSystem=full, ProtectHome=read-only, PrivateTmp, no capabilities, non-root
user).

## Health / observability

- Structured **JSON log lines** to journald: `startup`, `universe_loaded`,
  `d1_baseline`, `ws_connected`, `flush` (requested/written/failed),
  `shutdown`, `ws_heartbeat_dead`, `ws_connection_lost`.
- D1 `app_meta['quoteIngestorHealth']` mirrors a concise health snapshot on each
  market-hours flush: `connection_status`, `connected_at`, `last_message_at`,
  `last_flush_at`, `last_successful_flush_at`, `subscriptions_expected=50`,
  `symbols_seen_recently`, `reconnect_count`, `malformed_message_count`,
  `d1_write_errors`, `last_error`, `updated_at`.
- The Worker's `/api/screener` resolves the global quotes provider from
  `quoteIngestorHealth` (WebSocket) and falls back to the REST `quotesHealth`
  only when no WebSocket record exists.

## D1 write cadence

- Flush target ~60 s **inside the US regular session only** (DST-safe
  America/New_York; US market holidays included). No writes overnight/weekend.
- Only **changed symbols** are written, one multi-VALUES UPSERT per flush
  (single HTTP request). `latest_quotes` stays at ~50 rows — never appended.
- Race guard (both writers): `WHERE excluded.provider_timestamp >=
  latest_quotes.provider_timestamp`; both store ISO 8601 UTC, so an older REST
  response can never regress a newer WebSocket quote (and vice versa).
- Only WebSocket-provided fields are written (symbol, price, provider
  `finnhub-websocket`, provider_timestamp, updated_at). `previous_close`,
  `day_open/high/low` are preserved last-known-good; `change_abs/change_pct`
  are recomputed only when `previous_close` is valid.
- Measured: ~40 rows/flush ≈ ~40 writes/min in session ⇒ **~15–16k rows /
  trading day** (D1 free 100k/day budget ok).

## Validating D1 (read-only)

```bash
sudo wrangler d1 execute stock-autotrader-db --remote --command \
  "SELECT provider, COUNT(*) FROM latest_quotes GROUP BY provider"
# expect: finnhub-websocket | 50
curl -s https://stock-autotrader-web.barroso-labs.workers.dev/api/screener
# expect: quotes.provider finnhub-websocket, counts live≈50, stale 0
```

## Rollback (if the WebSocket collector fails)

1. `sudo systemctl stop stock-autotrader-finnhub-ws.service`
   (`disable` if you want no boot start).
2. Restore the `* * * * *` cron trigger in `apps/web/wrangler.jsonc`
   (and the CI pin), deploy the Worker — `runQuotesShardJob` + the Finnhub REST
   provider are still in the codebase and become the automatic collector again.
3. `latest_quotes` is untouched (same table, additive). No destructive migration.
4. Rollback completes in minutes; `quoteIngestorHealth` simply goes stale.

## Out of scope (this component)

No candles (daily/weekly/minute), no tick history, no indicators, no
Alpha Vantage, no second API key, no public VPS endpoint, no Durable Objects.
