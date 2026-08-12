"""Market snapshot and candidate quote handling.

Quotes arrive as JSON input produced by an external provider (TradingView or
equivalent). The pipeline validates rather than fabricates:

Benchmark items (required to publish a new edition):
    {"symbol": "SP:SPX", "value": "6,410.23", "change": "+0.34%",
     "state": "Constructive", "note": "..."}

Candidate quotes (optional per symbol):
    {"symbol": "NVDA", "company": "NVIDIA Corporation", "price": "$182.64",
     "change": "+1.80%", "thesis": "...", "technical": [...], "financial": [...],
     "news": [...], "risks": [...],
     "levels": {"trigger": "...", "invalidation": "...", "objective": "...",
                "rewardRisk": "2.5R", "rewardRiskRatio": 2.5}}
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .universe import canonical_symbol

BENCHMARK_DEFINITIONS = (
    ("S&P 500", "SP:SPX"),
    ("Nasdaq-100", "NASDAQ:NDX"),
    ("VIX", "CBOE:VIX"),
)

REWARD_RISK_TEXT_RE = re.compile(r"^(\d+(?:\.\d+)?)R\b", re.IGNORECASE)

NON_EMPTY_FIELDS = (
    "value",
    "change",
    "state",
    "note",
)


MAX_TEXT_LENGTH = 2_000  # mirrors nonEmptyString in the wire contract


def _non_empty_string(value: Any, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field_name} must be a non-empty string")
    if len(value) > MAX_TEXT_LENGTH:
        raise ValueError(f"{field_name} exceeds {MAX_TEXT_LENGTH} characters")
    return value.strip()


@dataclass(frozen=True)
class BenchmarkItem:
    name: str
    symbol: str
    value: str
    change: str
    state: str
    note: str

    def to_contract(self) -> dict[str, str]:
        return {
            "name": self.name,
            "symbol": self.symbol,
            "value": self.value,
            "change": self.change,
            "state": self.state,
            "note": self.note,
        }


def _parse_benchmark(raw: dict[str, Any]) -> BenchmarkItem:
    name = _non_empty_string(raw.get("name"), "name")
    symbol = canonical_symbol(str(raw.get("symbol", "")))
    if symbol.startswith("SP") or ":" in str(raw.get("symbol", "")):
        symbol = str(raw.get("symbol", "")).strip().upper()
    fields = {key: _non_empty_string(raw.get(key), key) for key in NON_EMPTY_FIELDS}
    return BenchmarkItem(name=name, symbol=symbol, **fields)


def load_benchmarks(raw_items: list[dict[str, Any]]) -> list[BenchmarkItem] | None:
    """Return the three canonical benchmark items, or ``None`` if invalid.

    ``None`` means the snapshot is unusable — the pipeline must NOT publish a
    new edition (fail closed).
    """
    if not isinstance(raw_items, list) or len(raw_items) != len(BENCHMARK_DEFINITIONS):
        return None
    parsed: list[BenchmarkItem] = []
    try:
        for raw in raw_items:
            if not isinstance(raw, dict):
                return None
            parsed.append(_parse_benchmark(raw))
    except ValueError:
        return None

    expected = {name: symbol for name, symbol in BENCHMARK_DEFINITIONS}
    seen_names: set[str] = set()
    for item in parsed:
        if item.name not in expected:
            return None
        if item.symbol != expected[item.name]:
            return None
        if item.name in seen_names:
            return None
        seen_names.add(item.name)
    if seen_names != set(expected):
        return None
    return parsed


@dataclass(frozen=True)
class IdeaLevels:
    trigger: str
    invalidation: str
    objective: str
    rewardRisk: str
    rewardRiskRatio: float | None

    def to_contract(self) -> dict[str, Any]:
        return {
            "trigger": self.trigger,
            "invalidation": self.invalidation,
            "objective": self.objective,
            "rewardRisk": self.rewardRisk,
            "rewardRiskRatio": self.rewardRiskRatio,
        }


@dataclass(frozen=True)
class CandidateQuote:
    symbol: str
    company: str
    price: str
    change: str
    thesis: str
    technical: tuple[str, ...]
    financial: tuple[str, ...]
    news: tuple[str, ...]
    risks: tuple[str, ...]
    levels: IdeaLevels

    def is_complete(self) -> bool:
        """A candidate is usable as a Potential Entry only when fully populated."""
        if not self.company or not self.price or not self.change or not self.thesis:
            return False
        if not self.technical or not self.financial or not self.news or not self.risks:
            return False
        levels = self.levels
        if not (levels.trigger and levels.invalidation and levels.objective and levels.rewardRisk):
            return False
        ratio = levels.rewardRiskRatio
        if ratio is None or ratio <= 0:
            return False
        match = REWARD_RISK_TEXT_RE.match(levels.rewardRisk.strip())
        if not match:
            return False
        return abs(float(match.group(1)) - ratio) <= 0.01

    def to_contract(self) -> dict[str, Any]:
        return {
            "symbol": self.symbol,
            "company": self.company,
            "price": self.price,
            "change": self.change,
            "thesis": self.thesis,
            "technical": list(self.technical),
            "financial": list(self.financial),
            "news": list(self.news),
            "risks": list(self.risks),
            "levels": self.levels.to_contract(),
        }


def _string_list(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list) or not value:
        raise ValueError("expected a non-empty list of strings")
    items: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise ValueError("list items must be non-empty strings")
        items.append(item.strip())
    return tuple(items)


def _parse_levels(raw: Any) -> IdeaLevels:
    if not isinstance(raw, dict):
        raise ValueError("levels must be an object")
    try:
        trigger = _non_empty_string(raw.get("trigger"), "trigger")
        invalidation = _non_empty_string(raw.get("invalidation"), "invalidation")
        objective = _non_empty_string(raw.get("objective"), "objective")
        reward_risk = _non_empty_string(raw.get("rewardRisk"), "rewardRisk")
    except ValueError:
        raise
    ratio = raw.get("rewardRiskRatio")
    if ratio is None:
        reward_risk_ratio: float | None = None
    else:
        try:
            reward_risk_ratio = float(ratio)
        except (TypeError, ValueError):
            raise ValueError("rewardRiskRatio must be numeric") from None
        if reward_risk_ratio <= 0:
            raise ValueError("rewardRiskRatio must be positive")
    return IdeaLevels(
        trigger=trigger,
        invalidation=invalidation,
        objective=objective,
        rewardRisk=reward_risk,
        rewardRiskRatio=reward_risk_ratio,
    )


def load_candidate_quotes(raw_quotes: list[dict[str, Any]]) -> dict[str, CandidateQuote]:
    """Parse candidate quotes keyed by canonical symbol.

    Malformed entries are skipped (they simply fail the completeness gate).
    """
    quotes: dict[str, CandidateQuote] = {}
    if not isinstance(raw_quotes, list):
        return quotes
    for raw in raw_quotes:
        if not isinstance(raw, dict):
            continue
        symbol_raw = raw.get("symbol")
        if not isinstance(symbol_raw, str) or not symbol_raw:
            continue
        symbol = canonical_symbol(symbol_raw)
        try:
            levels = _parse_levels(raw.get("levels"))
            quote = CandidateQuote(
                symbol=symbol,
                company=_non_empty_string(raw.get("company"), "company"),
                price=_non_empty_string(raw.get("price"), "price"),
                change=_non_empty_string(raw.get("change"), "change"),
                thesis=_non_empty_string(raw.get("thesis"), "thesis"),
                technical=_string_list(raw.get("technical")),
                financial=_string_list(raw.get("financial")),
                news=_string_list(raw.get("news")),
                risks=_string_list(raw.get("risks")),
                levels=levels,
            )
        except ValueError:
            continue
        quotes[symbol] = quote
    return quotes
