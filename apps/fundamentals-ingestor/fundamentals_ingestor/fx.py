"""Daily FX feed for quote-currency normalization.

Source: open.er-api.com (free, no API key) ``/v6/latest/USD``, which returns
ECB-equivalent daily rates and crucially covers the three local currencies the
Core Universe needs (TWD, DKK, EUR) in a single request. The ECB-backed
Frankfurter API was evaluated first but dropped TWD, so open.er-api was chosen
as the single source covering all three required pairs. Requests happen
server-side in the VPS fundamentals-ingestor (never in the Worker); rates are
persisted to D1 so a failed fetch continues on last-known-good.

Rates are expressed as ``local_currency_units_per_1_USD`` (e.g. 31.85 TWD/USD),
which is exactly the divisor for converting a local-currency amount to USD:
``usd = local / rate``.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from collections.abc import Callable
from email.utils import parsedate_to_datetime
from typing import Any

DEFAULT_FX_URL = "https://open.er-api.com/v6/latest/USD"
# Pairs the ingestor needs: quote currency (USD) -> local fundamentals currency.
FX_QUOTE_BASE = "USD"
FX_PAIRS = ("TWD", "DKK", "EUR")


class FxError(RuntimeError):
    """Raised when the FX source cannot be fetched or parsed."""


def _first_number(value: Any) -> float | None:
    """Return a finite numeric value, rejecting booleans and malformed inputs."""
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and abs(number) != float("inf") else None


def _rate_as_of(updated_text: Any) -> str | None:
    """Normalize a provider update label to YYYY-MM-DD when it is a string."""
    if not isinstance(updated_text, str) or not updated_text.strip():
        return None
    normalized = updated_text.strip()
    try:
        parsed = parsedate_to_datetime(normalized)
    except (TypeError, ValueError, OverflowError):
        # Fallback: extract a leading ISO-ish date if present.
        match = __import__("re").search(r"\d{4}-\d{2}-\d{2}", normalized)
        return match.group(0) if match else None
    return parsed.date().isoformat()


def parse_rates(payload: Any) -> tuple[dict[tuple[str, str], float], str | None]:
    """Extract ``{ (USD, LOCAL): rate }`` for the required pairs plus as_of date.

    Raises FxError when the payload is malformed or is missing a required pair.
    """
    if not isinstance(payload, dict):
        raise FxError("fx_invalid_payload")
    if payload.get("result") not in (None, "success"):
        raise FxError("fx_provider_error")
    rates_map = payload.get("rates")
    if not isinstance(rates_map, dict):
        raise FxError("fx_invalid_payload")

    as_of = _rate_as_of(payload.get("time_last_update_utc") or payload.get("date"))
    rates: dict[tuple[str, str], float] = {}
    for local in FX_PAIRS:
        raw = rates_map.get(local)
        number = _first_number(raw)
        if number is None or number <= 0:
            raise FxError("fx_missing_pair")
        rates[(FX_QUOTE_BASE, local)] = number
    return rates, as_of


class FxClient:
    """Small HTTP client for the single daily USD FX feed."""

    def __init__(
        self,
        timeout_seconds: float = 30.0,
        url: str = DEFAULT_FX_URL,
        opener: Callable[..., Any] | None = None,
    ) -> None:
        self._timeout = timeout_seconds
        self._url = (url or "").strip() or DEFAULT_FX_URL
        self._opener = opener or urllib.request.urlopen

    def fetch_rates(self) -> tuple[dict[tuple[str, str], float], str | None]:
        """Fetch and validate the required FX pairs, raising FxError on failure."""
        try:
            request = urllib.request.Request(
                self._url,
                headers={"Accept": "application/json", "User-Agent": "stock-autotrader/1.0"},
            )
            with self._opener(request, timeout=self._timeout) as response:
                if response.status != 200:
                    raise FxError(f"fx_http_{response.status}")
                payload = json.loads(response.read().decode("utf-8"))
        except FxError:
            raise
        except (urllib.error.URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError) as exc:
            raise FxError("fx_request_failed") from exc
        return parse_rates(payload)
