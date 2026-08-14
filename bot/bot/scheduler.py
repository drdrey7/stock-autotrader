"""Scheduler framework — APScheduler with America/New_York timezone.

The data-refresh and health handlers are active; screening, strategies and
research jobs remain explicit later-phase extension points.
"""
from __future__ import annotations

import logging
from datetime import datetime
from zoneinfo import ZoneInfo

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger

from .config import Settings
from .jobs.health import health_job
from .jobs.market_data import market_data_job
from .state import StateStore

log = logging.getLogger(__name__)


def _cron(field: str, timezone: str = "America/New_York") -> CronTrigger:
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
        timezone=ZoneInfo(timezone),
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
        _cron(settings.pre_market_scan_cron, settings.timezone),
        id="pre_market_scan",
        name="Pre-market scan",
        replace_existing=True,
    )
    sched.add_job(
        _noop("post_close_scan"),
        _cron(settings.post_close_scan_cron, settings.timezone),
        id="post_close_scan",
        name="Post-close scan",
        replace_existing=True,
    )
    # Data refresh is wired to the validated provider pipeline in PR #5.
    sched.add_job(
        market_data_job,
        _cron(settings.data_refresh_cron, settings.timezone),
        args=[settings, store],
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
