"""Health: observable runtime state (command + scheduler job)."""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from apscheduler.triggers.cron import CronTrigger
from zoneinfo import ZoneInfo

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
    """Return twice the time between consecutive scheduled health fires."""
    try:
        trigger = CronTrigger.from_crontab(
            settings.health_check_cron,
            timezone=ZoneInfo(settings.timezone),
        )
        now = datetime.now(ZoneInfo(settings.timezone))
        first = trigger.get_next_fire_time(None, now)
        second = trigger.get_next_fire_time(first, first) if first else None
        if first and second:
            return max(60, int((second - first).total_seconds()) * 2)
    except (TypeError, ValueError):
        pass
    return 3600


def _missed_health_check(settings: Settings, finished_at: datetime, now: datetime | None = None) -> bool:
    """True when at least one scheduled check should have fired since
    ``finished_at``."""
    if now is None:
        now = datetime.now(ZoneInfo(settings.timezone))
    try:
        trigger = CronTrigger.from_crontab(
            settings.health_check_cron,
            timezone=ZoneInfo(settings.timezone),
        )
        now_inner = datetime.now(ZoneInfo(settings.timezone)) if now is None else now
        if finished_at.tzinfo is None:
            finished_at = finished_at.replace(tzinfo=ZoneInfo(settings.timezone))
        nxt = trigger.get_next_fire_time(finished_at, now_inner)
        return nxt is not None and nxt <= now_inner
    except (TypeError, ValueError):
        return True


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
            if _missed_health_check(settings, finished):
                health_failed = True
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
