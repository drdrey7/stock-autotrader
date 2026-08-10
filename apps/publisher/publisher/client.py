"""Stock Autotrader publisher client.

Sends normalized public events to the protected ingest endpoint
(POST /ingest/events) signed with HMAC-SHA256.

Stdlib only — runs on the VPS without extra dependencies.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import urllib.request
from datetime import datetime, timezone
from typing import Any


def sign(secret: str, body: bytes) -> str:
    """Return the X-Ingest-Signature value for a raw request body."""
    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).digest()
    return "sha256=" + digest.hex()


def publish(endpoint: str, secret: str, events: list[dict[str, Any]], timeout: int = 30) -> dict[str, Any]:
    """Publish a batch of events. Raises on HTTP errors; returns the ingest response."""
    body = json.dumps({"events": events}).encode("utf-8")
    request = urllib.request.Request(endpoint, data=body, method="POST")
    request.add_header("Content-Type", "application/json")
    request.add_header("X-Ingest-Signature", sign(secret, body))
    request.add_header("X-Ingest-Timestamp", datetime.now(timezone.utc).isoformat())
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def make_event(event_type: str, payload: dict[str, Any], event_id: str | None = None) -> dict[str, Any]:
    """Build a normalized event envelope."""
    return {
        "type": event_type,
        "event_id": event_id or f"{event_type.lower()}-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')}",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "payload": payload,
    }
