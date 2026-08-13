from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class UniverseConfig:
    min_price: float = 5.0
    min_avg_volume: int = 250_000
    min_market_cap: int = 300_000_000

    def __post_init__(self) -> None:
        values = (self.min_price, self.min_avg_volume, self.min_market_cap)
        if any(not math.isfinite(float(value)) or value < 0 for value in values):
            raise ValueError("universe thresholds must be finite and non-negative")


@dataclass(frozen=True)
class Instrument:
    symbol: str
    company: str
    sector: str
    exchange: str
    security_type: str
    index_membership: tuple[str, ...]
    market_cap: int
    avg_volume: int
    price: float

    def to_dict(self) -> dict[str, Any]:
        value = asdict(self)
        value["index_membership"] = list(self.index_membership)
        return value


@dataclass(frozen=True)
class UniverseResult:
    total: int
    eligible: tuple[Instrument, ...]
    excluded_symbols: tuple[str, ...]
    exclusions: dict[str, str]

    @property
    def excluded(self) -> int:
        return self.total - len(self.eligible)

    def to_dict(self) -> dict[str, Any]:
        return {
            "total": self.total,
            "eligible": len(self.eligible),
            "eligibleSymbols": [item.symbol for item in self.eligible],
            "excluded": self.excluded,
            "excludedSymbols": list(self.excluded_symbols),
            "exclusions": dict(self.exclusions),
        }


@dataclass(frozen=True)
class PriceBar:
    symbol: str
    date: str
    open: float
    high: float
    low: float
    close: float
    adjusted_close: float
    volume: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "date": self.date,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "adjustedClose": self.adjusted_close,
            "volume": self.volume,
        }


@dataclass(frozen=True)
class IndexBar:
    symbol: str
    name: str
    value: float
    change: float
    updated_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "name": self.name,
            "value": self.value,
            "change": self.change,
            "updatedAt": self.updated_at,
        }


@dataclass(frozen=True)
class MarketDataSnapshot:
    provider: str
    status: str
    as_of: str | None
    last_successful_update: str | None
    universe: UniverseResult
    benchmarks: tuple[PriceBar, ...]
    warnings: tuple[str, ...]
    updated_at: str
    indices: tuple[IndexBar, ...] = ()

    def to_dict(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "status": self.status,
            "asOf": self.as_of,
            "lastSuccessfulUpdate": self.last_successful_update,
            "universe": self.universe.to_dict(),
            "benchmarks": [bar.to_dict() for bar in self.benchmarks],
            "indices": [index.to_dict() for index in self.indices],
            "warnings": list(self.warnings),
            "updatedAt": self.updated_at,
        }

    def public_dict(self) -> dict[str, Any]:
        value = self.to_dict()
        value["universe"] = {
            key: value["universe"][key]
            for key in ("total", "eligible", "excluded")
        }
        return value
