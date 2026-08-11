"""CLI — smoke, health, run, alert.

Usage:
    python -m bot smoke            # validate runtime (no side effects)
    python -m bot health           # print health report
    python -m bot run              # start the scheduler (blocking)
    python -m bot alert "message"  # print alert line to stdout (Hermes cron delivers)
"""
from __future__ import annotations

import argparse
import json
import signal
import sys

from .alerts import format_alert
from .config import get_settings
from .health import health_report
from .logging_setup import setup_logging
from .state import StateStore


def _cmd_smoke(args) -> int:
    settings = get_settings()
    # Smoke must be safe against a production DATA_DIR: use an in-memory
    # ledger so validation never creates files or appends runtime events.
    store = StateStore(":memory:")
    from .scheduler import build_scheduler, next_runs

    sched = build_scheduler(settings, store, blocking=False)
    report = {
        "smoke": "ok",
        "env": settings.bot_env,
        "db": str(store.db_path),
        "db_ok": True,
        "jobs_registered": len(sched.get_jobs()),
        "timezone": settings.timezone,
        "next_runs": next_runs(sched)[:3],
        "missing_secrets": settings.check_secrets(),
    }
    try:
        sched.shutdown(wait=False)
    except Exception:
        pass
    store.close()
    print(json.dumps(report, indent=2))
    return 0


def _cmd_health(args) -> int:
    settings = get_settings()
    store = StateStore(settings.data_dir / "state.db")
    report = health_report(settings, store)
    store.close()
    print(json.dumps(report, indent=2))
    return 0


def _cmd_run(args) -> int:
    settings = get_settings()
    setup_logging(settings.log_level, settings.data_dir / "runtime.log")
    store = StateStore(settings.data_dir / "state.db")
    store.record_event("INFO", "runtime", "runtime starting")

    from .scheduler import build_scheduler

    sched = build_scheduler(settings, store, blocking=True)

    def _shutdown(signum, frame):
        store.record_event("INFO", "runtime", f"received signal {signum}, shutting down")
        # Drain APScheduler workers before closing their shared SQLite store.
        sched.shutdown(wait=True)

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    try:
        sched.start()
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        store.close()
    return 0


def _cmd_alert(args) -> int:
    """Print the alert line to stdout — a Hermes cron (profile default)
    delivers it to the configured Telegram channel."""
    settings = get_settings()
    print(format_alert(settings, args.message))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="stock-autotrader-bot", description="VPS runtime")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("smoke", help="validate runtime (no side effects)")
    sub.add_parser("health", help="print health report")
    sub.add_parser("run", help="start scheduler (blocking)")
    alert = sub.add_parser("alert", help="print alert line to stdout (Hermes cron delivers)")
    alert.add_argument("message", help="alert text")

    args = parser.parse_args(argv)
    handlers = {"smoke": _cmd_smoke, "health": _cmd_health, "run": _cmd_run, "alert": _cmd_alert}
    return handlers[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
