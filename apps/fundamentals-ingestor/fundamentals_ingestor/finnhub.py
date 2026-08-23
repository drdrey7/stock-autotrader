"""Minimal Finnhub client for Stock Detail fundamentals."""

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
    # Keep the original six fields first for backwards-compatible tests/callers.
    market_cap: float | None
    pe_ttm: float | None
    beta: float | None
    eps_ttm: float | None
    dividend_yield: float | None
    checked_at: str | None
    roic_pct: float | None = None
    fcf_margin_pct: float | None = None
    debt_to_equity: float | None = None
    fcf_per_share_ttm: float | None = None


def _finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _latest_series_value(payload: dict[str, Any], cadence: str, field: str) -> float | None:
    series = payload.get("series")
    if not isinstance(series, dict):
        return None
    bucket = series.get(cadence)
    if not isinstance(bucket, dict):
        return None
    rows = bucket.get(field)
    if not isinstance(rows, list):
        return None

    candidates: list[tuple[str, float]] = []
    undated: list[float] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        value = _finite_number(row.get("v", row.get("value")))
        if value is None:
            continue
        period = row.get("period")
        if isinstance(period, str) and period.strip():
            candidates.append((period.strip(), value))
        else:
            undated.append(value)
    if candidates:
        return max(candidates, key=lambda item: item[0])[1]
    return undated[-1] if undated else None


def _first_not_none(*values: float | None) -> float | None:
    return next((value for value in values if value is not None), None)


def normalize_metric(payload: Any, checked_at: str | None = None) -> MarketData:
    if not isinstance(payload, dict):
        return MarketData(None, None, None, None, None, checked_at)
    metric = payload.get("metric")
    if not isinstance(metric, dict):
        metric = {}

    market_cap_millions = _finite_number(metric.get("marketCapitalization"))
    pe_ttm = _finite_number(metric.get("peTTM"))
    beta = _finite_number(metric.get("beta"))
    eps_ttm = _finite_number(metric.get("epsTTM"))
    dividend_yield = _finite_number(
        metric.get("dividendYieldTTM", metric.get("dividendYieldIndicatedAnnual", metric.get("dividendYield"))),
    )

    # Finnhub series ratios are decimal ratios (e.g. 0.25 = 25%). Store the
    # two percentage-labelled D1 fields in percentage points for the UI.
    roic_ratio = _first_not_none(
        _latest_series_value(payload, "quarterly", "roicTTM"),
        _latest_series_value(payload, "annual", "roic"),
    )
    fcf_margin_ratio = _first_not_none(
        _latest_series_value(payload, "quarterly", "fcfMargin"),
        _latest_series_value(payload, "annual", "fcfMargin"),
    )
    # Use the semantically explicit ratio series only. The similarly named
    # metric field has ambiguous provider units and is unnecessary for our
    # observed Core Universe coverage.
    debt_to_equity = _latest_series_value(payload, "quarterly", "totalDebtToEquity")
    fcf_per_share_ttm = _latest_series_value(payload, "quarterly", "fcfPerShareTTM")

    # Finnhub reports marketCapitalization in millions. This is only provider
    # unit normalization; no quote-based valuation is performed here.
    market_cap = market_cap_millions * 1_000_000 if market_cap_millions is not None else None
    return MarketData(
        market_cap=market_cap,
        pe_ttm=pe_ttm,
        beta=beta,
        eps_ttm=eps_ttm,
        dividend_yield=dividend_yield,
        checked_at=checked_at,
        roic_pct=roic_ratio * 100 if roic_ratio is not None else None,
        fcf_margin_pct=fcf_margin_ratio * 100 if fcf_margin_ratio is not None else None,
        debt_to_equity=debt_to_equity,
        fcf_per_share_ttm=fcf_per_share_ttm,
    )


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
        payload = self._get("stock/metric", symbol, {"metric": "all"})
        if not isinstance(payload, dict) or payload.get("error"):
            raise FinnhubError("finnhub_invalid_metric_payload")
        metric = payload.get("metric")
        if not isinstance(metric, dict) or not metric or not {"marketCapitalization", "peTTM"}.intersection(metric):
            raise FinnhubError("finnhub_invalid_metric_payload")
        checked_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        normalized = normalize_metric(payload, checked_at)
        direct_values = (
            normalized.market_cap,
            normalized.pe_ttm,
            normalized.beta,
            normalized.eps_ttm,
            normalized.dividend_yield,
            normalized.roic_pct,
            normalized.fcf_margin_pct,
            normalized.debt_to_equity,
            normalized.fcf_per_share_ttm,
        )
        if all(value is None for value in direct_values):
            raise FinnhubError("finnhub_invalid_metric_payload")
        return normalized
