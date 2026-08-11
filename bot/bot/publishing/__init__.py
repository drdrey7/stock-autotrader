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


def publish_system_status(settings: Settings, last_data_update: str | None = None) -> dict:
    """Publish runtime status without fabricating market-data freshness.

    ``last_data_update`` must come from the last successful market-data update;
    when unknown it is omitted rather than set to the heartbeat timestamp.
    """
    from publisher import client

    degraded = bool(settings.check_secrets())
    payload = {
        "engine": _public_engine_status(settings),
        "apiHealth": "degraded" if degraded else "healthy",
    }
    if last_data_update is not None:
        payload["lastDataUpdate"] = last_data_update
    event = client.make_event("SYSTEM_STATUS", payload)
    return publish_events(settings, [event])
