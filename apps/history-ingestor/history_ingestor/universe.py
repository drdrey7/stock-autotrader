"""Core Universe loading and validation.

The history ingestor may use EXCLUSIVELY the canonical universe file
(``packages/contracts/src/core-universe.v1.json``) — the only source of truth
for the 50 symbols. No second permanent list may exist here. Mirrors
``apps/quote-ingestor/quote_ingestor/universe.py`` and the TS validation in
``packages/contracts/src/core-universe.ts``.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

EXPECTED_UNIVERSE_SIZE = 50
SYMBOL_RE = re.compile(r"^[A-Z][A-Z0-9-]{0,11}$")


class UniverseError(RuntimeError):
    """Raised when the canonical universe file is invalid."""


def load_core_universe(path: str | Path) -> list[str]:
    """Load, validate and return the canonical Core Universe symbol list.

    Validation: positive integer version; exactly EXPECTED_UNIVERSE_SIZE
    symbols; no duplicates; valid ticker shapes; sorted ascending.
    """
    file_path = Path(path)
    if not file_path.is_file():
        raise UniverseError(f"core-universe file not found: {file_path}")
    try:
        payload = json.loads(file_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise UniverseError(f"core-universe file is not valid JSON: {exc}") from exc

    if not isinstance(payload, dict):
        raise UniverseError("core-universe must be a JSON object with a symbols array")
    version = payload.get("version")
    if not isinstance(version, int) or version <= 0:
        raise UniverseError("core-universe version must be a positive integer")

    symbols_raw = payload.get("symbols")
    if not isinstance(symbols_raw, list):
        raise UniverseError("core-universe symbols must be an array")

    seen: set[str] = set()
    symbols: list[str] = []
    for index, item in enumerate(symbols_raw):
        if not isinstance(item, str):
            raise UniverseError(f"symbol at index {index} is not a string")
        token = item.strip()
        if token == "":
            raise UniverseError(f"symbol at index {index} is empty")
        if not SYMBOL_RE.match(token):
            raise UniverseError(f"symbol {token!r} does not match the ticker shape ^[A-Z][A-Z0-9-]{{0,11}}$")
        if token in seen:
            raise UniverseError(f"duplicate symbol in core-universe: {token}")
        seen.add(token)
        symbols.append(token)

    if len(symbols) != EXPECTED_UNIVERSE_SIZE:
        raise UniverseError(
            f"core-universe must contain exactly {EXPECTED_UNIVERSE_SIZE} symbols, got {len(symbols)}"
        )
    if symbols != sorted(symbols):
        raise UniverseError("core-universe symbols must be sorted ascending")
    return symbols
