"""One-shot resumable historical bootstrap.

Loads the canonical Core Universe, resumes from the checkpoint (only pending
symbols are fetched — no duplicate downloads), fetches SPLITS before WEEKLY
per symbol (so split adjustment is always correct), upserts weekly_prices
idempotently, recomputes technical_metrics and persists the checkpoint after
every symbol so an interruption (or a day's quota exhaustion) resumes from
unfinished work.

Quota policy: requests are paced per key, accounted per key against the
documented 25/day entitlement, and the run STOPS as soon as every key is
exhausted — it never bypasses the provider limit. The report tells the
operator exactly which symbols remain.
"""

from __future__ import annotations

import datetime as dt
import logging
import time
from collections.abc import Callable
from typing import Any

from .config import Settings
from .d1 import D1QueryError
from .maintenance_state import (
    RECONCILE_STATUS_META_PREFIX,
    RECOVERY_PENDING,
    SERVING_BLOCKED,
    SERVING_READY,
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
from .sma import TechnicalMetrics, compute_technical_metrics
from .splits import adjust_series, split_events_equal, split_events_from_rows, split_events_to_rows
from .state import STATUS_DONE, STATUS_ERROR, STATUS_PENDING, StateStore
from .universe import load_core_universe
from .weeks import completed_bars_filter, ny_date_of

logger = logging.getLogger("history_ingestor.bootstrap")


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"


def classify_symbol_work(store: StateStore, symbol: str) -> str:
    """Classify bootstrap work for fairness ordering.

    Returns one of: ``done``, ``pending`` (never-tried / both pending),
    ``partial`` (one endpoint done), ``error`` (transient endpoint error).
    """
    splits = store.symbol_status(symbol, "splits")
    weekly = store.symbol_status(symbol, "weekly")
    if splits == STATUS_DONE and weekly == STATUS_DONE:
        return "done"
    if splits == STATUS_ERROR or weekly == STATUS_ERROR:
        return "error"
    if splits == STATUS_DONE or weekly == STATUS_DONE:
        return "partial"
    return "pending"


def order_symbols_for_bootstrap(store: StateStore, symbols: list[str]) -> list[str]:
    """Fair queue: pending → partial → transient errors (stable within class)."""
    priority = {"pending": 0, "partial": 1, "error": 2, "done": 3}
    indexed = list(enumerate(symbols))
    indexed.sort(key=lambda item: (priority[classify_symbol_work(store, item[1])], item[0]))
    return [symbol for _, symbol in indexed]


def symbols_done_from_store(store: StateStore, symbols: list[str]) -> list[str]:
    """Symbols whose checkpoint shows both endpoints done (universe order)."""
    return [symbol for symbol in symbols if classify_symbol_work(store, symbol) == "done"]


def symbols_remaining_from_store(store: StateStore, symbols: list[str]) -> list[str]:
    """Symbols not fully done (pending / partial / error), universe order."""
    return [symbol for symbol in symbols if classify_symbol_work(store, symbol) != "done"]


class SplitsStoreError(RuntimeError):
    """The durable split_events store is missing or inconsistent for a symbol."""


def metrics_row(symbol: str, metrics: TechnicalMetrics) -> dict:
    """Project TechnicalMetrics into the technical_metrics D1 row shape."""
    return {
        "symbol": symbol,
        "anchor_week": metrics.anchor_week,
        "completed_weeks_available": metrics.completed_weeks_available,
        "sum_199": metrics.sum_199,
        "anchor_close": metrics.anchor_close,
        "closed_sma_200w": metrics.closed_sma_200w,
        "historical_data_as_of": _now_iso(),
        "calculated_at": _now_iso(),
        "status": metrics.status,
    }


class BootstrapRunner:
    """Orchestrates the resumable bootstrap; unit-testable with fakes."""

    def __init__(
        self,
        settings: Settings,
        d1: Any,
        provider: AlphaVantageClient,
        store: StateStore,
        now_fn: Callable[[], dt.datetime] | None = None,
    ) -> None:
        self._settings = settings
        self._d1 = d1
        self._provider = provider
        self._store = store
        self._now = now_fn or (lambda: dt.datetime.now(dt.UTC))
        self._splits_cache: dict[str, list] = {}

    # ------------------------------------------------------------------ core

    def run(
        self,
        universe: list[str] | None = None,
        dry_run: bool = False,
        limit: int | None = None,
        symbols_filter: list[str] | None = None,
    ) -> dict:
        """Run the bootstrap; returns a structured report (never secrets).

        ``limit`` caps the total provider requests; ``symbols_filter``
        restricts the universe to a subset.
        """
        symbols = universe if universe is not None else load_core_universe(self._settings.universe_path)
        if symbols_filter is not None:
            wanted = set(symbols_filter)
            symbols = [symbol for symbol in symbols if symbol in wanted]
        if not symbols:
            return self._report(symbols, "complete", 0, 0, 0, [])
        self._store.load()
        if dry_run:
            # Planning mode: never touches the provider or D1 writes.
            return self._report(symbols, "plan", 0, 0, 0, [])
        # Residual worker: even without an explicit --limit, bootstrap is hard
        # capped so a single problem symbol can never exhaust the day's quota
        # ahead of the maintenance (which has strict priority). Honest progress
        # still happens across days via the checkpoint.
        #
        # The cap is enforced against a PERSISTED bootstrap-only daily counter
        # (StateStore.bootstrap_daily_used), which resets only on a UTC day
        # change. Multiple processes/runs within the same UTC day SHARE the same
        # budget: each provider request is persisted to the counter immediately,
        # so a later process never re-consumes quota the current one already
        # spent. An explicit --limit is CLAMPED to the configured cap (min,
        # never bypasses it); lower explicit limits are respected.
        cap = self._settings.bootstrap_max_requests_per_day
        limit = cap if limit is None else min(limit, cap)
        self._combat_budget_limit = limit

        self._store.load()
        errors: list[str] = []
        weekly_fetched = 0
        splits_fetched = 0
        rows_written = 0

        # Fairness: never-tried/pending first, then partial, then old errors.
        work_order = order_symbols_for_bootstrap(self._store, symbols)

        def _budget_exhausted() -> bool:
            """True when bootstrap has consumed the daily cap.

            Reads the PERSISTED per-UTC-day counter (shared across processes),
            not a per-process counter. Checked IMMEDIATELY before every provider
            call (SPLITS, legacy split backfill, WEEKLY) so a single symbol can
            never exceed the cap by issuing SPLITS then WEEKLY in one iteration.
            """
            return self._store.bootstrap_daily_used() >= self._combat_budget_limit

        def _consume_budget() -> None:
            """Persist one provider request against bootstrap's UTC-day budget.

            Called immediately AFTER each successful provider call so a crash
            between calls cannot lose the counter and let a later process
            re-spend the same quota.
            """
            self._store.mark_bootstrap_daily_used()
            self._store.save()

        for symbol in work_order:
            if self._store.symbol_status(symbol, "splits") == STATUS_DONE \
                    and self._store.symbol_status(symbol, "weekly") == STATUS_DONE:
                continue

            # --- SPLITS (must precede WEEKLY so adjustment is correct) ---
            if self._store.symbol_status(symbol, "splits") != STATUS_DONE:
                if _budget_exhausted():
                    break
                try:
                    _, events, _ = self._provider.fetch_splits(symbol)
                    _consume_budget()
                    # Durable FIRST: only mark complete once the provider
                    # history is persisted — a crash before the write leaves
                    # the status pending so the next run re-does it (idempotent
                    # UPSERT, never duplicate history).
                    split_set_changed = self._persist_splits(symbol, events)
                    self._splits_cache[symbol] = events
                    self._store.mark_symbol(symbol, "splits", STATUS_DONE)
                    if split_set_changed and self._store.symbol_status(symbol, "weekly") == STATUS_DONE:
                        # A partially completed legacy bootstrap may have
                        # weekly data from a different split set. Re-fetch the
                        # full weekly series before publishing READY.
                        self._store.mark_symbol(symbol, "weekly", STATUS_PENDING)
                    splits_fetched += 1
                except QuotaExhaustedError:
                    self._store.save()
                    return self._report(symbols, "quota", weekly_fetched, splits_fetched,
                                        rows_written, errors)
                except ThrottleExhaustedError:
                    # Provider-wide throttle: stop immediately. Do NOT mark the
                    # symbol as a permanent/ticker error — leave pending so
                    # fairness can still prefer never-tried symbols next run.
                    self._store.save()
                    return self._report(symbols, "throttled", weekly_fetched, splits_fetched,
                                        rows_written, errors)
                except (ProviderError, AllKeysFailedError) as exc:
                    self._store.mark_symbol(symbol, "splits", STATUS_ERROR)
                    errors.append(f"{symbol} splits: {str(exc)[:160]}")
                    self._store.save()
                    continue

            # Splits already completed in a previous run: load them from the
            # DURABLE split_events store — completed endpoint work is never
            # requested from the provider again.
            if symbol not in self._splits_cache:
                try:
                    events, backfill = self._splits_from_store(symbol)
                    if backfill:
                        # Legacy symbol (completed before split_events existed):
                        # its history proves adjustment but the durable store is
                        # empty — one bounded refetch backfills the record.
                        if _budget_exhausted():
                            break
                        _, events, _ = self._provider.fetch_splits(symbol)
                        _consume_budget()
                        self._persist_splits(symbol, events)
                        splits_fetched += 1
                    self._splits_cache[symbol] = events
                except QuotaExhaustedError:
                    self._store.save()
                    return self._report(symbols, "quota", weekly_fetched, splits_fetched,
                                        rows_written, errors)
                except ThrottleExhaustedError:
                    self._store.save()
                    return self._report(symbols, "throttled", weekly_fetched, splits_fetched,
                                        rows_written, errors)
                except (ProviderError, AllKeysFailedError, SplitsStoreError) as exc:
                    if isinstance(exc, SplitsStoreError):
                        self._store.mark_symbol(symbol, "splits", STATUS_ERROR)
                    errors.append(f"{symbol} splits store: {str(exc)[:160]}")
                    self._store.save()
                    continue

            # --- WEEKLY ---
            if self._store.symbol_status(symbol, "weekly") != STATUS_DONE:
                if _budget_exhausted():
                    break
                try:
                    _, bars, _ = self._provider.fetch_weekly(symbol)
                    _consume_budget()
                    completed, _ = completed_bars_filter(
                        [bar.week_end_date for bar in bars], self._now()
                    )
                    completed_set = set(completed)
                    completed_bars = [bar for bar in bars if bar.week_end_date in completed_set]
                    if not completed_bars:
                        raise ProviderError("no completed weekly buckets (provider only has the in-progress week)")
                    as_of = ny_date_of(self._now())
                    adjusted = adjust_series(
                        completed_bars,
                        self._splits_cache[symbol],
                        as_of_date=f"{as_of.year:04d}-{as_of.month:02d}-{as_of.day:02d}",
                    )
                    weekly_fetched += 1
                    if not dry_run:
                        rows = [
                            (
                                bar.symbol, bar.week_end_date, bar.open, bar.high, bar.low,
                                bar.close, bar.volume, float(factor), adj_close, _now_iso(),
                            )
                            for bar, factor, adj_close in adjusted
                        ]
                        result = self._d1.upsert_weekly_rows(rows)
                        if result.failed:
                            raise ProviderError(f"D1 weekly write failed: {result.error}")
                        rows_written += len(rows)
                        metrics = compute_technical_metrics(symbol, [(bar, close) for bar, _f, close in adjusted])
                        write = self._d1.upsert_technical_metrics(metrics_row(symbol, metrics))
                        if write.failed:
                            raise ProviderError(f"technical_metrics write failed: {write.error}")
                        self._publish_split_verification(symbol)
                    self._store.mark_symbol(symbol, "weekly", STATUS_DONE)
                except QuotaExhaustedError:
                    self._store.save()
                    return self._report(symbols, "quota", weekly_fetched, splits_fetched,
                                        rows_written, errors)
                except ThrottleExhaustedError:
                    self._store.save()
                    return self._report(symbols, "throttled", weekly_fetched, splits_fetched,
                                        rows_written, errors)
                except (ProviderError, AllKeysFailedError) as exc:
                    self._store.mark_symbol(symbol, "weekly", STATUS_ERROR)
                    errors.append(f"{symbol} weekly: {str(exc)[:160]}")

            if not dry_run:
                self._store.save()

        # Recompute metrics for symbols completed in PREVIOUS runs whose
        # metrics row may be missing (crash between weekly write and metrics
        # write) — reads D1 and upserts idempotently.
        if not dry_run:
            done_now = symbols_done_from_store(self._store, symbols)
            self._reconcile_previous_metrics(symbols, done_now)

        remaining = symbols_remaining_from_store(self._store, symbols)
        status = "complete" if not remaining else "partial"
        return self._report(symbols, status, weekly_fetched, splits_fetched,
                            rows_written, errors)

    # -------------------------------------------------------------- helpers

    def _operation_now_iso(self) -> str:
        """Return the injected bootstrap clock as a UTC timestamp."""
        now = self._now()
        if now.tzinfo is None:
            now = now.replace(tzinfo=dt.UTC)
        return now.astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

    def _publish_serving_state(self, symbol: str, state: str, reason: str) -> None:
        """Persist the authoritative per-symbol serving state."""
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
        """Persist a retry request so a crash after BLOCKED self-heals."""
        try:
            existing = self._d1.read_app_meta(split_recovery_key(symbol))
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
            written = self._d1.write_app_meta(split_recovery_key(symbol), payload)
        except Exception as exc:
            raise ProviderError(f"split recovery request write failed for {symbol}: {exc}") from exc
        if not written:
            raise ProviderError(f"split recovery request write failed for {symbol}")

    def _publish_split_verification(self, symbol: str) -> None:
        """Publish READY only after adjusted history and metrics are durable."""
        self._publish_serving_state(symbol, SERVING_READY, "bootstrap")
        payload = {
            "version": 1,
            "symbol": symbol,
            "status": STATUS_DONE,
            "updated_at": self._operation_now_iso(),
        }
        try:
            written = self._d1.write_app_meta(f"{RECONCILE_STATUS_META_PREFIX}{symbol}", payload)
        except Exception as exc:
            raise ProviderError(f"split verification marker write failed: {exc}") from exc
        if not written:
            raise ProviderError("split verification marker write failed")
        try:
            self._d1.delete_app_meta(split_recovery_key(symbol))
        except Exception:
            # The recovery worker also removes a stale request after observing
            # READY.  Cleanup is best-effort and never weakens the serving
            # publication that has already been confirmed.
            logger.warning("bootstrap split recovery cleanup failed for %s", symbol)

    def _persist_splits(self, symbol: str, events: list[SplitEvent]) -> bool:
        """Persist split history durably (idempotent UPSERT) before completion.

        Raises ProviderError so the caller treats a failed durable write as an
        endpoint failure (the symbol stays pending and is retried next run).
        """
        try:
            stored_rows = self._d1.read_split_events(symbol)
            stored_events = split_events_from_rows(stored_rows)
        except D1QueryError as exc:
            raise ProviderError(f"D1 split_events read failed: {exc}") from exc
        changed = not split_events_equal(stored_events, events)
        if changed:
            try:
                existing_history = self._d1.read_weekly_rows(symbol)
            except D1QueryError as exc:
                raise ProviderError(f"D1 weekly read failed: {exc}") from exc
            # A fresh symbol has no serving data to hide. Any existing history
            # (including legacy factor=1 history) must be hidden before its
            # split set changes, because weekly/metrics may still be old-scale.
            if existing_history or stored_rows:
                self._publish_serving_state(symbol, SERVING_BLOCKED, "split_history_changed")
                self._ensure_recovery_request(symbol, "split_history_changed")

        write = self._d1.upsert_split_events(split_events_to_rows(symbol, events, self._operation_now_iso()))
        if write.failed:
            raise ProviderError(f"D1 split_events write failed: {write.error}")
        deleted = self._d1.delete_extra_split_events(
            symbol, [event.effective_date for event in events]
        )
        if deleted.failed:
            raise ProviderError(f"D1 split_events cleanup failed: {deleted.error}")
        return changed

    def _splits_from_store(self, symbol: str) -> tuple[list[SplitEvent], bool]:
        """Load split history from the durable split_events store.

        Returns (events, backfill_needed). ``backfill_needed`` is True ONLY
        for legacy symbols completed before split_events existed whose stored
        history proves adjustment (stored weekly factors != 1) while the
        durable store is empty — they need one bounded provider refetch to
        backfill the durable record before any new computation.

        An empty store is otherwise the provider's verified ``data: []``
        (zero splits) — the DURABLE record of "no splits for this symbol" is
        the empty table for that symbol, so this is NOT treated as missing.
        """
        try:
            stored = self._d1.read_split_events(symbol)
        except D1QueryError as exc:
            raise SplitsStoreError(f"read_split_events failed: {exc}") from exc
        if stored:
            return split_events_from_rows(stored), False
        # Empty durable store. Distinguish verified-zero from legacy-missing.
        try:
            weekly = self._d1.read_weekly_rows(symbol)
        except D1QueryError as exc:
            raise SplitsStoreError(f"read_weekly_rows failed: {exc}") from exc
        if any(abs(float(row.get("split_adjustment_factor") or 1.0) - 1.0) > 1e-12 for row in weekly):
            # History was adjusted with splits that were never persisted.
            return [], True
        return [], False

    def _reconcile_previous_metrics(self, symbols: list[str], done: list[str]) -> None:
        """Recompute metrics for earlier-completed symbols missing a row."""
        try:
            existing = {row["symbol"] for row in self._d1.read_technical_metrics()}
        except Exception:
            return
        for symbol in symbols:
            if symbol not in done or symbol in existing:
                continue
            try:
                rows = self._d1.read_weekly_rows(symbol)
            except Exception:
                continue
            if not rows:
                continue
            adjusted: list[tuple[WeeklyBar, float]] = []
            for row in rows:
                bar = WeeklyBar(
                    symbol=row["symbol"], week_end_date=row["week_end_date"],
                    open=float(row["raw_open"]), high=float(row["raw_high"]),
                    low=float(row["raw_low"]), close=float(row["raw_close"]),
                    volume=int(row["volume"]),
                )
                adjusted.append((bar, float(row["split_adjusted_close"])))
            metrics = compute_technical_metrics(symbol, adjusted)
            write = self._d1.upsert_technical_metrics(metrics_row(symbol, metrics))
            if write.failed:
                raise ProviderError(f"technical_metrics write failed for {symbol}: {write.error}")

    def _report(
        self,
        universe: list[str],
        status: str,
        weekly_fetched: int,
        splits_fetched: int,
        rows_written: int,
        errors: list[str],
    ) -> dict:
        # Counts always come from the durable checkpoint — never from which
        # symbols the current loop iteration managed to visit before an early
        # stop (throttle / quota / request limit).
        done = symbols_done_from_store(self._store, universe)
        remaining = symbols_remaining_from_store(self._store, universe)
        keys_used = [{"index": k.get("index"), "used": k.get("used", 0)} for k in self._store.state.keys]
        attempt_log = list(getattr(self._provider, "attempt_log", []) or [])
        return {
            "status": status,
            "universe_total": len(universe),
            "symbols_done": len(done),
            "symbols_remaining": len(remaining),
            "remaining_symbols": remaining,
            "requests_used_total": self._provider.requests_this_run,
            "weekly_fetched": weekly_fetched,
            "splits_fetched": splits_fetched,
            "rows_written": rows_written,
            "keys_used": keys_used,
            "quota_exhausted": status == "quota",
            "throttled": status == "throttled",
            "errors": errors,
            "attempt_log": attempt_log,
        }
