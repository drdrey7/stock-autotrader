"""Telegram operational alerts (bot → André's chat).

Only for operational events (runtime start, health degradation, scan
failures). Not for trade signals — that is product territory, later.
"""
from __future__ import annotations

import logging

import requests

from .config import Settings

log = logging.getLogger(__name__)


def send_alert(settings: Settings, text: str) -> bool:
    if not (settings.telegram_bot_token and settings.telegram_chat_id):
        log.warning("telegram alert skipped: TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not configured")
        return False
    url = f"https://api.telegram.org/bot{settings.telegram_bot_token}/sendMessage"
    payload = {"chat_id": settings.telegram_chat_id, "text": text, "disable_web_page_preview": True}
    try:
        resp = requests.post(url, json=payload, timeout=10)
        resp.raise_for_status()
        return True
    except requests.RequestException as exc:
        # NEVER log the raw exception: requests embeds the full token in the
        # URL on connection failures. Log the exception type only.
        log.error("telegram alert failed: %s", type(exc).__name__)
        return False


def alert_runtime_start(settings: Settings) -> None:
    send_alert(settings, f"🚀 Stock Autotrader runtime started ({settings.bot_env})")
