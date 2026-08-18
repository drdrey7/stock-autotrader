"""Environment-driven configuration for the quote ingestor.

All secrets arrive via environment variables (systemd ``EnvironmentFile`` on
the VPS). This module NEVER logs, prints or serialises a secret value; the
``masked`` helper is the only projection of credentials that may reach logs
(e.g. "configured=true" / "configured=false").
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# Deliberately not a constant imported anywhere a log could format it — see
# project rule: FINNHUB_API_KEY value must never appear in logs/stdout/git.

_FINNHUB_WS_HOST = "wss://ws.finnhub.io"


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


def secret_present(name: str) -> bool:
    """Whether a non-empty secret env var is set. The only secret-adjacent
    boolean a log line may contain — never the value."""
    return bool(os.environ.get(name, "").strip())


@dataclass(frozen=True)
class Settings:
    # Required (no defaults — ordering matters for the frozen dataclass).
    finnhub_api_key: str
    cloudflare_api_token: str
    cloudflare_account_id: str
    cloudflare_d1_database_id: str

    # --- Finnhub ---
    finnhub_ws_host: str = _FINNHUB_WS_HOST
    ws_ping_interval_seconds: float = 9.0
    ws_recv_timeout_seconds: float = 10.0
    ws_reconnect_base_seconds: float = 0.5
    ws_reconnect_max_seconds: float = 60.0
    ws_reconnect_jitter: float = 0.3
    ws_connect_timeout_seconds: float = 20.0

    # --- Cloudflare D1 HTTP API ---
    d1_region: str | None = None
    d1_batch_max_rows: int = 20
    d1_max_retries: int = 3
    d1_retry_base_seconds: float = 1.0
    d1_request_timeout_seconds: float = 20.0

    # --- Behaviour ---
    flush_interval_seconds: float = 60.0
    market_open_hhmm: str = "09:30"
    market_close_hhmm: str = "16:00"
    max_timestamp_future_seconds: float = 300.0
    max_timestamp_age_seconds: float = 24 * 60 * 60.0
    log_flush_summaries: bool = True
    universe_path: Path = field(default_factory=lambda: Path(
        os.environ.get(
            "QUOTE_INGESTOR_UNIVERSE",
            str(Path(__file__).resolve().parents[3] / "packages" / "contracts" / "src" / "core-universe.v1.json"),
        )
    ))

    @property
    def finnhub_api_key_configured(self) -> bool:
        return bool(self.finnhub_api_key)


def from_env(environ: os._Environ | dict[str, str] | None = None) -> Settings:
    """Build Settings from the process environment (or an explicit mapping).

    Missing secrets raise ConfigError with a non-secret message so the service
    dies fast with a clear journal entry instead of half-starting.
    """
    backup = os.environ
    try:
        if environ is not None:
            os.environ = environ  # type: ignore[assignment]
        return Settings(
            finnhub_api_key=_required("FINNHUB_API_KEY"),
            cloudflare_api_token=_required("CLOUDFLARE_API_TOKEN"),
            cloudflare_account_id=_required("CLOUDFLARE_ACCOUNT_ID"),
            cloudflare_d1_database_id=_required("CLOUDFLARE_D1_DATABASE_ID"),
            flush_interval_seconds=_float_env("FLUSH_INTERVAL_SECONDS", 60.0),
            ws_ping_interval_seconds=_float_env("WS_PING_INTERVAL_SECONDS", 9.0),
            ws_recv_timeout_seconds=_float_env("WS_RECV_TIMEOUT_SECONDS", 10.0),
            ws_reconnect_base_seconds=_float_env("WS_RECONNECT_BASE_SECONDS", 0.5),
            ws_reconnect_max_seconds=_float_env("WS_RECONNECT_MAX_SECONDS", 60.0),
            d1_max_retries=_positive_int("D1_MAX_RETRIES", 3),
            market_open_hhmm=os.environ.get("MARKET_OPEN_HHMM", "09:30"),
            market_close_hhmm=os.environ.get("MARKET_CLOSE_HHMM", "16:00"),
            universe_path=Path(os.environ.get(
                "QUOTE_INGESTOR_UNIVERSE",
                str(Path(__file__).resolve().parents[3] / "packages" / "contracts" / "src" / "core-universe.v1.json"),
            )),
        )
    finally:
        if environ is not None:
            os.environ = backup
