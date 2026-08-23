"""Alpha Vantage provider client — generic multi-key, quota-aware, paced.

Design points (locked by the 2026-08-19 live POC and official docs):

- Free tier: 25 requests/day per key. Multiple keys are legitimate separate
  entitlements and are accounted per key — the tool NEVER rotates keys to
  bypass a single key's quota; it simply stops once every key is exhausted.
- Soft pacing: back-to-back requests return ``{"Information": ...}``
  (empirically, ~13s gaps succeed). A key that returns Information is marked
  throttled for the rest of the run (circuit breaker) — one HTTP debit, no
  same-key retry storm. Other keys may still be tried once.
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


class ThrottleExhaustedError(ProviderError):
    """Every available key returned Information throttle this run.

    Distinct from quota: the run should stop and checkpoint without marking
    the current symbol as a permanent/ticker-specific error.
    """


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
        # Per-run circuit breaker: keys that returned Information this run are
        # not reused (avoids 10-request throttle burn loops).
        self._throttled_keys: set[int] = set()
        self.requests_this_run = 0
        self.throttle_retries_this_run = 0
        self.quota_hits_this_run: list[int] = []
        # Structured attempt log for tests/operators (no secrets).
        self.attempt_log: list[dict[str, Any]] = []

    # ------------------------------------------------------------------ utils

    def _record_attempt(
        self,
        *,
        endpoint: str,
        symbol: str,
        key_index: int | None,
        attempt: int,
        result: str,
    ) -> None:
        entry = {
            "endpoint": endpoint,
            "symbol": symbol,
            "key_index": key_index,
            "attempt": attempt,
            "result": result,
        }
        self.attempt_log.append(entry)
        # JSON line — indexes only, never key material.
        logger.info(
            json.dumps(
                {
                    "event": "provider_attempt",
                    **entry,
                    "requests_this_run": self.requests_this_run,
                },
                sort_keys=True,
            )
        )

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
            if index not in exclude
            and index not in self._throttled_keys
            and self._ledger.remaining(index) > 0
        ]
        if not candidates:
            return None
        offset = self.requests_this_run % len(candidates)
        return candidates[offset]

    def _endpoint_name(self, params: dict) -> str:
        function = str(params.get("function") or "UNKNOWN")
        if function == "TIME_SERIES_WEEKLY":
            return "WEEKLY"
        if function == "SPLITS":
            return "SPLITS"
        return function

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
        key has budget left, ThrottleExhaustedError when every key was
        throttled this run, AllKeysFailedError when every key failed
        transiently, ProviderError for non-retryable provider messages.
        """
        endpoint = self._endpoint_name(params)
        symbol = str(params.get("symbol") or "")
        failed_keys: set[int] = set()
        # One attempt per key is enough for throttle (circuit breaker). Allow a
        # small extra bound for non-throttle transients so we never approach the
        # old keys*(max_retries+2) Information burn loop.
        max_attempts = max(len(self._keys) * 2, 1)
        attempt = 0

        def _no_key_available() -> None:
            """Raise the most accurate terminal error when no key can be tried."""
            usable = [
                i for i in range(len(self._keys))
                if i not in failed_keys
                and i not in self._throttled_keys
                and self._ledger.remaining(i) > 0
            ]
            assert not usable  # caller only invokes when _next_key_index is None
            # Provider-wide throttle: stop the run; do not look like a ticker error.
            if self._throttled_keys and not any(
                i not in self._throttled_keys and self._ledger.remaining(i) > 0
                for i in range(len(self._keys))
            ):
                self._record_attempt(
                    endpoint=endpoint, symbol=symbol, key_index=None,
                    attempt=attempt, result="throttled",
                )
                raise ThrottleExhaustedError(
                    f"provider throttle on {len(self._throttled_keys)} key(s)"
                )
            if self.quota_hits_this_run or not any(
                self._ledger.remaining(i) > 0 for i in range(len(self._keys))
            ):
                self._record_attempt(
                    endpoint=endpoint, symbol=symbol, key_index=None,
                    attempt=attempt, result="quota",
                )
                n = len(self.quota_hits_this_run) or len(self._keys)
                raise QuotaExhaustedError(
                    f"provider daily quota reached on {n} key(s)"
                    if self.quota_hits_this_run
                    else "all Alpha Vantage keys out of daily budget"
                )
            if failed_keys:
                self._record_attempt(
                    endpoint=endpoint, symbol=symbol, key_index=None,
                    attempt=attempt, result="http_error",
                )
                raise AllKeysFailedError("all keys failed transiently")
            self._record_attempt(
                endpoint=endpoint, symbol=symbol, key_index=None,
                attempt=attempt, result="quota",
            )
            raise QuotaExhaustedError("all Alpha Vantage keys out of daily budget")

        for _ in range(max_attempts):
            index = self._next_key_index(failed_keys)
            if index is None:
                _no_key_available()
                raise RuntimeError("unreachable")  # pragma: no cover

            attempt += 1
            try:
                _status, payload = self._request(params, index)
                self.requests_this_run += 1
                self._ledger.mark_used(index, 1)
            except InvalidKeyError:
                failed_keys.add(index)
                self._record_attempt(
                    endpoint=endpoint, symbol=symbol, key_index=index,
                    attempt=attempt, result="http_error",
                )
                continue
            except ProviderError:
                failed_keys.add(index)
                self._record_attempt(
                    endpoint=endpoint, symbol=symbol, key_index=index,
                    attempt=attempt, result="http_error",
                )
                continue

            # AV returns HTTP 200 for informational payloads — classify here.
            # A provider payload must be a JSON object; anything else (a
            # string, a bare array, garbage) is never market data.
            if not isinstance(payload, dict):
                self._record_attempt(
                    endpoint=endpoint, symbol=symbol, key_index=index,
                    attempt=attempt, result="http_error",
                )
                raise ProviderError("unexpected payload shape: not a JSON object")
            if "Note" in payload:
                self.quota_hits_this_run.append(index)
                self._ledger.mark_exhausted(index)
                failed_keys.add(index)
                self._record_attempt(
                    endpoint=endpoint, symbol=symbol, key_index=index,
                    attempt=attempt, result="note",
                )
                continue
            if "Information" in payload:
                # Circuit breaker: count the real HTTP request, retire this
                # key for the rest of the run, try another key once.
                self.throttle_retries_this_run += 1
                self._throttled_keys.add(index)
                self._record_attempt(
                    endpoint=endpoint, symbol=symbol, key_index=index,
                    attempt=attempt, result="information",
                )
                continue
            if "Error Message" in payload:
                message = str(payload["Error Message"])[:300]
                if "apikey" in message.lower():
                    failed_keys.add(index)
                    self._record_attempt(
                        endpoint=endpoint, symbol=symbol, key_index=index,
                        attempt=attempt, result="http_error",
                    )
                    continue
                self._record_attempt(
                    endpoint=endpoint, symbol=symbol, key_index=index,
                    attempt=attempt, result="http_error",
                )
                raise ProviderError(f"provider message: {message}")
            if not payload:
                self._record_attempt(
                    endpoint=endpoint, symbol=symbol, key_index=index,
                    attempt=attempt, result="http_error",
                )
                raise ProviderError("empty payload")
            self._record_attempt(
                endpoint=endpoint, symbol=symbol, key_index=index,
                attempt=attempt, result="data",
            )
            return index, payload

        # Bound exhausted without success.
        _no_key_available()
        raise AllKeysFailedError("all keys failed transiently")  # pragma: no cover
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
