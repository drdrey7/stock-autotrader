from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

from ai_analysis_runner.config import Settings
from ai_analysis_runner.models import EngineOutput


def settings(state_dir: Path, **overrides: Any) -> Settings:
    value = Settings(
        cloudflare_api_token="d1-secret",
        cloudflare_queues_api_token="queue-secret",
        cloudflare_account_id="account-id",
        cloudflare_d1_database_id="database-id",
        cloudflare_ai_queue_id="queue-id",
        google_api_key="google-secret",
        openai_api_key="",
        primary_provider="google",
        quick_model="gemini-3.1-flash-lite",
        deep_model="gemini-3.5-flash",
        openai_fallback_enabled=False,
        openai_quick_model="gpt-5.4-mini",
        openai_deep_model="gpt-5.5",
        state_dir=state_dir,
        queue_visibility_timeout_ms=3_600_000,
        queue_request_timeout_seconds=30,
        d1_request_timeout_seconds=30,
        http_max_attempts=1,
        max_analysis_attempts=3,
        retry_delay_seconds=60,
        heartbeat_interval_seconds=60,
        stale_lease_seconds=300,
        empty_poll_min_seconds=1,
        empty_poll_max_seconds=10,
        result_max_bytes=1_500_000,
        valid_days=5,
        llm_max_retries=2,
    )
    return replace(value, **overrides)


def final_state(portfolio: str | None = None) -> dict[str, Any]:
    return {
        "market_report": "Market report",
        "sentiment_report": "Sentiment report",
        "news_report": "News report",
        "fundamentals_report": "Fundamentals report",
        "investment_debate_state": {
            "bull_history": "Bull case",
            "bear_history": "Bear case",
            "judge_decision": "Research decision",
        },
        "trader_investment_plan": "Trader plan",
        "risk_debate_state": {
            "aggressive_history": "Aggressive case",
            "neutral_history": "Neutral case",
            "conservative_history": "Conservative case",
        },
        "final_trade_decision": portfolio or (
            "**Rating**: BUY\n\n"
            "**Executive Summary**: Strong setup.\n\n"
            "**Investment Thesis**: Durable growth.\n\n"
            "**Price Target**: $225.50\n\n"
            "**Time Horizon**: 12 months"
        ),
    }


def output(portfolio: str | None = None) -> EngineOutput:
    return EngineOutput(final_state(portfolio), "Buy", "google", "gemini-3.1-flash-lite", "gemini-3.5-flash")


class FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload

    def __enter__(self) -> FakeResponse:
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps(self.payload).encode()

