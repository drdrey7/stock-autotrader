"""Technical-metrics computation (the 200-week SMA historical basis).

This module computes the DETERMINISTIC historical basis that the Worker
combines with the live quote at read time (see §7/§9 of the PR spec):

Live SMA200W = (sum of the 199 completed split-adjusted closes immediately
preceding the quote's trading week + the current quote) / 200.

The basis only changes when weekly data changes (once per week), so it is
precomputed into ``technical_metrics`` instead of being re-derived from
~1000 rows per symbol on every public Screener request.

Semantics:
- ``anchor_week``  — the week_end_date of the latest COMPLETED stored week L.
- ``sum_199``      — sum of the 199 most recent completed closes ending at L.
- ``anchor_close`` — the split-adjusted close of week L (the one-row
                     correction term the Worker needs when the live quote's
                     own week has already been stored as completed).
- ``closed_sma_200w`` — plain 200-week SMA over completed closes ending at L
                     (chart-style reading; informational only).
- ``status``       — "ok" (>=200 completed weeks), "limited" (199..199),
                     "not_enough_history" (<199), "no_data" (0).
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Iterable
from dataclasses import dataclass

from .parser import WeeklyBar
from .weeks import week_label

# The live formula needs 199 completed weeks strictly BEFORE the quote's week.
MIN_BASIS_WEEKS = 199
# The closed (chart-style) SMA needs 200 completed weeks.
MIN_CLOSED_WEEKS = 200


@dataclass(frozen=True)
class TechnicalMetrics:
    symbol: str
    anchor_week: str | None            # YYYY-MM-DD of week L (latest completed)
    anchor_week_label: str | None      # ISO week label of L, e.g. "2026-W33"
    completed_weeks_available: int
    sum_199: float | None              # None when < 199 completed weeks
    anchor_close: float | None         # split-adjusted close of week L
    closed_sma_200w: float | None      # None when < 200 completed weeks
    status: str                        # ok | limited | not_enough_history | no_data


def _to_float(value: float | None) -> float | None:
    return value


def compute_technical_metrics(
    symbol: str,
    adjusted: Iterable[tuple[WeeklyBar, float]],  # (bar, split_adjusted_close), ascending
) -> TechnicalMetrics:
    """Compute the basis from split-adjusted closes (ascending by week).

    ``adjusted`` items only need ``(bar, close)``; the bar's week_end_date is
    read for the anchor. Empty input yields ``no_data``.
    """
    rows = list(adjusted)
    if not rows:
        return TechnicalMetrics(
            symbol=symbol,
            anchor_week=None,
            anchor_week_label=None,
            completed_weeks_available=0,
            sum_199=None,
            anchor_close=None,
            closed_sma_200w=None,
            status="no_data",
        )

    closes = [close for _, close in rows]
    count = len(closes)
    anchor_date: str | None = None
    for bar, _ in rows:
        anchor_date = bar.week_end_date  # last row wins (input is ascending)
    anchor_label = week_label(dt.date.fromisoformat(anchor_date)) if anchor_date else None

    sum_199: float | None = None
    anchor_close: float | None = None
    closed_sma: float | None = None

    if count >= MIN_BASIS_WEEKS:
        window = closes[-MIN_BASIS_WEEKS:]
        sum_199 = _to_float(sum(window))
        anchor_close = _to_float(closes[-1])
    if count >= MIN_CLOSED_WEEKS:
        closed_sma = _to_float(sum(closes[-MIN_CLOSED_WEEKS:]) / MIN_CLOSED_WEEKS)

    if count >= MIN_CLOSED_WEEKS:
        status = "ok"
    elif count >= MIN_BASIS_WEEKS:
        status = "limited"
    else:
        status = "not_enough_history"

    return TechnicalMetrics(
        symbol=symbol,
        anchor_week=anchor_date,
        anchor_week_label=anchor_label,
        completed_weeks_available=count,
        sum_199=sum_199,
        anchor_close=anchor_close,
        closed_sma_200w=closed_sma,
        status=status,
    )
