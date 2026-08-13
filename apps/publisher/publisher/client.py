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


def sign(secret: str, body: bytes, timestamp: str) -> str:
    """Return the signature over the exact timestamp and raw request body."""
    signing_payload = timestamp.encode("utf-8") + b"." + body
    digest = hmac.new(secret.encode("utf-8"), signing_payload, hashlib.sha256).digest()
    return "sha256=" + digest.hex()


def publish(endpoint: str, secret: str, events: list[dict[str, Any]], timeout: int = 30) -> dict[str, Any]:
    """Publish a batch of events. Raises on HTTP errors; returns the ingest response."""
    body = json.dumps({"events": events}).encode("utf-8")
    request = urllib.request.Request(endpoint, data=body, method="POST")
    # Browser-like headers: the Cloudflare WAF in front of the worker returns
    # 403/1010 for default urllib user agents even with a valid HMAC signature.
    request.add_header("User-Agent", (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
        "(KHTML, like Gecko) Version/17.4 Safari/605.1.15"
    ))
    request.add_header("Accept", "application/json, text/plain, */*")
    request.add_header("Accept-Language", "en-US,en;q=0.9")
    request.add_header("Content-Type", "application/json")
    timestamp = datetime.now(timezone.utc).isoformat()
    request.add_header("X-Ingest-Signature", sign(secret, body, timestamp))
    request.add_header("X-Ingest-Timestamp", timestamp)
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
