"""Alpha Vantage provider client — generic multi-key, quota-aware, paced.

Design points (locked by the 2026-08-19 live POC and official docs):

- Free tier: 25 requests/day per key. Multiple keys are legitimate separate
  entitlements and are accounted per key — the tool NEVER rotates keys to
  bypass a single key's quota; it simply stops once every key is exhausted.
- Soft pacing: back-to-back requests return ``{"Information": ...}``
  (empirically, ~13s gaps succeed). The client paces per key and treats the
  Information payload as a retryable throttle with backoff.
- Daily quota exhaustion returns ``{"Note": ...}`` — a hard stop for that
  key (never retried in a tight loop; the run checkpoints and reports).
- Invalid/missing key returns ``{"Error Message": "... apikey ..."}``.
- Unknown symbol returns a generic ``Error Message`` (non-retryable).
- Keys are referenced ONLY by index; values never enter logs, errors,
  checkpoints or stdout (covered by test_secrets).
"""

from __future__ import annotations

import json
import logging
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Protocol

from .config import Settings
from .parser import (
    InvalidKeyError,
    PayloadError,
    parse_splits_payload,
    parse_weekly_payload,
)

logger = logging.getLogger("history_ingestor.provider")


class ProviderError(RuntimeError):
    """Base provider failure."""


class QuotaExhaustedError(ProviderError):
    """Every configured key is out of daily budget (Note or budget count)."""


class AllKeysFailedError(ProviderError):
    """Transient failures on every key — caller may retry later."""


class BudgetLedger(Protocol):
    """Per-key request accounting the provider reports into (checkpoint-backed)."""

    def remaining(self, index: int) -> int: ...

    def mark_used(self, index: int, delta: int = 1) -> None: ...

    def mark_exhausted(self, index: int) -> None: ...


class _StaticBudget:
    """Standalone fixed-25 budget for tests/validation without a checkpoint."""

    def __init__(self, budget: int) -> None:
        self._budget = budget
        self.used = [0]

    def remaining(self, index: int) -> int:
        return max(0, self._budget - self.used[index])

    def mark_used(self, index: int, delta: int = 1) -> None:
        self.used[index] += delta

    def mark_exhausted(self, index: int) -> None:
        self.used[index] = self._budget


class AlphaVantageClient:
    """Paced, budgeted, multi-key HTTP client for Alpha Vantage.

    ``ledger`` is the per-key budget the client both consults and reports
    into (StateStore-backed in bootstrap/maintenance; a static budget in
    tests). ``now_fn``/``sleep_fn``/``urlopen``/``rnd`` are injectable for
    deterministic tests.
    """

    def __init__(
        self,
        settings: Settings,
        ledger: BudgetLedger,
        now_fn: Any | None = None,
        sleep_fn: Any | None = None,
        urlopen: Any | None = None,
        rnd: random.Random | None = None,
    ) -> None:
        self._settings = settings
        self._ledger = ledger
        self._now = now_fn or time.monotonic
        self._sleep = sleep_fn or time.sleep
        self._urlopen = urlopen or (lambda req, timeout: urllib.request.urlopen(req, timeout=timeout))
        self._rnd = rnd or random.Random()
        self._keys = settings.alpha_vantage_keys
        self._last_request_at = [float("-inf")] * len(self._keys)
        self.requests_this_run = 0
        self.throttle_retries_this_run = 0
        self.quota_hits_this_run: list[int] = []

    # ------------------------------------------------------------------ utils

    def _wait_for_pacing(self, index: int) -> None:
        if self._last_request_at[index] == float("-inf"):
            # First request on this key: no pacing debt.
            self._last_request_at[index] = self._now()
            return
        elapsed = self._now() - self._last_request_at[index]
        needed = self._settings.av_min_interval_seconds - elapsed
        if needed > 0:
            self._sleep(needed)
        self._last_request_at[index] = self._now()

    def _next_key_index(self, exclude: set[int] | None = None) -> int | None:
        """Round-robin across keys with remaining budget, skipping ``exclude``."""
        exclude = exclude or set()
        candidates = [
            index for index in range(len(self._keys))
            if index not in exclude and self._ledger.remaining(index) > 0
        ]
        if not candidates:
            return None
        offset = self.requests_this_run % len(candidates)
        return candidates[offset]

    # ------------------------------------------------------------------ fetch

    def _request(self, params: dict, key_index: int) -> tuple[int, dict]:
        """One HTTP GET. Returns (http_status, parsed_payload).

        Raises ProviderError on network/timeout/HTTP-error (the caller
        decides retryability); HTTP 200 message payloads come back parsed.
        """
        key = self._keys[key_index]
        query = dict(params)
        query["apikey"] = key
        url = f"{self._settings.av_base_url}?{urllib.parse.urlencode(query)}"
        request = urllib.request.Request(url, headers={"User-Agent": "stock-autotrader-history/1.0"})
        self._wait_for_pacing(key_index)
        try:
            with self._urlopen(request, self._settings.av_timeout_seconds) as response:
                body = response.read().decode("utf-8")
                try:
                    parsed = json.loads(body) if body else {}
                except json.JSONDecodeError as exc:
                    raise ProviderError(f"invalid JSON response: {exc}") from exc
                return response.status, parsed
        except urllib.error.HTTPError as exc:
            exc.read()  # drain the body; HTTP status is what matters here
            if exc.code in (401, 403):
                raise InvalidKeyError(f"HTTP {exc.code}")
            raise ProviderError(f"HTTP {exc.code}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise ProviderError(f"network error: {exc.__class__.__name__}") from exc

    def _fetch_with_keys(
        self,
        params: dict,
    ) -> tuple[int, dict]:
        """Fetch ``params`` trying keys until one succeeds or all are spent.

        Returns ``(key_index, payload)``. Raises QuotaExhaustedError when no
        key has budget left, AllKeysFailedError when every key failed
        transiently, ProviderError for non-retryable provider messages.
        """
        failed_keys: set[int] = set()
        for _ in range(len(self._keys) * (self._settings.av_max_retries + 2)):
            index = self._next_key_index(failed_keys)
            if index is None:
                if self.quota_hits_this_run:
                    raise QuotaExhaustedError(
                        f"provider daily quota reached on {len(self.quota_hits_this_run)} key(s)"
                    )
                if failed_keys:
                    raise AllKeysFailedError("all keys failed transiently")
                raise QuotaExhaustedError("all Alpha Vantage keys out of daily budget")

            try:
                status, payload = self._request(params, index)
                self.requests_this_run += 1
                self._ledger.mark_used(index, 1)
            except InvalidKeyError:
                failed_keys.add(index)
                continue
            except ProviderError:
                failed_keys.add(index)
                continue

            # AV returns HTTP 200 for informational payloads — classify here.
            # A provider payload must be a JSON object; anything else (a
            # string, a bare array, garbage) is never market data.
            if not isinstance(payload, dict):
                raise ProviderError("unexpected payload shape: not a JSON object")
            if "Note" in payload:
                self.quota_hits_this_run.append(index)
                self._ledger.mark_exhausted(index)
                failed_keys.add(index)
                continue
            if "Information" in payload:
                self.throttle_retries_this_run += 1
                # Soft pacing throttle: bounded backoff, retry same key —
                # never a tight loop.
                delay = self._settings.av_retry_base_seconds * (1 + self._rnd.uniform(-0.2, 0.2))
                self._sleep(delay)
                continue
            if "Error Message" in payload:
                message = str(payload["Error Message"])[:300]
                if "apikey" in message.lower():
                    failed_keys.add(index)
                    continue
                raise ProviderError(f"provider message: {message}")
            if not payload:
                raise ProviderError("empty payload")
            return index, payload

        raise AllKeysFailedError("all keys failed transiently")

    # ------------------------------------------------------------- endpoints

    def fetch_weekly(self, symbol: str) -> tuple[int, list, str]:
        """Fetch + parse TIME_SERIES_WEEKLY. Returns (key_index, bars, note)."""
        key_index, payload = self._fetch_with_keys(
            {"function": "TIME_SERIES_WEEKLY", "symbol": symbol, "outputsize": "full"},
        )
        try:
            bars = parse_weekly_payload(symbol, payload)
        except PayloadError as exc:
            raise ProviderError(f"WEEKLY {symbol}: {exc}") from exc
        return key_index, bars, ""

    def fetch_splits(self, symbol: str) -> tuple[int, list, str]:
        """Fetch + parse SPLITS. Returns (key_index, events, note)."""
        key_index, payload = self._fetch_with_keys(
            {"function": "SPLITS", "symbol": symbol},
        )
        try:
            events = parse_splits_payload(symbol, payload)
        except PayloadError as exc:
            raise ProviderError(f"SPLITS {symbol}: {exc}") from exc
        return key_index, events, ""
