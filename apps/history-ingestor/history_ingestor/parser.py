"""Strict parsing of Alpha Vantage WEEKLY and SPLITS payloads.

The POC (2026-08-19, live) locked the contracts:

TIME_SERIES_WEEKLY::
    {"Meta Data": {"1. Information": "...", "2. Symbol": "NVDA",
                   "3. Last Refreshed": "...", "4. Time Zone": "US/Eastern"},
     "Weekly Time Series": {
         "2026-08-18": {"1. open": "219.7400", "2. high": "...", "3. low": "...",
                        "4. close": "...", "5. volume": "196806932"}, ...}}

SPLITS::
    {"symbol": "NVDA", "data": [{"effective_date": "2024-06-10", "split_factor": "10.0000"}, ...]}

The weekly series is newest-first; buckets are keyed by the week's last
trading day. SPLITS data is newest-first; split_factor is a decimal string
(4 decimals) — "4.0000" = 4:1, "1.5000" = 3:2, "0.5000" = 1:2 reverse split.

Provider message payloads are NEVER accepted as data: ``Information``
(soft pacing throttle), ``Note`` (daily quota) and ``Error Message``
(invalid key / unknown symbol) raise distinct errors here.
"""

from __future__ import annotations

import datetime as dt
import math
import re
from dataclasses import dataclass
from fractions import Fraction
from typing import Any

DATE_KEY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class PayloadError(RuntimeError):
    """Raised when a provider payload cannot be parsed as market data."""


class ProviderMessageError(PayloadError):
    """The payload is a provider informational message, not data."""


class QuotaMessageError(ProviderMessageError):
    """The payload is the daily-quota ``Note`` message."""


class ThrottleMessageError(ProviderMessageError):
    """The payload is the soft pacing ``Information`` message."""


class InvalidKeyError(ProviderMessageError):
    """The payload is the invalid-apikey ``Error Message``."""


@dataclass(frozen=True)
class WeeklyBar:
    symbol: str
    week_end_date: str  # YYYY-MM-DD (week's last trading day per the provider)
    open: float
    high: float
    low: float
    close: float
    volume: int


@dataclass(frozen=True)
class SplitEvent:
    symbol: str
    effective_date: str  # YYYY-MM-DD
    ratio: Fraction      # 4 -> Fraction(4, 1) for a 4:1 split; Fraction(1, 2) for 1:2 reverse


def _message_kind(payload: dict) -> ProviderMessageError | None:
    if "Note" in payload:
        return QuotaMessageError(str(payload["Note"])[:200])
    if "Information" in payload:
        return ThrottleMessageError(str(payload["Information"])[:200])
    if "Error Message" in payload:
        message = str(payload["Error Message"])[:300]
        if "apikey" in message.lower():
            return InvalidKeyError(message)
        return ProviderMessageError(message)
    return None


def _require_messages(payload: Any) -> None:
    """Reject non-object and provider message payloads before any data interpretation.

    A provider response is ONLY market data when it is a JSON object with the
    expected series/array keys. Anything else (list, string, garbage, or one
    of Alpha Vantage's informational messages) is an error — never data.
    """
    if not isinstance(payload, dict):
        raise PayloadError(f"provider payload is not a JSON object: {type(payload).__name__}")
    error = _message_kind(payload)
    if error is not None:
        raise error


def _finite_positive(value: Any, field: str, index: int) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise PayloadError(f"weekly row {index}: {field} is not numeric: {value!r}") from exc
    if not math.isfinite(number) or number <= 0:
        raise PayloadError(f"weekly row {index}: {field} must be finite and > 0, got {value!r}")
    return number


def parse_weekly_payload(symbol: str, payload: Any) -> list[WeeklyBar]:
    """Parse a TIME_SERIES_WEEKLY payload into ascending WeeklyBar rows.

    Strict: any malformed row rejects the whole payload (garbage is never
    persisted as market data). The returned list is sorted ascending by
    week_end_date and has unique dates.
    """
    _require_messages(payload)
    series = payload.get("Weekly Time Series") or payload.get("Time Series (Weekly)")
    if not isinstance(series, dict) or not series:
        raise PayloadError(f"weekly payload for {symbol} has no weekly series")

    bars: list[WeeklyBar] = []
    seen: set[str] = set()
    for index, (date_key, row) in enumerate(series.items()):
        if not DATE_KEY_RE.match(str(date_key)):
            raise PayloadError(f"weekly row {index}: invalid date key {date_key!r}")
        try:
            dt.date.fromisoformat(str(date_key))
        except ValueError as exc:
            raise PayloadError(f"weekly row {index}: unparseable date {date_key!r}") from exc
        if date_key in seen:
            raise PayloadError(f"weekly row {index}: duplicate date {date_key}")
        seen.add(date_key)
        if not isinstance(row, dict):
            raise PayloadError(f"weekly row {index}: row is not an object")
        open_ = _finite_positive(row.get("1. open"), "open", index)
        high = _finite_positive(row.get("2. high"), "high", index)
        low = _finite_positive(row.get("3. low"), "low", index)
        close = _finite_positive(row.get("4. close"), "close", index)
        try:
            volume = int(row.get("5. volume"))  # type: ignore[arg-type]
        except (TypeError, ValueError) as exc:
            raise PayloadError(f"weekly row {index}: volume is not an integer: {row.get('5. volume')!r}") from exc
        if volume < 0:
            raise PayloadError(f"weekly row {index}: volume must be >= 0, got {volume}")
        if not (low <= open_ <= high) or not (low <= close <= high):
            # AV data is consistent OHLC; reject impossible bars instead of
            # silently persisting them (data-quality gate).
            raise PayloadError(f"weekly row {index}: inconsistent OHLC (open {open_}, high {high}, low {low}, close {close})")
        bars.append(WeeklyBar(symbol=symbol, week_end_date=date_key, open=open_, high=high, low=low, close=close, volume=volume))

    bars.sort(key=lambda bar: bar.week_end_date)
    return bars


def parse_splits_payload(symbol: str, payload: Any) -> list[SplitEvent]:
    """Parse a SPLITS payload into ascending SplitEvent rows.

    A payload with NO split array at all (missing ``data`` and ``splits``
    keys) is an unexpected/malformed provider payload and raises — it must
    NOT be silently read as "zero splits". ONLY an explicit ``data: []`` (or
    the legacy ``splits: []``) is the provider's verified empty history.
    ``data``/``splits`` that are present but not a list are also errors.
    """
    _require_messages(payload)
    if "data" not in payload and "splits" not in payload:
        raise PayloadError(f"splits payload for {symbol} has no data array (missing 'data'/'splits')")
    data = payload.get("data")
    if data is None and "splits" in payload:
        data = payload["splits"]  # tolerate the legacy key shape
    if not isinstance(data, list):
        raise PayloadError(f"splits payload for {symbol} has no data array")

    events: list[SplitEvent] = []
    seen: set[str] = set()
    for index, row in enumerate(data):
        if not isinstance(row, dict):
            raise PayloadError(f"splits row {index}: not an object")
        date_key = row.get("effective_date") or row.get("date")
        if not isinstance(date_key, str) or not DATE_KEY_RE.match(date_key):
            raise PayloadError(f"splits row {index}: invalid effective date {date_key!r}")
        try:
            dt.date.fromisoformat(date_key)
        except ValueError as exc:
            raise PayloadError(f"splits row {index}: unparseable date {date_key!r}") from exc
        if date_key in seen:
            raise PayloadError(f"splits row {index}: duplicate split date {date_key}")
        seen.add(date_key)
        factor_raw = row.get("split_factor")
        if not isinstance(factor_raw, str):
            raise PayloadError(f"splits row {index}: split_factor is not a string: {factor_raw!r}")
        try:
            factor = Fraction(factor_raw).limit_denominator(1_000_000)
        except (ValueError, ZeroDivisionError) as exc:
            raise PayloadError(f"splits row {index}: unparseable split_factor {factor_raw!r}") from exc
        if factor <= 0:
            raise PayloadError(f"splits row {index}: split_factor must be > 0, got {factor_raw!r}")
        events.append(SplitEvent(symbol=symbol, effective_date=date_key, ratio=factor))

    events.sort(key=lambda event: event.effective_date)
    return events
