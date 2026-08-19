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
from .parser import SplitEvent, WeeklyBar
from .provider import (
    AllKeysFailedError,
    AlphaVantageClient,
    ProviderError,
    QuotaExhaustedError,
)
from .sma import TechnicalMetrics, compute_technical_metrics
from .splits import adjust_series, split_events_from_rows, split_events_to_rows
from .state import STATUS_DONE, STATUS_ERROR, StateStore
from .universe import load_core_universe
from .weeks import completed_bars_filter

logger = logging.getLogger("history_ingestor.bootstrap")


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"


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
            return self._report(symbols, "complete", 0, 0, 0, [], [], [])
        self._store.load()
        if dry_run:
            # Planning mode: never touches the provider or D1 writes.
            pending = self._store.pending_symbols(symbols)
            return self._report(symbols, "plan", 0, 0, 0,
                                [s for s in symbols if s in pending], [], [s for s in symbols if s not in pending])

        self._store.load()
        done: list[str] = []
        remaining: list[str] = []
        errors: list[str] = []
        weekly_fetched = 0
        splits_fetched = 0
        rows_written = 0

        for symbol in symbols:
            if self._store.symbol_status(symbol, "splits") == STATUS_DONE \
                    and self._store.symbol_status(symbol, "weekly") == STATUS_DONE:
                done.append(symbol)
                continue
            if limit is not None and self._provider.requests_this_run >= limit:
                remaining = [s for s in symbols if s not in done]
                break

            # --- SPLITS (must precede WEEKLY so adjustment is correct) ---
            if self._store.symbol_status(symbol, "splits") != STATUS_DONE:
                try:
                    _, events, _ = self._provider.fetch_splits(symbol)
                    # Durable FIRST: only mark complete once the provider
                    # history is persisted — a crash before the write leaves
                    # the status pending so the next run re-does it (idempotent
                    # UPSERT, never duplicate history).
                    self._persist_splits(symbol, events)
                    self._splits_cache[symbol] = events
                    self._store.mark_symbol(symbol, "splits", STATUS_DONE)
                    splits_fetched += 1
                except QuotaExhaustedError:
                    self._store.save()
                    remaining = [s for s in symbols if s not in done]
                    return self._report(symbols, "quota", weekly_fetched, splits_fetched,
                                        rows_written, remaining, errors, done)
                except (ProviderError, AllKeysFailedError) as exc:
                    self._store.mark_symbol(symbol, "splits", STATUS_ERROR)
                    errors.append(f"{symbol} splits: {str(exc)[:160]}")
                    remaining.append(symbol)
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
                        _, events, _ = self._provider.fetch_splits(symbol)
                        self._persist_splits(symbol, events)
                        splits_fetched += 1
                    self._splits_cache[symbol] = events
                except QuotaExhaustedError:
                    self._store.save()
                    remaining = [s for s in symbols if s not in done]
                    return self._report(symbols, "quota", weekly_fetched, splits_fetched,
                                        rows_written, remaining, errors, done)
                except (ProviderError, AllKeysFailedError, SplitsStoreError) as exc:
                    if isinstance(exc, SplitsStoreError):
                        self._store.mark_symbol(symbol, "splits", STATUS_ERROR)
                    errors.append(f"{symbol} splits store: {str(exc)[:160]}")
                    remaining.append(symbol)
                    self._store.save()
                    continue

            # --- WEEKLY ---
            if self._store.symbol_status(symbol, "weekly") != STATUS_DONE:
                try:
                    _, bars, _ = self._provider.fetch_weekly(symbol)
                    completed, _ = completed_bars_filter(
                        [bar.week_end_date for bar in bars], self._now()
                    )
                    completed_set = set(completed)
                    completed_bars = [bar for bar in bars if bar.week_end_date in completed_set]
                    if not completed_bars:
                        raise ProviderError("no completed weekly buckets (provider only has the in-progress week)")
                    adjusted = adjust_series(completed_bars, self._splits_cache[symbol])
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
                    self._store.mark_symbol(symbol, "weekly", STATUS_DONE)
                    done.append(symbol)
                except QuotaExhaustedError:
                    self._store.save()
                    remaining = [s for s in symbols if s not in done]
                    return self._report(symbols, "quota", weekly_fetched, splits_fetched,
                                        rows_written, remaining, errors, done)
                except (ProviderError, AllKeysFailedError) as exc:
                    self._store.mark_symbol(symbol, "weekly", STATUS_ERROR)
                    errors.append(f"{symbol} weekly: {str(exc)[:160]}")
                    remaining.append(symbol)
            else:
                done.append(symbol)

            if not dry_run:
                self._store.save()

        # Recompute metrics for symbols completed in PREVIOUS runs whose
        # metrics row may be missing (crash between weekly write and metrics
        # write) — reads D1 and upserts idempotently.
        if not dry_run:
            self._reconcile_previous_metrics(symbols, done)

        status = "complete" if not remaining else "partial"
        return self._report(symbols, status, weekly_fetched, splits_fetched,
                            rows_written, remaining, errors, done)

    # -------------------------------------------------------------- helpers

    def _persist_splits(self, symbol: str, events: list[SplitEvent]) -> None:
        """Persist split history durably (idempotent UPSERT) before completion.

        Raises ProviderError so the caller treats a failed durable write as an
        endpoint failure (the symbol stays pending and is retried next run).
        """
        write = self._d1.upsert_split_events(split_events_to_rows(symbol, events, _now_iso()))
        if write.failed:
            raise ProviderError(f"D1 split_events write failed: {write.error}")

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
                logger.warning("reconcile_previous_metrics: %s write failed: %s", symbol, write.error)

    def _report(
        self,
        universe: list[str],
        status: str,
        weekly_fetched: int,
        splits_fetched: int,
        rows_written: int,
        remaining: list[str],
        errors: list[str],
        done: list[str],
    ) -> dict:
        keys_used = [{"index": k.get("index"), "used": k.get("used", 0)} for k in self._store.state.keys]
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
            "errors": errors,
        }
