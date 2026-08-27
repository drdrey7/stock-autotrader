"""US equity regular-session calendar in America/New_York (DST-safe).

NYSE and Nasdaq share the same regular session for this purpose: 09:30–16:00
Eastern Time, weekdays, excluding US market holidays; early-close days
(Black Friday, Christmas Eve) close at 13:00 ET. A short post-close GRACE
period lets late trades that still belong to the regular session (closing
auction, the last few seconds) land in a final flush instead of dropping the
final snapshot.

Outside the session the ingestor keeps the WebSocket connected (robust, per
the POC) and writes only its 1/minute heartbeat health record — no point
writing quote rows overnight/weekends/holidays and no CPU or log spam.

The holiday algorithm mirrors ``apps/web/worker/market-context.ts`` so both
sides of the system agree on the same holiday set.
"""

from __future__ import annotations

import datetime as dt
import functools
from typing import Literal
from zoneinfo import ZoneInfo

NEW_YORK_TZ = ZoneInfo("America/New_York")

# Regular equity session limits in America/New_York (minutes of day).
DEFAULT_OPEN_MINUTES = 9 * 60 + 30  # 09:30
DEFAULT_CLOSE_MINUTES = 16 * 60  # 16:00
# Early-close afternoons (NYSE/Nasdaq close at 13:00 ET).
EARLY_CLOSE_MINUTES = 13 * 60
# Trades that belong to the regular session are still accepted (and flushed)
# for this long after the session close, so the closing auction and the very
# last regular ticks are not lost. After the grace the write window is closed.
CLOSE_GRACE_MINUTES = 5

MarketPhase = Literal["pre_open", "open", "grace", "closed"]


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


def _thanksgiving_date(year: int) -> dt.date:
    """Fourth Thursday of November."""
    first = dt.date(year, 11, 1)
    offset = (3 - first.weekday()) % 7  # Thursday
    return first + dt.timedelta(days=offset + 21)


def _early_close_minutes_for(day: dt.date) -> int | None:
    """Sessions that close at 13:00 ET instead of 16:00.

    Mirrors ``apps/web/worker/market-context.ts:isEarlyClose`` so both sides
    agree: Black Friday, Christmas Eve (weekday), and July 3 when Independence
    Day falls on a weekday.
    """
    if day == _thanksgiving_date(day.year) + dt.timedelta(days=1):
        return EARLY_CLOSE_MINUTES
    if day.month == 12 and day.day == 24 and day.weekday() < 5:
        return EARLY_CLOSE_MINUTES
    independence_weekday = dt.date(day.year, 7, 4).weekday()
    if day.month == 7 and day.day == 3 and independence_weekday < 5:
        return EARLY_CLOSE_MINUTES
    return None


def session_close_minutes(day: dt.date | dt.datetime) -> int:
    """Session close (minutes of day, America/New_York) for the NY date."""
    date = day.date() if isinstance(day, dt.datetime) else day
    early = _early_close_minutes_for(date)
    return early if early is not None else DEFAULT_CLOSE_MINUTES


def session_close_utc(day: dt.date) -> dt.datetime:
    """Exact UTC close for a known NYSE/Nasdaq trading date."""
    key = _day_key(day.year, day.month, day.day)
    if day.weekday() >= 5 or key in _holidays_for_year(day.year):
        raise ValueError("not_a_trading_session")
    close_minutes = session_close_minutes(day)
    close_local = dt.datetime(
        day.year,
        day.month,
        day.day,
        close_minutes // 60,
        close_minutes % 60,
        tzinfo=NEW_YORK_TZ,
    )
    return close_local.astimezone(dt.UTC)


def _as_utc(instant: dt.datetime) -> dt.datetime:
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=dt.UTC)
    return instant.astimezone(dt.UTC)


def _session_bounds_utc(now_utc: dt.datetime) -> tuple[dt.datetime, dt.datetime] | None:
    """(open_utc, close_utc) for the NY trading day of ``now_utc``, or None."""
    local = now_utc.astimezone(NEW_YORK_TZ)
    if local.weekday() >= 5:
        return None
    if is_us_market_holiday(local):
        return None
    date = local.date()
    close_utc = session_close_utc(date)
    open_local = dt.datetime(date.year, date.month, date.day, 9, 30, tzinfo=NEW_YORK_TZ)
    return open_local.astimezone(dt.UTC), close_utc


def is_us_market_holiday(instant: dt.datetime) -> bool:
    local = _as_utc(instant).astimezone(NEW_YORK_TZ)
    return _day_key(local.year, local.month, local.day) in _holidays_for_year(local.year)


def trading_session_date(instant: dt.datetime) -> dt.date | None:
    """Return the New York trading date for ``instant``, or None on closed days."""
    local = _as_utc(instant).astimezone(NEW_YORK_TZ)
    day = local.date()
    if day.weekday() >= 5:
        return None
    if _day_key(day.year, day.month, day.day) in _holidays_for_year(day.year):
        return None
    return day


def previous_trading_session_date(day: dt.date | dt.datetime) -> dt.date:
    """Immediately preceding NYSE/Nasdaq trading date, skipping holidays/weekends."""
    current = day.date() if isinstance(day, dt.datetime) else day
    candidate = current - dt.timedelta(days=1)
    for _ in range(10):
        key = _day_key(candidate.year, candidate.month, candidate.day)
        if candidate.weekday() < 5 and key not in _holidays_for_year(candidate.year):
            return candidate
        candidate -= dt.timedelta(days=1)
    raise RuntimeError("previous_trading_session_not_found")


def market_phase(instant: dt.datetime) -> MarketPhase:
    """Where ``instant`` sits relative to the regular session + close grace.

    ``instant`` may be naive UTC or tz-aware; conversion is via
    America/New_York so DST transitions never break the window.
    """
    now = _as_utc(instant)
    bounds = _session_bounds_utc(now)
    if bounds is None:
        return "closed"
    open_utc, close_utc = bounds
    grace_end = close_utc + dt.timedelta(minutes=CLOSE_GRACE_MINUTES)
    if now < open_utc:
        return "pre_open"
    if now < close_utc:
        return "open"
    if now < grace_end:
        return "grace"
    return "closed"


def in_flush_window(instant: dt.datetime) -> bool:
    """True while D1 quote writes are allowed: regular session + close grace."""
    return market_phase(instant) in ("open", "grace")


def accept_regular_trade(trade_ts: dt.datetime, now: dt.datetime) -> bool:
    """Whether a trade belongs to the CURRENT regular session."""
    if market_phase(now) not in ("open", "grace"):
        return False
    now_utc = _as_utc(now)
    bounds = _session_bounds_utc(now_utc)
    if bounds is None:
        return False
    open_utc, close_utc = bounds
    trade = _as_utc(trade_ts)
    return open_utc <= trade < close_utc


def ny_iso(instant: dt.datetime) -> str:
    """Human-readable New York local time for logs (never used for scheduling)."""
    return _as_utc(instant).astimezone(NEW_YORK_TZ).isoformat(timespec="seconds")
