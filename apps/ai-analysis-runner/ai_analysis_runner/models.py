"""Small app-owned transport models."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class QueueMessage:
    id: str
    attempts: int
    lease_id: str
    analysis_id: str
    timestamp_ms: int | None = None


@dataclass(frozen=True)
class Analysis:
    id: str
    symbol: str
    status: str
    analysis_date: str
    attempt_count: int
    execution_token: str | None
    execution_message_id: str | None
    heartbeat_at: str | None


@dataclass(frozen=True)
class EngineOutput:
    final_state: dict[str, Any]
    decision: str
    provider: str
    quick_model: str
    deep_model: str

