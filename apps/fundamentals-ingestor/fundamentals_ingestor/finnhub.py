"""Minimal Finnhub client for direct market valuation fields."""

from __future__ import annotations

import json
import math
import time
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

FINNHUB_BASE_URL = "https://finnhub.io/api/v1"


class FinnhubError(RuntimeError):
    """Raised for an invalid or unsuccessful Finnhub response."""


@dataclass(frozen=True)
class MarketData:
    market_cap: float | None
    pe_ttm: float | None
    market_as_of: str | None


def _finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _timestamp(value: Any) -> str | None:
    number = _finite_number(value)
    if number is None or number <= 0:
        return None
    return datetime.fromtimestamp(number, tz=UTC).isoformat().replace("+00:00", "Z")


def normalize_quote(payload: Any) -> str | None:
    """Return Finnhub's quote timestamp without manufacturing one."""
    if not isinstance(payload, dict):
        return None
    return _timestamp(payload.get("t"))


def normalize_metric(payload: Any, market_as_of: str | None = None) -> MarketData:
    if not isinstance(payload, dict):
        return MarketData(None, None, market_as_of)
    metric = payload.get("metric")
    if not isinstance(metric, dict):
        metric = payload
    market_cap_millions = _finite_number(metric.get("marketCapitalization"))
    pe_ttm = _finite_number(metric.get("peTTM"))
    # Finnhub reports marketCapitalization in millions. This is a unit
    # conversion, not a derived valuation calculation. Negative/non-positive
    # valuation fields are not presentation-safe and fail closed.
    market_cap = market_cap_millions * 1_000_000 if market_cap_millions is not None and market_cap_millions > 0 else None
    pe = pe_ttm if pe_ttm is not None and pe_ttm > 0 else None
    return MarketData(market_cap, pe, market_as_of)


class FinnhubClient:
    def __init__(
        self,
        api_key: str,
        timeout_seconds: float = 30.0,
        opener: Callable[..., Any] | None = None,
        min_interval_seconds: float = 1.05,
    ) -> None:
        self._api_key = api_key
        self._timeout = timeout_seconds
        self._opener = opener or urllib.request.urlopen
        self._min_interval = min_interval_seconds
        self._last_request_at: float | None = None

    def _get(self, path: str, symbol: str) -> Any:
        if self._last_request_at is not None:
            remaining = self._min_interval - (time.monotonic() - self._last_request_at)
            if remaining > 0:
                time.sleep(remaining)
        query = urllib.parse.urlencode({"symbol": symbol, "token": self._api_key})
        request = urllib.request.Request(f"{FINNHUB_BASE_URL}/{path}?{query}", headers={"Accept": "application/json"})
        try:
            self._last_request_at = time.monotonic()
            with self._opener(request, timeout=self._timeout) as response:
                if response.status != 200:
                    raise FinnhubError(f"finnhub_http_{response.status}")
                return json.loads(response.read().decode("utf-8"))
        except FinnhubError:
            raise
        except Exception as exc:
            raise FinnhubError("finnhub_request_failed") from exc

    def fetch(self, symbol: str) -> MarketData:
        quote = self._get("quote", symbol)
        market_as_of = normalize_quote(quote)
        metrics = normalize_metric(self._get("stock/metric", symbol), market_as_of)
        return metrics
