from __future__ import annotations

import csv
import re
from datetime import date
from math import isfinite
from pathlib import Path
from typing import Any, Mapping

from .models import PriceBar


class DataValidationError(ValueError):
    """Raised when a provider returns malformed market data."""


class CsvMarketDataProvider:
    """Read reproducible universe and OHLCV snapshots from CSV files.

    Expected files are ``universe.csv`` and ``bars.csv`` under ``root``. This
    adapter deliberately has no network access: a later provider can implement
    the same contract without changing the pipeline or its backtests.
    """

    name = "csv"

    def __init__(self, root: Path):
        self.root = Path(root)

    def load_universe(self) -> list[Mapping[str, Any]]:
        path = self.root / "universe.csv"
        if not path.is_file():
            raise FileNotFoundError(f"market universe file not found: {path}")
        with path.open(newline="", encoding="utf-8") as handle:
            reader = csv.DictReader(handle)
            required = {
                "symbol", "company", "sector", "exchange", "security_type",
                "index_membership", "active", "market_cap", "avg_volume", "price",
            }
            missing = required - set(reader.fieldnames or [])
            if missing:
                raise DataValidationError(f"universe.csv missing columns: {sorted(missing)}")
            return [dict(row) for row in reader]

    def load_bars(self, symbols: set[str]) -> list[PriceBar]:
        path = self.root / "bars.csv"
        if not path.is_file():
            raise FileNotFoundError(f"market bars file not found: {path}")
        with path.open(newline="", encoding="utf-8") as handle:
            reader = csv.DictReader(handle)
            required = {"symbol", "date", "open", "high", "low", "close", "adjusted_close", "volume"}
            missing = required - set(reader.fieldnames or [])
            if missing:
                raise DataValidationError(f"bars.csv missing columns: {sorted(missing)}")
            bars = [self._parse_bar(row, index) for index, row in enumerate(reader, start=2)]
        return [bar for bar in bars if bar.symbol in symbols]

    @staticmethod
    def _parse_bar(row: dict[str, Any], line: int) -> PriceBar:
        try:
            symbol = str(row["symbol"]).strip().upper().replace("/", "-")
            bar_date = str(row["date"]).strip()
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", bar_date):
                raise ValueError("date must use YYYY-MM-DD")
            date.fromisoformat(bar_date)
            values = {key: float(row[key]) for key in ("open", "high", "low", "close", "adjusted_close")}
            raw_volume = float(row["volume"])
            if not isfinite(raw_volume) or not raw_volume.is_integer():
                raise ValueError("volume must be a finite integer")
            volume = int(raw_volume)
        except (KeyError, TypeError, ValueError) as exc:
            raise DataValidationError(f"invalid bars.csv row {line}") from exc
        if not re.fullmatch(r"[A-Z0-9.-]{1,12}", symbol):
            raise DataValidationError(f"invalid symbol in bars.csv row {line}")
        if any(not isfinite(value) or value <= 0 for value in values.values()) or volume <= 0:
            raise DataValidationError(f"non-positive OHLCV value for {symbol} in bars.csv row {line}")
        if values["high"] < max(values["open"], values["close"]) or values["low"] > min(values["open"], values["close"]):
            raise DataValidationError(f"inconsistent OHLC range for {symbol} in bars.csv row {line}")
        return PriceBar(symbol=symbol, date=bar_date, volume=volume, **values)
