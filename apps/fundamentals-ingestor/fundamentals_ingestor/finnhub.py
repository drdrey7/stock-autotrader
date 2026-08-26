"""Minimal Finnhub client for Stock Detail fundamentals."""

from __future__ import annotations

import json
import math
import time
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any

FINNHUB_BASE_URL = "https://finnhub.io/api/v1"

# Number of years used to select the trailing P/E and P/FCF history window.
VALUATION_HISTORY_YEARS = 5


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
    # Valuation feature layer (PR1: data normalization only).
    revenue_growth_ttm_yoy_pct: float | None = None
    revenue_growth_3y_pct: float | None = None
    revenue_growth_5y_pct: float | None = None
    roe_ttm_pct: float | None = None
    pe_5y_p25: float | None = None
    pe_5y_median: float | None = None
    pe_5y_p75: float | None = None
    pe_5y_samples: int | None = None
    pe_5y_as_of: str | None = None
    pfcf_5y_p25: float | None = None
    pfcf_5y_median: float | None = None
    pfcf_5y_p75: float | None = None
    pfcf_5y_samples: int | None = None
    pfcf_5y_as_of: str | None = None
    # Relative valuation facts (P/S and P/B; data layer only).
    revenue_per_share_ttm: float | None = None
    book_value_per_share: float | None = None
    ps_5y_p25: float | None = None
    ps_5y_median: float | None = None
    ps_5y_p75: float | None = None
    ps_5y_samples: int | None = None
    ps_5y_as_of: str | None = None
    pb_5y_p25: float | None = None
    pb_5y_median: float | None = None
    pb_5y_p75: float | None = None
    pb_5y_samples: int | None = None
    pb_5y_as_of: str | None = None


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


def percentile(values: list[float], percentile_point: float) -> float:
    """Deterministic quantile with numpy-style linear interpolation.

    Uses the standard R-7 / Hyndman-Fan Type 7 method, which matches NumPy's
    default ``method='linear'``. For ``q = percentile_point / 100`` and ``N``
    values the rank is ``x = (N - 1) * q``; the result interpolates between the
    two nearest sorted values. Well defined for ``N = 1`` (returns the single
    value) and even/odd ``N`` (median falls on the middle element for odd ``N``
    and averages the two middle elements for even ``N``).

    Implemented in pure Python so percentiles do not require numpy/pandas.
    """
    if not values:
        raise ValueError("cannot compute percentile of an empty sequence")
    if not 0.0 <= percentile_point <= 100.0:
        raise ValueError("percentile_point must be between 0 and 100")
    ordered = sorted(values)
    rank = (len(ordered) - 1) * (percentile_point / 100.0)
    lower_index = int(math.floor(rank))
    upper_index = int(math.ceil(rank))
    if lower_index == upper_index:
        return ordered[lower_index]
    fraction = rank - lower_index
    return ordered[lower_index] * (1.0 - fraction) + ordered[upper_index] * fraction


def _five_years_earlier(value: date) -> date:
    try:
        return value.replace(year=value.year - VALUATION_HISTORY_YEARS)
    except ValueError:
        # Leap day (Feb 29) has no day-29 counterpart five years earlier.
        return value.replace(year=value.year - VALUATION_HISTORY_YEARS, day=28)


def _series_percentiles_5y(payload: dict[str, Any], field: str) -> dict[str, Any] | None:
    """Trailing 5-year P25/median/P75 for a quarterly ratio/multiple series.

    The 5-year window is anchored at the most recent reported period of the
    series itself, regardless of whether that period's value is usable. Only
    after the window is fixed are points with a non-valid or non-positive
    value discarded. ``as_of`` therefore reflects the freshness of the series
    (latest reported period), not the last positive multiple.

    No extra provider request, no annual fallback, no caps or outlier removal.
    Returns ``None`` (``as_of`` NULL, ``samples`` 0) only when the series has
    no parseable period at all.
    """
    series = payload.get("series")
    if not isinstance(series, dict):
        return None
    bucket = series.get("quarterly")
    if not isinstance(bucket, dict):
        return None
    rows = bucket.get(field)
    if not isinstance(rows, list):
        return None

    dated: list[tuple[str, date, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        period = row.get("period")
        if not isinstance(period, str) or not period.strip():
            continue
        try:
            parsed = date.fromisoformat(period.strip())
        except ValueError:
            continue
        dated.append((period.strip(), parsed, row.get("v", row.get("value"))))
    if not dated:
        return None

    anchor_date = max(point[1] for point in dated)
    anchor_period = next(point[0] for point in dated if point[1] == anchor_date)
    cutoff = _five_years_earlier(anchor_date)

    # Fix the window first (date-based), then keep only finite, positive values.
    window_values: list[float] = []
    for _, parsed, value in dated:
        if parsed < cutoff:
            continue
        number = _finite_number(value)
        if number is None or number <= 0:
            continue
        window_values.append(number)
    if not window_values:
        return {
            "as_of": anchor_period,
            "samples": 0,
            "p25": None,
            "median": None,
            "p75": None,
        }

    return {
        "as_of": anchor_period,
        "samples": len(window_values),
        "p25": percentile(window_values, 25),
        "median": percentile(window_values, 50),
        "p75": percentile(window_values, 75),
    }


def _percentile_fields(result: dict[str, Any] | None) -> tuple[float | None, float | None, float | None, int | None, str | None]:
    """Flatten a *_series_percentiles_5y result into (p25, median, p75, samples, as_of)."""
    if result is None:
        return (None, None, None, 0, None)
    return (result["p25"], result["median"], result["p75"], result["samples"], result["as_of"])


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
    # percentage-labelled D1 fields in percentage points for the UI.
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

    # Valuation feature layer (PR1). Growth fields are already expressed by the
    # provider in percentage points, so they are stored directly. ROE comes
    # from the quarterly series as a decimal ratio and is converted to points.
    revenue_growth_ttm_yoy_pct = _finite_number(metric.get("revenueGrowthTTMYoy"))
    revenue_growth_3y_pct = _finite_number(metric.get("revenueGrowth3Y"))
    revenue_growth_5y_pct = _finite_number(metric.get("revenueGrowth5Y"))
    roe_ratio = _latest_series_value(payload, "quarterly", "roeTTM")

    pe_result = _series_percentiles_5y(payload, "peTTM")
    pfcf_result = _series_percentiles_5y(payload, "pfcfTTM")
    pe_p25, pe_median, pe_p75, pe_samples, pe_as_of = _percentile_fields(pe_result)
    pfcf_p25, pfcf_median, pfcf_p75, pfcf_samples, pfcf_as_of = _percentile_fields(pfcf_result)

    # Relative valuation facts (PR2 input layer: data normalization only).
    #
    # revenue_per_share_ttm: finite metric value, else NULL.
    revenue_per_share_ttm = _finite_number(metric.get("revenuePerShareTTM"))

    # book_value_per_share: prefer bookValuePerShareQuarterly. A present and
    # finite quarterly value is economic information (a negative or zero book
    # value is real, not missing data), so a zero/negative quarterly must NOT
    # be replaced by an older positive annual figure that would mislead a
    # future P/B-based IV. Fall back to bookValuePerShareAnnual only when the
    # quarterly point is actually missing or non-finite. In all cases the
    # selected value must be finite and positive, else NULL. Never derived from
    # a current price, market cap, or the P/B multiple.
    bvps_quarterly = _finite_number(metric.get("bookValuePerShareQuarterly"))
    bvps_annual = _finite_number(metric.get("bookValuePerShareAnnual"))
    book_value_per_share = None
    if bvps_quarterly is not None:
        if bvps_quarterly > 0:
            book_value_per_share = bvps_quarterly
        # quarterly <= 0 -> economic signal, keep NULL (no annual fallback).
    elif bvps_annual is not None and bvps_annual > 0:
        book_value_per_share = bvps_annual

    # P/S and P/B trailing 5-year windows, reusing the exact PR #118 semantics
    # (window anchored at the latest reported period, positive finite values only).
    ps_result = _series_percentiles_5y(payload, "psTTM")
    pb_result = _series_percentiles_5y(payload, "pb")
    ps_p25, ps_median, ps_p75, ps_samples, ps_as_of = _percentile_fields(ps_result)
    pb_p25, pb_median, pb_p75, pb_samples, pb_as_of = _percentile_fields(pb_result)

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
        revenue_growth_ttm_yoy_pct=revenue_growth_ttm_yoy_pct,
        revenue_growth_3y_pct=revenue_growth_3y_pct,
        revenue_growth_5y_pct=revenue_growth_5y_pct,
        roe_ttm_pct=roe_ratio * 100 if roe_ratio is not None else None,
        pe_5y_p25=pe_p25,
        pe_5y_median=pe_median,
        pe_5y_p75=pe_p75,
        pe_5y_samples=pe_samples,
        pe_5y_as_of=pe_as_of,
        pfcf_5y_p25=pfcf_p25,
        pfcf_5y_median=pfcf_median,
        pfcf_5y_p75=pfcf_p75,
        pfcf_5y_samples=pfcf_samples,
        pfcf_5y_as_of=pfcf_as_of,
        revenue_per_share_ttm=revenue_per_share_ttm,
        book_value_per_share=book_value_per_share,
        ps_5y_p25=ps_p25,
        ps_5y_median=ps_median,
        ps_5y_p75=ps_p75,
        ps_5y_samples=ps_samples,
        ps_5y_as_of=ps_as_of,
        pb_5y_p25=pb_p25,
        pb_5y_median=pb_median,
        pb_5y_p75=pb_p75,
        pb_5y_samples=pb_samples,
        pb_5y_as_of=pb_as_of,
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
