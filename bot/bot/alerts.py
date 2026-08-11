"""Operational alert messages for the VPS runtime.

Delivery is NOT done by the bot: `python -m bot alert "<text>"` prints the
message to stdout, and a Hermes cron (profile default, workdir=repo root)
delivers it to the already-configured Telegram channel. No bot token, no
requests dependency, no secrets in this code path.
"""
from __future__ import annotations

from .config import Settings

PREFIX = "📡 stock-autotrader"


def format_alert(settings: Settings, text: str) -> str:
    """Return the alert line to print (stdout → Hermes cron → Telegram)."""
    return f"{PREFIX} [{settings.bot_env}] {text}"


def runtime_start_message(settings: Settings) -> str:
    return format_alert(settings, "runtime started")
