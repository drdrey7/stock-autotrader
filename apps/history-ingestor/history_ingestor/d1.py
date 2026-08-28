"""Cloudflare D1 writer via the HTTP API (no wrangler, no subprocess).

Same transport as ``apps/quote-ingestor`` (one statement object per request,
bounded retries, non-retryable 4xx config errors). Writes are idempotent:

- ``weekly_prices``: multi-VALUES UPSERT keyed by (symbol, week_end_date) —
  re-running the same data never duplicates rows; newer fetches overwrite.
- ``technical_metrics``: one row per symbol, UPSERTed.
- ``app_meta``: bootstrap checkpoint + maintenance reports (one JSON blob).

The D1 HTTP API accepts exactly ONE statement object per request — arrays of
statements are rejected (verified empirically on this account in PR #65).
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

logger = logging.getLogger("history_ingestor.d1")

D1_ACCOUNT_QUERY_ENDPOINT = (
    "https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}/query"
)

# One VALUES row of the weekly_prices UPSERT.
_WEEKLY_ROW_SQL = (
    "(?, ?, ?, ?, ?, ?, ?, ?, ?, 'alpha-vantage', ?)"
)

_WEEKLY_UPSERT_TAIL_SQL = """
ON CONFLICT(symbol, week_end_date) DO UPDATE SET
  raw_open = excluded.raw_open,
  raw_high = excluded.raw_high,
  raw_low = excluded.raw_low,
  raw_close = excluded.raw_close,
  volume = excluded.volume,
  split_adjustment_factor = excluded.split_adjustment_factor,
  split_adjusted_close = excluded.split_adjusted_close,
  source = excluded.source,
  source_fetched_at = excluded.source_fetched_at
"""

_METRICS_UPSERT_SQL = """
INSERT INTO technical_metrics
  (symbol, anchor_week, completed_weeks_available, sum_199, anchor_close,
   closed_sma_200w, historical_data_as_of, calculated_at, status, source)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'alpha-vantage')
ON CONFLICT(symbol) DO UPDATE SET
  anchor_week = excluded.anchor_week,
  completed_weeks_available = excluded.completed_weeks_available,
  sum_199 = excluded.sum_199,
  anchor_close = excluded.anchor_close,
  closed_sma_200w = excluded.closed_sma_200w,
  historical_data_as_of = excluded.historical_data_as_of,
  calculated_at = excluded.calculated_at,
  status = excluded.status,
  source = excluded.source
"""

# One VALUES row of the split_events UPSERT (4 bound params + source literal).
_SPLIT_ROW_SQL = "(?, ?, ?, 'alpha-vantage', ?)"

APP_META_UPSERT_SQL = (
    "INSERT INTO app_meta (key, value) VALUES (?, ?) "
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
)

BOOTSTRAP_STATE_META_KEY = "historyBootstrapState"
MAINTENANCE_REPORT_META_KEY = "historyMaintenanceReport"
MAINTENANCE_STATE_META_KEY = "historyMaintenanceState"


def build_weekly_upsert_sql(row_count: int) -> str:
    if row_count <= 0:
        raise ValueError("row_count must be positive")
    values = ",\n  ".join([_WEEKLY_ROW_SQL] * row_count)
    return (
        "INSERT INTO weekly_prices\n"
        "  (symbol, week_end_date, raw_open, raw_high, raw_low, raw_close, volume,\n"
        "   split_adjustment_factor, split_adjusted_close, source, source_fetched_at)\n"
        f"VALUES\n  {values}\n"
        f"{_WEEKLY_UPSERT_TAIL_SQL}"
    )


def build_split_upsert_sql(row_count: int) -> str:
    """Idempotent multi-VALUES UPSERT of split_events rows.

    Each row binds 4 params (symbol, effective_date, split_factor,
    source_fetched_at; source is a literal), so the default batch of 10 stays
    well under the D1 100-bound-variable ceiling (10 x 4 = 40).
    """
    if row_count <= 0:
        raise ValueError("row_count must be positive")
    values = ",\n  ".join([_SPLIT_ROW_SQL] * row_count)
    return (
        "INSERT INTO split_events\n"
        "  (symbol, effective_date, split_factor, source, source_fetched_at)\n"
        f"VALUES\n  {values}\n"
        "ON CONFLICT(symbol, effective_date) DO UPDATE SET\n"
        "  split_factor = excluded.split_factor,\n"
        "  source = excluded.source,\n"
        "  source_fetched_at = excluded.source_fetched_at"
    )


def _chunks(items: list, size: int) -> Iterable[list]:
    for index in range(0, len(items), size):
        yield items[index:index + size]


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"


@dataclass
class D1WriteResult:
    written: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)
    total_changes: int = 0
    http_status: int = 0
    error: str | None = None


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
        batch_max_rows: int = 10,
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
        self.request_count = 0
        self.error_count = 0
        self.last_error: str | None = None

    # ------------------------------------------------------------------ HTTP

    def _post(self, body: dict) -> tuple[int, dict]:
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

    def upsert_weekly_rows(
        self,
        rows: list[tuple[str, str, float, float, float, float, int, float, float, str]],
    ) -> D1WriteResult:
        """Idempotent multi-VALUES UPSERT of weekly rows.

        ``rows``: (symbol, week_end_date, raw_open, raw_high, raw_low,
        raw_close, volume, split_adjustment_factor, split_adjusted_close,
        source_fetched_at).
        """
        if not rows:
            return D1WriteResult()
        aggregated = D1WriteResult()
        for chunk in _chunks(rows, self._batch_max_rows):
            symbols = [row[0] for row in chunk]
            params: list[object] = []
            for row in chunk:
                params.extend(row)
            result = self._run_object(build_weekly_upsert_sql(len(chunk)), params, symbols)
            aggregated.written.extend(result.written)
            aggregated.failed.extend(result.failed)
            aggregated.total_changes += result.total_changes
            if result.error:
                aggregated.error = result.error
                aggregated.http_status = result.http_status
        return aggregated

    def upsert_technical_metrics(
        self,
        metrics: dict,
    ) -> D1WriteResult:
        """One UPSERT per symbol's technical_metrics row (50 rows max)."""
        params: list[object] = [
            metrics["symbol"],
            metrics["anchor_week"],
            int(metrics["completed_weeks_available"]),
            metrics.get("sum_199"),
            metrics.get("anchor_close"),
            metrics.get("closed_sma_200w"),
            metrics.get("historical_data_as_of"),
            metrics.get("calculated_at"),
            metrics["status"],
        ]
        return self._run_object(_METRICS_UPSERT_SQL, params, [metrics["symbol"]])

    def upsert_split_events(
        self,
        rows: list[tuple[str, str, float, str]],
    ) -> D1WriteResult:
        """Idempotent split_events UPSERT (batched chunks of rows).

        ``rows``: (symbol, effective_date, split_factor, source_fetched_at).
        """
        if not rows:
            return D1WriteResult()
        aggregated = D1WriteResult()
        for chunk in _chunks(rows, self._batch_max_rows):
            symbols = [row[0] for row in chunk]
            params: list[object] = []
            for row in chunk:
                params.extend(row)
            result = self._run_object(build_split_upsert_sql(len(chunk)), params, symbols)
            aggregated.written.extend(result.written)
            aggregated.failed.extend(result.failed)
            aggregated.total_changes += result.total_changes
            if result.error:
                aggregated.error = result.error
                aggregated.http_status = result.http_status
        return aggregated

    def delete_extra_split_events(self, symbol: str, keep_dates: list[str]) -> D1WriteResult:
        """Remove stored split events for ``symbol`` that are no longer present
        in the provider history (a corrected/removed split).

        ``keep_dates`` = effective dates that must survive. Follows the
        "replace/reconcile" rule: upsert the new set first, then delete extras
        — a crash between the two is self-healing on the next run, never
        destructive (stale rows are harmless, corrected rows are recomputed).
        """
        if keep_dates:
            placeholders = ", ".join(["?"] * len(keep_dates))
            sql = (
                "DELETE FROM split_events WHERE symbol = ? "
                f"AND effective_date NOT IN ({placeholders})"
            )
            params: list[object] = [symbol, *keep_dates]
        else:
            sql = "DELETE FROM split_events WHERE symbol = ?"
            params = [symbol]
        result = self._run_object(sql, params, [symbol])
        return result

    def write_app_meta(self, key: str, value: dict) -> bool:
        """Upsert one JSON app_meta value and report whether it was durable."""
        result = self._run_object(
            APP_META_UPSERT_SQL,
            [key, json.dumps(value, sort_keys=True)],
            [f"__meta__{key}"],
        )
        if result.failed:
            self.error_count += 1
            return False
        return True

    def delete_app_meta(self, key: str) -> bool:
        """Delete one app_meta key idempotently and report write success."""
        result = self._run_object(
            "DELETE FROM app_meta WHERE key = ?",
            [key],
            [f"__meta__{key}"],
        )
        if result.failed:
            self.error_count += 1
            return False
        return True

    # ----------------------------------------------------------------- reads

    def read_app_meta(self, key: str) -> dict | None:
        """Read and strictly decode one JSON app_meta value."""
        status, payload = self._post({
            "sql": "SELECT value FROM app_meta WHERE key = ? LIMIT 1",
            "params": [key],
        })
        if status != 200 or not payload.get("success"):
            raise D1QueryError(f"read failed HTTP {status}")
        rows = (payload.get("result") or [{}])[0].get("results", [])
        if not rows:
            return None
        try:
            parsed = json.loads(rows[0]["value"])
        except (KeyError, TypeError, json.JSONDecodeError) as exc:
            raise D1MalformedMetaError(f"app_meta {key} is not valid JSON") from exc
        if not isinstance(parsed, dict):
            raise D1MalformedMetaError(f"app_meta {key} must contain a JSON object")
        return parsed

    def read_app_meta_prefix(self, prefix: str) -> list[tuple[str, dict]]:
        """Read JSON app_meta rows under ``prefix`` for durable work queues.

        Malformed values are represented as a pending record for the symbol
        encoded in its key.  The recovery consumer can therefore repair a
        corrupt queue entry automatically, while still refusing keys outside
        the canonical universe.  They are never interpreted as provider data.
        """
        status, payload = self._post({
            "sql": "SELECT key, value FROM app_meta WHERE key LIKE ? ORDER BY key",
            "params": [f"{prefix}%"],
        })
        if status != 200 or not payload.get("success"):
            raise D1QueryError(f"read failed HTTP {status}")
        rows = (payload.get("result") or [{}])[0].get("results", [])
        decoded: list[tuple[str, dict]] = []
        for row in rows:
            key = row.get("key") if isinstance(row, dict) else None
            raw = row.get("value") if isinstance(row, dict) else None
            if not isinstance(key, str) or not isinstance(raw, str):
                continue
            try:
                value = json.loads(raw)
            except json.JSONDecodeError:
                value = None
            if not isinstance(value, dict):
                value = {
                    "version": 1,
                    "symbol": key.removeprefix(prefix),
                    "status": "pending",
                    "reason": "invalid_recovery_state",
                    "attempts": 0,
                }
            decoded.append((key, value))
        return decoded

    def read_weekly_summary(self, symbol: str | None = None) -> dict:
        """Read-only coverage query for validation/status (never hot path)."""
        if symbol is None:
            sql = (
                "SELECT symbol, COUNT(*) AS rows, MIN(week_end_date) AS oldest, "
                "MAX(week_end_date) AS newest FROM weekly_prices GROUP BY symbol ORDER BY symbol"
            )
            params: list[object] = []
        else:
            sql = (
                "SELECT symbol, COUNT(*) AS rows, MIN(week_end_date) AS oldest, "
                "MAX(week_end_date) AS newest FROM weekly_prices WHERE symbol = ? GROUP BY symbol"
            )
            params = [symbol]
        status, payload = self._post({"sql": sql, "params": params})
        if status != 200 or not payload.get("success"):
            raise D1QueryError(f"read failed HTTP {status}")
        rows = (payload.get("result") or [{}])[0].get("results", [])
        return {"total_symbols": len(rows), "rows": rows}

    def read_weekly_rows(self, symbol: str) -> list[dict]:
        """All weekly rows for one symbol, ascending (used for reconciliation)."""
        status, payload = self._post({
            "sql": (
                "SELECT symbol, week_end_date, raw_open, raw_high, raw_low, raw_close, "
                "volume, split_adjustment_factor, split_adjusted_close, source, source_fetched_at "
                "FROM weekly_prices WHERE symbol = ? ORDER BY week_end_date"
            ),
            "params": [symbol],
        })
        if status != 200 or not payload.get("success"):
            raise D1QueryError(f"read failed HTTP {status}")
        return (payload.get("result") or [{}])[0].get("results", [])

    def read_technical_metrics(self) -> list[dict]:
        status, payload = self._post({
            "sql": (
                "SELECT symbol, anchor_week, completed_weeks_available, sum_199, anchor_close, "
                "closed_sma_200w, historical_data_as_of, calculated_at, status, source "
                "FROM technical_metrics ORDER BY symbol"
            ),
        })
        if status != 200 or not payload.get("success"):
            raise D1QueryError(f"read failed HTTP {status}")
        return (payload.get("result") or [{}])[0].get("results", [])

    def read_split_events(self, symbol: str) -> list[dict]:
        """All durable split events for one symbol, ascending by effective_date."""
        status, payload = self._post({
            "sql": (
                "SELECT symbol, effective_date, split_factor, source, source_fetched_at "
                "FROM split_events WHERE symbol = ? ORDER BY effective_date"
            ),
            "params": [symbol],
        })
        if status != 200 or not payload.get("success"):
            raise D1QueryError(f"read failed HTTP {status}")
        return (payload.get("result") or [{}])[0].get("results", [])

    def read_all_split_events(self) -> dict[str, list[dict]]:
        """All durable split events, grouped by symbol (maintenance comparison)."""
        status, payload = self._post({
            "sql": (
                "SELECT symbol, effective_date, split_factor, source, source_fetched_at "
                "FROM split_events ORDER BY symbol, effective_date"
            ),
        })
        if status != 200 or not payload.get("success"):
            raise D1QueryError(f"read failed HTTP {status}")
        grouped: dict[str, list[dict]] = {}
        for row in (payload.get("result") or [{}])[0].get("results", []):
            grouped.setdefault(row["symbol"], []).append(row)
        return grouped

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
                result.written = list(symbols)
                return result

            message = self._error_message(status, payload)
            if status in (400, 401, 403, 404, 409):
                self.error_count += 1
                self.last_error = message
                return self._failure_result(symbols, status, message)
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


class D1MalformedMetaError(D1QueryError):
    """A stored app_meta value could not be decoded as a JSON object."""
