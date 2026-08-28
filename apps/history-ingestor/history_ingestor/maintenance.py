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
    unchanged  -> validate the history (and repair a legacy mixed basis when
                  it is provable from durable split data);
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
import math
import time
from collections.abc import Callable
from typing import Any

from .config import Settings
from .d1 import D1MalformedMetaError, D1QueryError
from .maintenance_state import (
    RECONCILE_D1_META_KEY,
    RECONCILE_STATUS_META_PREFIX,
    RECOVERY_PENDING,
    RECOVERY_RETRY,
    RECOVERY_RUNNING,
    SERVING_BLOCKED,
    SERVING_READY,
    SPLIT_RECOVERY_META_PREFIX,
    SPLIT_SERVING_STATE_META_PREFIX,
    STATUS_DONE,
    STATUS_ERROR,
    STATUS_PENDING,
    ReconcileStore,
    split_recovery_key,
    split_serving_state_key,
)
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

# A single large weekly close move is not enough to infer a split.  The
# fail-closed legacy detector below requires all four raw OHLC values to move
# by the same conventional factor across consecutive ISO weeks, with the
# newer scale persisting for another week.  This catches a mixed historical
# regime without turning an ordinary market move or one corrected candle into
# a split event.
STRUCTURAL_SCALE_TOLERANCE = 0.005
STRUCTURAL_SCALE_MIN_RATIO = 0.8
STRUCTURAL_SCALE_MAX_RATIO = 1.25
STRUCTURAL_REGIME_TOLERANCE = 0.25

# Recovery is checked hourly, but an unchanged provider response is not a
# reason to spend another request on every hourly tick.  The delay is stored
# in each durable queue row via ``next_attempt_at`` and grows to one request
# per day for a persistently unpublished split.  This leaves the shared daily
# provider ledger available to the normal Sunday discovery and weekly work.
RECOVERY_RETRY_MAX_HOURS = 24


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
        self._reconcile_store: ReconcileStore | None = None
        self._now = now_fn or (lambda: dt.datetime.now(dt.UTC))

    def _get_reconcile_store(self) -> ReconcileStore:
        if self._reconcile_store is None:
            # Derive the reconcile checkpoint path from the maintenance store's
            # checkpoint location (same StateDirectory in prod, same tmp in tests)
            # so tests stay isolated and prod keeps both in /var/lib/history-ingestor.
            base = getattr(self._store, "_state_path", None) or self._settings.maintenance_state_path
            self._reconcile_store = ReconcileStore(self._settings, self._d1, state_path=base.with_name("reconcile.json"))
            self._reconcile_store.load()
        return self._reconcile_store

    # --------------------------------------------------------- serving state

    def _operation_now_iso(self) -> str:
        """Return the injected clock as a canonical UTC timestamp."""
        now = self._now()
        if now.tzinfo is None:
            now = now.replace(tzinfo=dt.UTC)
        return now.astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

    def _read_serving_state(self, symbol: str) -> dict | None:
        """Read one symbol's authoritative READY/BLOCKED state.

        ``None`` means the rollout has not published a per-symbol state yet.
        A present but malformed value is deliberately interpreted as BLOCKED;
        corrupt metadata must never silently fall back to last-known-good data.
        """
        try:
            payload = self._d1.read_app_meta(split_serving_state_key(symbol))
        except D1MalformedMetaError:
            # Prefix recovery has already established that this symbol owns a
            # malformed marker. Treat it as repairable BLOCKED state instead
            # of confusing metadata corruption with a D1 transport failure.
            return {
                "version": 1,
                "symbol": symbol,
                "state": SERVING_BLOCKED,
                "reason": "invalid_serving_state",
            }
        except D1QueryError as exc:
            raise ProviderError(f"serving state read failed for {symbol}: {exc}") from exc
        if payload is None:
            return None
        if not isinstance(payload, dict):
            return {
                "version": 1,
                "symbol": symbol,
                "state": SERVING_BLOCKED,
                "reason": "invalid_serving_state",
            }
        if (
            payload.get("version") == 1
            and payload.get("symbol") == symbol
            and payload.get("state") in (SERVING_READY, SERVING_BLOCKED)
        ):
            return payload
        return {
            "version": 1,
            "symbol": symbol,
            "state": SERVING_BLOCKED,
            "reason": "invalid_serving_state",
        }

    def _persist_serving_state(self, symbol: str, state: str, reason: str) -> None:
        """Durably publish one serving state, failing closed on write errors."""
        if state not in (SERVING_READY, SERVING_BLOCKED):
            raise ValueError(f"invalid serving state {state!r}")
        payload = {
            "version": 1,
            "symbol": symbol,
            "state": state,
            "reason": reason[:160],
            "updated_at": self._operation_now_iso(),
        }
        try:
            written = self._d1.write_app_meta(split_serving_state_key(symbol), payload)
        except Exception as exc:
            raise ProviderError(f"serving state write failed for {symbol}: {exc}") from exc
        if not written:
            raise ProviderError(f"serving state write failed for {symbol}")

    def _ensure_recovery_request(self, symbol: str, reason: str) -> None:
        """Create/update a single durable recovery request (idempotently)."""
        key = split_recovery_key(symbol)
        try:
            existing = self._d1.read_app_meta(key)
        except D1QueryError:
            existing = None
        try:
            attempts = max(0, int((existing or {}).get("attempts", 0)))
        except (TypeError, ValueError):
            attempts = 0
        payload = {
            "version": 1,
            "symbol": symbol,
            "status": RECOVERY_PENDING,
            "reason": reason[:160],
            "attempts": attempts,
            "next_attempt_at": self._operation_now_iso(),
            "updated_at": self._operation_now_iso(),
        }
        try:
            written = self._d1.write_app_meta(key, payload)
        except Exception as exc:
            raise ProviderError(f"split recovery request write failed for {symbol}: {exc}") from exc
        if not written:
            raise ProviderError(f"split recovery request write failed for {symbol}")

    def _mark_recovery_request(self, request: dict, status: str, error: str | None = None) -> None:
        """Persist recovery workflow progress without changing serving state."""
        symbol = str(request.get("symbol") or "")
        if not symbol:
            return
        try:
            attempts = max(0, int(request.get("attempts", 0)))
        except (TypeError, ValueError):
            attempts = 0
        now = self._now()
        if now.tzinfo is None:
            now = now.replace(tzinfo=dt.UTC)
        # Use the number of completed retries, rather than the current
        # process invocation, to choose the next attempt.  The hourly timer
        # still notices the row, while repeated provider responses cannot
        # consume the daily quota on every tick.  A new request (attempts=0)
        # therefore retries after two hours; the delay then grows to 4/8/16
        # hours and caps at one day.  A later process/restart reads the same
        # timestamp and preserves this backoff.
        retry_number = max(1, attempts + 1)
        retry_delay_hours = min(RECOVERY_RETRY_MAX_HOURS, 2 ** retry_number)
        next_attempt = now + dt.timedelta(hours=retry_delay_hours)
        payload = {
            "version": 1,
            "symbol": symbol,
            "status": status,
            "reason": str(request.get("reason") or "scale_mismatch")[:160],
            "attempts": attempts + (1 if status == RECOVERY_RETRY else 0),
            "next_attempt_at": next_attempt.astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "updated_at": self._operation_now_iso(),
        }
        if error:
            payload["last_error"] = error[:240]
        try:
            written = self._d1.write_app_meta(split_recovery_key(symbol), payload)
        except Exception as exc:
            raise ProviderError(f"split recovery state write failed for {symbol}: {exc}") from exc
        if not written:
            raise ProviderError(f"split recovery state write failed for {symbol}")

    def _clear_recovery_request(self, symbol: str) -> bool:
        """Remove a completed request; a failed cleanup is safe to retry."""
        try:
            return bool(self._d1.delete_app_meta(split_recovery_key(symbol)))
        except Exception:
            logger.warning("split recovery cleanup failed for %s", symbol)
            return False

    def _block_for_scale_operation(self, symbol: str, reason: str, queue: bool) -> None:
        """Publish BLOCKED before any split/history mutation."""
        self._persist_serving_state(symbol, SERVING_BLOCKED, reason)
        if queue:
            self._ensure_recovery_request(symbol, reason)

    @staticmethod
    def _raw_ohlc(row: dict) -> tuple[float, float, float, float] | None:
        """Decode a valid positive raw candle for structural comparisons."""
        try:
            values = tuple(float(row[name]) for name in ("raw_open", "raw_high", "raw_low", "raw_close"))
        except (KeyError, TypeError, ValueError):
            return None
        if not all(math.isfinite(value) and value > 0 for value in values):
            return None
        raw_open, raw_high, raw_low, raw_close = values
        if raw_high < max(raw_open, raw_low, raw_close) or raw_low > min(raw_open, raw_high, raw_close):
            return None
        return values

    @staticmethod
    def _consecutive_iso_weeks(older: dt.date, newer: dt.date) -> bool:
        """Accept Friday/holiday bucket dates in adjacent ISO weeks."""
        older_monday = older - dt.timedelta(days=older.weekday())
        newer_monday = newer - dt.timedelta(days=newer.weekday())
        return (newer_monday - older_monday).days == 7

    @classmethod
    def _structural_scale_between(cls, older: dict, newer: dict) -> float | None:
        """Return an evidenced raw scale ratio, or None for ordinary movement."""
        old_values = cls._raw_ohlc(older)
        new_values = cls._raw_ohlc(newer)
        if old_values is None or new_values is None:
            return None
        ratios = [old / new for old, new in zip(old_values, new_values)]
        scale = ratios[0]
        if not math.isfinite(scale) or scale <= 0:
            return None
        if any(abs(ratio / scale - 1) > STRUCTURAL_SCALE_TOLERANCE for ratio in ratios[1:]):
            return None
        if STRUCTURAL_SCALE_MIN_RATIO < scale < STRUCTURAL_SCALE_MAX_RATIO:
            return None
        return scale

    @classmethod
    def _has_unexplained_scale_transition(cls, rows: list[dict]) -> bool:
        """Detect a persisted mixed raw regime without inventing an event.

        The extra newer-side witness is deliberate: a provider correction to a
        single weekly candle can change every OHLC field together, but it does
        not keep the new scale for the following week.  This detector only
        blocks serving; the recovery job still waits for Alpha Vantage to
        publish authoritative SPLITS before mutating split_events.
        """
        ordered: list[tuple[dt.date, dict]] = []
        for row in rows:
            try:
                day = date_from_iso(str(row["week_end_date"]))
                factor = float(row["split_adjustment_factor"])
                raw_close = float(row["raw_close"])
                adjusted_close = float(row["split_adjusted_close"])
            except (KeyError, TypeError, ValueError):
                continue
            if (
                not math.isfinite(factor)
                or not math.isfinite(raw_close)
                or not math.isfinite(adjusted_close)
                or abs(factor - 1) > 1e-9
                or abs(adjusted_close - raw_close) > max(1e-6, abs(raw_close) * 1e-6)
            ):
                continue
            ordered.append((day, row))
        ordered.sort(key=lambda item: item[0])
        for index in range(len(ordered) - 2):
            older_day, older = ordered[index]
            newer_day, newer = ordered[index + 1]
            witness_day, witness = ordered[index + 2]
            if not cls._consecutive_iso_weeks(older_day, newer_day):
                continue
            if not cls._consecutive_iso_weeks(newer_day, witness_day):
                continue
            scale = cls._structural_scale_between(older, newer)
            if scale is None:
                continue
            try:
                older_close = float(older["raw_close"])
                witness_close = float(witness["raw_close"])
            except (KeyError, TypeError, ValueError):
                continue
            witness_ratio = older_close / witness_close
            if math.isfinite(witness_ratio) and abs(witness_ratio / scale - 1) <= STRUCTURAL_REGIME_TOLERANCE:
                return True
        return False

    def _history_matches_events(self, symbol: str, events: list[SplitEvent]) -> bool:
        """Verify every stored row is internally consistent and split-fresh.

        The Worker serves all four adjusted OHLC values, not only close.  A
        close-only check could therefore publish a candle with a stale high or
        low after a repair.  Validate the complete persisted row before READY.
        """
        try:
            rows = self._d1.read_weekly_rows(symbol)
        except D1QueryError as exc:
            raise ProviderError(f"weekly read failed for {symbol}: {exc}") from exc
        if not rows:
            return True
        as_of = ny_date_of(self._now())
        as_of_iso = f"{as_of.year:04d}-{as_of.month:02d}-{as_of.day:02d}"
        try:
            effective_events = sorted(
                (event for event in events if date_from_iso(event.effective_date) <= as_of),
                key=lambda event: event.effective_date,
            )
            latest_effective = effective_events[-1].effective_date if effective_events else None
            latest_effective_date = date_from_iso(latest_effective) if latest_effective else None
        except (TypeError, ValueError):
            return False
        split_ms = None
        if latest_effective_date is not None:
            split_ms = dt.datetime.combine(
                latest_effective_date, dt.time.min, tzinfo=dt.UTC,
            ).timestamp()
        for row in rows:
            try:
                week_end = date_from_iso(str(row["week_end_date"]))
                raw_open = float(row["raw_open"])
                raw_high = float(row["raw_high"])
                raw_low = float(row["raw_low"])
                raw_close = float(row["raw_close"])
                volume = float(row["volume"])
                factor = float(row["split_adjustment_factor"])
                adjusted_close = float(row["split_adjusted_close"])
                expected = float(cumulative_split_factor(row["week_end_date"], events, as_of_date=as_of_iso))
                fetched = dt.datetime.fromisoformat(
                    str(row["source_fetched_at"]).replace("Z", "+00:00")
                )
            except (KeyError, TypeError, ValueError, ZeroDivisionError):
                return False
            if fetched.tzinfo is None:
                fetched = fetched.replace(tzinfo=dt.UTC)
            if not all(math.isfinite(value) and value > 0 for value in (
                raw_open, raw_high, raw_low, raw_close, factor, adjusted_close, expected,
            )):
                return False
            if raw_high < max(raw_open, raw_low, raw_close) or raw_low > min(raw_open, raw_high, raw_close):
                return False
            if not math.isfinite(volume) or volume < 0 or not volume.is_integer():
                return False
            if abs(factor - expected) > max(1e-9, expected * 1e-9):
                return False
            expected_close = raw_close / expected
            if abs(adjusted_close - expected_close) > max(1e-6, abs(expected_close) * 1e-6):
                return False
            if split_ms is not None and latest_effective_date is not None and week_end < latest_effective_date:
                if fetched.timestamp() < split_ms:
                    return False
        # A legacy checkpoint can say "done" while split_events is empty and
        # raw history contains both sides of a split.  Do not publish READY in
        # that state merely because factor=1 is internally self-consistent.
        # Future-only events do not adjust today's rows, so the same guard also
        # applies while an announced split is waiting for its effective date.
        if not effective_events and self._has_unexplained_scale_transition(rows):
            return False
        return True

    @staticmethod
    def _can_publish_ready(serving: dict | None) -> bool:
        """Allow recovery only for data-workflow blocks, never quote-only blocks."""
        if serving is None or serving.get("state") == SERVING_READY:
            return True
        reason = str(serving.get("reason") or "")
        return reason in {
            "scale_mismatch",
            "split_verification_pending",
            "split_history_changed",
            "split_recovery_verified",
            "due_split",
            "history_factor_mismatch",
            "bootstrap",
            "legacy_rollout_backfill",
            "invalid_serving_state",
        }

    def _publish_reconciled_ready(self, symbol: str, reason: str) -> None:
        """Publish READY only after the persisted history has been verified."""
        self._persist_serving_state(symbol, SERVING_READY, reason)

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

    def _reconcile_event_set(
        self,
        symbol: str,
        stored_events: list[SplitEvent],
        fresh_events: list[SplitEvent],
        result: dict,
        *,
        events_changed: bool,
        reason: str,
    ) -> None:
        """Apply one complete split-history operation with fail-closed ordering.

        Serving BLOCKED is durable before any split_events/history mutation.
        READY is written only after split_events, every weekly row and metrics
        are durable and the resulting factors have been checked again.  Every
        write is idempotent, so a later recovery can safely repeat the batch.
        """
        rstore = self._get_reconcile_store()
        self._block_for_scale_operation(symbol, reason, queue=True)
        rstore.state.mark(symbol, STATUS_PENDING)
        if not rstore.save():
            raise ProviderError(f"split workflow invalidation failed for {symbol}")

        if events_changed:
            split_write = self._d1.upsert_split_events(
                split_events_to_rows(symbol, fresh_events, self._operation_now_iso())
            )
            if split_write.failed:
                raise ProviderError(f"split_events write failed: {split_write.error}")
            delete_write = self._d1.delete_extra_split_events(
                symbol, [event.effective_date for event in fresh_events]
            )
            if delete_write.failed:
                raise ProviderError(f"split_events cleanup failed: {delete_write.error}")

        # An unchanged event set can still have a stale/mixed weekly basis (the
        # original NVDA incident).  Rebuild it whenever there is durable split
        # evidence.  With no events, a factor mismatch is an unknown split and
        # must stay blocked until the provider supplies evidence; writing factor
        # 1 would be unsafe.
        if events_changed or stored_events:
            self._rewrite_history_from_stored(symbol, fresh_events, result)
        elif not self._history_matches_events(symbol, fresh_events):
            raise ProviderError(
                f"{symbol} history scale mismatch has no durable split evidence"
            )

        if not self._history_matches_events(symbol, fresh_events):
            raise ProviderError(f"{symbol} history verification failed after rewrite")

        # READY is the authoritative final write.  The old reconciliation
        # marker is updated only afterwards, so it can never create a safe
        # rollout fallback if this publication fails.
        self._publish_reconciled_ready(symbol, "split_history_verified")
        rstore.state.mark(symbol, STATUS_DONE)
        if not rstore.save():
            # The serving state is already safe; the workflow checkpoint will
            # retry/repair on the next pass and the recovery row remains.
            raise ProviderError(f"split workflow completion write failed for {symbol}")
        self._clear_recovery_request(symbol)
        result["splits"] = STATUS_DONE
        result["history_repaired"] = not events_changed

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
                # Unchanged provider history is normally a no-op, but it is
                # also the repair opportunity for a legacy/mixed weekly basis.
                # A READY symbol remains READY; a quote-only BLOCKED symbol is
                # never unblocked merely because SPLITS is unchanged.
                if not self._history_matches_events(symbol, stored_events):
                    self._reconcile_event_set(
                        symbol,
                        stored_events,
                        fresh_events,
                        result,
                        events_changed=False,
                        reason="history_factor_mismatch",
                    )
                else:
                    serving = self._read_serving_state(symbol)
                    if self._can_publish_ready(serving) and (serving is None or serving.get("state") != SERVING_READY):
                        self._publish_reconciled_ready(symbol, "split_history_verified")
                    # A previous run can have completed all data writes and
                    # READY publication but died before deleting its queue
                    # item.  Unchanged, verified history is sufficient to
                    # remove that stale workflow row without another fetch.
                    if serving is None or serving.get("state") == SERVING_READY:
                        self._clear_recovery_request(symbol)
                    self._get_reconcile_store().state.mark(symbol, STATUS_DONE)
                return result

            result["split_changed"] = True
            if dry_run:
                self._get_reconcile_store().state.mark(symbol, STATUS_DONE)
                return result

            self._reconcile_event_set(
                symbol,
                stored_events,
                fresh_events,
                result,
                events_changed=True,
                reason="split_history_changed",
            )
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
            # A failed attempt is not evidence that last-known-good history is
            # invalid. Keep its serving marker while recording retry progress.
            self._get_reconcile_store().state.mark(symbol, STATUS_ERROR, update_serving_marker=False)
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
            serving = self._read_serving_state(symbol)
            serving_reason = str((serving or {}).get("reason") or "")
            due_events = [
                event for event in stored_events
                if date_from_iso(event.effective_date) <= as_of
            ]
            # apply-due-splits normally performs this transition before the
            # weekly timer.  Keep the weekly boundary safe if that timer was
            # missed, delayed, or raced with this process: an old stored
            # basis must become BLOCKED before the first weekly mutation.
            due_history_rewrite = bool(due_events and stored) and not self._history_matches_events(
                symbol, stored_events,
            )
            if due_history_rewrite:
                if serving is None or serving.get("state") == SERVING_READY:
                    self._block_for_scale_operation(symbol, "due_split", queue=True)
                else:
                    # Preserve an existing quote-only BLOCKED reason.  It is
                    # not safe to relabel that state as a data repair merely
                    # because a stored split is also due.
                    self._ensure_recovery_request(symbol, serving_reason or "due_split")
            changed = []
            has_provider_correction = False
            for bar, factor, adj_close in adjusted_full:
                old = stored.get(bar.week_end_date)
                if old is None or self._row_differs(old, bar, factor, adj_close):
                    has_provider_correction = has_provider_correction or old is not None
                    changed.append((
                        bar.symbol, bar.week_end_date, bar.open, bar.high, bar.low,
                        bar.close, bar.volume, float(factor), adj_close, _now_iso(),
                    ))
            if changed:
                write = self._d1.upsert_weekly_rows(changed)
                if write.failed:
                    raise ProviderError(f"D1 weekly write failed: {write.error}")
                result["rows_updated"] = len(changed)
                if has_provider_correction:
                    # OHLC corrections are not split evidence.  Keep the
                    # last-known-good serving state; split-scale verification
                    # remains the independent reconciliation responsibility.
                    result["anomalies"].append(f"{symbol}: provider correction rewrote {len(changed)} rows (serving state preserved)")

            self._store.state.mark_symbol(symbol, "weekly", STATUS_DONE)
            if due_history_rewrite:
                # Include the newly fetched rows in the durable raw history,
                # then rebuild the complete series from those raw rows.  This
                # covers a missed Monday due-split run without ever exposing
                # a partially rewritten READY history.
                self._rewrite_history_from_stored(symbol, stored_events, result)
                if not self._history_matches_events(symbol, stored_events):
                    raise ProviderError(f"{symbol} history verification failed after weekly due split")
                if self._can_publish_ready(serving):
                    self._publish_reconciled_ready(symbol, "due_split_applied")
                    self._clear_recovery_request(symbol)
                else:
                    result["anomalies"].append(
                        f"{symbol}: due split history repaired; existing quote-scale block preserved"
                    )
                self._store.state.mark_symbol(symbol, "metrics", STATUS_DONE)
            else:
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

    def _row_needs_split_timestamp_refresh(
        self,
        row: dict,
        events: list[SplitEvent],
        as_of: dt.date,
    ) -> bool:
        """Detect a correctly-valued row fetched before its governing split."""
        try:
            week_end = date_from_iso(str(row["week_end_date"]))
            applicable = [
                event for event in events
                if week_end < date_from_iso(event.effective_date)
                and date_from_iso(event.effective_date) <= as_of
            ]
            if not applicable:
                return False
            fetched_dt = dt.datetime.fromisoformat(
                str(row["source_fetched_at"]).replace("Z", "+00:00")
            )
            if fetched_dt.tzinfo is None:
                fetched_dt = fetched_dt.replace(tzinfo=dt.UTC)
            fetched = fetched_dt.timestamp()
            latest = max(date_from_iso(event.effective_date) for event in applicable)
            split_timestamp = dt.datetime.fromisoformat(f"{latest}T00:00:00+00:00").timestamp()
            return fetched < split_timestamp
        except (KeyError, TypeError, ValueError):
            return True

    def _stored_rows(self, symbol: str) -> dict[str, tuple]:
        """Map week_end_date -> (open, high, low, close, volume, factor, adj)."""
        try:
            rows = self._d1.read_weekly_rows(symbol)
        except D1QueryError as exc:
            raise ProviderError(f"weekly read failed for {symbol}: {exc}") from exc
        try:
            return {
                row["week_end_date"]: (
                    float(row["raw_open"]), float(row["raw_high"]), float(row["raw_low"]),
                    float(row["raw_close"]), int(row["volume"]),
                    float(row["split_adjustment_factor"]), float(row["split_adjusted_close"]),
                )
                for row in rows
            }
        except (KeyError, TypeError, ValueError) as exc:
            raise ProviderError(f"weekly row decode failed for {symbol}: {exc}") from exc

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
        try:
            stored = {
                row["week_end_date"]: (
                    float(row["raw_open"]), float(row["raw_high"]), float(row["raw_low"]),
                    float(row["raw_close"]), int(row["volume"]),
                    float(row["split_adjustment_factor"]), float(row["split_adjusted_close"]),
                )
                for row in stored_rows
            }
            source_rows = {row["week_end_date"]: row for row in stored_rows}
        except (KeyError, TypeError, ValueError) as exc:
            raise ProviderError(f"weekly row decode failed for {symbol}: {exc}") from exc
        changed = []
        for bar, factor, adj_close in adjusted_full:
            old = stored.get(bar.week_end_date)
            source_row = source_rows.get(bar.week_end_date)
            needs_timestamp_refresh = source_row is not None and self._row_needs_split_timestamp_refresh(
                source_row, events, as_of,
            )
            if old is None or self._row_differs(old, bar, factor, adj_close) or needs_timestamp_refresh:
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
        # Successful recompute is reported so the caller/counter reflects it.
        result["metrics_updated"] = True
        result["metrics"] = STATUS_DONE
        # Mark which splits were NOT yet applied (future-dated) so the
        # daily due-split reconciliation knows what to pick up.
        future_splits = [e for e in events if date_from_iso(e.effective_date) > as_of]
        if future_splits:
            result["anomalies"].append(
                f"{symbol}: {len(future_splits)} future split(s) stored but not yet applied"
            )

    def apply_due_splits(self, symbols_filter: list[str] | None = None) -> dict:
        """Apply due stored splits with zero provider requests and fail closed."""
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
                if not stored_events:
                    continue
                stored_rows = self._d1.read_weekly_rows(symbol)
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
                stored = {
                    row["week_end_date"]: (
                        float(row["raw_open"]), float(row["raw_high"]), float(row["raw_low"]),
                        float(row["raw_close"]), int(row["volume"]),
                        float(row["split_adjustment_factor"]), float(row["split_adjusted_close"]),
                    )
                    for row in stored_rows
                }
                source_rows = {row["week_end_date"]: row for row in stored_rows}
                today_date = date_from_iso(today_iso)
                changed = []
                for bar, factor, adj_close in adjusted_full:
                    old = stored.get(bar.week_end_date)
                    needs_timestamp_refresh = (
                        bar.week_end_date in source_rows
                        and self._row_needs_split_timestamp_refresh(
                            source_rows[bar.week_end_date], stored_events, today_date,
                        )
                    )
                    if (
                        old is None
                        or self._row_differs(old, bar, factor, adj_close)
                        or needs_timestamp_refresh
                    ):
                        changed.append((
                            bar.symbol, bar.week_end_date, bar.open, bar.high, bar.low,
                            bar.close, bar.volume, float(factor), adj_close, _now_iso(),
                        ))
                serving = self._read_serving_state(symbol)
                serving_reason = str((serving or {}).get("reason") or "")
                was_blocked_before = serving is not None and serving.get("state") == SERVING_BLOCKED
                operation_was_blocked = was_blocked_before
                if changed and not operation_was_blocked:
                    # The serving state is written and confirmed before the
                    # first weekly mutation. A Monday crash is therefore safe.
                    self._block_for_scale_operation(symbol, "due_split", queue=True)
                    operation_was_blocked = True
                elif changed and operation_was_blocked:
                    # A prior run may have persisted BLOCKED but lost the
                    # durable queue write, or a different workflow may have
                    # left the symbol blocked. Keep one retry request alive
                    # before mutating history.
                    self._ensure_recovery_request(symbol, serving_reason or "due_split")

                if changed:
                    write = self._d1.upsert_weekly_rows(changed)
                    if write.failed:
                        raise ProviderError(f"D1 weekly write failed: {write.error}")

                # If a previous due-split run died after BLOCKED, recompute
                # metrics even when the row diff is now empty, then publish
                # READY only for this known due-split workflow. An unexpected
                # quote-scale block remains blocked until SPLITS confirms it.
                if changed or (operation_was_blocked and serving_reason == "due_split"):
                    metrics = compute_technical_metrics(symbol, [(bar, close) for bar, _f, close in adjusted_full])
                    self._upsert_metrics(symbol, metrics)
                    if not self._history_matches_events(symbol, stored_events):
                        raise ProviderError(f"{symbol} history verification failed after due split")
                    if self._can_publish_ready(serving):
                        self._publish_reconciled_ready(symbol, "due_split_applied")
                        self._clear_recovery_request(symbol)

                if not changed:
                    continue
                report["symbols"][symbol] = {"status": "applied", "rows_updated": len(changed)}
                report["rows_updated"] += len(changed)
                report["metrics_updated"] += 1
                report["splits_applied"] += 1
                report["status"] = "applied"
            except (ProviderError, D1QueryError, KeyError, TypeError, ValueError) as exc:
                # If BLOCKED was already durable, leave it untouched. If the
                # block write itself failed, no data write was attempted.
                report["symbols"][symbol] = {"status": "error", "error": str(exc)[:200]}
        return report

    def _recovery_request_is_due(self, request: dict) -> bool:
        """Return whether a pending/retry/running request may be attempted."""
        if request.get("status") not in (RECOVERY_PENDING, RECOVERY_RETRY, RECOVERY_RUNNING):
            return False
        raw = request.get("next_attempt_at")
        if not isinstance(raw, str) or not raw:
            return True
        try:
            due = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return True
        now = self._now()
        if now.tzinfo is None:
            now = now.replace(tzinfo=dt.UTC)
        if due.tzinfo is None:
            due = due.replace(tzinfo=dt.UTC)
        return due <= now.astimezone(dt.UTC)

    def recover_split_mismatches(
        self,
        symbols_filter: list[str] | None = None,
        limit: int | None = None,
    ) -> dict:
        """Retry only durable split-verification requests.

        An empty queue returns before constructing a provider call.  Requests
        are claimed in app_meta, use the same Alpha Vantage client and shared
        key ledger as normal reconciliation, and remain BLOCKED when the
        provider still reports the old split history.
        """
        universe = load_core_universe(self._settings.universe_path)
        if symbols_filter is not None:
            wanted = set(symbols_filter)
            universe = [symbol for symbol in universe if symbol in wanted]
        self._store.load()
        if self._key_store is not None:
            try:
                self._key_store.load()
            except Exception:
                logger.warning("split recovery: shared budget ledger unreadable — keys will report empty")
        rstore = self._get_reconcile_store()
        try:
            queue_rows = self._d1.read_app_meta_prefix(SPLIT_RECOVERY_META_PREFIX)
            serving_rows = self._d1.read_app_meta_prefix(SPLIT_SERVING_STATE_META_PREFIX)
        except D1QueryError as exc:
            return {
                "status": "error", "symbols": {}, "requests_used_total": 0,
                "keys_used": [], "quota_exhausted": False, "throttled": False,
                "anomalies": [f"split recovery queue read failed: {exc}"],
            }

        pending: list[dict] = []
        queued_symbols: set[str] = set()
        for key, payload in queue_rows:
            suffix = key.removeprefix(SPLIT_RECOVERY_META_PREFIX)
            # The app_meta key is the durable ownership boundary. Ignore a
            # stale/malformed payload symbol rather than allowing a corrupted
            # NVDA key to trigger a provider call for another ticker or clear
            # another ticker's request.
            symbol = suffix
            if symbol not in universe:
                continue
            queued_symbols.add(symbol)
            request = dict(payload)
            request["symbol"] = symbol
            # A syntactically valid JSON object can still be an invalid queue
            # record (for example, missing status/version). Normalize that
            # case to executable pending work so corruption self-heals instead
            # of silently disappearing from the recovery scan.
            if request.get("status") not in (RECOVERY_PENDING, RECOVERY_RETRY, RECOVERY_RUNNING):
                request["status"] = RECOVERY_PENDING
                request["reason"] = "invalid_recovery_state"
                request.pop("next_attempt_at", None)
            if self._recovery_request_is_due(request):
                pending.append(request)

        # A BLOCKED marker is authoritative even if the process crashed in
        # the narrow window after publishing that marker and before writing
        # its separate queue row.  Reconstruct the missing work from D1 so a
        # missing queue row cannot strand a symbol indefinitely.  READY rows
        # are deliberately ignored, preserving the invariant that an empty
        # queue with no blocked marker makes zero provider requests.
        for key, payload in serving_rows:
            suffix = key.removeprefix(SPLIT_SERVING_STATE_META_PREFIX)
            symbol = suffix
            if symbol not in universe or symbol in queued_symbols:
                continue
            state = payload.get("state") if isinstance(payload, dict) else None
            if state == SERVING_READY:
                continue
            # The web read model fails closed for malformed serving metadata;
            # route that same evidence through automatic split verification.
            if state != SERVING_BLOCKED and state is not None:
                reason = "invalid_serving_state"
            else:
                reason = str(
                    (payload.get("reason") if isinstance(payload, dict) else None)
                    or "scale_mismatch"
                )
            pending.append({
                "version": 1,
                "symbol": symbol,
                "status": RECOVERY_PENDING,
                "reason": reason[:160],
                "attempts": 0,
                "next_attempt_at": self._operation_now_iso(),
                "_discovered_from_serving_marker": True,
            })

        report: dict = {
            "status": "noop" if not pending else "partial",
            "symbols": {},
            "requests_used_total": 0,
            "keys_used": [],
            "quota_exhausted": False,
            "throttled": False,
            "anomalies": [],
            "recovered": 0,
            "pending": len(pending),
        }
        configured_cap = max(1, int(getattr(self._settings, "split_recovery_max_requests", 2)))
        effective_limit = configured_cap if limit is None else min(configured_cap, max(0, int(limit)))

        for request in pending:
            symbol = str(request["symbol"])
            if self._provider.requests_this_run >= effective_limit:
                report["anomalies"].append("recovery run cap reached; remaining requests stay pending")
                break
            try:
                serving = self._read_serving_state(symbol)
                if serving is not None and serving.get("state") == SERVING_READY:
                    # A prior attempt published READY but crashed before queue
                    # cleanup. Remove the stale queue item without a provider call.
                    self._clear_recovery_request(symbol)
                    report["symbols"][symbol] = {"status": "cleaned"}
                    continue
                if serving is None:
                    self._persist_serving_state(symbol, SERVING_BLOCKED, "scale_mismatch")
                if request.get("_discovered_from_serving_marker"):
                    # Recreate the durable queue before the first provider
                    # call. If this write fails, the handler reports retry and
                    # makes no provider request; the BLOCKED marker remains a
                    # discoverable fallback on the next run.
                    self._ensure_recovery_request(
                        symbol, str(request.get("reason") or "scale_mismatch")
                    )
                self._mark_recovery_request(request, RECOVERY_RUNNING)
                _, fresh_events, _ = self._provider.fetch_splits(symbol)
                try:
                    stored_events = split_events_from_rows(self._d1.read_split_events(symbol))
                except D1QueryError as exc:
                    raise ProviderError(f"split_events read failed: {exc}") from exc

                if not split_events_equal(fresh_events, stored_events):
                    symbol_result = {
                        "splits": STATUS_PENDING, "weekly": STATUS_DONE,
                        "metrics": STATUS_PENDING, "split_changed": True,
                        "rows_updated": 0, "metrics_updated": False,
                        "completed_weeks": 0, "quota": False, "throttled": False,
                        "anomalies": [],
                    }
                    self._reconcile_event_set(
                        symbol,
                        stored_events,
                        fresh_events,
                        symbol_result,
                        events_changed=True,
                        reason="split_recovery_verified",
                    )
                    report["symbols"][symbol] = {
                        "status": "recovered",
                        "rows_updated": symbol_result["rows_updated"],
                        "metrics_updated": symbol_result["metrics_updated"],
                    }
                    report["recovered"] += 1
                    continue

                # The provider has not published new evidence. A known data or
                # verification workflow may be repaired from durable events;
                # a quote-only mismatch must remain blocked.
                reason = str(request.get("reason") or "scale_mismatch")
                known_data_work = reason in {
                    "scale_mismatch", "history_factor_mismatch", "quote_history_scale_mismatch",
                    "split_history_changed", "split_recovery_verified", "split_verification_pending", "due_split",
                    "invalid_serving_state",
                }
                # The request reason may have been replaced by a transient
                # write error after split_events became durable.  In that
                # crash window the authoritative evidence is the blocked
                # symbol plus history that no longer matches the stored event
                # set, not the last human-readable retry message.
                history_needs_rewrite = (
                    bool(stored_events)
                    and not self._history_matches_events(symbol, stored_events)
                )
                if known_data_work or history_needs_rewrite:
                    symbol_result = {
                        "splits": STATUS_PENDING, "weekly": STATUS_DONE,
                        "metrics": STATUS_PENDING, "split_changed": False,
                        "rows_updated": 0, "metrics_updated": False,
                        "completed_weeks": 0, "quota": False, "throttled": False,
                        "anomalies": [],
                    }
                    self._rewrite_history_from_stored(symbol, stored_events, symbol_result)
                    if not self._history_matches_events(symbol, stored_events):
                        raise ProviderError(f"{symbol} history verification failed during recovery")
                    if self._can_publish_ready(serving):
                        self._publish_reconciled_ready(symbol, "split_recovery_verified")
                        rstore.state.mark(symbol, STATUS_DONE)
                        if not rstore.save():
                            raise ProviderError(f"split workflow completion write failed for {symbol}")
                        self._clear_recovery_request(symbol)
                        report["symbols"][symbol] = {
                            "status": "recovered",
                            "rows_updated": symbol_result["rows_updated"],
                            "metrics_updated": symbol_result["metrics_updated"],
                        }
                        report["recovered"] += 1
                    else:
                        # History is now internally correct, but this request
                        # originated from a quote-vs-history mismatch.  Do not
                        # turn a still-unsafe quote into READY; retain the
                        # durable request for the next provider verification.
                        self._mark_recovery_request(
                            request,
                            RECOVERY_RETRY,
                            "history verified; quote scale block remains active",
                        )
                        report["symbols"][symbol] = {
                            "status": "pending",
                            "reason": "quote scale block remains active",
                        }
                else:
                    self._mark_recovery_request(
                        request,
                        RECOVERY_RETRY,
                        "provider split history unchanged; verification remains pending",
                    )
                    report["symbols"][symbol] = {
                        "status": "pending",
                        "reason": "provider split history unchanged",
                    }
            except QuotaExhaustedError:
                self._mark_recovery_request(request, RECOVERY_RETRY, "provider daily quota exhausted")
                report["quota_exhausted"] = True
                report["anomalies"].append(f"{symbol}: provider daily quota exhausted")
                break
            except ThrottleExhaustedError:
                self._mark_recovery_request(request, RECOVERY_RETRY, "provider throttle")
                report["throttled"] = True
                report["anomalies"].append(f"{symbol}: provider throttle")
                break
            except (ProviderError, AllKeysFailedError) as exc:
                try:
                    self._mark_recovery_request(request, RECOVERY_RETRY, str(exc))
                except ProviderError as state_exc:
                    report["anomalies"].append(str(state_exc)[:200])
                report["symbols"][symbol] = {"status": "retry", "error": str(exc)[:200]}
                report["anomalies"].append(f"{symbol}: {str(exc)[:200]}")

        report["requests_used_total"] = self._provider.requests_this_run
        report["keys_used"] = [
            {"index": key.get("index"), "used": key.get("used", 0)}
            for key in (self._key_store.state.keys if self._key_store is not None else [])
        ]
        if self._key_store is not None:
            self._key_store.save()
        if report["quota_exhausted"]:
            report["status"] = "quota"
        elif report["throttled"]:
            report["status"] = "throttled"
        elif not pending:
            report["status"] = "noop"
        elif report["recovered"] == len(pending):
            report["status"] = "complete"
        elif pending:
            report["status"] = "partial"
        return report

    def _backfill_legacy_serving_states(self, symbols: list[str]) -> int:
        """Publish READY once for legacy terminal checkpoints during rollout."""
        rstore = self._get_reconcile_store()
        bootstrap_payload: dict | None = None
        legacy_payload: dict | None = None
        written = 0
        for symbol in symbols:
            if self._read_serving_state(symbol) is not None:
                continue
            try:
                marker = self._d1.read_app_meta(f"{RECONCILE_STATUS_META_PREFIX}{symbol}")
            except D1QueryError as exc:
                raise ProviderError(f"legacy split marker read failed for {symbol}: {exc}") from exc
            symbol_marker_present = marker is not None
            verified = (
                isinstance(marker, dict)
                and marker.get("symbol") == symbol
                and marker.get("status") == STATUS_DONE
            ) if symbol_marker_present else rstore.state.status(symbol) == STATUS_DONE
            # A present non-terminal per-symbol marker is newer workflow
            # evidence than the legacy global document. Never let the global
            # checkpoint publish READY over pending/error state.
            if symbol_marker_present and not verified:
                continue
            if not verified:
                if legacy_payload is None:
                    try:
                        legacy_payload = self._d1.read_app_meta(RECONCILE_D1_META_KEY)
                    except D1QueryError as exc:
                        raise ProviderError(f"legacy split checkpoint read failed: {exc}") from exc
                legacy_splits = (
                    legacy_payload.get("splits")
                    if isinstance(legacy_payload, dict) else None
                )
                verified = isinstance(legacy_splits, dict) and legacy_splits.get(symbol) == STATUS_DONE
            if not verified:
                if bootstrap_payload is None:
                    try:
                        bootstrap_payload = self._d1.read_app_meta("historyBootstrapState")
                    except D1QueryError as exc:
                        raise ProviderError(f"bootstrap checkpoint read failed: {exc}") from exc
                bootstrap_symbols = (
                    bootstrap_payload.get("symbols")
                    if isinstance(bootstrap_payload, dict) else None
                )
                bootstrap_status = (
                    bootstrap_symbols.get(symbol, {})
                    if isinstance(bootstrap_symbols, dict) else {}
                )
                verified = (
                    isinstance(bootstrap_status, dict)
                    and bootstrap_status.get("splits") == STATUS_DONE
                    and bootstrap_status.get("weekly") == STATUS_DONE
                )
            if verified:
                try:
                    stored_events = split_events_from_rows(self._d1.read_split_events(symbol))
                except D1QueryError as exc:
                    raise ProviderError(f"legacy split history read failed for {symbol}: {exc}") from exc
                # A terminal legacy checkpoint is evidence of completed work,
                # not a substitute for validating the rows that will actually
                # be served.  This protects rollout from the original mixed
                # NVDA regime (global `done` plus factor-1 historical rows).
                if not self._history_matches_events(symbol, stored_events):
                    self._block_for_scale_operation(symbol, "history_factor_mismatch", queue=True)
                    # Do not let the later legacy-marker backfill recreate a
                    # durable `done` marker for a symbol we just proved is
                    # unsafe.  The serving state is already BLOCKED, but the
                    # workflow checkpoint must also stop advertising verified
                    # split history until the queued repair completes.
                    rstore.state.mark(symbol, STATUS_ERROR, update_serving_marker=False)
                    continue
                self._publish_reconciled_ready(symbol, "legacy_rollout_backfill")
                written += 1
        return written

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

        PROGRESS IS PERSISTENT IN A DEDICATED STATE: each reconciled symbol is
        marked done in the durable ``ReconcileStore`` (``app_meta
        historyReconcileSplitState``), which is a SEPARATE responsibility from
        the weekly maintenance cycle. It therefore survives
        ``MaintenanceStore.reset_cycle()`` (weekly rollover never erases
        reconciliation progress). A capped/early-stopped run leaves the rest
        pending; the next run SKIPS done symbols and resumes from the first
        unfinished one. When every symbol is done the pass is complete, and the
        next invocation deliberately starts a NEW reconciliation pass so new
        splits are re-checked on the next cadence.

        ``dry_run`` is provider-free: it returns a plan with zero provider
        calls and zero D1 writes.
        """
        symbols = load_core_universe(self._settings.universe_path)
        if symbols_filter is not None:
            wanted = set(symbols_filter)
            symbols = [symbol for symbol in symbols if symbol in wanted]
        self._store.load()
        rstore = self._get_reconcile_store()

        if dry_run:
            return {
                "status": "plan",
                "symbols": {symbol: {"splits": rstore.state.status(symbol),
                                     "plan": "reconcile-splits"} for symbol in symbols},
                "requests_used_total": 0,
                "keys_used": [],
                "quota_exhausted": False,
                "throttled": False,
                "split_changes": 0,
                "rows_updated": 0,
                "metrics_updated": 0,
                "anomalies": [],
            }

        # Idempotent rollout bridge: validate legacy terminal evidence and
        # publish the authoritative serving state BEFORE materialising any new
        # per-symbol verification marker.  If a process dies between these
        # writes, a malformed/mixed legacy history is already BLOCKED rather
        # than temporarily looking verified to the Worker.
        try:
            self._backfill_legacy_serving_states(symbols)
        except ProviderError as exc:
            return {
                "status": "error",
                "symbols": {},
                "requests_used_total": 0,
                "keys_used": [],
                "quota_exhausted": False,
                "throttled": False,
                "split_changes": 0,
                "rows_updated": 0,
                "metrics_updated": 0,
                "anomalies": [str(exc)[:240]],
            }
        # Preserve legacy completed reconciliation before a fresh pass resets
        # the global progress map. If this durable marker write fails, do not
        # spend provider quota; the serving state remains authoritative.
        if rstore.backfill_verified_markers() and not rstore.save():
            return {
                "status": "error",
                "symbols": {},
                "requests_used_total": 0,
                "keys_used": [],
                "quota_exhausted": False,
                "throttled": False,
                "split_changes": 0,
                "rows_updated": 0,
                "metrics_updated": 0,
                "anomalies": ["could not backfill durable split verification markers"],
            }

        # A completed pass means EVERY selected symbol is already reconciled; start a
        # NEW pass (reset to pending) so the next cadence re-checks. Otherwise
        # ensure every selected symbol is tracked — a capped/partial previous
        # run left some symbols unvisited, so they stay pending and the run
        # reports partial and resumes them next time.
        selected_all_done = rstore.state.splits and all(
            rstore.state.status(s) == STATUS_DONE for s in symbols
        )
        if selected_all_done:
            rstore.start_new_pass(symbols)
        else:
            for symbol in symbols:
                if symbol not in rstore.state.splits:
                    rstore.state.splits[symbol] = STATUS_PENDING

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
        # Effective per-invocation provider cap: reconciliation draws from the shared
        # per-key daily ledger, but this job is hard-bounded per run so it can
        # never overrun the whole day ahead of maintenance. An explicit --limit
        # and the configured RECONCILE_SPLITS_MAX_REQUESTS are both enforced as
        # an upper bound (never add, always clamp to the smaller).
        configured_cap = self._settings.reconcile_splits_max_requests
        if configured_cap is not None and limit is not None:
            effective_limit = min(limit, configured_cap)
        elif configured_cap is None:
            effective_limit = limit
        else:
            effective_limit = configured_cap
        for symbol in symbols:
            # SKIP already-reconciled symbols (dedicated durable progress).
            if rstore.state.status(symbol) == STATUS_DONE:
                report["symbols"][symbol] = {"splits": STATUS_DONE}
                continue
            # Provider budget is checked IMMEDIATELY before the fetch so a
            # single symbol cannot blow past the cap mid-iteration.
            if effective_limit is not None and self._provider.requests_this_run >= effective_limit:
                report["anomalies"].append("run stopped by request limit before finishing SPLITS reconciliation")
                break
            symbol_report = self._reconcile_splits(symbol, dry_run=False)
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
            # Persist dedicated reconciliation progress after every symbol.
            # A successful serving publication is not enough to report a
            # completed workflow: the retry cursor itself must also be
            # durable.  Mark the in-memory workflow as an error if this write
            # fails so the final report cannot claim completion.
            if not rstore.save():
                symbol_report["splits"] = STATUS_ERROR
                symbol_report["anomalies"].append(
                    f"{symbol} split workflow checkpoint write failed"
                )
                rstore.state.mark(symbol, STATUS_ERROR, update_serving_marker=False)
        # Completion reads the dedicated state across the FULL selected universe
        # (never the per-run `report`, which omits unvisited symbols after a cap).
        remaining = rstore.state.pending_in(symbols)
        report["requests_used_total"] = self._provider.requests_this_run
        report["keys_used"] = [
            {"index": k.get("index"), "used": k.get("used", 0)}
            for k in (self._key_store.state.keys if self._key_store is not None else [])
        ]
        if self._key_store is not None:
            self._key_store.save()
        checkpoint_saved = rstore.save()
        if not checkpoint_saved:
            report["anomalies"].append("split workflow checkpoint write failed")
        if report["quota_exhausted"]:
            report["status"] = "quota"
        elif report["throttled"]:
            report["status"] = "throttled"
        elif not checkpoint_saved:
            report["status"] = "error"
        elif remaining:
            report["status"] = "partial"
        else:
            report["status"] = "complete"
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
