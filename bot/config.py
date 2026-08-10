from enum import StrEnum

from pydantic import BaseModel, Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class UniverseBucket(StrEnum):
    CORE = "CORE"
    FUTURE_MID_CAP = "FUTURE_MID_CAP"


class UniverseConfig(BaseModel):
    min_market_cap: float = 1_000_000_000
    min_price: float = 5.0
    min_median_dollar_volume_20d: float = 10_000_000
    future_bucket_min_market_cap: float = 500_000_000
    excluded_security_types: frozenset[str] = frozenset({"ETF", "PREFERRED", "WARRANT", "RIGHT", "UNIT"})


class RiskConfig(BaseModel):
    initial_capital: float = Field(default=5_000, gt=0, allow_inf_nan=False)
    risk_per_trade_pct: float = Field(default=0.005, gt=0, le=0.02, allow_inf_nan=False)
    max_positions: int = Field(default=4, ge=1)
    max_open_risk_pct: float = Field(default=0.02, gt=0, le=1, allow_inf_nan=False)
    max_gross_exposure_pct: float = Field(default=1.0, gt=0, le=1, allow_inf_nan=False)
    max_single_position_pct: float = Field(default=0.30, gt=0, le=1, allow_inf_nan=False)
    max_sector_exposure_pct: float = Field(default=0.40, gt=0, le=1, allow_inf_nan=False)
    leverage_allowed: bool = False
    averaging_down_allowed: bool = False
    martingale_allowed: bool = False

    @model_validator(mode="after")
    def risk_per_trade_within_portfolio_limit(self) -> "RiskConfig":
        if self.risk_per_trade_pct > self.max_open_risk_pct:
            raise ValueError("Risk per trade cannot exceed maximum open risk")
        return self


class EngineSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ENGINE_", env_file=".env", extra="ignore")
    env: str = "development"
    timezone: str = "America/New_York"
    log_level: str = "INFO"
    database_path: str = "/data/engine.sqlite3"
