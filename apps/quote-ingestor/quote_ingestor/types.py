"""Shared datatypes for parsed ticks and per-symbol quote state."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class TradeTick:
    """One validated trade tick from a Finnhub WebSocket frame.

    ``timestamp_ms`` is the exchange event time in UTC epoch milliseconds
    (Finnhub's ``t`` field). ``size`` is the per-trade volume (``v``) when
    present; the ingestor does not aggregate it today (no candle/history work).
    """

    symbol: str
    price: float
    timestamp_ms: int
    size: float | None = None


@dataclass
class QuoteState:
    """Latest in-memory state for one Core Universe symbol.

    Updated in place by the state store; the only state the ingestor keeps
    (no tick history, no minute series). ``update_count`` counts the number of
    applied ticks since process start (observability, not history).
    """

    symbol: str
    price: float = 0.0
    as_of_ms: int = 0
    update_count: int = 0


@dataclass
class FlushStats:
    """Per-flush write outcome (for health/metrics)."""

    requested: int = 0
    written: int = 0
    failed: int = 0
    skipped_regression: int = 0
    duration_ms: int = 0
    error: str | None = None
    rows: list[tuple[str, float, int]] = field(default_factory=list)
