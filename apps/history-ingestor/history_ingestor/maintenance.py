"""Weekly maintenance: durable cycle — Sunday SPLITS, Monday WEEKLY.

Recurring (systemd timer, deploy/) process that keeps the historical layer
honest. Unlike bootstrap (one-shot historical loading), maintenance is a
CYCLE: it targets one completed trading week (the ISO week of the most
recent Friday) and is durably checkpointed in ``app_meta``
(``historyMaintenanceState``), so it can spread across days under the
provider's free-tier quota and resume without repeating completed work.

Cycle shape (state machine, self-healing from per-symbol status):

  SPLITS phase (typically Sunday, but resumes any day after quota):
    for each symbol: fetch SPLITS, compare with the durable split_events;
    unchanged  -> mark done, NO historical rewrite;
    changed    -> reconcile split_events (upsert + delete extras), recompute
                  the whole affected history from stored raw rows + new
                  factors, recompute technical_metrics — never a mixed regime.

  WEEKLY phase (fetches only on NY Mondays — a weekly bucket is storable
    only once its NY ISO week has ended):
    for each symbol: fetch TIME_SERIES_WEEKLY, DROP the in-progress bucket,
    adjust with the durable split_events, compare with stored rows (raw
    OHLCV + factor + adjusted close) and UPSERT ONLY changed/new rows — a
    normal Monday writes exactly one new week; provider corrections update
    only the affected rows. Then recompute technical_metrics.

Quota semantics: exhaustion is NORMAL partial completion — the run checkpoints
exactly where it stopped and reports; it is NOT a failure (exit 0). Real
failures (config/corrupted state/unrecoverable D1) surface as non-zero.
"""

from __future__ import annotations

import datetime as dt
import logging
import time
from collections.abc import Callable
from typing import Any

from .config import Settings
from .d1 import D1QueryError
from .maintenance_state import STATUS_DONE, STATUS_ERROR, STATUS_PENDING
from .parser import SplitEvent, WeeklyBar
from .provider import (
    AllKeysFailedError,
    AlphaVantageClient,
    ProviderError,
    QuotaExhaustedError,
    ThrottleExhaustedError,
)
from .sma import compute_technical_metrics
from .splits import (
    adjust_series,
    cumulative_split_factor,
    split_events_equal,
    split_events_from_rows,
    split_events_to_rows,
)
from .universe import load_core_universe
from .weeks import (
    completed_bars_filter,
    date_from_iso,
    is_weekly_phase_ready,
    ny_date_of,
    target_completed_week,
    week_label_of_date_key,
)

logger = logging.getLogger("history_ingestor.maintenance")


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"


class MaintenanceRunner:
    """Cycle-based weekly maintenance; unit-testable with fakes.

    ``store`` is the durable cycle checkpoint (MaintenanceStore).
    ``key_store`` (optional) is the bootstrap StateStore used purely as the
    shared per-key daily budget ledger — bootstrap and maintenance draw from
    the SAME provider day quota, so they must share the accounting while
    keeping their own state (meta keys) separate.
    """

    def __init__(
        self,
        settings: Settings,
        d1: Any,
        provider: AlphaVantageClient,
        store: Any,
        key_store: Any = None,
        now_fn: Callable[[], dt.datetime] | None = None,
    ) -> None:
        self._settings = settings
        self._d1 = d1
        self._provider = provider
        self._store = store
        self._key_store = key_store
        self._now = now_fn or (lambda: dt.datetime.now(dt.UTC))

    # ------------------------------------------------------------------ core

    def run(
        self,
        universe: list[str] | None = None,
        dry_run: bool = False,
        limit: int | None = None,
        symbols_filter: list[str] | None = None,
    ) -> dict:
        full_universe = universe if universe is not None else load_core_universe(self._settings.universe_path)
        if symbols_filter is not None:
            wanted = set(symbols_filter)
            symbols = [symbol for symbol in full_universe if symbol in wanted]
        else:
            symbols = list(full_universe)
        now = self._now()
        target = target_completed_week(now)
        self._store.load()
        # The shared per-key daily budget ledger (bootstrap StateStore) must be
        # loaded too — its per-key entries drive the provider's budget checks
        # and day rollover; maintenance never touches its symbol statuses.
        if self._key_store is not None:
            try:
                self._key_store.load()
            except Exception:
                logger.warning("maintenance: shared budget ledger unreadable — keys will report empty")

        if dry_run:
            return self._plan_report(full_universe, target)

        # START A NEW CYCLE when a new completed week exists (or no state yet).
        # The durable cycle is ALWAYS seeded with the FULL canonical universe —
        # --symbols only restricts which symbols are processed in THIS
        # invocation, never the durable membership (P2-2).
        if self._store.state.cycle_week != target or not self._store.state.symbols:
            self._store.reset_cycle(target, full_universe)
            self._store.save()
            logger.info("maintenance: new cycle for %s", target)

        # Retry: symbols whose SPLITS reconciliation errored in a prior run
        # are re-marked PENDING so the next daily run retries. ERROR does not
        # block `phase()` (so other symbols proceed), but without this the
        # failed symbol stays stuck until the next cycle reset.
        for symbol in symbols:
            if self._store.state.symbol_status(symbol, "splits") == STATUS_ERROR:
                self._store.state.mark_symbol(symbol, "splits", STATUS_PENDING)
        self._store.save()

        report: dict = {
            "status": "complete",
            "cycle_week": target,
            "phase": self._store.state.phase(),
            "symbols": {},
            "requests_used_total": 0,
            "keys_used": [],
            "quota_exhausted": False,
            "throttled": False,
            "anomalies": [],
            "rows_updated": 0,
            "metrics_updated": 0,
            "split_changes": 0,
        }

        # A fully-complete cycle performs ZERO provider calls.
        if self._store.state.phase() == "complete":
            # Metrics-only repair: symbols whose weekly history is stored but
            # whose metrics row is missing/errored. Zero provider calls.
            if not dry_run:
                for symbol in symbols:
                    if (self._store.state.symbol_status(symbol, "weekly") == STATUS_DONE
                            and self._store.state.symbol_status(symbol, "metrics") != STATUS_DONE):
                        break
                else:
                    report["status"] = "noop_complete"
                    report["symbols"] = {symbol: self._status_only(symbol) for symbol in symbols}
                    self._finalize_report(report)
                    return report
                self._reconcile_metrics_gaps(symbols, report)
            report["status"] = "noop_complete"
            report["symbols"] = {symbol: self._status_only(symbol) for symbol in symbols}
            self._finalize_report(report)
            return report

        # ---- WEEKLY phase (the priority; independent of split status) ----
        # The weekly SMA refresh never depends on split reconciliation. It
        # adjusts from the durable split_events store (D1) with whatever split
        # state is present; new splits are discovered separately by the
        # low-frequency `reconcile-splits` / daily `apply-due-splits` paths.
        if self._store.state.phase() == "weekly":
            if is_weekly_phase_ready(now, target):
                for symbol in symbols:
                    if (self._store.state.symbol_status(symbol, "weekly") == STATUS_DONE
                            and self._store.state.symbol_status(symbol, "metrics") == STATUS_DONE):
                        continue
                    if self._store.state.symbol_status(symbol, "weekly") == STATUS_DONE:
                        # Weekly history already stored — defer metrics repair to
                        # the zero-provider _reconcile_metrics_gaps path.
                        continue
                    if limit is not None and self._provider.requests_this_run >= limit:
                        report["anomalies"].append("run stopped by request limit before finishing WEEKLY")
                        break
                    symbol_report = self._refresh_weekly(symbol, dry_run=dry_run)
                    report["symbols"][symbol] = symbol_report
                    report["anomalies"].extend(symbol_report["anomalies"])
                    if symbol_report["quota"]:
                        report["quota_exhausted"] = True
                        break
                    if symbol_report.get("throttled"):
                        report["throttled"] = True
                        break
                    if not dry_run:
                        self._store.save()
                if not dry_run and not report["quota_exhausted"] and not report["throttled"]:
                    # Repair metrics-only gaps from D1 (zero provider calls).
                    self._reconcile_metrics_gaps(symbols, report)
            else:
                report["anomalies"].append(
                    "weekly phase pending: next fetch happens Monday (NY) — the new week is storable only then"
                )

        # Fill status-only entries for symbols this run did not touch (done or
        # not yet reached) — never overwrite the detailed per-symbol dicts.
        for symbol in symbols:
            if symbol not in report["symbols"]:
                report["symbols"][symbol] = self._status_only(symbol)
        phase = self._store.state.phase()
        report["phase"] = phase
        if report["quota_exhausted"]:
            report["status"] = "quota"
        elif report["throttled"]:
            report["status"] = "throttled"
        elif phase == "complete":
            report["status"] = "complete"
        else:
            report["status"] = "partial"
        self._finalize_report(report)
        return report

    # ----------------------------------------------------------------- phases

    def _reconcile_splits(self, symbol: str, dry_run: bool) -> dict:
        """Sunday SPLITS pass for one symbol (provider compare, exact)."""
        result: dict = {
            "splits": STATUS_DONE, "weekly": self._store.state.symbol_status(symbol, "weekly"),
            "metrics": self._store.state.symbol_status(symbol, "metrics"),
            "split_changed": False, "rows_updated": 0, "metrics_updated": False,
            "completed_weeks": 0, "quota": False, "throttled": False, "anomalies": [],
        }
        try:
            _, fresh_events, _ = self._provider.fetch_splits(symbol)
            try:
                stored_events = split_events_from_rows(self._d1.read_split_events(symbol))
            except D1QueryError as exc:
                raise ProviderError(f"split_events read failed: {exc}") from exc

            if split_events_equal(fresh_events, stored_events):
                # Unchanged history: no weekly rewrite, no provider refetch.
                self._store.state.mark_symbol(symbol, "splits", STATUS_DONE)
                return result

            result["split_changed"] = True
            if dry_run:
                self._store.state.mark_symbol(symbol, "splits", STATUS_DONE)
                return result

            # Reconcile the durable store: upsert the new set, then delete
            # events the provider no longer reports (a corrected/removed split).
            write = self._d1.upsert_split_events(split_events_to_rows(symbol, fresh_events, _now_iso()))
            if write.failed:
                raise ProviderError(f"split_events write failed: {write.error}")
            self._d1.delete_extra_split_events(symbol, [event.effective_date for event in fresh_events])

            # Rewrite the affected historical rows from stored RAW data with
            # the new factors — never a mixed adjustment regime. No provider
            # WEEKLY request needed: the raw history is already in D1.
            self._rewrite_history_from_stored(symbol, fresh_events, result)
            self._store.state.mark_symbol(symbol, "splits", STATUS_DONE)
            return result
        except QuotaExhaustedError:
            result["quota"] = True
            result["anomalies"].append("provider daily quota exhausted — SPLITS resumes from checkpoint")
            result["splits"] = "pending"
            return result
        except ThrottleExhaustedError:
            result["throttled"] = True
            result["anomalies"].append("provider throttle — SPLITS resumes from checkpoint")
            result["splits"] = "pending"
            return result
        except (ProviderError, AllKeysFailedError) as exc:
            self._store.state.mark_symbol(symbol, "splits", STATUS_ERROR)
            result["splits"] = STATUS_ERROR
            result["anomalies"].append(f"{symbol} splits: {str(exc)[:200]}")
            return result

    def _refresh_weekly(self, symbol: str, dry_run: bool) -> dict:
        """Monday WEEKLY pass for one symbol (full series, changed rows only)."""
        result: dict = {
            "splits": self._store.state.symbol_status(symbol, "splits"),
            "weekly": STATUS_DONE, "metrics": self._store.state.symbol_status(symbol, "metrics"),
            "split_changed": False, "rows_updated": 0, "metrics_updated": False,
            "completed_weeks": 0, "quota": False, "throttled": False, "anomalies": [],
        }
        try:
            # Split factors come from the DURABLE store (reconciled on Sunday)
            # — the weekly pass does NOT re-request SPLITS.
            try:
                stored_events = split_events_from_rows(self._d1.read_split_events(symbol))
            except D1QueryError as exc:
                raise ProviderError(f"split_events read failed: {exc}") from exc

            _, bars, _ = self._provider.fetch_weekly(symbol)
            completed, in_progress = completed_bars_filter(
                [bar.week_end_date for bar in bars], self._now()
            )
            if in_progress:
                result["anomalies"].append(f"{symbol}: excluded in-progress week {in_progress[0]}")
            if not completed:
                result["anomalies"].append(f"{symbol}: no completed weekly buckets")
                result["weekly"] = "error"
                return result
            completed_set = set(completed)
            completed_bars = [bar for bar in bars if bar.week_end_date in completed_set]
            result["completed_weeks"] = len(completed_bars)

            as_of = ny_date_of(self._now())
            as_of_iso = f"{as_of.year:04d}-{as_of.month:02d}-{as_of.day:02d}"
            adjusted_full = adjust_series(completed_bars, stored_events, as_of_date=as_of_iso)
            if dry_run:
                result["rows_updated"] = 1  # planning-mode hint
                return result

            # Only changed/new rows are written — never a blanket rewrite.
            stored = self._stored_rows(symbol)
            changed = []
            for bar, factor, adj_close in adjusted_full:
                old = stored.get(bar.week_end_date)
                if old is None or self._row_differs(old, bar, factor, adj_close):
                    changed.append((
                        bar.symbol, bar.week_end_date, bar.open, bar.high, bar.low,
                        bar.close, bar.volume, float(factor), adj_close, _now_iso(),
                    ))
            if changed:
                write = self._d1.upsert_weekly_rows(changed)
                if write.failed:
                    raise ProviderError(f"D1 weekly write failed: {write.error}")
                result["rows_updated"] = len(changed)
                if len(changed) > 1:
                    result["anomalies"].append(f"{symbol}: provider correction rewrote {len(changed)} rows")

            self._store.state.mark_symbol(symbol, "weekly", STATUS_DONE)
            metrics = compute_technical_metrics(symbol, [(bar, close) for bar, _f, close in adjusted_full])
            try:
                self._upsert_metrics(symbol, metrics)
                self._store.state.mark_symbol(symbol, "metrics", STATUS_DONE)
                result["metrics_updated"] = True
            except (ProviderError, D1QueryError) as exc:
                # weekly data is safely stored; metrics recompute alone is
                # retried from D1 (no provider call) on the next run.
                self._store.state.mark_symbol(symbol, "metrics", STATUS_ERROR)
                result["metrics"] = STATUS_ERROR
                result["anomalies"].append(f"{symbol} metrics: {str(exc)[:200]}")

            # Coverage verification.
            if result["completed_weeks"] < 199:
                result["anomalies"].append(
                    f"{symbol}: only {result['completed_weeks']} completed weeks (< 199 -> NotEnoughHistory)"
                )
            gaps = self._week_gaps(completed)
            if gaps:
                result["anomalies"].append(f"{symbol}: week gaps: {', '.join(gaps[:5])}{'…' if len(gaps) > 5 else ''}")
            return result
        except QuotaExhaustedError:
            result["quota"] = True
            result["anomalies"].append("provider daily quota exhausted — WEEKLY resumes from checkpoint")
            result["weekly"] = "pending"
            return result
        except ThrottleExhaustedError:
            result["throttled"] = True
            result["anomalies"].append("provider throttle — WEEKLY resumes from checkpoint")
            result["weekly"] = "pending"
            return result
        except (ProviderError, AllKeysFailedError) as exc:
            self._store.state.mark_symbol(symbol, "weekly", STATUS_ERROR)
            result["weekly"] = STATUS_ERROR
            result["anomalies"].append(f"{symbol} weekly: {str(exc)[:200]}")
            return result

    # -------------------------------------------------------------- helpers

    @staticmethod
    def _row_differs(old: tuple, bar: WeeklyBar, factor, adj_close: float) -> bool:
        """Whether a freshly fetched bar differs from the stored row.

        Compares raw OHLCV (provider corrections), the split factor and the
        split-adjusted close — so a corrected raw bar is propagated even when
        the adjusted close happens to match.
        """
        return (
            abs(old[0] - bar.open) > 1e-9
            or abs(old[1] - bar.high) > 1e-9
            or abs(old[2] - bar.low) > 1e-9
            or abs(old[3] - bar.close) > 1e-9
            or int(old[4]) != int(bar.volume)
            or abs(old[5] - float(factor)) > 1e-12
            or abs(old[6] - adj_close) > 1e-9
        )

    def _stored_rows(self, symbol: str) -> dict[str, tuple]:
        """Map week_end_date -> (open, high, low, close, volume, factor, adj)."""
        try:
            rows = self._d1.read_weekly_rows(symbol)
        except D1QueryError:
            return {}
        return {
            row["week_end_date"]: (
                float(row["raw_open"]), float(row["raw_high"]), float(row["raw_low"]),
                float(row["raw_close"]), int(row["volume"]),
                float(row["split_adjustment_factor"]), float(row["split_adjusted_close"]),
            )
            for row in rows
        }

    def _rewrite_history_from_stored(
        self,
        symbol: str,
        events: list[SplitEvent],
        result: dict,
    ) -> None:
        """Recompute the full historical adjustment for ``symbol`` from the
        stored RAW rows with the new split factors; rewrite only changed rows
        and recompute metrics. Runs on a split-history change (Sunday).

        Uses today's date as the split as-of boundary: any split whose
        effective date is in the future is NOT applied yet (it is stored in
        split_events for later due-split reconciliation, but must not change
        the historical basis while the live quote is still on the old scale).
        """
        try:
            stored_rows = self._d1.read_weekly_rows(symbol)
        except D1QueryError as exc:
            raise ProviderError(f"weekly read failed: {exc}") from exc
        if not stored_rows:
            return  # no history yet — the durable split_events store is enough
        bars: list[WeeklyBar] = []
        for row in stored_rows:
            bars.append(WeeklyBar(
                symbol=row["symbol"], week_end_date=row["week_end_date"],
                open=float(row["raw_open"]), high=float(row["raw_high"]),
                low=float(row["raw_low"]), close=float(row["raw_close"]),
                volume=int(row["volume"]),
            ))
        as_of = ny_date_of(self._now())
        as_of_iso = f"{as_of.year:04d}-{as_of.month:02d}-{as_of.day:02d}"
        adjusted_full = list(adjust_series(bars, events, as_of_date=as_of_iso))
        stored = self._stored_rows(symbol)
        changed = []
        for bar, factor, adj_close in adjusted_full:
            old = stored.get(bar.week_end_date)
            if old is None or self._row_differs(old, bar, factor, adj_close):
                changed.append((
                    bar.symbol, bar.week_end_date, bar.open, bar.high, bar.low,
                    bar.close, bar.volume, float(factor), adj_close, _now_iso(),
                ))
        if changed:
            write = self._d1.upsert_weekly_rows(changed)
            if write.failed:
                raise ProviderError(f"D1 weekly write failed: {write.error}")
            result["rows_updated"] = len(changed)
            result["anomalies"].append(f"{symbol}: split history change rewrote {len(changed)} rows (no mixed regime)")
        # Recompute metrics from the full set on the new factors.
        metrics = compute_technical_metrics(symbol, [(bar, close) for bar, _f, close in adjusted_full])
        self._upsert_metrics(symbol, metrics)
        # Mark which splits were NOT yet applied (future-dated) so the
        # daily due-split reconciliation knows what to pick up.
        future_splits = [e for e in events if date_from_iso(e.effective_date) > as_of]
        if future_splits:
            result["anomalies"].append(
                f"{symbol}: {len(future_splits)} future split(s) stored but not yet applied"
            )

    def apply_due_splits(self, symbols_filter: list[str] | None = None) -> dict:
        """Daily ZERO-PROVIDER reconciliation: apply splits whose effective
        date has been reached.

        For each symbol, reads stored ``split_events`` from D1, finds any
        split whose ``effective_date <= today`` (NY) that has not yet been
        applied to the historical basis, and recomputes the affected weekly
        rows + technical_metrics — all from stored RAW data, no Alpha Vantage
        request.

        Idempotent: a second run on the same day finds nothing to do.
        """
        symbols = load_core_universe(self._settings.universe_path)
        if symbols_filter is not None:
            wanted = set(symbols_filter)
            symbols = [symbol for symbol in symbols if symbol in wanted]
        today = ny_date_of(self._now())
        today_iso = f"{today.year:04d}-{today.month:02d}-{today.day:02d}"
        report: dict = {
            "status": "noop",
            "symbols": {},
            "rows_updated": 0,
            "metrics_updated": 0,
            "splits_applied": 0,
        }
        for symbol in symbols:
            try:
                stored_events = split_events_from_rows(self._d1.read_split_events(symbol))
            except D1QueryError:
                continue
            if not stored_events:
                continue
            try:
                stored_rows = self._d1.read_weekly_rows(symbol)
            except D1QueryError:
                continue
            if not stored_rows:
                continue
            bars: list[WeeklyBar] = []
            for row in stored_rows:
                bars.append(WeeklyBar(
                    symbol=row["symbol"], week_end_date=row["week_end_date"],
                    open=float(row["raw_open"]), high=float(row["raw_high"]),
                    low=float(row["raw_low"]), close=float(row["raw_close"]),
                    volume=int(row["volume"]),
                ))
            # Compute with all splits effective up to today
            adjusted_full = list(adjust_series(bars, stored_events, as_of_date=today_iso))
            stored = self._stored_rows(symbol)
            changed = []
            for bar, factor, adj_close in adjusted_full:
                old = stored.get(bar.week_end_date)
                if old is None or self._row_differs(old, bar, factor, adj_close):
                    changed.append((
                        bar.symbol, bar.week_end_date, bar.open, bar.high, bar.low,
                        bar.close, bar.volume, float(factor), adj_close, _now_iso(),
                    ))
            if changed:
                write = self._d1.upsert_weekly_rows(changed)
                if write.failed:
                    report["symbols"][symbol] = {"status": "error", "error": write.error}
                    continue
            metrics = compute_technical_metrics(symbol, [(bar, close) for bar, _f, close in adjusted_full])
            try:
                self._upsert_metrics(symbol, metrics)
            except (ProviderError, D1QueryError) as exc:
                report["symbols"][symbol] = {"status": "error", "error": str(exc)[:200]}
                continue
            if not changed:
                continue
            report["symbols"][symbol] = {"status": "applied", "rows_updated": len(changed)}
            report["rows_updated"] += len(changed)
            report["metrics_updated"] += 1
            report["splits_applied"] += 1
            report["status"] = "applied"
        return report

    def reconcile_splits(self, symbols_filter: list[str] | None = None, dry_run: bool = False, limit: int | None = None) -> dict:
        """LOW-FREQUENCY (weekly/monthly) provider SPLITS reconciliation.

        This is the SEPARATE split-checking responsibility, decoupled from the
        weekly SMA refresh. It fetches the provider SPLITS endpoint per symbol
        (bounded, quota-aware), compares against the durable ``split_events``
        store and, only on a change, rewrites that symbol's history + metrics.
        It shares the exact compare/rewrite logic with the week's maintenance
        but is invoked explicitly (never as a blocking precursor to WEEKLY).

        NOT duplicated: ``apply_due_splits`` (zero-provider, daily) applies
        splits whose effective date has been reached from stored events; this
        method is the only provider-fetching SPLITS path.
        """
        symbols = load_core_universe(self._settings.universe_path)
        if symbols_filter is not None:
            wanted = set(symbols_filter)
            symbols = [symbol for symbol in symbols if symbol in wanted]
        self._store.load()
        report: dict = {
            "status": "complete",
            "symbols": {},
            "requests_used_total": 0,
            "keys_used": [],
            "quota_exhausted": False,
            "throttled": False,
            "split_changes": 0,
            "rows_updated": 0,
            "metrics_updated": 0,
            "anomalies": [],
        }
        for symbol in symbols:
            if limit is not None and self._provider.requests_this_run >= limit:
                report["anomalies"].append("run stopped by request limit before finishing SPLITS reconciliation")
                break
            symbol_report = self._reconcile_splits(symbol, dry_run=dry_run)
            report["symbols"][symbol] = symbol_report
            report["anomalies"].extend(symbol_report["anomalies"])
            report["split_changes"] += 1 if symbol_report.get("split_changed") else 0
            report["rows_updated"] += symbol_report.get("rows_updated", 0)
            if symbol_report.get("metrics_updated"):
                report["metrics_updated"] += 1
            if symbol_report["quota"]:
                report["quota_exhausted"] = True
                break
            if symbol_report.get("throttled"):
                report["throttled"] = True
                break
            if not dry_run:
                self._store.save()
        report["requests_used_total"] = self._provider.requests_this_run
        report["keys_used"] = [
            {"index": k.get("index"), "used": k.get("used", 0)}
            for k in (self._key_store.state.keys if self._key_store is not None else [])
        ]
        if self._key_store is not None:
            self._key_store.save()
        if report["quota_exhausted"]:
            report["status"] = "quota"
        elif report["throttled"]:
            report["status"] = "throttled"
        else:
            report["status"] = "complete" if not any(
                r.get("splits") == "pending" or r.get("splits") == "error"
                for r in report["symbols"].values()
            ) else "partial"
        return report

    def _upsert_metrics(self, symbol: str, metrics) -> None:
        write = self._d1.upsert_technical_metrics({
            "symbol": symbol,
            "anchor_week": metrics.anchor_week,
            "completed_weeks_available": metrics.completed_weeks_available,
            "sum_199": metrics.sum_199,
            "anchor_close": metrics.anchor_close,
            "closed_sma_200w": metrics.closed_sma_200w,
            "historical_data_as_of": _now_iso(),
            "calculated_at": _now_iso(),
            "status": metrics.status,
        })
        if write.failed:
            raise ProviderError(f"technical_metrics write failed for {symbol}: {write.error}")

    def _reconcile_metrics_gaps(self, symbols: list[str], report: dict) -> None:
        """Recompute metrics for symbols whose weekly data is stored but whose
        metrics row is missing or in error — D1-only, ZERO provider calls."""
        as_of = ny_date_of(self._now())
        as_of_iso = f"{as_of.year:04d}-{as_of.month:02d}-{as_of.day:02d}"
        for symbol in symbols:
            if (self._store.state.symbol_status(symbol, "weekly") == STATUS_DONE
                    and self._store.state.symbol_status(symbol, "metrics") != STATUS_DONE):
                # Metrics missing or in error — repair from stored D1 weekly
                # history (zero provider calls).
                try:
                    rows = self._d1.read_weekly_rows(symbol)
                except D1QueryError:
                    continue
                if not rows:
                    continue
                try:
                    stored_events = split_events_from_rows(self._d1.read_split_events(symbol))
                except D1QueryError:
                    continue
                adjusted = []
                for row in rows:
                    bar = WeeklyBar(
                        symbol=row["symbol"], week_end_date=row["week_end_date"],
                        open=float(row["raw_open"]), high=float(row["raw_high"]),
                        low=float(row["raw_low"]), close=float(row["raw_close"]),
                        volume=int(row["volume"]),
                    )
                    factor = cumulative_split_factor(row["week_end_date"], stored_events, as_of_date=as_of_iso)
                    adjusted.append((bar, bar.close / float(factor)))
                try:
                    metrics = compute_technical_metrics(symbol, adjusted)
                    self._upsert_metrics(symbol, metrics)
                    self._store.state.mark_symbol(symbol, "metrics", STATUS_DONE)
                    report["metrics_updated"] += 1
                except (ProviderError, D1QueryError):
                    self._store.state.mark_symbol(symbol, "metrics", STATUS_ERROR)

    def _status_only(self, symbol: str) -> dict:
        """Status-only per-symbol projection (never overwrites detail dicts)."""
        return {
            "splits": self._store.state.symbol_status(symbol, "splits"),
            "weekly": self._store.state.symbol_status(symbol, "weekly"),
            "metrics": self._store.state.symbol_status(symbol, "metrics"),
        }

    def _plan_report(self, symbols: list[str], target: str) -> dict:
        return {
            "status": "plan",
            "cycle_week": target,
            "phase": self._store.state.phase() if self._store.state.symbols else "splits",
            "symbols": {symbol: {"splits": "pending", "weekly": "pending", "metrics": "pending"}
                        for symbol in symbols},
            "requests_used_total": 0,
            "keys_used": [],
            "quota_exhausted": False,
            "anomalies": [],
            "rows_updated": 0,
            "metrics_updated": 0,
            "split_changes": 0,
        }

    def _finalize_report(self, report: dict) -> None:
        report["requests_used_total"] = self._provider.requests_this_run
        report["keys_used"] = [
            {"index": k.get("index"), "used": k.get("used", 0)}
            for k in (self._key_store.state.keys if self._key_store is not None else [])
        ]
        # Persist the shared per-key budget ledger so bootstrap + maintenance
        # draw from the same daily quota (documented contract at cli.py:76-78).
        if self._key_store is not None:
            self._key_store.save()
        # Persist the report mirror into app_meta (best effort).
        try:
            self._d1.write_app_meta("historyMaintenanceReport", report)
        except Exception:
            pass

    def _week_gaps(self, completed: list[str]) -> list[str]:
        """ISO-week sequence gaps in ascending bucket dates (<= 52 reported)."""
        if len(completed) < 2:
            return []
        ordered = sorted(completed)

        def monday_of(year: int, week: int) -> dt.date:
            jan4 = dt.date(year, 1, 4)
            start = jan4 - dt.timedelta(days=jan4.isoweekday() - 1)
            return start + dt.timedelta(weeks=week - 1)

        def week_of(date_key: str) -> tuple[int, int]:
            day = dt.date.fromisoformat(date_key)
            iso = day.isocalendar()
            return (iso[0], iso[1])

        gaps: list[str] = []
        prev = week_of(ordered[0])
        prev_monday = monday_of(*prev)
        for date_key in ordered[1:]:
            current = week_of(date_key)
            current_monday = monday_of(*current)
            gap_weeks = round((current_monday - prev_monday).days / 7)
            if gap_weeks > 1:
                label = week_label_of_date_key(date_key)
                after = week_label_of_date_key(ordered[ordered.index(date_key) - 1])
                gaps.append(f"{label} (after {after})")
                if len(gaps) >= 52:
                    break
            prev = current
            prev_monday = current_monday
        return gaps
