# quote-ingestor — Finnhub WebSocket → D1 (stock-autotrader)

VPS-side WebSocket ingestor that replaces the per-minute Finnhub REST `/quote`
cron as the ONLY automatic quotes collector.

```text
Finnhub WebSocket (50 Core symbols, 1 connection)
   -> VPS systemd service (stock-autotrader-finnhub-ws)
   -> latest prices in RAM
   -> close-proof candidates checkpointed under systemd StateDirectory
   -> flush ~60s, changed symbols only, during the US regular session +
      5 min post-close GRACE (America/New_York, DST-safe, early-close aware)
   -> Cloudflare D1 HTTP API -> latest_quotes (50 rows, UPSERT)
   -> Cloudflare Worker -> Screener + Stock Detail
```

D1 remains the canonical serving store. The local checkpoint is replay-only
workflow state used only when a close-window D1 write has not become durable
yet. The VPS serves nothing to browsers; if it is offline, the site continues
to serve the last D1 snapshot and applies the normal freshness semantics.

## Install / deploy

- Code is read from `/home/hermes/projects/stock-autotrader/apps/quote-ingestor`.
- Unit file: `deploy/stock-autotrader-finnhub-ws.service` →
  `/etc/systemd/system/stock-autotrader-finnhub-ws.service`.
- Root installer: `deploy/install-finnhub-ws-root.sh`. It copies the env sources
  into `/etc/stock-autotrader/`, installs the unit, runs `daemon-reload` and
  enables the service. It NEVER starts the service.
- After any unit change, re-run the installer (or install the repo unit and run
  `systemctl daemon-reload`) before restarting the service.
- The unit declares `StateDirectory=stock-autotrader-finnhub-ws`; systemd owns
  creation/permissions of `/var/lib/stock-autotrader-finnhub-ws` and exports
  `STATE_DIRECTORY` to the process.
- Runtime configuration fails fast if neither `STATE_DIRECTORY` nor the explicit
  local/test override `QUOTE_INGESTOR_STATE_PATH` exists. Production therefore
  cannot silently run without crash-safe close-candidate persistence.
- Unit update/self-check helper (root-owned):
  `/usr/local/sbin/stock-autotrader-finnhub-ws-install`.
- The restrictive `sudoers.d` ruleset grants `hermes` NOPASSWD only for the
  service-scoped systemctl/journal/helper commands documented by the project.

## Environment

Secrets remain outside the repo, chmod 600, owner `hermes`.

`/etc/stock-autotrader/finnhub.env`:

```text
FINNHUB_API_KEY=<key>
```

`/etc/stock-autotrader/cloudflare.env`:

```text
CLOUDFLARE_API_TOKEN=<token>
CLOUDFLARE_ACCOUNT_ID=<account_id>
CLOUDFLARE_D1_DATABASE_ID=<db_id>
```

No secret is ever printed/versioned: logs report only booleans, counts, safe
operation names and exception classes.

## Durable close-candidate state

The 1D invariant needs the immediately prior regular-session close. D1 normally
provides that durable state. One exceptional case needs local workflow state:
D1 can fail during the final close-proof window and the process can then crash
or be redeployed before retrying.

The service therefore keeps a tiny checkpoint at:

```text
/var/lib/stock-autotrader-finnhub-ws/pending-close-candidates.json
```

Contract:

- only Core symbol, price and Finnhub trade timestamp are stored;
- first valid final-five-minute candidate is persisted immediately on intake;
- the latest candidate is refreshed before D1 network I/O at flush cadence;
- file writes use mode 0600, file `fsync`, atomic rename and directory `fsync`;
- in-memory checkpoint state advances only after the atomic file write succeeds;
- startup restores checkpointed candidates into pending quote state;
- prior-session work is replayed before current-session work for the same symbol;
- a failed prior write blocks only that symbol, not unrelated current quotes;
- local state is cleared only after D1 confirms an equal/newer submitted row is
  durable;
- replay after a crash between D1 success and local cleanup is idempotent due to
  the D1 provider-timestamp guard;
- malformed or semantically invalid checkpoint content fails closed.

This is not a second quote datastore and is never used by the Worker/frontend.

## Operating

```bash
sudo systemctl status  stock-autotrader-finnhub-ws.service
sudo systemctl restart stock-autotrader-finnhub-ws.service
sudo systemctl stop    stock-autotrader-finnhub-ws.service
sudo systemctl start   stock-autotrader-finnhub-ws.service
sudo journalctl -u stock-autotrader-finnhub-ws.service -n 200
/usr/local/sbin/stock-autotrader-finnhub-ws-install --check
```

The unit keeps the existing hardening: non-root `hermes`, `NoNewPrivileges`,
`ProtectSystem=full`, `ProtectHome=read-only`, `PrivateTmp`, no capabilities.
`StateDirectory` is the dedicated persistent writable path; `UMask=0077` keeps
checkpoint files private. `Restart=on-failure`, `RestartSec=5`, graceful
SIGTERM and best-effort final flush remain unchanged.

## Health / observability

- Structured JSON log lines to journald include startup/universe/D1 baseline,
  WS status, flush summaries, shutdown and watchdog events.
- Checkpoint observability logs only candidate counts, operation names and safe
  exception classes; checkpoint values are never logged.
- D1 `app_meta['quoteIngestorHealth']` mirrors a health heartbeat every minute,
  including outside market hours: connection status, heartbeat/message/flush
  timestamps, subscription coverage, reconnect/error counters and update time.
- The Worker applies its heartbeat TTL independently of quote-row freshness.

## Session and 1D semantics

- Quote writes occur only during the US regular session plus the five-minute
  close grace window. After-hours trades never overwrite the regular close.
- Rollover trusts the prior price only if its provider timestamp belongs to the
  exact immediately preceding trading session AND final five minutes before
  that session's NYSE/Nasdaq close.
- Weekend/holiday/early-close/DST boundaries use the shared New York calendar.
- Gaps, missing provenance and effective split boundaries fail closed.
- Migration `0033_quote_session_baseline.sql` persists:
  `quote_session_date`, `previous_close_session_date`, `daily_change_valid`.
- The Worker never trusts stored `change_abs`/`change_pct` as source of truth.
  During a regular session, for a Live quote with valid provenance:

```text
change_abs = price - previous_close
change_pct = (price / previous_close - 1) * 100
```

- Otherwise 1D is null/`—` while the last price can remain available.
- Screener and Stock Detail use the same derived daily-change rule.

## D1 write behavior

- Only changed symbols are written; `latest_quotes` stays at ~50 rows.
- Pending work can contain both a retained prior-session close candidate and a
  current-session tick. D1 writes session groups chronologically.
- A prior-session failure blocks only that symbol's newer write; unrelated
  current-session symbols still progress.
- `WHERE excluded.provider_timestamp >= latest_quotes.provider_timestamp`
  prevents older writes/replays from regressing a newer durable quote.
- The disabled legacy REST writer deliberately invalidates session provenance
  if re-enabled, so it cannot inherit a WebSocket baseline it did not prove.
- The health heartbeat is one small `app_meta` write per minute and is separate
  from the ~50 quote rows.

## Validating D1 (read-only)

```bash
sudo wrangler d1 execute stock-autotrader-db --remote --command \
  "SELECT provider, COUNT(*) FROM latest_quotes GROUP BY provider"
# expect: finnhub-websocket | 50

sudo wrangler d1 execute stock-autotrader-db --remote --command \
  "SELECT symbol, quote_session_date, previous_close_session_date, daily_change_valid FROM latest_quotes ORDER BY symbol"

curl -s https://stock-autotrader-web.barroso-labs.workers.dev/api/screener
```

After deploying the new unit, also verify read-only service metadata:

```bash
systemctl show stock-autotrader-finnhub-ws.service -p StateDirectory -p StateDirectoryMode
```

## Rollback

1. Stop `stock-autotrader-finnhub-ws.service` (`disable` too if boot start is not
   wanted).
2. Restore the legacy Worker quote cron only if deliberately reverting to that
   architecture; do not run both automatic collectors casually.
3. `latest_quotes` remains additive/non-destructive. Migration 0033 does not
   delete quote rows.
4. The local StateDirectory may remain on disk during rollback; it is not read by
   the Worker and contains no credentials.

## Out of scope

No candles, tick history, indicators, Alpha Vantage quote path, Yahoo, second
quote API key, public VPS endpoint, Durable Objects or new external service.
