"""Scheduled market-data refresh job."""
from __future__ import annotations

import json
from datetime import datetime

from ..config import Settings
from ..market_data import CsvMarketDataProvider, MarketDataPipeline, UniverseConfig
from ..market_data.provider import DataValidationError
from ..state import StateStore


def market_data_job(
    settings: Settings,
    store: StateStore,
    *,
    now: datetime | None = None,
) -> None:
    run_id = store.start_job("data_refresh")
    try:
        if settings.bot_env == "production" and not settings.ingest_secret:
            raise RuntimeError("INGEST_SECRET not configured for production market-data publication")
        snapshot = MarketDataPipeline(
            CsvMarketDataProvider(settings.market_data_dir),
            universe_config=UniverseConfig(
                min_price=settings.market_min_price,
                min_avg_volume=settings.market_min_avg_volume,
                min_market_cap=settings.market_min_market_cap,
            ),
            max_staleness_days=settings.market_max_staleness_days,
            cache_path=settings.market_data_cache,
        ).run(now=now)
        detail = json.dumps(snapshot.public_dict(), sort_keys=True)
        if snapshot.status == "healthy":
            store.record_event(
                "INFO",
                "market_data",
                f"Market data healthy: {snapshot.universe.eligible}/{snapshot.universe.total} eligible",
            )
        else:
            store.record_event("WARNING", "market_data", f"Market data degraded: {detail}")

        if settings.ingest_secret:
            from ..publishing import publish_market_data

            publish_market_data(settings, snapshot)
        store.finish_job(run_id, "ok" if snapshot.status == "healthy" else "degraded", detail)
    except (DataValidationError, FileNotFoundError, OSError, RuntimeError, ValueError) as exc:
        store.record_event("ERROR", "market_data", f"Market data refresh failed: {exc}")
        store.finish_job(run_id, "error", str(exc))
