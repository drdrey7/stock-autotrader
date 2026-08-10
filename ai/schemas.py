from datetime import datetime
from enum import StrEnum

from pydantic import AnyHttpUrl, BaseModel, Field


class EventStatus(StrEnum):
    CONFIRM = "CONFIRM"
    REVIEW = "REVIEW"
    REJECT = "REJECT"


class RiskLevel(StrEnum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"


class Source(BaseModel):
    title: str
    url: AnyHttpUrl
    published_at: datetime | None = None


class AiEventAssessment(BaseModel):
    symbol: str = Field(pattern=r"^[A-Z][A-Z0-9.-]{0,9}$")
    event_status: EventStatus
    risk_level: RiskLevel
    earnings_risk: bool
    material_event: bool
    summary: str = Field(min_length=1, max_length=1000)
    sources: list[Source]
