from __future__ import annotations

import re
from collections import Counter
from math import isfinite
from typing import Any, Mapping

from .models import Instrument, UniverseConfig, UniverseResult

SUPPORTED_SECURITY_TYPES = {"COMMON_STOCK", "ADR"}
SUPPORTED_EXCHANGES = {"NYSE", "NASDAQ", "AMEX", "ARCA", "NMS"}
SUPPORTED_MEMBERSHIPS = {"SP500", "NASDAQ"}
SYMBOL_RE = re.compile(r"^[A-Z0-9.-]{1,12}$")


def _symbol(value: Any) -> str:
    return str(value or "").strip().upper().replace("/", "-")


def _float(row: Mapping[str, Any], key: str) -> float:
    return float(str(row.get(key, "")).strip())


def _int(row: Mapping[str, Any], key: str) -> int:
    value = float(str(row.get(key, "")).strip())
    if not isfinite(value) or not value.is_integer():
        raise ValueError(f"{key} must be a finite integer")
    return int(value)


def _active(value: Any) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "y"}


def _memberships(value: Any) -> set[str]:
    return {part.strip().upper() for part in re.split(r"[,;|]", str(value or "")) if part.strip()}


def build_universe(rows: list[Mapping[str, Any]], config: UniverseConfig | None = None) -> UniverseResult:
    config = config or UniverseConfig()
    eligible: list[Instrument] = []
    excluded_symbols: list[str] = []
    exclusions: dict[str, str] = {}
    normalized_symbols = [_symbol(row.get("symbol")) or "<invalid-symbol>" for row in rows]
    duplicate_symbols = {
        symbol
        for symbol, count in Counter(normalized_symbols).items()
        if count > 1
    }

    for row, symbol in zip(rows, normalized_symbols):
        reason: str | None = "duplicate symbol" if symbol in duplicate_symbols else None
        security_type = ""
        exchange = ""
        memberships: set[str] = set()
        market_cap = 0
        avg_volume = 0
        price = 0.0
        if reason is None and not SYMBOL_RE.fullmatch(symbol):
            reason = "invalid symbol"
        try:
            security_type = str(row.get("security_type", "")).strip().upper()
            exchange = str(row.get("exchange", "")).strip().upper()
            memberships = _memberships(row.get("index_membership"))
            market_cap = _int(row, "market_cap")
            avg_volume = _int(row, "avg_volume")
            price = _float(row, "price")
            if reason is None and not _active(row.get("active")):
                reason = "inactive"
            elif reason is None and (
                not isfinite(price) or price <= 0 or market_cap <= 0 or avg_volume <= 0
            ):
                reason = "invalid numeric field"
            elif reason is None and security_type not in SUPPORTED_SECURITY_TYPES:
                reason = "unsupported security type"
            elif reason is None and exchange not in SUPPORTED_EXCHANGES:
                reason = "unsupported exchange"
            elif reason is None and not memberships.intersection(SUPPORTED_MEMBERSHIPS):
                reason = "outside core universe"
            elif reason is None and price < config.min_price:
                reason = "below minimum price"
            elif reason is None and avg_volume < config.min_avg_volume:
                reason = "below minimum average volume"
            elif reason is None and market_cap < config.min_market_cap:
                reason = "below minimum market cap"
        except (TypeError, ValueError):
            reason = reason or "invalid numeric field"

        if reason is not None:
            excluded_symbols.append(symbol)
            exclusions[symbol] = reason
            continue

        eligible.append(
            Instrument(
                symbol=symbol,
                company=str(row.get("company", "")).strip(),
                sector=str(row.get("sector", "")).strip(),
                exchange=exchange,
                security_type=security_type.lower(),
                index_membership=tuple(sorted(memberships)),
                market_cap=market_cap,
                avg_volume=avg_volume,
                price=price,
            )
        )

    eligible.sort(key=lambda item: item.symbol)
    return UniverseResult(
        total=len(rows),
        eligible=tuple(eligible),
        excluded_symbols=tuple(sorted(excluded_symbols)),
        exclusions=dict(sorted(exclusions.items())),
    )
