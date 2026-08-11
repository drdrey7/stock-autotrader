"""Scheduler framework — APScheduler with America/New_York timezone.

Jobs registered here are the *skeleton* for Fase 2; their handlers are wired
in later PRs (screening, strategies, research...). Health job runs now.
"""
from __future__ import annotations

import logging
from datetime import datetime

from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from zoneinfo import ZoneInfo

from .config import Settings
from .state import StateStore
from .jobs.health import health_job

log = logging.getLogger(__name__)


def _cron(field: str) -> CronTrigger:
    parts = field.split()
    if len(parts) != 5:
        raise ValueError(f"cron field must have 5 parts: {field!r}")
    minute, hour, day, month, weekday = parts
    return CronTrigger(
        minute=minute,
        hour=hour,
        day=day,
        month=month,
        day_of_week=weekday,
        timezone=ZoneInfo("America/New_York"),
    )


def build_scheduler(settings: Settings, store: StateStore, blocking: bool = False):
    sched = BlockingScheduler(timezone=ZoneInfo(settings.timezone)) if blocking else BackgroundScheduler(timezone=ZoneInfo(settings.timezone))

    # Health first — it is implemented and observable from day one.
    sched.add_job(
        health_job,
        CronTrigger.from_crontab(settings.health_check_cron, timezone=ZoneInfo(settings.timezone)),
        args=[store],
        id="health_check",
        name="Health check",
        replace_existing=True,
    )

    # Skeleton jobs — handlers arrive in later PRs. Registered now so the
    # runtime shape (and the scheduler wiring) is production-true.
    sched.add_job(
        _noop("pre_market_scan"),
        _cron(settings.pre_market_scan_cron),
        id="pre_market_scan",
        name="Pre-market scan",
        replace_existing=True,
    )
    sched.add_job(
        _noop("post_close_scan"),
        _cron(settings.post_close_scan_cron),
        id="post_close_scan",
        name="Post-close scan",
        replace_existing=True,
    )
    sched.add_job(
        _noop("data_refresh"),
        _cron(settings.data_refresh_cron),
        id="data_refresh",
        name="Data refresh",
        replace_existing=True,
    )
    return sched


def _noop(name: str):
    def run() -> None:
        log.info("job %s triggered (handler not wired yet — coming in later PRs)", name)
    return run


def next_runs(sched) -> list[dict]:
    out = []
    now = datetime.now(ZoneInfo("America/New_York"))
    for job in sched.get_jobs():
        nxt = getattr(job, "next_run_time", None)
        # Pending jobs (scheduler not started) may not have next_run_time set —
        # compute the next fire directly from the trigger.
        if nxt is None and job.trigger is not None:
            try:
                nxt = job.trigger.get_next_fire_time(None, now)
            except Exception:  # pragma: no cover - defensive
                nxt = None
        out.append({
            "id": job.id,
            "name": job.name,
            "next_run": nxt.isoformat() if nxt else None,
            "in": str(nxt - now) if nxt else None,
        })
    return out
