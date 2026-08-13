"""Publishing bridge: bot → D1 ingest (reuses the PR #3 publisher client).

The publisher client lives in apps/publisher (PR #3). The Docker image sets
PYTHONPATH so `from publisher import client` resolves on the VPS.
"""
from __future__ import annotations

import logging

from ..config import Settings
from ..market_data.models import MarketDataSnapshot

log = logging.getLogger(__name__)


def publish_events(settings: Settings, events: list[dict]) -> dict:
    from publisher import client  # apps/publisher (PYTHONPATH)

    if not settings.ingest_secret:
        raise RuntimeError("INGEST_SECRET not configured")
    return client.publish(settings.ingest_url, settings.ingest_secret, events, timeout=30)


def _public_engine_status(settings: Settings) -> str:
    """Map private runtime health to the public ingest enum."""
    return "delayed" if settings.check_secrets() else "online"


def publish_market_data(settings: Settings, snapshot: MarketDataSnapshot) -> dict:
    """Publish a bounded, normalized market-data health snapshot."""
    from publisher import client

    event = client.make_event("MARKET_DATA_UPDATED", snapshot.public_dict())
    result = publish_events(settings, [event])
    if not isinstance(result, dict):
        raise RuntimeError("market-data publication returned an invalid response")
    applied = result.get("applied", [])
    skipped = result.get("skipped", [])
    rejected = result.get("rejected", [])
    if not isinstance(applied, list) or not isinstance(skipped, list) or not isinstance(rejected, list):
        raise RuntimeError("market-data publication returned an invalid acknowledgement")
    if rejected or event["event_id"] not in applied + skipped:
        raise RuntimeError("market-data event was not acknowledged by ingest")
    return result


def publish_system_status(settings: Settings, last_data_update: str | None = None) -> dict:
    """Publish runtime status without fabricating market-data freshness."""
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
