"""Validated, environment-only runner configuration."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse


class ConfigError(RuntimeError):
    """Raised for unsafe or incomplete runner configuration."""


_IDENTIFIER = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_TRUE = frozenset({"1", "true", "yes", "on"})
_FALSE = frozenset({"0", "false", "no", "off"})


def _required(name: str, values: dict[str, str]) -> str:
    value = values.get(name, "").strip()
    if not value:
        raise ConfigError(f"{name} is not configured")
    return value


def _identifier(name: str, values: dict[str, str]) -> str:
    value = _required(name, values)
    if not _IDENTIFIER.fullmatch(value):
        raise ConfigError(f"{name} has an invalid format")
    return value


def _boolean(name: str, default: bool, values: dict[str, str]) -> bool:
    raw = values.get(name, "").strip().lower()
    if not raw:
        return default
    if raw in _TRUE:
        return True
    if raw in _FALSE:
        return False
    raise ConfigError(f"{name} must be a boolean")


def _integer(name: str, default: int, values: dict[str, str], *, minimum: int, maximum: int) -> int:
    raw = values.get(name, "").strip()
    try:
        value = default if not raw else int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer") from exc
    if not minimum <= value <= maximum:
        raise ConfigError(f"{name} must be between {minimum} and {maximum}")
    return value


def _number(name: str, default: float, values: dict[str, str], *, minimum: float, maximum: float) -> float:
    raw = values.get(name, "").strip()
    try:
        value = default if not raw else float(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be a number") from exc
    if not minimum <= value <= maximum:
        raise ConfigError(f"{name} must be between {minimum:g} and {maximum:g}")
    return value


def _model(name: str, default: str, values: dict[str, str]) -> str:
    value = values.get(name, "").strip() or default
    if not value or len(value) > 128 or any(char.isspace() for char in value):
        raise ConfigError(f"{name} has an invalid model identifier")
    return value


def _https_url(name: str, values: dict[str, str]) -> str:
    value = _required(name, values)
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ConfigError(f"{name} must be an HTTPS base URL without credentials, query, or fragment")
    return value.rstrip("/")


@dataclass(frozen=True)
class Settings:
    cloudflare_api_token: str
    cloudflare_queues_api_token: str
    cloudflare_account_id: str
    cloudflare_d1_database_id: str
    cloudflare_ai_queue_id: str
    google_api_key: str
    openai_api_key: str
    primary_provider: str
    llm_backend_url: str | None
    quick_model: str
    deep_model: str
    openai_fallback_enabled: bool
    openai_quick_model: str
    openai_deep_model: str
    state_dir: Path
    queue_visibility_timeout_ms: int
    queue_request_timeout_seconds: float
    d1_request_timeout_seconds: float
    http_max_attempts: int
    max_analysis_attempts: int
    retry_delay_seconds: int
    heartbeat_interval_seconds: int
    stale_lease_seconds: int
    empty_poll_min_seconds: float
    empty_poll_max_seconds: float
    result_max_bytes: int
    valid_days: int
    llm_max_retries: int

    def __repr__(self) -> str:
        return (
            "Settings(cloudflare_api_token='<redacted>', "
            "cloudflare_queues_api_token='<redacted>', google_api_key='<redacted>', "
            "openai_api_key='<redacted>', "
            f"cloudflare_account_id={self.cloudflare_account_id!r}, "
            f"cloudflare_d1_database_id={self.cloudflare_d1_database_id!r}, "
            f"cloudflare_ai_queue_id={self.cloudflare_ai_queue_id!r}, "
            f"primary_provider={self.primary_provider!r})"
        )


def from_env(environ: dict[str, str] | None = None) -> Settings:
    """Build settings without ever putting secret values in an error."""

    values = dict(os.environ if environ is None else environ)
    primary_provider = values.get("TRADINGAGENTS_LLM_PROVIDER", "google").strip().lower()
    if primary_provider not in {"google", "openai", "openai_compatible"}:
        raise ConfigError("TRADINGAGENTS_LLM_PROVIDER must be google, openai, or openai_compatible")

    google_api_key = values.get("GOOGLE_API_KEY", "").strip()
    openai_api_key = values.get("OPENAI_API_KEY", "").strip()
    if primary_provider == "google" and not google_api_key:
        raise ConfigError("GOOGLE_API_KEY is required for the Google provider")
    if primary_provider == "openai" and not openai_api_key:
        raise ConfigError("OPENAI_API_KEY is required for the OpenAI provider")
    if primary_provider == "openai_compatible" and not values.get("OPENAI_COMPATIBLE_API_KEY", "").strip():
        raise ConfigError("OPENAI_COMPATIBLE_API_KEY is required for the OpenAI-compatible provider")
    llm_backend_url = (
        _https_url("TRADINGAGENTS_LLM_BACKEND_URL", values)
        if primary_provider == "openai_compatible"
        else None
    )
    fallback = _boolean("AI_ANALYSIS_OPENAI_FALLBACK_ENABLED", False, values)
    if fallback and primary_provider != "google":
        raise ConfigError("the OpenAI fallback is only valid with the Google primary provider")
    if fallback and not openai_api_key:
        raise ConfigError("OPENAI_API_KEY is required when the OpenAI fallback is enabled")

    quick_defaults = {"google": "gemini-3.1-flash-lite", "openai": "gpt-5.4-mini", "openai_compatible": "glm-5.3"}
    deep_defaults = {"google": "gemini-3.5-flash", "openai": "gpt-5.5", "openai_compatible": "glm-5.3"}

    heartbeat = _integer("AI_ANALYSIS_HEARTBEAT_INTERVAL_SECONDS", 60, values, minimum=10, maximum=600)
    stale = _integer("AI_ANALYSIS_STALE_LEASE_SECONDS", 300, values, minimum=30, maximum=86_400)
    if stale <= heartbeat * 2:
        raise ConfigError("AI_ANALYSIS_STALE_LEASE_SECONDS must exceed two heartbeat intervals")

    empty_min = _number("AI_ANALYSIS_EMPTY_POLL_MIN_SECONDS", 1.0, values, minimum=0.1, maximum=60)
    empty_max = _number("AI_ANALYSIS_EMPTY_POLL_MAX_SECONDS", 10.0, values, minimum=0.1, maximum=300)
    if empty_max < empty_min:
        raise ConfigError("AI_ANALYSIS_EMPTY_POLL_MAX_SECONDS must be at least the minimum")

    state_dir = Path(values.get("AI_ANALYSIS_STATE_DIR", "/var/lib/ai-analysis-runner")).expanduser()
    if not state_dir.is_absolute():
        raise ConfigError("AI_ANALYSIS_STATE_DIR must be absolute")

    return Settings(
        cloudflare_api_token=_required("CLOUDFLARE_API_TOKEN", values),
        cloudflare_queues_api_token=_required("CLOUDFLARE_QUEUES_API_TOKEN", values),
        cloudflare_account_id=_identifier("CLOUDFLARE_ACCOUNT_ID", values),
        cloudflare_d1_database_id=_identifier("CLOUDFLARE_D1_DATABASE_ID", values),
        cloudflare_ai_queue_id=_identifier("CLOUDFLARE_AI_QUEUE_ID", values),
        google_api_key=google_api_key,
        openai_api_key=openai_api_key,
        primary_provider=primary_provider,
        llm_backend_url=llm_backend_url,
        quick_model=_model("TRADINGAGENTS_QUICK_THINK_LLM", quick_defaults[primary_provider], values),
        deep_model=_model("TRADINGAGENTS_DEEP_THINK_LLM", deep_defaults[primary_provider], values),
        openai_fallback_enabled=fallback,
        openai_quick_model=_model("AI_ANALYSIS_OPENAI_QUICK_MODEL", "gpt-5.4-mini", values),
        openai_deep_model=_model("AI_ANALYSIS_OPENAI_DEEP_MODEL", "gpt-5.5", values),
        state_dir=state_dir,
        queue_visibility_timeout_ms=_integer("AI_ANALYSIS_QUEUE_VISIBILITY_TIMEOUT_MS", 3_600_000, values, minimum=60_000, maximum=43_200_000),
        queue_request_timeout_seconds=_number("AI_ANALYSIS_QUEUE_REQUEST_TIMEOUT_SECONDS", 30, values, minimum=1, maximum=120),
        d1_request_timeout_seconds=_number("AI_ANALYSIS_D1_REQUEST_TIMEOUT_SECONDS", 30, values, minimum=1, maximum=120),
        http_max_attempts=_integer("AI_ANALYSIS_HTTP_MAX_ATTEMPTS", 3, values, minimum=1, maximum=8),
        max_analysis_attempts=_integer("AI_ANALYSIS_MAX_ATTEMPTS", 3, values, minimum=1, maximum=10),
        retry_delay_seconds=_integer("AI_ANALYSIS_RETRY_DELAY_SECONDS", 60, values, minimum=0, maximum=43_200),
        heartbeat_interval_seconds=heartbeat,
        stale_lease_seconds=stale,
        empty_poll_min_seconds=empty_min,
        empty_poll_max_seconds=empty_max,
        result_max_bytes=_integer("AI_ANALYSIS_RESULT_MAX_BYTES", 1_500_000, values, minimum=1_000, maximum=1_900_000),
        valid_days=_integer("AI_ANALYSIS_VALID_DAYS", 5, values, minimum=1, maximum=30),
        llm_max_retries=_integer("TRADINGAGENTS_LLM_MAX_RETRIES", 2, values, minimum=0, maximum=8),
    )
