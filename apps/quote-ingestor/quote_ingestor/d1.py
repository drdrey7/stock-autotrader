"""Cloudflare D1 writer via the HTTP API (no wrangler, no subprocess).

``latest_quotes`` stays near 50 rows: every flush runs ONE HTTP request with a
single multi-VALUES UPSERT statement (one row per changed symbol, never
appending rows/snapshots). D1's HTTP API accepts exactly ONE statement object
per request — arrays of statements are rejected with HTTP 400
("Expected object, received array"), verified empirically on this account.

Race rule (REST collector still runs during the transition window): the
UPSERT carries ``WHERE excluded.provider_timestamp >=
latest_quotes.provider_timestamp``. ``provider_timestamp`` is stored as ISO
8601 UTC in both writers, so a lexicographic compare is chronological: an
older REST response can never regress a newer WebSocket quote (and vice
versa).

Only the WebSocket-provided fields are written: symbol, price, provider
(finnhub-websocket), provider_timestamp (trade time) and updated_at (flush
time). previous_close / day_high / day_low / day_open are PRESERVED as
last-known-good from the existing row; change_abs/change_pct are recomputed
from the stored previous_close when it is valid, otherwise preserved.
"""

from __future__ import annotations

import json
import logging
import random
import time
import urllib.error
import urllib.request
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger("quote_ingestor.d1")

D1_ACCOUNT_QUERY_ENDPOINT = (
    "https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}/query"
)

# One VALUES row of the multi-VALUES UPSERT. Only the fields the WebSocket can
# provide are written; everything else is preserved as last-known-good.
_UPSERT_ROW_SQL = "(?, ?, 0, 0, NULL, NULL, NULL, NULL, 'finnhub-websocket', ?, ?)"

_UPSERT_TAIL_SQL = """
ON CONFLICT(symbol) DO UPDATE SET
  price = excluded.price,
  change_abs = CASE
    WHEN latest_quotes.previous_close IS NOT NULL AND latest_quotes.previous_close > 0
    THEN excluded.price - latest_quotes.previous_close
    ELSE latest_quotes.change_abs END,
  change_pct = CASE
    WHEN latest_quotes.previous_close IS NOT NULL AND latest_quotes.previous_close > 0
    THEN (excluded.price / latest_quotes.previous_close - 1) * 100
    ELSE latest_quotes.change_pct END,
  day_high = latest_quotes.day_high,
  day_low = latest_quotes.day_low,
  day_open = latest_quotes.day_open,
  previous_close = latest_quotes.previous_close,
  provider = excluded.provider,
  provider_timestamp = excluded.provider_timestamp,
  updated_at = excluded.updated_at
WHERE excluded.provider_timestamp >= latest_quotes.provider_timestamp
"""


def build_upsert_sql(row_count: int) -> str:
    if row_count <= 0:
        raise ValueError("row_count must be positive")
    values = ",\n  ".join([_UPSERT_ROW_SQL] * row_count)
    return (
        "INSERT INTO latest_quotes\n"
        "  (symbol, price, change_abs, change_pct, day_high, day_low, day_open, previous_close, provider, provider_timestamp, updated_at)\n"
        f"VALUES\n  {values}\n"
        f"{_UPSERT_TAIL_SQL}"
    )


APP_META_UPSERT_SQL = (
    "INSERT INTO app_meta (key, value) VALUES (?, ?) "
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
)

HEALTH_META_KEY = "quoteIngestorHealth"


@dataclass
class D1WriteResult:
    """Per-flush result aligned with the changed symbols submitted."""

    written: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)
    total_changes: int = 0
    http_status: int = 0
    error: str | None = None


def _chunks(items: list, size: int) -> Iterable[list]:
    for index in range(0, len(items), size):
        yield items[index:index + size]


def iso_from_ms(timestamp_ms: int) -> str:
    """UTC ISO 8601 with milliseconds for a trade epoch-ms timestamp."""
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(timestamp_ms / 1000)) + f".{int(timestamp_ms % 1000):03d}Z"


def _now_iso() -> str:
    return iso_from_ms(int(time.time() * 1000))


class D1Client:
    """Bounded-retry client for the Cloudflare D1 HTTP query API."""

    def __init__(
        self,
        api_token: str,
        account_id: str,
        database_id: str,
        max_retries: int = 3,
        retry_base_seconds: float = 1.0,
        request_timeout_seconds: float = 20.0,
        batch_max_rows: int = 20,
        random_source: random.Random | None = None,
        urlopen: Any | None = None,
    ) -> None:
        self._token = api_token
        self._account_id = account_id
        self._database_id = database_id
        self._max_retries = max_retries
        self._retry_base = retry_base_seconds
        self._timeout = request_timeout_seconds
        self._batch_max_rows = batch_max_rows
        self._rnd = random_source or random.Random()
        self._urlopen = urlopen or (lambda req, timeout: urllib.request.urlopen(req, timeout=timeout))
        # Tracked for health (counts, not values).
        self.request_count = 0
        self.error_count = 0
        self.last_error: str | None = None

    # ------------------------------------------------------------------ HTTP

    def _post(self, body: dict) -> tuple[int, dict]:
        """POST a single statement object to the D1 query API.

        Returns (status, json). Raises on network/timeout errors (caller
        retries); HTTP statuses must still yield a parsed body or raise.
        """
        url = D1_ACCOUNT_QUERY_ENDPOINT.format(
            account_id=self._account_id, database_id=self._database_id
        )
        request = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self._token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        self.request_count += 1
        try:
            with self._urlopen(request, self._timeout) as response:
                payload = response.read().decode("utf-8")
                return response.status, json.loads(payload) if payload else {}
        except urllib.error.HTTPError as exc:
            payload = exc.read().decode("utf-8", errors="replace")
            try:
                return exc.code, json.loads(payload) if payload else {}
            except json.JSONDecodeError:
                return exc.code, {}
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise D1TransportError(f"request failed: {exc.__class__.__name__}") from exc

    # ---------------------------------------------------------------- writes

    def upsert_quotes(self, rows: list[tuple[str, float, int]]) -> D1WriteResult:
        """One multi-VALUES UPSERT per changed-symbol chunk.

        ``rows``: (symbol, price, as_of_ms). On success the caller ack's the
        returned ``written`` symbols; failures stay pending for the next flush.
        A single multi-VALUES statement is atomic — chunks are very rare (the
        universe is 50 symbols and the D1 free write budget is per-row).
        """
        if not rows:
            return D1WriteResult()
        updated_at = _now_iso()
        aggregated = D1WriteResult()
        for chunk in _chunks(rows, self._batch_max_rows):
            symbols = [symbol for symbol, _, _ in chunk]
            params: list[object] = []
            for symbol, price, as_of_ms in chunk:
                params.extend([symbol, price, iso_from_ms(as_of_ms), updated_at])
            result = self._run_object(build_upsert_sql(len(chunk)), params, symbols)
            aggregated.written.extend(result.written)
            aggregated.failed.extend(result.failed)
            aggregated.total_changes += result.total_changes
            if result.error:
                aggregated.error = result.error
                aggregated.http_status = result.http_status
        return aggregated

    def write_health(self, record: dict) -> bool:
        """Mirror the ingestor health snapshot into app_meta (one tiny row)."""
        result = self._run_object(
            APP_META_UPSERT_SQL,
            [HEALTH_META_KEY, json.dumps(record, sort_keys=True)],
            ["__health__"],
        )
        if result.failed:
            self.error_count += 1
            return False
        return result.written == ["__health__"]

    def read_latest_quotes_count(self) -> dict:
        """Read-only population check (validation/smoke): SELECT COUNT(*) and
        recent-provider breakdown. Never used on the hot path."""
        status, payload = self._post({
            "sql": "SELECT symbol, provider, provider_timestamp FROM latest_quotes ORDER BY symbol",
        })
        if status != 200 or not payload.get("success"):
            raise D1QueryError(f"read failed HTTP {status}")
        rows = (payload.get("result") or [{}])[0].get("results", [])
        return {"total": len(rows), "rows": rows}

    # -------------------------------------------------------------- internals

    def _run_object(self, sql: str, params: list[object], symbols: list[str]) -> D1WriteResult:
        attempt = 0
        while True:
            try:
                status, payload = self._post({"sql": sql, "params": params})
            except D1TransportError as exc:
                self.error_count += 1
                self.last_error = str(exc)[:300]
                if attempt >= self._max_retries:
                    return self._failure_result(symbols, 0, str(exc)[:300])
                self._sleep_before_retry(attempt)
                attempt += 1
                continue

            if status == 200 and payload.get("success"):
                result = D1WriteResult(http_status=200)
                statements = payload.get("result") or []
                meta = (statements[0] if statements else {}).get("meta") or {}
                result.total_changes = int(meta.get("changes", 0) or 0)
                result.written = list(symbols)  # atomic statement: all landed
                return result

            message = self._error_message(status, payload)
            if status in (400, 401, 403, 404, 409):
                # Configuration errors: never retried — retrying only spams.
                self.error_count += 1
                self.last_error = message
                return self._failure_result(symbols, status, message)
            # 429 / 5xx / unknown: bounded retry with backoff.
            self.error_count += 1
            self.last_error = message
            if attempt >= self._max_retries:
                return self._failure_result(symbols, status, message)
            self._sleep_before_retry(attempt)
            attempt += 1

    def _sleep_before_retry(self, attempt: int) -> None:
        delay = min(self._retry_base * (2 ** attempt), 30.0) * (1 + self._rnd.uniform(-0.2, 0.2))
        time.sleep(max(0.0, delay))

    @staticmethod
    def _error_message(status: int, payload: dict) -> str:
        errors = payload.get("errors") or []
        detail = ""
        if isinstance(errors, list) and errors:
            first = errors[0]
            if isinstance(first, dict):
                detail = str(first.get("message") or first)[:200]
            else:
                detail = str(first)[:200]
        return f"HTTP {status}" + (f": {detail}" if detail else "")

    @staticmethod
    def _failure_result(symbols: list[str], status: int, error: str) -> D1WriteResult:
        return D1WriteResult(written=[], failed=list(symbols), http_status=status, error=error[:300])


class D1TransportError(RuntimeError):
    """Network/timeout layer failure (retryable)."""


class D1QueryError(RuntimeError):
    """Non-retryable D1 API error surfaced for operators."""
