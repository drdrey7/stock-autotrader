"""Daily FX feed for quote-currency normalization.

Source: the official ExchangeRate-API **Free** plan (API-key authenticated),
``https://v6.exchangerate-api.com/v6/{api_key}/latest/USD``. Per the provider's
own documentation the Free plan requires **no public attribution** (unlike the
keyless open.er-api.com endpoint which "requires attribution"), updates once
per day and allows 1500 requests/month — far more than this ingestor's single
daily fetch. It covers every ISO 4217 code including the three local currencies
the Core Universe needs (TWD, DKK, EUR) in one request. The ECB-backed
Frankfurter API was evaluated first but drops TWD, so ExchangeRate-API is the
single source covering all three required pairs.

The request happens server-side in the VPS fundamentals-ingestor (never in the
Worker); rates are persisted to D1 so a failed fetch continues on
last-known-good. The API key is injected into the URL by the config layer and
must never be logged or committed.

Rates are expressed as ``local_currency_units_per_1_USD`` (e.g. 31.85 TWD/USD),
which is exactly the divisor for converting a local-currency amount to USD:
``usd = local / rate``. The stored pair tuple is ``(base_currency="USD",
counter_currency=local)``, i.e. ``(USD, TWD)`` = TWD units per 1 USD.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from collections.abc import Callable
from email.utils import parsedate_to_datetime
from typing import Any

# Official ExchangeRate-API Free (keyed) endpoint template. The api_key is
# filled in server-side by the config layer; never log the resulting URL.
DEFAULT_FX_BASE_URL = "https://v6.exchangerate-api.com/v6/{api_key}/latest/USD"
# Pairs the ingestor needs: base currency (USD) -> counter (local fundamentals) currency.
FX_QUOTE_BASE = "USD"
FX_PAIRS = ("TWD", "DKK", "EUR")


class FxError(RuntimeError):
    """Raised when the FX source cannot be fetched or parsed."""


def _first_number(value: Any) -> float | None:
    """Coerce a provider value to a finite positive-capable float, or None.

    Booleans are rejected outright (True == 1.0 in Python but is NOT a rate),
    as are NaN and infinities. Non-numeric values and numeric strings that do
    not parse are also rejected.
    """
    if isinstance(value, bool) or isinstance(value, (dict, list, tuple, set)):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or abs(number) == float("inf"):
        return None
    return number


def _rate_as_of(updated_text: Any) -> str | None:
    """Parse the provider's last-update timestamp to an ISO date, or None.

    A non-string update field (dict, list, bool, number) is treated as absent
    rather than raising AttributeError.
    """
    if not isinstance(updated_text, str) or not updated_text.strip():
        return None
    try:
        parsed = parsedate_to_datetime(updated_text.strip())
    except (TypeError, ValueError, OverflowError):
        # Fallback: extract a leading ISO-ish date if present.
        match = re.search(r"\d{4}-\d{2}-\d{2}", updated_text)
        return match.group(0) if match else None
    return parsed.date().isoformat()


def parse_rates(payload: Any) -> tuple[dict[tuple[str, str], float], str | None]:
    """Extract ``{ (USD, LOCAL): rate }`` for the required pairs plus as_of date.

    Validity is enforced so wrong-currency or malformed payloads can never be
    used as USD rates:

    * payload must be a dict with ``result`` of ``success``;
    * ``base_code`` must be present and exactly ``USD`` (fail closed if a
      misconfigured FUNDAMENTALS_FX_URL points at /latest/EUR);
    * ``rates`` must be a dict containing TWD, DKK and EUR as finite positive
      non-boolean numbers.

    Raises FxError for any violation.
    """
    if not isinstance(payload, dict):
        raise FxError("fx_invalid_payload")
    if payload.get("result") != "success":
        raise FxError("fx_provider_error")
    base_code = payload.get("base_code")
    if not isinstance(base_code, str) or base_code.upper() != "USD":
        raise FxError("fx_wrong_base")
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
    def __init__(
        self,
        timeout_seconds: float = 30.0,
        url: str | None = None,
        opener: Callable[..., Any] | None = None,
    ) -> None:
        self._timeout = timeout_seconds
        self._url = url if url else DEFAULT_FX_BASE_URL
        self._opener = opener or urllib.request.urlopen

    def fetch_rates(self) -> tuple[dict[tuple[str, str], float], str | None]:
        if not self._url:
            raise FxError("fx_invalid_config")
        request = urllib.request.Request(self._url, headers={"Accept": "application/json", "User-Agent": "stock-autotrader/1.0"})
        try:
            with self._opener(request, timeout=self._timeout) as response:
                if response.status != 200:
                    raise FxError(f"fx_http_{response.status}")
                payload = json.loads(response.read().decode("utf-8"))
        except FxError:
            raise
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
            raise FxError("fx_request_failed") from exc
        return parse_rates(payload)