"""Minimal JSON logging with field allow-listing and secret redaction.

Operational fields only. Prompts, raw model responses, report bodies,
Queue lease IDs, auth headers, and API keys are NEVER logged.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from typing import Any

_LOGGER = logging.getLogger("ai_analysis_runner")
_LOGGER.addHandler(logging.NullHandler())
_LOGGER.propagate = False

_SECRET_MARKERS = frozenset({
    "token", "secret", "password", "api_key", "authorization", "auth",
    "lease_id", "prompt", "response", "raw_response", "model_response",
    "report", "report_body", "result", "body", "content", "raw",
})

_NEVER_LOG_FIELDS = frozenset({
    "prompt", "response", "raw_response", "model_response", "report",
    "report_body", "result", "lease_id", "auth", "authorization",
    "raw", "body", "content", "api_key", "token", "secret", "password",
})

_ALLOWED_FIELDS = frozenset({
    "analysis_id", "attempt", "code", "delay_seconds", "elapsed_ms",
    "event", "level", "message_id", "provider", "status", "symbol",
    "timestamp", "error_type", "error_code", "queue_depth",
    "heartbeat_age_seconds", "stale", "reused", "checkpoint",
})


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = record.msg if isinstance(record.msg, dict) else {"event": "log", "message": str(record.msg)}
        return json.dumps(payload, separators=(",", ":"), sort_keys=True, ensure_ascii=False)


def configure_logging() -> None:
    handler = logging.StreamHandler()
    handler.setFormatter(_JsonFormatter())
    _LOGGER.handlers[:] = [handler]
    _LOGGER.setLevel(logging.INFO)
    _LOGGER.propagate = False


def _safe_value(key: str, value: Any) -> str | int | float | bool | None:
    key_lower = key.lower()
    if key_lower in _NEVER_LOG_FIELDS:
        return "<forbidden>"
    if any(marker in key_lower for marker in _SECRET_MARKERS):
        return "<redacted>"
    if value is None or isinstance(value, (int, float, bool)):
        return value
    text = str(value).replace("\n", " ").replace("\r", " ")
    return text[:256]


def log_event(event: str, *, level: int = logging.INFO, **fields: Any) -> None:
    payload: dict[str, Any] = {
        "timestamp": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "level": logging.getLevelName(level).lower(),
        "event": event[:96],
    }
    for key, value in fields.items():
        if key in _NEVER_LOG_FIELDS:
            continue
        if key in _ALLOWED_FIELDS and key not in {"event", "level", "timestamp"}:
            payload[key] = _safe_value(key, value)
    _LOGGER.log(level, payload)
