from enum import StrEnum
from typing import Any

from pydantic import AwareDatetime, BaseModel, Field

from bot.models import utc_now


class EventType(StrEnum):
    SCAN_STARTED = "SCAN_STARTED"
    UNIVERSE_LOADED = "UNIVERSE_LOADED"
    FILTER_COMPLETED = "FILTER_COMPLETED"
    RANKING_COMPLETED = "RANKING_COMPLETED"
    CANDIDATE_SELECTED = "CANDIDATE_SELECTED"
    ANALYSIS_STARTED = "ANALYSIS_STARTED"
    ANALYSIS_COMPLETED = "ANALYSIS_COMPLETED"
    SIGNAL_CREATED = "SIGNAL_CREATED"
    SIGNAL_REJECTED = "SIGNAL_REJECTED"
    SHADOW_TRADE_OPENED = "SHADOW_TRADE_OPENED"
    SHADOW_TRADE_CLOSED = "SHADOW_TRADE_CLOSED"
    SCAN_COMPLETED = "SCAN_COMPLETED"
    ERROR = "ERROR"


class BotEvent(BaseModel):
    event_type: EventType
    public_message: str
    severity: str = "info"
    symbol: str | None = None
    strategy_id: str | None = None
    public_metadata: dict[str, Any] = Field(default_factory=dict)
    occurred_at: AwareDatetime = Field(default_factory=utc_now)


class EventSink:
    def __init__(self) -> None:
        self.events: list[BotEvent] = []

    def emit(self, event: BotEvent) -> None:
        self.events.append(event)
