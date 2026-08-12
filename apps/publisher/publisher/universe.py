"""Versioned S&P 500 / Nasdaq-100 membership snapshots.

The publisher keeps its own JSON copies of the shared contract snapshot
(``packages/contracts/src/briefing-universe.ts``); regenerate with
``python3 scripts/extract_universe.py`` whenever the contract snapshot changes.
Membership is used for the cheap gate BEFORE any expensive candidate analysis.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

CANONICAL_SYMBOL_RE = re.compile(r"^[A-Z0-9.-]{1,12}$")

SP500_INDEX = "S&P 500"
NASDAQ100_INDEX = "Nasdaq-100"


def canonical_symbol(value: str) -> str:
    """Normalise a raw ticker mention into canonical contract format.

    Mirrors ``canonicalBriefingSymbol`` in packages/contracts: uppercase and
    ``.`` -> ``-`` (so ``$BRK.B`` resolves to the canonical ``BRK-B``).
    """
    symbol = value.strip().upper()
    if symbol.startswith("$"):
        symbol = symbol[1:]
    symbol = symbol.replace(".", "-").replace("/", "-")
    return symbol


@dataclass(frozen=True)
class UniverseSnapshot:
    version: str
    indexes: dict[str, frozenset[str]]

    def index_of(self, symbol: str) -> str | None:
        """Return the first index containing the symbol, else ``None``."""
        for index_name in (SP500_INDEX, NASDAQ100_INDEX):
            if symbol in self.indexes.get(index_name, frozenset()):
                return index_name
        return None

    def index_labels(self, symbol: str) -> tuple[str, ...]:
        """Return all index labels containing the symbol, canonical order."""
        return tuple(
            index_name
            for index_name in (SP500_INDEX, NASDAQ100_INDEX)
            if symbol in self.indexes.get(index_name, frozenset())
        )

    def contains(self, symbol: str) -> bool:
        return self.index_of(symbol) is not None


def _load_index_file(path: Path) -> tuple[str, frozenset[str]]:
    with path.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    index_name = payload.get("index")
    version = payload.get("version")
    symbols = payload.get("symbols")
    if not isinstance(index_name, str) or not isinstance(version, str) or not isinstance(symbols, list):
        raise ValueError(f"invalid universe file: {path}")
    normalized: list[str] = []
    for symbol in symbols:
        if not isinstance(symbol, str):
            raise ValueError(f"non-string symbol in {path}")
        canonical = canonical_symbol(symbol)
        if not CANONICAL_SYMBOL_RE.fullmatch(canonical):
            raise ValueError(f"malformed symbol {symbol!r} in {path}")
        normalized.append(canonical)
    if len(set(normalized)) != len(normalized):
        raise ValueError(f"duplicate symbols in {path}")
    return index_name, frozenset(normalized)


def load_universe(sp500_path: str | Path, nasdaq100_path: str | Path) -> UniverseSnapshot:
    """Load both membership snapshots; versions must agree."""
    sp500_index, sp500_members = _load_index_file(Path(sp500_path))
    nasdaq_index, nasdaq_members = _load_index_file(Path(nasdaq100_path))

    sp500_payload = json.loads(Path(sp500_path).read_text(encoding="utf-8"))
    nasdaq_payload = json.loads(Path(nasdaq100_path).read_text(encoding="utf-8"))
    version = sp500_payload.get("version")
    if version != nasdaq_payload.get("version"):
        raise ValueError("S&P 500 and Nasdaq-100 snapshots have different versions")

    indexes = {
        sp500_index: sp500_members,
        nasdaq_index: nasdaq_members,
    }
    return UniverseSnapshot(version=version, indexes=indexes)
