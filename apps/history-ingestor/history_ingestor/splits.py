"""Split-only (NOT dividend) deterministic price adjustment.

Raw Alpha Vantage TIME_SERIES_WEEKLY values are as-traded: a stock that did a
4:1 split shows historical prices ~4x higher than today's scale. The Screener
SMA deliberately uses SPLIT-ADJUSTED closes only — a normal stock chart
adjustment — and ignores dividends.

Rule: for each historical weekly close, divide by the product of the ratios
of every split whose effective date is AFTER that observation's week end.

    raw_close(week t) / F(t) = split_adjusted_close(week t)
    F(t) = product(ratio(s) for s in splits if s.effective_date > week_end(t))

A 4:1 split:  raw 400 -> adjusted 100.  A 1:2 reverse split: raw 100 -> 200.

A split whose effective date falls INSIDE a week (or on its last trading
day) is already reflected in that week's as-traded close (the close printed
post-split), so only weeks ending BEFORE the split get divided.

Ratios are kept as exact :class:`fractions.Fraction` values throughout;
floating point appears only at the final raw/float conversion.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Iterable
from fractions import Fraction

from .parser import SplitEvent, WeeklyBar


def cumulative_split_factor(
    week_end_date: str,
    splits: list[SplitEvent],
) -> Fraction:
    """F(t) — the product of all split ratios effective strictly AFTER ``week_end_date``.

    Identity F == 1 when no later split exists (weeks after the last split).
    """
    week_end = dt.date.fromisoformat(week_end_date)
    factor = Fraction(1, 1)
    for split in splits:
        if dt.date.fromisoformat(split.effective_date) > week_end:
            factor *= split.ratio
    return factor


def adjust_series(
    bars: Iterable[WeeklyBar],
    splits: list[SplitEvent],
) -> list[tuple[WeeklyBar, Fraction, float]]:
    """Compute ``(bar, split_adjustment_factor, split_adjusted_close)`` per bar.

    Factors are exact Fractions; the adjusted close is the final float
    conversion (``raw_close / factor``). Deterministic and auditable: the
    persisted row keeps both the raw close and the factor, so any client can
    recompute the adjusted value.
    """
    ordered = sorted(splits, key=lambda event: event.effective_date)
    results: list[tuple[WeeklyBar, Fraction, float]] = []
    for bar in bars:
        factor = cumulative_split_factor(bar.week_end_date, ordered)
        adjusted = bar.close / float(factor)
        results.append((bar, factor, adjusted))
    return results


def split_factor_float(factor: Fraction) -> float:
    """Float projection of an exact factor for persistence (>= 0 check done by SQL)."""
    return float(factor)
