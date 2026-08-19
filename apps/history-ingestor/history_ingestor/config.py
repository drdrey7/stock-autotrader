"""Environment-driven configuration for the history ingestor.

All secrets arrive via environment variables (systemd ``EnvironmentFile`` on
the VPS). This module NEVER logs, prints or serialises a secret value; the
``masked`` helpers are the only projections of credentials that may reach
logs (booleans/counts only).

Alpha Vantage keys: ``ALPHA_VANTAGE_API_KEYS`` — comma-separated list. The
design is generic multi-key (any number of keys); the free tier entitles each
key to its own 25 requests/day, so the tool accounts per key and never
assumes rotating keys bypasses a per-key quota.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


class ConfigError(RuntimeError):
    """Raised when a required config value is missing or invalid."""


def _positive_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer, got {raw!r}") from exc
    if value <= 0:
        raise ConfigError(f"{name} must be positive, got {value}")
    return value


def _float_env(name: str, default: float, minimum: float = 0.0) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be a number, got {raw!r}") from exc
    if value < minimum:
        raise ConfigError(f"{name} must be >= {minimum}, got {value}")
    return value


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ConfigError(f"{name} is not configured (set it in the systemd EnvironmentFile)")
    return value


def parse_keys(raw: str) -> list[str]:
    """Split the comma-separated key list. Never logs values.

    Accepts a single key or several; each entry must be non-empty and
    alphanumeric (Alpha Vantage keys are 16 alphanumeric chars). The list is
    returned as-is — the tool only ever references keys by index.
    """
    keys = [token.strip() for token in raw.split(",") if token.strip()]
    if not keys:
        raise ConfigError("ALPHA_VANTAGE_API_KEYS is empty")
    for key in keys:
        if not key.isalnum():
            raise ConfigError("ALPHA_VANTAGE_API_KEYS entries must be alphanumeric")
    return keys


@dataclass(frozen=True)
class Settings:
    # Required (no defaults — ordering matters for the frozen dataclass).
    alpha_vantage_keys: list[str]
    cloudflare_api_token: str
    cloudflare_account_id: str
    cloudflare_d1_database_id: str

    # --- Alpha Vantage ---
    av_base_url: str = "https://www.alphavantage.co/query"
    av_min_interval_seconds: float = 13.0  # observed soft pacing (Information throttle)
    av_timeout_seconds: float = 30.0
    av_max_retries: int = 3
    av_retry_base_seconds: float = 10.0
    av_budget_per_key_per_day: int = 25  # documented free-tier entitlement

    def __repr__(self) -> str:
        """Never surface secret values (keys/token) in repr/str output."""
        return (
            f"Settings(alpha_vantage_keys=[{'<redacted>' * len(self.alpha_vantage_keys)}], "
            f"cloudflare_api_token='<redacted>', cloudflare_account_id={self.cloudflare_account_id!r}, "
            f"cloudflare_d1_database_id={self.cloudflare_d1_database_id!r}, "
            f"av_min_interval_seconds={self.av_min_interval_seconds!r}, "
            f"av_budget_per_key_per_day={self.av_budget_per_key_per_day!r}, "
            f"universe_path={str(self.universe_path)!r}, state_path={str(self.state_path)!r})"
        )

    # --- Cloudflare D1 HTTP API ---
    d1_max_retries: int = 3
    d1_retry_base_seconds: float = 1.0
    d1_request_timeout_seconds: float = 20.0
    # 10 rows/statement x 10 bound params = 100 SQL variables — D1 caps a
    # single statement at 100 variables (verified live: 20 rows -> HTTP 400
    # "too many SQL variables"). Keep well under the cap.
    d1_batch_max_rows: int = 10

    # --- Behaviour ---
    universe_path: Path = field(default_factory=lambda: Path(
        os.environ.get(
            "HISTORY_INGESTOR_UNIVERSE",
            str(Path(__file__).resolve().parents[3] / "packages" / "contracts" / "src" / "core-universe.v1.json"),
        )
    ))
    state_path: Path = field(default_factory=lambda: Path(
        os.environ.get(
            "HISTORY_INGESTOR_STATE",
            str(Path.home() / ".local" / "state" / "history-ingestor" / "checkpoint.json"),
        )
    ))
    maintenance_state_path: Path = field(default_factory=lambda: Path(
        os.environ.get(
            "HISTORY_INGESTOR_MAINTENANCE_STATE",
            str(Path.home() / ".local" / "state" / "history-ingestor" / "maintenance.json"),
        )
    ))
    log_flush_summaries: bool = True

    @property
    def key_count(self) -> int:
        return len(self.alpha_vantage_keys)


def from_env(environ: os._Environ | dict[str, str] | None = None) -> Settings:
    """Build Settings from the process environment (or an explicit mapping)."""
    backup = os.environ
    try:
        if environ is not None:
            os.environ = environ  # type: ignore[assignment]
        return Settings(
            alpha_vantage_keys=parse_keys(_required("ALPHA_VANTAGE_API_KEYS")),
            cloudflare_api_token=_required("CLOUDFLARE_API_TOKEN"),
            cloudflare_account_id=_required("CLOUDFLARE_ACCOUNT_ID"),
            cloudflare_d1_database_id=_required("CLOUDFLARE_D1_DATABASE_ID"),
            av_min_interval_seconds=_float_env("AV_MIN_INTERVAL_SECONDS", 13.0),
            av_timeout_seconds=_float_env("AV_TIMEOUT_SECONDS", 30.0, minimum=5.0),
            av_max_retries=_positive_int("AV_MAX_RETRIES", 3),
            av_retry_base_seconds=_float_env("AV_RETRY_BASE_SECONDS", 10.0),
            av_budget_per_key_per_day=_positive_int("AV_BUDGET_PER_KEY_PER_DAY", 25),
            d1_max_retries=_positive_int("D1_MAX_RETRIES", 3),
            d1_batch_max_rows=_positive_int("D1_BATCH_MAX_ROWS", 10),
            universe_path=Path(os.environ.get(
                "HISTORY_INGESTOR_UNIVERSE",
                str(Path(__file__).resolve().parents[3] / "packages" / "contracts" / "src" / "core-universe.v1.json"),
            )),
            state_path=Path(os.environ.get(
                "HISTORY_INGESTOR_STATE",
                str(Path.home() / ".local" / "state" / "history-ingestor" / "checkpoint.json"),
            )),
        )
    finally:
        if environ is not None:
            os.environ = backup
