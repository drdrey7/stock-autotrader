"""Environment-only configuration for the fundamentals ingestor."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from .fx import DEFAULT_FX_BASE_URL


class ConfigError(RuntimeError):
    """Raised when required deployment configuration is missing or invalid."""


def _required(name: str, environ: dict[str, str]) -> str:
    value = environ.get(name, "").strip()
    if not value:
        raise ConfigError(f"{name} is not configured")
    return value


def _positive_float(name: str, default: float, environ: dict[str, str]) -> float:
    raw = environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be a number") from exc
    if value <= 0:
        raise ConfigError(f"{name} must be positive")
    return value


def _fx_url(api_key: str, environ: dict[str, str]) -> str:
    """Resolve the FX endpoint URL.

    ``FUNDAMENTALS_FX_URL`` is optional. When set but whitespace-only or empty
    it falls back to the official keyed default. The returned URL embeds the
    API key server-side and must never be logged.
    """
    raw = environ.get("FUNDAMENTALS_FX_URL", "")
    stripped = raw.strip() if isinstance(raw, str) else ""
    return stripped or DEFAULT_FX_BASE_URL.format(api_key=api_key)


@dataclass(frozen=True)
class Settings:
    finnhub_api_key: str
    cloudflare_api_token: str
    cloudflare_account_id: str
    cloudflare_d1_database_id: str
    # Legacy adapter field retained so old focused Edgar tests/callers do not
    # break. The daily runtime no longer requires or reads EDGAR_IDENTITY.
    edgar_identity: str = ""
    universe_path: Path = field(default_factory=lambda: Path(__file__).resolve().parents[3] / "packages/contracts/src/core-universe.v1.json")
    request_timeout_seconds: float = 30.0
    finnhub_min_interval_seconds: float = 1.05
    fx_url: str = ""
    exchange_rate_api_key: str = ""

    def __repr__(self) -> str:
        return (
            "Settings(finnhub_api_key='<redacted>', "
            "cloudflare_api_token='<redacted>', "
            f"cloudflare_account_id={self.cloudflare_account_id!r}, "
            "cloudflare_d1_database_id='<redacted>', "
            "exchange_rate_api_key='<redacted>')"
        )


def from_env(environ: dict[str, str] | None = None) -> Settings:
    values = dict(os.environ if environ is None else environ)
    exchange_rate_api_key = _required("EXCHANGE_RATE_API_KEY", values)
    return Settings(
        finnhub_api_key=_required("FINNHUB_API_KEY", values),
        cloudflare_api_token=_required("CLOUDFLARE_API_TOKEN", values),
        cloudflare_account_id=_required("CLOUDFLARE_ACCOUNT_ID", values),
        cloudflare_d1_database_id=_required("CLOUDFLARE_D1_DATABASE_ID", values),
        edgar_identity=values.get("EDGAR_IDENTITY", "").strip(),
        universe_path=Path(values.get(
            "FUNDAMENTALS_UNIVERSE",
            str(Path(__file__).resolve().parents[3] / "packages/contracts/src/core-universe.v1.json"),
        )),
        request_timeout_seconds=_positive_float("FUNDAMENTALS_REQUEST_TIMEOUT", 30.0, values),
        finnhub_min_interval_seconds=_positive_float("FINNHUB_MIN_INTERVAL_SECONDS", 1.05, values),
        fx_url=_fx_url(exchange_rate_api_key, values),
        exchange_rate_api_key=exchange_rate_api_key,
    )