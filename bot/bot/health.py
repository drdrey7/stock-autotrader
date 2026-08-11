"""Health: observable runtime state (command + scheduler job)."""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from .config import Settings
from .state import StateStore

log = logging.getLogger(__name__)


def health_job(store: StateStore) -> None:
    run_id = store.start_job("health_check")
    try:
        # Trivial but real: DB is writable, scheduler is alive (this job ran).
        store.record_event("INFO", "health", "health check ok")
        store.finish_job(run_id, "ok")
        log.debug("health check ok")
    except Exception as exc:  # pragma: no cover - defensive
        store.finish_job(run_id, "error", str(exc))
        log.exception("health check failed")


def _health_interval_seconds(settings: Settings) -> int:
    """Return the configured health cadence, with a small two-run grace."""
    minute = settings.health_check_cron.split()[0]
    if minute == "*":
        return 120
    if minute.startswith("*/"):
        try:
            return max(60, int(minute[2:]) * 60 * 2)
        except ValueError:
            pass
    return 3600


def health_report(settings: Settings, store: StateStore, sched=None) -> dict:
    from .scheduler import next_runs  # lazy import to avoid cycle

    missing = settings.check_secrets()
    last_health = store.last_job_status("health_check")
    health_failed = last_health is None or last_health.get("status") != "ok"
    if last_health and last_health.get("finished_at"):
        try:
            finished = datetime.fromisoformat(last_health["finished_at"])
            if finished.tzinfo is None:
                finished = finished.replace(tzinfo=timezone.utc)
            age = (datetime.now(timezone.utc) - finished).total_seconds()
            health_failed = health_failed or age > _health_interval_seconds(settings)
        except (TypeError, ValueError):
            health_failed = True
    return {
        "status": "ok" if not missing and not health_failed else "degraded",
        "env": settings.bot_env,
        "timezone": settings.timezone,
        "db": str(store.db_path),
        "db_writable": not health_failed,
        "last_health_check": last_health,
        "missing_secrets": missing,
        "jobs": next_runs(sched) if sched else [],
    }
