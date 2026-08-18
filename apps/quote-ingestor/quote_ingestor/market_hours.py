"""US equity regular-session window in America/New_York (DST-safe).

NYSE and Nasdaq share the same regular session for this purpose: 09:30–16:00
Eastern Time, weekdays, excluding US market holidays. Outside this window the
ingestor keeps the WebSocket connected (robust, per the POC) but does not
flush to D1 — no pointless D1 writes overnight/weekends/holidays and no CPU
or log spam.

The holiday algorithm mirrors ``apps/web/worker/market-context.ts`` so both
sides of the system agree on the same holiday set.
"""

from __future__ import annotations

import datetime as dt
import functools
from zoneinfo import ZoneInfo

NEW_YORK_TZ = ZoneInfo("America/New_York")

# Regular equity session in America/New_York (opening/closing minutes of day).
DEFAULT_OPEN_MINUTES = 9 * 60 + 30  # 09:30
DEFAULT_CLOSE_MINUTES = 16 * 60  # 16:00


def _day_key(year: int, month: int, day: int) -> str:
    return f"{year}-{month:02d}-{day:02d}"


def _observed_fixed(year: int, month: int, day: int) -> str:
    date = dt.date(year, month, day)
    weekday = date.weekday()  # Mon=0 .. Sun=6
    if weekday == 5:  # Saturday -> Friday
        date -= dt.timedelta(days=1)
    elif weekday == 6:  # Sunday -> Monday
        date += dt.timedelta(days=1)
    return _day_key(date.year, date.month, date.day)


def _nth_weekday(year: int, month: int, weekday_mon_is_zero: int, ordinal: int) -> str:
    """weekday: 0=Mon..6=Sun; ordinal: 1st/2nd/3rd/4th occurrence."""
    first = dt.date(year, month, 1)
    offset = (weekday_mon_is_zero - first.weekday()) % 7
    date = first + dt.timedelta(days=offset + (ordinal - 1) * 7)
    return _day_key(date.year, date.month, date.day)


def _last_weekday(year: int, month: int, weekday_mon_is_zero: int) -> str:
    next_month_first = dt.date(year + (month == 12), (month % 12) + 1, 1)
    last = next_month_first - dt.timedelta(days=1)
    date = last - dt.timedelta(days=(last.weekday() - weekday_mon_is_zero) % 7)
    return _day_key(date.year, date.month, date.day)


def _good_friday(year: int) -> str:
    # Gregorian computus (Meeus/Jones/Butcher) — returns Easter Sunday.
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l_ = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l_) // 451
    month = (h + l_ - 7 * m + 114) // 31
    day = ((h + l_ - 7 * m + 114) % 31) + 1
    friday = dt.date(year, month, day) - dt.timedelta(days=2)
    return _day_key(friday.year, friday.month, friday.day)


@functools.lru_cache(maxsize=8)
def _holidays_for_year(year: int) -> frozenset[str]:
    return frozenset({
        _observed_fixed(year, 1, 1),  # New Year's Day
        _observed_fixed(year + 1, 1, 1),  # New Year's Day observed on prior Dec 31
        _nth_weekday(year, 1, 0, 3),  # Martin Luther King Jr. Day
        _nth_weekday(year, 2, 0, 3),  # Presidents' Day
        _good_friday(year),
        _last_weekday(year, 5, 0),  # Memorial Day
        _observed_fixed(year, 6, 19),  # Juneteenth
        _observed_fixed(year, 7, 4),  # Independence Day
        _nth_weekday(year, 9, 0, 1),  # Labor Day
        _nth_weekday(year, 11, 3, 4),  # Thanksgiving
        _observed_fixed(year, 12, 25),  # Christmas Day
    })


def is_us_market_holiday(instant: dt.datetime) -> bool:
    local = instant.astimezone(NEW_YORK_TZ)
    return _day_key(local.year, local.month, local.day) in _holidays_for_year(local.year)


def in_flush_window(instant: dt.datetime, open_minutes: int = DEFAULT_OPEN_MINUTES, close_minutes: int = DEFAULT_CLOSE_MINUTES) -> bool:
    """True while D1 flushes are allowed: regular session, weekday, non-holiday.

    ``instant`` may be naive UTC or tz-aware; conversion is done via
    America/New_York so DST transitions never break the window.
    """
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=dt.UTC)
    local = instant.astimezone(NEW_YORK_TZ)
    if local.weekday() >= 5:
        return False
    if is_us_market_holiday(local):
        return False
    minutes = local.hour * 60 + local.minute
    return open_minutes <= minutes < close_minutes


def ny_iso(instant: dt.datetime) -> str:
    """Human-readable New York local time for logs (never used for scheduling)."""
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=dt.UTC)
    return instant.astimezone(NEW_YORK_TZ).isoformat(timespec="seconds")
