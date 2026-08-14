"""Configuration for the VPS runtime.

All values come from environment variables / .env (pydantic-settings).
Secrets are never committed: .env is gitignored, only .env.example is tracked.
"""
from __future__ import annotations

import math
from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BOT_DIR = Path(__file__).resolve().parent
REPO_ROOT = BOT_DIR.parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=REPO_ROOT / "bot/.env",
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    # --- runtime ---
    bot_env: str = "dev"  # dev | production
    log_level: str = "INFO"
    data_dir: Path = BOT_DIR / "data"
    market_data_dir: Path = BOT_DIR / "data" / "market"
    market_data_cache: Path = BOT_DIR / "data" / "market" / "latest.json"
    market_min_price: float = 5.0
    market_min_avg_volume: int = 250_000
    market_min_market_cap: int = 300_000_000
    market_max_staleness_days: int = 3

    # --- scheduler (America/New_York) ---
    # BOT_TIMEZONE alias avoids the generic TIMEZONE env var that many hosts set empty.
    timezone: str = Field(default="America/New_York", validation_alias="BOT_TIMEZONE")
    # APScheduler day_of_week: 0=Monday..6=Sunday, so use names ("mon-fri")
    # instead of numeric ranges ("1-5" would mean Tue-Sat).
    pre_market_scan_cron: str = "30 7 * * mon-fri"    # 07:30 ET Mon-Fri (before open)
    post_close_scan_cron: str = "30 16 * * mon-fri"   # 16:30 ET Mon-Fri (after close)
    data_refresh_cron: str = "15 * * * *"         # hourly data refresh
    health_check_cron: str = "*/5 * * * *"        # every 5 minutes

    # --- publishing (PR #3 ingest endpoint) ---
    ingest_url: str = "https://stock-autotrader-web.barroso-labs.workers.dev/ingest/events"
    ingest_secret: str = ""  # required in production (from .env / secret store)

    # NOTE: no Telegram credentials here — operational alerts are delivered by
    # a Hermes cron (profile default) to the already-configured Telegram channel.

    @model_validator(mode="after")
    def _market_paths_follow_data_dir(self) -> Settings:
        if "market_data_dir" not in self.model_fields_set:
            self.market_data_dir = self.data_dir / "market"
        if "market_data_cache" not in self.model_fields_set:
            self.market_data_cache = self.market_data_dir / "latest.json"
        return self

    @field_validator("market_min_price", "market_min_avg_volume", "market_min_market_cap", "market_max_staleness_days")
    @classmethod
    def _market_threshold_non_negative(cls, v: float | int) -> float | int:
        if not math.isfinite(float(v)) or v < 0:
            raise ValueError("market thresholds must be finite and non-negative")
        return v

    @field_validator("timezone", mode="before")
    @classmethod
    def _timezone_default_if_empty(cls, v: str | None) -> str:
        return v or "America/New_York"

    @field_validator("ingest_secret")
    @classmethod
    def _secret_not_placeholder(cls, v: str) -> str:
        if v and v in ("change-me", "dev-secret-change-me"):
            raise ValueError("ingest_secret must not be a placeholder value")
        return v

    @field_validator("bot_env")
    @classmethod
    def _env_known(cls, v: str) -> str:
        if v not in ("dev", "production"):
            raise ValueError("bot_env must be 'dev' or 'production'")
        return v

    @property
    def production(self) -> bool:
        return self.bot_env == "production"

    def check_secrets(self) -> list[str]:
        """Return a list of missing secret names (empty = all present)."""
        missing: list[str] = []
        if self.production and not self.ingest_secret:
            missing.append("INGEST_SECRET")
        return missing


@lru_cache
def get_settings() -> Settings:
    return Settings()
