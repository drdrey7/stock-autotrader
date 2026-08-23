"""Minimal Finnhub client for reference market fundamentals."""

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
    beta: float | None
    eps_ttm: float | None
    dividend_yield: float | None
    checked_at: str | None


def _finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def normalize_metric(payload: Any, checked_at: str | None = None) -> MarketData:
    if not isinstance(payload, dict):
        return MarketData(None, None, None, None, None, checked_at)
    metric = payload.get("metric")
    if not isinstance(metric, dict):
        metric = payload
    market_cap_millions = _finite_number(metric.get("marketCapitalization"))
    pe_ttm = _finite_number(metric.get("peTTM"))
    beta = _finite_number(metric.get("beta"))
    eps_ttm = _finite_number(metric.get("epsTTM"))
    dividend_yield = _finite_number(
        metric.get("dividendYieldTTM", metric.get("dividendYieldIndicatedAnnual", metric.get("dividendYield"))),
    )
    # Finnhub reports marketCapitalization in millions. This is only a provider
    # unit normalization; no quote-based valuation is performed here.
    market_cap = market_cap_millions * 1_000_000 if market_cap_millions is not None else None
    pe = pe_ttm
    return MarketData(market_cap, pe, beta, eps_ttm, dividend_yield, checked_at)


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

    def _get(self, path: str, symbol: str, extra_params: dict[str, str] | None = None) -> Any:
        if self._last_request_at is not None:
            remaining = self._min_interval - (time.monotonic() - self._last_request_at)
            if remaining > 0:
                time.sleep(remaining)
        params = {"symbol": symbol, "token": self._api_key}
        if extra_params:
            params.update(extra_params)
        query = urllib.parse.urlencode(params)
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
        metric_payload = self._get("stock/metric", symbol, {"metric": "all"})
        if not isinstance(metric_payload, dict) or metric_payload.get("error"):
            raise FinnhubError("finnhub_invalid_metric_payload")
        metric = metric_payload.get("metric")
        if not isinstance(metric, dict) or not metric or not {"marketCapitalization", "peTTM"}.intersection(metric):
            raise FinnhubError("finnhub_invalid_metric_payload")
        checked_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        normalized = normalize_metric(metric_payload, checked_at)
        if all(value is None for value in (normalized.market_cap, normalized.pe_ttm, normalized.beta, normalized.eps_ttm, normalized.dividend_yield)):
            raise FinnhubError("finnhub_invalid_metric_payload")
        return normalized
