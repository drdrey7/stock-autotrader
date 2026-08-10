from datetime import UTC, date, datetime
from enum import StrEnum
from typing import Any

from pydantic import AwareDatetime, BaseModel, Field, model_validator


def utc_now() -> datetime:
    return datetime.now(UTC)


class SignalStatus(StrEnum):
    STRONG_SETUP = "Strong Setup"
    WATCH = "Watch"
    NO_SETUP = "No Setup"
    REJECTED = "Rejected"


class Direction(StrEnum):
    BULLISH = "Bullish"
    NEUTRAL = "Neutral"
    BEARISH = "Bearish"


class ReasonOutcome(StrEnum):
    PASS = "pass"
    REJECT = "reject"
    INFO = "info"


class DecisionReason(BaseModel):
    outcome: ReasonOutcome
    code: str
    label: str
    observed: str | None = None
    threshold: str | None = None


class SecuritySnapshot(BaseModel):
    symbol: str
    company: str
    sector: str | None = None
    security_type: str = "COMMON_STOCK"
    market_cap: float
    price: float
    median_dollar_volume_20d: float
    data_as_of: AwareDatetime = Field(default_factory=utc_now)


class EarningsSnapshot(BaseModel):
    symbol: str
    event_date: date
    timing: str = "TBD"
    price_reaction_pct: float | None = None
    relative_volume: float | None = None
    guidance_status: str | None = None
    available_at: AwareDatetime


class StrategyContext(BaseModel):
    symbol: str
    features: dict[str, float | bool | None]
    market_regime_positive: bool
    earnings: EarningsSnapshot | None = None
    as_of: AwareDatetime

    @model_validator(mode="after")
    def earnings_must_match_symbol(self) -> "StrategyContext":
        if self.earnings and self.earnings.symbol.strip().upper() != self.symbol.strip().upper():
            raise ValueError("Earnings symbol must match strategy context symbol")
        return self


class StrategyDecision(BaseModel):
    strategy_id: str
    strategy_version: str
    symbol: str
    signal: SignalStatus
    direction: Direction
    quant_score: float = Field(ge=0, le=100)
    reasons: list[DecisionReason]
    stop_price: float | None = Field(default=None, gt=0)
    generated_at: AwareDatetime = Field(default_factory=utc_now)
    metadata: dict[str, Any] = Field(default_factory=dict)
