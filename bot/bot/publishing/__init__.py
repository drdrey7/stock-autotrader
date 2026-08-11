"""Publishing bridge: bot → D1 ingest (reuses the PR #3 publisher client).

The publisher client lives in apps/publisher (PR #3). The Docker image sets
PYTHONPATH so `from publisher import client` resolves on the VPS.
"""
from __future__ import annotations

import logging

from ..config import Settings

log = logging.getLogger(__name__)


def publish_events(settings: Settings, events: list[dict]) -> dict:
    from publisher import client  # apps/publisher (PYTHONPATH)

    if not settings.ingest_secret:
        raise RuntimeError("INGEST_SECRET not configured")
    return client.publish(settings.ingest_url, settings.ingest_secret, events, timeout=30)


def _public_engine_status(settings: Settings) -> str:
    """Map private runtime health to the public ingest enum."""
    return "delayed" if settings.check_secrets() else "online"


def publish_system_status(settings: Settings) -> dict:
    """Publish a SYSTEM_STATUS event so the public dashboard stays fresh."""
    from publisher import client

    now = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()
    degraded = bool(settings.check_secrets())
    event = client.make_event("SYSTEM_STATUS", {
        "engine": _public_engine_status(settings),
        "nextScan": None,
        "lastDataUpdate": now,
        "apiHealth": "degraded" if degraded else "healthy",
    })
    return publish_events(settings, [event])
