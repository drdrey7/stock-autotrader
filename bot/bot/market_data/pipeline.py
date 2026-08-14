from __future__ import annotations

import json
import re
import tempfile
from collections.abc import Mapping
from datetime import UTC, date, datetime
from math import isfinite
from pathlib import Path
from typing import Any, Protocol

from .models import MarketDataSnapshot, PriceBar, UniverseConfig, UniverseResult
from .provider import DataValidationError
from .universe import build_universe

BENCHMARKS = ("SPY", "QQQ")


class MarketDataProvider(Protocol):
    name: str

    def load_universe(self) -> list[Mapping[str, Any]]: ...

    def load_bars(self, symbols: set[str]) -> list[PriceBar]: ...


class MarketDataPipeline:
    def __init__(
        self,
        provider: MarketDataProvider,
        *,
        universe_config: UniverseConfig | None = None,
        cache_path: Path | None = None,
        max_staleness_days: int = 3,
    ):
        if max_staleness_days < 0:
            raise ValueError("max_staleness_days must be non-negative")
        self.provider = provider
        self.universe_config = universe_config or UniverseConfig()
        self.cache_path = Path(cache_path) if cache_path else None
        self.max_staleness_days = max_staleness_days

    def run(self, now: datetime | None = None) -> MarketDataSnapshot:
        current_time = (now or datetime.now(UTC)).astimezone(UTC)
        updated_at = current_time.isoformat()
        try:
            universe = build_universe(self.provider.load_universe(), self.universe_config)
            bars = self.provider.load_bars(set(BENCHMARKS))
            for bar in bars:
                self._validate_bar(bar)
        except FileNotFoundError:
            return self._degraded_snapshot(current_time, "market data source unavailable: required input file missing")
        except DataValidationError as exc:
            detail = str(exc).strip().replace("\n", " ")
            if not detail or "/" in detail or "\\" in detail:
                detail = "validation failed"
            return self._degraded_snapshot(current_time, f"market data source invalid: {detail[:160]}")
        except (OSError, ValueError):
            return self._degraded_snapshot(current_time, "market data source invalid: validation failed")

        warnings: list[str] = []
        if not universe.eligible:
            warnings.append("eligible universe is empty")

        latest: dict[str, PriceBar] = {}
        for bar in bars:
            current = latest.get(bar.symbol)
            if current is None or bar.date > current.date:
                latest[bar.symbol] = bar
        benchmarks = tuple(latest[symbol] for symbol in BENCHMARKS if symbol in latest)
        for symbol in BENCHMARKS:
            bar = latest.get(symbol)
            if bar is None:
                warnings.append(f"missing benchmark: {symbol}")
                continue
            bar_date = date.fromisoformat(bar.date)
            age_days = (current_time.date() - bar_date).days
            if age_days < 0:
                warnings.append(f"future benchmark: {symbol} ({bar.date})")
            elif age_days > self.max_staleness_days:
                warnings.append(f"stale benchmark: {symbol} ({bar.date})")
        as_of = max((bar.date for bar in benchmarks), default=None)
        status = "healthy" if not warnings else "degraded"
        snapshot = MarketDataSnapshot(
            provider=self.provider.name,
            status=status,
            as_of=as_of,
            last_successful_update=updated_at if status == "healthy" else None,
            universe=universe,
            benchmarks=benchmarks,
            warnings=tuple(warnings),
            updated_at=updated_at,
        )
        if self.cache_path:
            self._write_cache(snapshot)
        return snapshot

    @staticmethod
    def _validate_bar(bar: PriceBar) -> None:
        try:
            if not isinstance(bar.date, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", bar.date):
                raise ValueError("date must use YYYY-MM-DD")
            parsed_date = date.fromisoformat(bar.date)
            if parsed_date.isoformat() != bar.date:
                raise ValueError("date must be a valid calendar date")
            values = (bar.open, bar.high, bar.low, bar.close, bar.adjusted_close)
            if any(not isfinite(float(value)) or float(value) <= 0 for value in values):
                raise ValueError("OHLC values must be positive and finite")
            volume = float(bar.volume)
            if not isfinite(volume) or not volume.is_integer() or volume <= 0:
                raise ValueError("volume must be a positive finite integer")
            if bar.high < max(bar.open, bar.close) or bar.low > min(bar.open, bar.close):
                raise ValueError("inconsistent OHLC range")
        except (AttributeError, TypeError, ValueError, OverflowError) as exc:
            raise ValueError("invalid market-data bar") from exc

    def _degraded_snapshot(self, current_time: datetime, warning: str) -> MarketDataSnapshot:
        snapshot = MarketDataSnapshot(
            provider=self.provider.name,
            status="degraded",
            as_of=None,
            last_successful_update=None,
            universe=UniverseResult(total=0, eligible=(), excluded_symbols=(), exclusions={}),
            benchmarks=(),
            warnings=(warning,),
            updated_at=current_time.isoformat(),
        )
        if self.cache_path:
            self._write_cache(snapshot)
        return snapshot

    def _write_cache(self, snapshot: MarketDataSnapshot) -> None:
        assert self.cache_path is not None
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        temporary: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                "w", encoding="utf-8", dir=self.cache_path.parent, delete=False
            ) as handle:
                temporary = Path(handle.name)
                json.dump(snapshot.to_dict(), handle, indent=2, sort_keys=True)
                handle.write("\n")
            assert temporary is not None
            temporary.replace(self.cache_path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
