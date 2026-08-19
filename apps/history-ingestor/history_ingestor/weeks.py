"""America/New_York calendar + ISO-week helpers.

The live SMA200W rule anchors the 199-week historical basis to the TRADING
WEEK of the latest quote, not to wall-clock "today" — so every timestamp must
be mapped to the NY week it belongs to. ISO weeks (Monday-based) are the
stable week identity: Alpha Vantage's weekly bucket dates are the week's
last trading day (a Thursday when Friday is a holiday, e.g. Good Friday
2025-04-17), and an ISO-week comparison keeps the anchor logic correct for
holiday weeks, early closes, weekends and year boundaries — no Friday-based
date arithmetic that would break on holiday weeks.
"""

from __future__ import annotations

import datetime as dt
from zoneinfo import ZoneInfo

NEW_YORK = ZoneInfo("America/New_York")

# Alpha Vantage WEEKLY bucket date keys are YYYY-MM-DD (week's last trading day).
DATE_KEY_RE = r"^\d{4}-\d{2}-\d{2}$"


def ny_date_of(instant: dt.datetime) -> dt.date:
    """NY calendar date for a UTC instant (DST-safe via zoneinfo)."""
    return instant.astimezone(NEW_YORK).date()


def iso_week_of(day: dt.date) -> tuple[int, int]:
    """(ISO year, ISO week) of a calendar date."""
    iso = day.isocalendar()
    return (iso[0], iso[1])


def iso_week_of_instant(instant: dt.datetime) -> tuple[int, int]:
    """(ISO year, ISO week) of the NY calendar date of a UTC instant."""
    return iso_week_of(ny_date_of(instant))


def week_label(day: dt.date) -> str:
    """Human/weekly-bucket identity, e.g. ``2026-W33``."""
    year, week = iso_week_of(day)
    return f"{year:04d}-W{week:02d}"


def week_label_of_date_key(date_key: str) -> str:
    """ISO week label of an Alpha Vantage date key (``YYYY-MM-DD``)."""
    return week_label(dt.date.fromisoformat(date_key))


def date_from_iso(date_key: str) -> dt.date:
    """Parse a ``YYYY-MM-DD`` key into a date (split/helper shared with the
    maintenance cycle)."""
    return dt.date.fromisoformat(date_key)


def is_in_progress_week(date_key: str, now: dt.datetime) -> bool:
    """Whether a weekly bucket belongs to the NY week that is still running
    at ``now`` (UTC). Buckets in the in-progress week are never stored as
    completed history — this keeps the historical basis deterministic no
    matter when bootstrap/maintenance runs, and guarantees the live formula
    never double-counts the quote's own week.
    """
    try:
        bucket_week = iso_week_of(dt.date.fromisoformat(date_key))
    except ValueError:
        return False  # malformed keys are rejected by the parser before this
    return bucket_week == iso_week_of_instant(now)


def completed_bars_filter(
    date_keys: list[str],
    now: dt.datetime,
) -> tuple[list[str], list[str]]:
    """Split bucket date keys into (completed, in_progress) by ``now``.

    Completed = strictly older NY week than the current one. The returned
    lists preserve input order.
    """
    completed: list[str] = []
    in_progress: list[str] = []
    for key in date_keys:
        if is_in_progress_week(key, now):
            in_progress.append(key)
        else:
            completed.append(key)
    return completed, in_progress


def target_completed_week(now: dt.datetime) -> str:
    """ISO week label of the last COMPLETED trading week as of ``now`` (UTC).

    The completed trading week is the one containing the most recent Friday
    (the market's weekly close) at or before today's NY date:
      Sunday  xxW34 (Fri xx-21)         -> "2026-W34"
      Monday  xxW35 (Fri xx-21 was W34) -> "2026-W34"
      next Sunday (Fri xx-28, W35)      -> "2026-W35"

    This is the maintenance cycle identity: Sunday STARTS a cycle for the week
    that closed on Friday (and reconciles its splits), and Monday's refresh
    stores exactly that same week's completed data.
    """
    ny = ny_date_of(now)
    days_since_friday = (ny.weekday() - 4) % 7  # Monday=0 .. Friday=4, Sat=5, Sun=6
    last_friday = ny - dt.timedelta(days=days_since_friday)
    return week_label(last_friday)


def is_monday_in_ny(now: dt.datetime) -> bool:
    """Whether ``now`` falls on a Monday in America/New_York.

    A weekly bucket only becomes storable (no longer the in-progress NY week)
    once Monday begins in NY, so the maintenance WEEKLY phase fetches only on
    NY Mondays. Sunday runs stay in the SPLITS phase.
    """
    return ny_date_of(now).weekday() == 0
