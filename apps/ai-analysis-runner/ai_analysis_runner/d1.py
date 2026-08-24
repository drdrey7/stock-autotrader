"""Cloudflare D1 REST client with execution-token compare-and-swap writes."""

from __future__ import annotations

import urllib.request
from collections.abc import Callable
from typing import Any

from .constants import ENGINE_DB_VERSION, ENGINE_NAME, RESULT_SCHEMA_VERSION
from .http import HttpError, post_json
from .models import Analysis

D1_ENDPOINT = "https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}/query"
ANALYSIS_COLUMNS = (
    "id", "symbol", "status", "analysis_date", "attempt_count", "execution_token",
    "execution_message_id", "heartbeat_at",
)

# Documented transient Cloudflare D1 conditions (see D1 retry documentation).
# Classification is message-based on purpose: Cloudflare does not document a
# numeric retryable D1 error code, so no numeric code set is used.
_TRANSIENT_D1_MESSAGES = (
    "network connection lost",
    "d1 db reset because its code was updated",
    "internal error while connecting to d1",
    "storage operation caused object to be reset",
    "transient issue on remote node",
)


class D1ProtocolError(RuntimeError):
    """D1 returned a success response that violated the expected shape."""


class D1Client:
    def __init__(
        self,
        api_token: str,
        account_id: str,
        database_id: str,
        *,
        timeout_seconds: float,
        max_attempts: int,
        opener: Callable[..., Any] = urllib.request.urlopen,
    ) -> None:
        self._token = api_token
        self._url = D1_ENDPOINT.format(account_id=account_id, database_id=database_id)
        self._timeout = timeout_seconds
        self._max_attempts = max_attempts
        self._opener = opener

    def _query(self, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
        payload = post_json(
            self._url,
            self._token,
            {"sql": sql, "params": params or []},
            timeout_seconds=self._timeout,
            max_attempts=self._max_attempts,
            opener=self._opener,
        )
        if payload.get("success") is not True:
            errors = payload.get("errors")
            first_error = errors[0] if isinstance(errors, list) and errors and isinstance(errors[0], dict) else {}
            upstream_code = first_error.get("code") if isinstance(first_error, dict) else None
            upstream_message = first_error.get("message") if isinstance(first_error, dict) else None
            retryable = False
            if isinstance(upstream_message, str):
                lowered = upstream_message.lower()
                retryable = any(marker in lowered for marker in _TRANSIENT_D1_MESSAGES)
            raise HttpError(
                "d1_query_failed",
                retryable=retryable,
                upstream_code=upstream_code,
                upstream_message=upstream_message,
            )
        result = payload.get("result")
        if not isinstance(result, list) or len(result) != 1 or not isinstance(result[0], dict):
            raise D1ProtocolError("d1_result_invalid")
        rows = result[0].get("results", [])
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise D1ProtocolError("d1_rows_invalid")
        return rows

    @staticmethod
    def _analysis(row: dict[str, Any]) -> Analysis:
        required_strings = ("id", "symbol", "status", "analysis_date")
        if any(not isinstance(row.get(key), str) for key in required_strings):
            raise D1ProtocolError("d1_analysis_invalid")
        attempt_count = row.get("attempt_count")
        if isinstance(attempt_count, bool) or not isinstance(attempt_count, int) or attempt_count < 0:
            raise D1ProtocolError("d1_analysis_invalid")
        optional = ("execution_token", "execution_message_id", "heartbeat_at")
        if any(row.get(key) is not None and not isinstance(row.get(key), str) for key in optional):
            raise D1ProtocolError("d1_analysis_invalid")
        return Analysis(
            id=row["id"],
            symbol=row["symbol"],
            status=row["status"],
            analysis_date=row["analysis_date"],
            attempt_count=attempt_count,
            execution_token=row.get("execution_token"),
            execution_message_id=row.get("execution_message_id"),
            heartbeat_at=row.get("heartbeat_at"),
        )

    def get_analysis(self, analysis_id: str) -> Analysis | None:
        rows = self._query(
            f"SELECT {', '.join(ANALYSIS_COLUMNS)} FROM ai_analyses WHERE id = ?1 LIMIT 1",
            [analysis_id],
        )
        return self._analysis(rows[0]) if rows else None

    def claim(
        self,
        analysis_id: str,
        message_id: str,
        execution_token: str,
        now: str,
        stale_before: str,
    ) -> Analysis | None:
        rows = self._query(
            f"""
            UPDATE ai_analyses
            SET status = 'running',
                started_at = COALESCE(started_at, ?4),
                attempt_count = attempt_count + 1,
                execution_token = ?3,
                execution_message_id = ?2,
                heartbeat_at = ?4,
                safe_error_code = NULL,
                safe_error_message = NULL,
                updated_at = ?4
            WHERE id = ?1
              AND (
                status = 'queued'
                OR (status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at <= ?5))
              )
            RETURNING {', '.join(ANALYSIS_COLUMNS)}
            """.strip(),
            [analysis_id, message_id, execution_token, now, stale_before],
        )
        return self._analysis(rows[0]) if rows else None

    def heartbeat(self, analysis_id: str, message_id: str, execution_token: str, now: str) -> bool:
        rows = self._query(
            """
            UPDATE ai_analyses
            SET heartbeat_at = ?4, updated_at = ?4
            WHERE id = ?1 AND status = 'running'
              AND execution_message_id = ?2 AND execution_token = ?3
            RETURNING id
            """.strip(),
            [analysis_id, message_id, execution_token, now],
        )
        return bool(rows)

    def requeue(
        self,
        analysis_id: str,
        message_id: str,
        execution_token: str,
        now: str,
        safe_error_code: str,
        safe_error_message: str,
    ) -> bool:
        rows = self._query(
            """
            UPDATE ai_analyses
            SET status = 'queued',
                execution_token = NULL,
                execution_message_id = NULL,
                heartbeat_at = NULL,
                safe_error_code = ?4,
                safe_error_message = ?5,
                updated_at = ?6
            WHERE id = ?1 AND status = 'running'
              AND execution_message_id = ?2 AND execution_token = ?3
            RETURNING id
            """.strip(),
            [analysis_id, message_id, execution_token, safe_error_code, safe_error_message, now],
        )
        return bool(rows)

    def complete(
        self,
        analysis_id: str,
        message_id: str,
        execution_token: str,
        result_json: str,
        completed_at: str,
        valid_until: str,
    ) -> bool:
        rows = self._query(
            """
            UPDATE ai_analyses
            SET status = 'completed',
                engine = ?4,
                engine_version = ?5,
                result_schema_version = ?6,
                result_json = ?7,
                completed_at = ?8,
                valid_until = ?9,
                heartbeat_at = ?8,
                safe_error_code = NULL,
                safe_error_message = NULL,
                updated_at = ?8
            WHERE id = ?1 AND status = 'running'
              AND execution_message_id = ?2 AND execution_token = ?3
            RETURNING id
            """.strip(),
            [
                analysis_id, message_id, execution_token, ENGINE_NAME, ENGINE_DB_VERSION,
                RESULT_SCHEMA_VERSION, result_json, completed_at, valid_until,
            ],
        )
        return bool(rows)

    def fail(
        self,
        analysis_id: str,
        message_id: str,
        execution_token: str,
        now: str,
        safe_error_code: str,
        safe_error_message: str,
    ) -> bool:
        """Make the definitive transition; the backend-owned D1 trigger refunds."""

        rows = self._query(
            """
            UPDATE ai_analyses
            SET status = 'failed',
                completed_at = NULL,
                valid_until = NULL,
                result_json = NULL,
                heartbeat_at = ?4,
                safe_error_code = ?5,
                safe_error_message = ?6,
                updated_at = ?4
            WHERE id = ?1 AND status = 'running'
              AND execution_message_id = ?2 AND execution_token = ?3
            RETURNING id
            """.strip(),
            [analysis_id, message_id, execution_token, now, safe_error_code, safe_error_message],
        )
        return bool(rows)
