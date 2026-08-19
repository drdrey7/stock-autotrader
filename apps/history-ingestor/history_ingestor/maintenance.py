"""Weekly maintenance: refresh, split reconciliation, metrics, coverage.

Recurring (systemd timer, documented in deploy/) process that keeps the
historical layer honest:

1. refetch WEEKLY + SPLITS per symbol (one full-series request each —
   idempotent UPSERT is fine at this scale; never a partial refetch);
2. reconcile split history: recompute the cumulative factors from the FRESH
   split list and rewrite every weekly row whose factor/adjusted close
   changed — a new/changed split rewrites the whole affected history so no
   mixed adjustment regime can survive;
3. recompute technical_metrics per symbol;
4. verify coverage (rows, oldest/newest week, week-sequence gaps, factor
   sanity) and report anomalies.

Provider quotas are respected exactly like bootstrap: paced per key, per-key
accounting, hard stop when every key is exhausted, checkpointed resume —
the run can spread across days and finish later.
"""

from __future__ import annotations

import datetime as dt
import logging
import time
from collections.abc import Callable
from typing import Any

from .config import Settings
from .provider import (
    AllKeysFailedError,
    AlphaVantageClient,
    ProviderError,
    QuotaExhaustedError,
)
from .sma import compute_technical_metrics
from .splits import adjust_series
from .state import StateStore
from .universe import load_core_universe
from .weeks import completed_bars_filter, week_label_of_date_key

logger = logging.getLogger("history_ingestor.maintenance")


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"


class MaintenanceRunner:
    """Recurring maintenance; unit-testable with fakes."""

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

    def run(
        self,
        universe: list[str] | None = None,
        dry_run: bool = False,
        limit: int | None = None,
        symbols_filter: list[str] | None = None,
    ) -> dict:
        symbols = universe if universe is not None else load_core_universe(self._settings.universe_path)
        if symbols_filter is not None:
            wanted = set(symbols_filter)
            symbols = [symbol for symbol in symbols if symbol in wanted]
        self._store.load()
        if dry_run:
            # Planning mode: never touches the provider or D1 writes.
            return {
                "status": "plan",
                "symbols": {symbol: {"weekly": "pending", "splits": "pending",
                                     "rows_updated": 0, "metrics_updated": False,
                                     "quota": False, "anomalies": [], "completed_weeks": 0}
                            for symbol in symbols},
                "requests_used_total": 0,
                "keys_used": [],
                "quota_exhausted": False,
                "anomalies": [],
                "rows_updated": 0,
                "metrics_updated": 0,
            }

        report: dict = {
            "symbols": {},
            "requests_used_total": 0,
            "keys_used": [],
            "quota_exhausted": False,
            "anomalies": [],
            "rows_updated": 0,
            "metrics_updated": 0,
        }
        updated_rows = 0
        metrics_updated = 0

        for symbol in symbols:
            if limit is not None and self._provider.requests_this_run >= limit:
                report["quota_exhausted"] = False
                report["anomalies"].append("run stopped by request limit before finishing all symbols")
                break
            symbol_report = self._maintain_symbol(symbol, dry_run)
            report["symbols"][symbol] = symbol_report
            updated_rows += symbol_report["rows_updated"]
            metrics_updated += 1 if symbol_report["metrics_updated"] else 0
            report["anomalies"].extend(symbol_report["anomalies"])
            if symbol_report["quota"]:
                report["quota_exhausted"] = True
                break
            if not dry_run:
                self._store.save()

        report["requests_used_total"] = self._provider.requests_this_run
        report["keys_used"] = [{"index": k.get("index"), "used": k.get("used", 0)} for k in self._store.state.keys]
        report["rows_updated"] = updated_rows
        report["metrics_updated"] = metrics_updated
        if not dry_run:
            self._d1.write_app_meta("historyMaintenanceReport", report)
        return report

    # ------------------------------------------------------------------ per symbol

    def _maintain_symbol(self, symbol: str, dry_run: bool) -> dict:
        result: dict = {
            "weekly": "pending", "splits": "pending", "rows_updated": 0,
            "metrics_updated": False, "quota": False, "anomalies": [],
            "completed_weeks": 0,
        }
        try:
            _, events, _ = self._provider.fetch_splits(symbol)
            result["splits"] = "ok"
            _, bars, _ = self._provider.fetch_weekly(symbol)
            result["weekly"] = "ok"
            completed, in_progress = completed_bars_filter(
                [bar.week_end_date for bar in bars], self._now()
            )
            if in_progress:
                result["anomalies"].append(f"{symbol}: excluded in-progress week {in_progress[0]}")
            if not completed:
                result["anomalies"].append(f"{symbol}: no completed weekly buckets")
                return result
            completed_set = set(completed)
            completed_bars = [bar for bar in bars if bar.week_end_date in completed_set]
            result["completed_weeks"] = len(completed_bars)

            adjusted = adjust_series(completed_bars, events)
            if dry_run:
                result["rows_updated"] = len(adjusted)
                return result

            # Reconcile: rewrite only rows whose factor/adjusted close changed.
            stored = self._stored_rows(symbol)
            changed = []
            for bar, factor, adj_close in adjusted:
                old = stored.get(bar.week_end_date)
                if old is None or abs(old[0] - float(factor)) > 1e-12 or abs(old[1] - adj_close) > 1e-9:
                    changed.append((
                        bar.symbol, bar.week_end_date, bar.open, bar.high, bar.low,
                        bar.close, bar.volume, float(factor), adj_close, _now_iso(),
                    ))
            if changed:
                write = self._d1.upsert_weekly_rows(changed)
                if write.failed:
                    result["anomalies"].append(f"{symbol}: D1 write failed: {write.error}")
                    return result
                result["rows_updated"] = len(changed)
                if len(changed) > 1:
                    result["anomalies"].append(f"{symbol}: split history change rewrote {len(changed)} rows")

            metrics = compute_technical_metrics(symbol, [(bar, close) for bar, _f, close in adjusted])
            self._d1.upsert_technical_metrics({
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
            result["metrics_updated"] = True

            # Coverage verification.
            if metrics.completed_weeks_available < 199:
                result["anomalies"].append(
                    f"{symbol}: only {metrics.completed_weeks_available} completed weeks (< 199 -> NotEnoughHistory)"
                )
            gaps = self._week_gaps(completed)
            if gaps:
                result["anomalies"].append(f"{symbol}: week gaps: {', '.join(gaps[:5])}{'…' if len(gaps) > 5 else ''}")
            return result
        except QuotaExhaustedError:
            result["quota"] = True
            result["anomalies"].append("provider daily quota exhausted — run will resume from checkpoint")
            return result
        except (ProviderError, AllKeysFailedError) as exc:
            result["anomalies"].append(f"{symbol}: {str(exc)[:200]}")
            result["weekly"] = "error"
            return result

    # -------------------------------------------------------------- helpers

    def _stored_rows(self, symbol: str) -> dict[str, tuple[float, float]]:
        """Map week_end_date -> (split_adjustment_factor, split_adjusted_close)."""
        try:
            rows = self._d1.read_weekly_rows(symbol)
        except Exception:
            return {}
        return {
            row["week_end_date"]: (float(row["split_adjustment_factor"]), float(row["split_adjusted_close"]))
            for row in rows
        }

    def _week_gaps(self, completed: list[str]) -> list[str]:
        """ISO-week sequence gaps in ascending bucket dates (<= 52 reported).

        Week distance is computed on ISO-week Monday dates, so year-boundary
        transitions (2021-W52 -> 2022-W01) are consecutive, never gaps.
        """
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
