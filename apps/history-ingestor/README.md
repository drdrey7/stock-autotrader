# History Ingestor — Alpha Vantage weekly history + split-only adjustment

Historical layer behind the live 200-week SMA. It stores split-adjusted weekly
history and precomputed SMA basis data in the shared Cloudflare D1 database.
Current/live prices still come from the Finnhub quote pipeline; this app never
provides current quotes.

```text
Alpha Vantage TIME_SERIES_WEEKLY ──► weekly_prices ──► technical_metrics
Alpha Vantage SPLITS             ──► split_events
                                             │
Finnhub latest quote + D1 SMA basis ─────────┴──► Worker/API/UI
```

## Design goals

- The 200W SMA basis changes only when a trading week closes.
- A valid SMA remains visible even if the VPS or provider is temporarily down.
- Provider quota is spent on WEEKLY history before any secondary work.
- Split discovery is independent from weekly maintenance.
- Split serving state is per-symbol and fail-closed: only `READY` is served;
  a possible scale mismatch is `BLOCKED` until history and metrics are verified.
- Unexpected mismatches enqueue one durable per-symbol recovery request; an
  empty queue makes zero SPLITS requests and a non-empty queue is retried
  automatically with the shared Alpha Vantage budget.
- Bootstrap is one-shot and disables itself when initial loading is complete.
- D1 is the durable serving source; the frontend does not depend on VPS uptime.

## Provider contract

Alpha Vantage free-tier accounting used by this app is 25 requests/day per key.
With two configured keys the nominal aggregate is 50 requests/day total. The
client tracks each key independently and does not rotate keys to bypass a
per-key quota.

`TIME_SERIES_WEEKLY?symbol=X&outputsize=full` returns weekly OHLCV history. The
newest in-progress week is excluded before persistence.

`SPLITS?symbol=X` returns split events. Weekly history is split-adjusted only;
dividends are never applied.

The history ingestor keeps the provider event set in `split_events` and derives
each row's cumulative factor from events effective on that row's side of the
split. It persists raw OHLCV unchanged, then persists
`split_adjustment_factor` and `split_adjusted_close`; the Worker divides every
raw OHLC field by that factor when building candles.

## Stored data

### `weekly_prices`

One row per `(symbol, week_end_date)` containing raw weekly OHLCV, split factor,
split-adjusted close, source and fetch timestamp. Writes are idempotent UPSERTs.

### `technical_metrics`

One row per symbol containing:

- `anchor_week`;
- `completed_weeks_available`;
- `sum_199`;
- `anchor_close`;
- `closed_sma_200w`;
- `historical_data_as_of`;
- `calculated_at`;
- `status`.

### `split_events`

Durable split history used to keep stored weekly prices on the correct current
share-price scale.

## Live 200W SMA semantics

For a valid 200-week basis, the Worker combines the stored weekly basis with the
latest quote. The exact live formula depends on the quote week relative to the
stored anchor.

Availability policy:

- same/current adjacent week with a valid basis → compute live 200W SMA;
- stored anchor more than one week behind → serve the last-known-good
  `closed_sma_200w` and compute distance using the current quote;
- quote older than the stored basis → `Unavailable`;
- confirmed quote/history split-scale mismatch → `Unavailable`;
- fewer than 200 completed weeks → `NotEnoughHistory` (`N/A`).

A delayed maintenance job must therefore never blank an already-valid SMA. A
confirmed split-scale mismatch is the deliberate fail-closed exception.

## Bootstrap

Bootstrap is initial historical loading only. It fetches SPLITS then WEEKLY for
unfinished symbols and persists progress in `app_meta.historyBootstrapState`.

```bash
python3 -m history_ingestor bootstrap
python3 -m history_ingestor bootstrap --dry-run
python3 -m history_ingestor bootstrap --limit 4 --symbols NVDA AAPL MSFT
python3 -m history_ingestor status
```

Safety properties:

- default residual cap: 6 real provider HTTP requests per UTC day;
- cap is enforced at the provider ledger boundary, including `Information`,
  `Note` and internal multi-key attempts;
- same-day process/systemd restart does not reset the bootstrap budget;
- `--limit` can only lower the configured cap;
- completed symbols are not downloaded again.

### Bootstrap completion means endpoint completion

The completion gate is intentionally:

```text
bootstrap_done = 50
bootstrap_pending = 0
universe_total = 50
```

`bootstrap_done=50` means the required bootstrap provider work completed for all
50 Core Universe symbols. It does **not** mean all 50 have 200 weeks of market
history.

A newly listed company can correctly have:

```text
bootstrap: done
technical_metrics.status: not_enough_history
UI: N/A
```

That is terminal bootstrap success, not unfinished work. Such stocks must not
keep bootstrap running forever. When the exact 50/50 endpoint gate is reached,
`history-ingestor-bootstrap-maybe-disable.service` disables and stops
`history-ingestor-bootstrap.timer` automatically.

## Weekly maintenance

Maintenance is the primary recurring provider workload:

```bash
python3 -m history_ingestor maintenance
```

It fetches only `TIME_SERIES_WEEKLY`, reads durable split events from D1,
upserts changed/new weekly rows and recomputes `technical_metrics`. It never
fetches SPLITS.

The timer runs daily at 07:00 UTC for resilience, but provider work is
effectively weekly:

- Monday: normally refresh the just-closed week for the 50-symbol universe;
- Tue-Sat: catch-up only if the weekly cycle is incomplete;
- completed cycle: zero provider requests.

This gives automatic recovery after a Monday outage without spending provider
quota every day.

## Split discovery

Provider split discovery is deliberately low-frequency because splits are rare
for a 50-stock universe.

```bash
python3 -m history_ingestor reconcile-splits
python3 -m history_ingestor reconcile-splits --dry-run
```

Production schedule:

- every Sunday at 09:00 UTC;
- `Persistent=false`;
- explicit maximum 50 provider HTTP requests per invocation;
- still constrained by the shared 25/key daily ledger.

Sunday is intentional: it discovers future-dated Monday splits without
competing with Monday's weekly refresh. Its independent durable checkpoint
resumes unfinished work at the next Sunday scan rather than restarting from the
beginning.

Filtered manual `--symbols` runs restrict processing only; they do not erase
unrelated reconciliation progress.

## Due split application

```bash
python3 -m history_ingestor apply-due-splits
```

This reads already-known future-dated split events from D1 and applies them when
they become effective. It makes zero provider calls and runs Monday through
Saturday before the weekly maintenance window. A Monday-effective split is
therefore applied before the new weekly row is served.

## Automatic split recovery

The Stock Detail Worker never calls a provider. If it sees durable evidence of
a quote/history scale transition with no matching split event, it atomically
persists `BLOCKED` plus one `historySplitRecovery:<SYMBOL>` request in D1. The
hourly `recover-split-mismatches` job reads that queue before constructing any
provider work:

- empty queue → zero Alpha Vantage requests;
- queued symbols → SPLITS requests only for those symbols, bounded to two per
  run by default and subject to the shared per-key ledger, throttle and flock;
- provider still has no new event → remain `BLOCKED`, move the request to a
  one-hour retry;
- changed events → `BLOCKED`, durable split-event update, full raw-history
  rewrite, metrics recompute, verification, then durable `READY` and queue
  removal.

`READY` and `BLOCKED` are serving state. Queue/checkpoint values such as
`pending`, `running`, `retry` and `done` are workflow state and never make a
symbol serve data by themselves. A normal unchanged SPLITS check, weekly
append/correction, or provider error preserves the last-known-good serving
state.

## Production systemd cadence

All times UTC:

| Priority | Timer | Cadence | Provider work |
|---|---|---|---|
| 1 | `history-ingestor-due-split.timer` | Mon-Sat 06:00 | zero-provider; before maintenance |
| 2 | `history-ingestor-maintenance.timer` | daily 07:00 | effectively weekly; catch-up only after Monday |
| 3 | `history-ingestor-bootstrap.timer` | daily 08:00 while incomplete | max 6 HTTP/day; auto-disables at terminal 50/50 |
| 4 | `history-ingestor-reconcile-split.timer` | Sunday 09:00 | max 50/run, shared quota |
| 5 | `history-ingestor-split-recovery.timer` | hourly; Monday resumes 07:30 | max 2 queued symbols/run, shared quota |

Operational priority is therefore:

```text
Monday due-split > Monday maintenance > bootstrap > Sunday split discovery
> hourly recovery (Monday recovery resumes after maintenance)
```

All provider-consuming paths share the same per-key daily ledger and the same
process lock. Recovery is persistent only as a D1 queue item, not as a missed
timer catch-up (`Persistent=false`): it makes no call when the queue is empty
and retries pending symbols on the next hourly window. Due-split remains
zero-provider.

## Secrets and production paths

Required environment variables are supplied through systemd `EnvironmentFile`
files and are never logged:

- `ALPHA_VANTAGE_API_KEYS`;
- `CLOUDFLARE_API_TOKEN`;
- `CLOUDFLARE_ACCOUNT_ID`;
- `CLOUDFLARE_D1_DATABASE_ID`.

Production paths:

- code: `/opt/stock-autotrader/apps/history-ingestor`;
- durable state: `/var/lib/history-ingestor`;
- env files: `/etc/stock-autotrader/alpha-vantage.env` and
  `/etc/stock-autotrader/cloudflare.env`.

Development checkouts under `/home/hermes/projects/...` must never be used as a
production systemd `WorkingDirectory`.

The root installer is transactional and preserves the previous enablement and
activity state of installed timers. See `deploy/DEPLOY.md` for the production
procedure.

## Tests

No test makes real Alpha Vantage requests.

```bash
cd apps/history-ingestor
python3 -m unittest discover -s tests -v
cd ../..
ruff check apps/history-ingestor
```

Coverage includes provider throttle/quota handling, exact bootstrap HTTP
accounting across restart, weekly maintenance resume, independent reconciliation
state, filtered reconciliation safety, split adjustment, D1 idempotency,
last-known-good behavior and split-scale mismatch fail-closed behavior.

## Rollback

`weekly_prices` and `technical_metrics` are additive durable data. If the SMA
feature ever needs to be disabled, the Worker/API can stop exposing it without
destructively dropping the historical tables. The live quote pipeline is
independent from this app.
