"""Finnhub WebSocket trade-frame parsing and message classification.

The parser is provider-aware but keeps provider vocabulary local: frame keys
(``type``/``data``/``s``/``p``/``t``/``v``) never escape this module. Only
valid trade ticks for known Core Universe symbols are returned; everything
else is classified (malformed / unknown-symbol / non-trade) so the caller can
count it and move on without logging every frame.
"""

from __future__ import annotations

import json
import re
import time
from collections.abc import Callable

from .types import TradeTick

TRADE = "trade"

_SYMBOL_RE = re.compile(r"^[A-Z][A-Z0-9-]{0,11}$")


class ParseResult:
    """Outcome of parsing one raw frame.

    - ``ticks``: valid trade ticks (symbols already restricted to the Core
      Universe membership set passed to the parser).
    - ``malformed``: frames/entries rejected as structurally invalid.
    - ``non_trade_messages``: valid JSON frames that are not ``type==trade``
      (e.g. ping/status frames) — informational, not errors.
    - ``unknown_symbols``: valid trade entries whose symbol is not in the Core
      Universe — ignored by design, never written to D1.
    """

    __slots__ = ("ticks", "malformed", "non_trade_messages", "unknown_symbols")

    def __init__(self) -> None:
        self.ticks: list[TradeTick] = []
        self.malformed = 0
        self.non_trade_messages = 0
        self.unknown_symbols: list[str] = []


def _finite_number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if _is_finite(float(value)) else None
    if isinstance(value, str):
        text = value.strip().replace(",", "")
        try:
            number = float(text)
        except ValueError:
            return None
        return number if _is_finite(number) else None
    return None


def _is_finite(number: float) -> bool:
    return number == number and number not in (float("inf"), float("-inf"))


class TradeFrameParser:
    """Stateless parser bound to a Core Universe membership set."""

    def __init__(
        self,
        symbols: list[str],
        now_ms: int | None = None,
        now_fn: Callable[[], int] | None = None,
    ) -> None:
        self._symbols = set(symbols)
        self._now_ms = now_ms
        self._now_fn = now_fn

    def parse(self, raw: str, max_future_ms: float, max_age_ms: float) -> ParseResult:
        """Parse one raw WS frame string.

        Timestamps use Finnhub's ``t`` (epoch milliseconds). A classic pitfall
        is comparing that with ``time.time()`` (seconds) directly — here all
        comparisons are millisecond-to-millisecond.
        """
        result = ParseResult()
        try:
            message = json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            result.malformed += 1
            return result

        if not isinstance(message, dict):
            result.malformed += 1
            return result

        message_type = message.get("type")
        if message_type is None:
            result.malformed += 1
            return result
        if message_type != TRADE:
            result.non_trade_messages += 1
            return result

        data = message.get("data")
        if not isinstance(data, list):
            result.malformed += 1
            return result

        now = (
            int(self._now_fn())
            if self._now_fn is not None
            else self._now_ms if self._now_ms is not None else int(time.time() * 1000)
        )
        for entry in data:
            if not isinstance(entry, dict):
                result.malformed += 1
                continue
            symbol = entry.get("s")
            if not isinstance(symbol, str) or not _SYMBOL_RE.match(symbol):
                result.malformed += 1
                continue
            if symbol not in self._symbols:
                result.unknown_symbols.append(symbol)
                continue

            price = _finite_number(entry.get("p"))
            if price is None or price <= 0:
                result.malformed += 1
                continue

            timestamp_ms = _finite_number(entry.get("t"))
            if timestamp_ms is None or timestamp_ms <= 0:
                result.malformed += 1
                continue
            timestamp_ms = int(timestamp_ms)
            if timestamp_ms > now + int(max_future_ms * 1000) or timestamp_ms < now - int(max_age_ms * 1000):
                result.malformed += 1
                continue

            size_value = _finite_number(entry.get("v"))
            size = None if size_value is None else float(size_value)
            result.ticks.append(TradeTick(symbol=symbol, price=price, timestamp_ms=timestamp_ms, size=size))
        return result
