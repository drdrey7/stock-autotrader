"""Extract versioned S&P 500 / Nasdaq-100 membership from the shared contract.

The canonical membership snapshot lives in
packages/contracts/src/briefing-universe.ts (single source of truth for the
publication boundary). This script regenerates the publisher's JSON copies so
both sides stay consistent. Run it only when the contract snapshot changes:

    python3 scripts/extract_universe.py

Outputs (committed):
    data/sp500.v1.json
    data/nasdaq100.v1.json
"""
from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from pathlib import Path

CONTRACT = Path(__file__).resolve().parents[3] / "packages" / "contracts" / "src" / "briefing-universe.ts"
OUT_DIR = Path(__file__).resolve().parents[1] / "data"


def _extract(text: str, name: str) -> list[str]:
    pattern = re.compile(rf'"{re.escape(name)}":\s*\[(.*?)\n\s*\]', re.S)
    match = pattern.search(text)
    if not match:
        raise SystemExit(f"could not locate member list for {name!r} in {CONTRACT}")
    symbols = re.findall(r'"([^"]+)"', match.group(1))
    if not symbols:
        raise SystemExit(f"empty member list for {name!r}")
    return symbols


def main() -> None:
    text = CONTRACT.read_text(encoding="utf-8")
    version_match = re.search(r"briefingUniverseMembershipVersion = \"([^\"]+)\"", text)
    if not version_match:
        raise SystemExit("membership version constant not found in contract")
    version = version_match.group(1)

    indexes = {
        "sp500": ("S&P 500", _extract(text, "S&P 500")),
        "nasdaq100": ("Nasdaq-100", _extract(text, "Nasdaq-100")),
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    generated_at = datetime.now(UTC).isoformat()
    for key, (index_name, symbols) in indexes.items():
        payload = {
            "version": version,
            "index": index_name,
            "generatedAt": generated_at,
            "symbolCount": len(symbols),
            "symbols": symbols,
        }
        path = OUT_DIR / f"{key}.v1.json"
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {path} ({len(symbols)} symbols, version {version})")

    # sanity: no duplicate symbols inside each list, canonical format
    for key, (_, symbols) in indexes.items():
        duplicates = {s for s in symbols if symbols.count(s) > 1}
        if duplicates:
            raise SystemExit(f"{key} contains duplicate symbols: {sorted(duplicates)}")
        bad = [s for s in symbols if not re.fullmatch(r"[A-Z0-9.-]{1,12}", s)]
        if bad:
            raise SystemExit(f"{key} contains malformed symbols: {bad}")


if __name__ == "__main__":
    main()
