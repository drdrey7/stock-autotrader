from enum import StrEnum

from pydantic import BaseModel, Field
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
    initial_capital: float = 5_000
    risk_per_trade_pct: float = Field(default=0.005, gt=0, le=0.02)
    max_positions: int = 4
    max_open_risk_pct: float = 0.02
    max_gross_exposure_pct: float = 1.0
    max_single_position_pct: float = 0.30
    max_sector_exposure_pct: float = 0.40
    leverage_allowed: bool = False
    averaging_down_allowed: bool = False
    martingale_allowed: bool = False


class EngineSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="ENGINE_", env_file=".env", extra="ignore")
    env: str = "development"
    timezone: str = "America/New_York"
    log_level: str = "INFO"
    database_path: str = "/data/engine.sqlite3"
