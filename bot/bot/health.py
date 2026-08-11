"""Health: observable runtime state (command + scheduler job)."""
from __future__ import annotations

import logging

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


def health_report(settings: Settings, store: StateStore, sched=None) -> dict:
    from .scheduler import next_runs  # lazy import to avoid cycle

    missing = settings.check_secrets()
    last_health = store.last_job_status("health_check")
    return {
        "status": "ok" if not missing else "degraded",
        "env": settings.bot_env,
        "timezone": settings.timezone,
        "db": str(store.db_path),
        "db_writable": store.last_job_status("health_check") is not None or store.recent_events(1) is not None,
        "last_health_check": last_health,
        "missing_secrets": missing,
        "jobs": next_runs(sched) if sched else [],
    }
