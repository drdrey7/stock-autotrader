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


def split_events_to_rows(
    symbol: str,
    events: Iterable[SplitEvent],
    fetched_at: str,
) -> list[tuple[str, str, float, str]]:
    """Project SplitEvents into durable ``split_events`` rows.

    Row shape: ``(symbol, effective_date, split_factor, source_fetched_at)``.
    The factor is stored as its float projection (matching
    ``weekly_prices.split_adjustment_factor``); exactness is recovered on read
    via :func:`split_events_from_rows`.
    """
    return [
        (symbol, event.effective_date, split_factor_float(event.ratio), fetched_at)
        for event in events
    ]


def split_events_from_rows(rows: Iterable[dict]) -> list[SplitEvent]:
    """Rebuild exact SplitEvents from stored ``split_events`` rows.

    Stored factors are REAL (float projection of the original decimal
    string); recovering the exact :class:`fractions.Fraction` is
    deterministic via ``limit_denominator`` (mirrors the parser's own
    recovery of ``\"10.0000\"`` etc.).
    """
    events: list[SplitEvent] = []
    for row in rows:
        try:
            ratio = Fraction(row["split_factor"]).limit_denominator(1_000_000)
        except (TypeError, ValueError, ZeroDivisionError, KeyError):
            continue
        if ratio <= 0:
            continue
        events.append(SplitEvent(symbol=str(row["symbol"]), effective_date=str(row["effective_date"]), ratio=ratio))
    events.sort(key=lambda event: event.effective_date)
    return events


def split_events_equal(
    events_a: Iterable[SplitEvent],
    events_b: Iterable[SplitEvent],
    epsilon: float = 1e-9,
) -> bool:
    """Whether two split histories match by (effective_date, ratio).

    Used by the weekly SPLITS pass to decide whether a reconciliation (and
    the associated historical rewrite) is needed. Ratios are compared on the
    float projection with a tiny epsilon — provider factors are binary-exact
    decimals in practice (``10.0``, ``1.5``, ``0.5``), so this never
    false-positives a change.
    """
    ordered_a = sorted(events_a, key=lambda event: event.effective_date)
    ordered_b = sorted(events_b, key=lambda event: event.effective_date)
    if len(ordered_a) != len(ordered_b):
        return False
    for left, right in zip(ordered_a, ordered_b):
        if left.effective_date != right.effective_date:
            return False
        if abs(split_factor_float(left.ratio) - split_factor_float(right.ratio)) > epsilon:
            return False
    return True
