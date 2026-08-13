"""Market context jobs: live indices (intraday) + daily sentiment.

Cadence (approved with André):
- indices: every 15 minutes during the NYSE regular session, plus one
  post-close snapshot per day; silent skip outside that window.
- sentiment: once per day (CNN Fear & Greed).
"""
from __future__ import annotations

import json
from datetime import datetime, time, timezone
from zoneinfo import ZoneInfo

from ..config import Settings
from ..market_data import CnnFearGreedProvider, YfinanceMarketContextProvider
from ..market_data.provider import DataValidationError
from ..state import StateStore

NY = ZoneInfo("America/New_York")

# Regular session 09:30-16:00 ET; the scheduler fires 09:00-16:45.
_SESSION_START = time(9, 30)
_SESSION_END = time(16, 0)
_CLOSE_WINDOW_END = time(16, 45)


def _ny_now(now: datetime | None) -> datetime:
    if now is None:
        now = datetime.now(NY)
    elif now.tzinfo is None:
        now = now.replace(tzinfo=NY)
    else:
        now = now.astimezone(NY)
    return now


def market_indices_job(
    settings: Settings,
    store: StateStore,
    *,
    now: datetime | None = None,
) -> None:
    run_id = store.start_job("market_indices")
    try:
        if settings.bot_env == "production" and not settings.ingest_secret:
            raise RuntimeError("INGEST_SECRET not configured for production market-indices publication")

        ny = _ny_now(now)
        if ny.weekday() >= 5:
            store.finish_job(run_id, "skipped", "weekend")
            return
        if ny.time() < _SESSION_START:
            store.finish_job(run_id, "skipped", "before_session")
            return
        if ny.time() >= _CLOSE_WINDOW_END:
            store.finish_job(run_id, "skipped", "after_close_window")
            return

        # Post-close: publish the final snapshot exactly once per day. Any
        # earlier completed run of today may carry the marker — a skipped
        # close_already_published run must not clear it.
        if ny.time() >= _SESSION_END:
            if store.has_finished_job_detail("market_indices", f"close_published:{ny.date().isoformat()}"):
                store.finish_job(run_id, "skipped", "close_already_published")
                return

        snapshot = YfinanceMarketContextProvider().build_snapshot(now=datetime.now(timezone.utc))
        detail = json.dumps(snapshot.public_dict(), sort_keys=True)
        if snapshot.status == "healthy":
            store.record_event("INFO", "market_indices", f"Indices healthy: {len(snapshot.benchmarks)} benchmarks, {len(snapshot.indices)} indices")
        else:
            store.record_event("WARNING", "market_indices", f"Indices degraded: {snapshot.warnings}")

        if settings.ingest_secret:
            from ..publishing import publish_market_data

            publish_market_data(settings, snapshot)
        close_marker = f"close_published:{ny.date().isoformat()}" if ny.time() >= _SESSION_END else f"intraday:{ny.date().isoformat()}"
        store.finish_job(run_id, "ok" if snapshot.status == "healthy" else "degraded", close_marker)
    except (DataValidationError, OSError, RuntimeError, ValueError) as exc:
        store.record_event("ERROR", "market_indices", f"Market indices refresh failed: {exc}")
        store.finish_job(run_id, "error", str(exc))


def sentiment_job(
    settings: Settings,
    store: StateStore,
    *,
    now: datetime | None = None,
) -> None:
    run_id = store.start_job("sentiment")
    try:
        if settings.bot_env == "production" and not settings.ingest_secret:
            raise RuntimeError("INGEST_SECRET not configured for production sentiment publication")

        ny = _ny_now(now)
        if ny.weekday() >= 5:
            store.finish_job(run_id, "skipped", "weekend")
            return

        reading = CnnFearGreedProvider().fetch(now=datetime.now(timezone.utc))
        detail = json.dumps({
            "provider": reading.provider,
            "score": reading.score,
            "rating": reading.rating,
            "asOf": reading.as_of,
        }, sort_keys=True)
        if settings.ingest_secret:
            from ..publishing import publish_sentiment

            publish_sentiment(settings, {
                "provider": reading.provider,
                "score": reading.score,
                "rating": reading.rating,
                "asOf": reading.as_of,
            })
        store.record_event("INFO", "sentiment", f"Sentiment {reading.rating}: {reading.score}")
        store.finish_job(run_id, "ok", detail)
    except (DataValidationError, OSError, RuntimeError, ValueError) as exc:
        store.record_event("ERROR", "sentiment", f"Sentiment refresh failed: {exc}")
        store.finish_job(run_id, "error", str(exc))
