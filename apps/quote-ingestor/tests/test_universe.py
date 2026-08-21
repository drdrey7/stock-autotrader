"""Core Universe loading/validation tests (canonical JSON fixture, real file)."""

from __future__ import annotations

import json
import re
import tempfile
import unittest
from pathlib import Path

from quote_ingestor.universe import (
    EXPECTED_UNIVERSE_SIZE,
    SYMBOL_RE,
    UniverseError,
    load_core_universe,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
CANONICAL = REPO_ROOT / "packages" / "contracts" / "src" / "core-universe.v1.json"

SYMBOLS = "AAPL ADBE AFRM AMAT AMD AMZN ARM ASML AVGO COIN COST CRCL CRM CRWD CRWV DDOG DELL GOOGL GS HOOD INTC JPM KLAC LLY LRCX MA META MSFT MU NBIS NET NFLX NOW NVDA NVO ORCL PANW PLTR QCOM RDDT SHOP SNDK SNOW SOFI TSLA TSM UBER UNH V WMT".split()


def _write_json(tmp: Path, payload: object) -> Path:
    path = tmp / "core-universe.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


class UniverseValidationTest(unittest.TestCase):
    def test_canonical_file_is_exactly_50_unique_sorted_and_valid(self) -> None:
        self.assertTrue(CANONICAL.is_file(), f"missing canonical universe fixture: {CANONICAL}")
        symbols = load_core_universe(CANONICAL)
        self.assertEqual(len(symbols), EXPECTED_UNIVERSE_SIZE)
        self.assertEqual(symbols, sorted(symbols))
        self.assertEqual(len(set(symbols)), len(symbols), "duplicate symbols")
        self.assertEqual(symbols, SYMBOLS, "canonical universe drifted from the known-good list")
        for symbol in symbols:
            self.assertRegex(symbol, SYMBOL_RE.pattern)

    def test_duplicate_detection(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_json(Path(tmp), {"version": 1, "symbols": ["AAPL", "AAPL", "MSFT"]})
            with self.assertRaisesRegex(UniverseError, "duplicate"):
                load_core_universe(path)

    def test_wrong_size_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_json(Path(tmp), {"version": 1, "symbols": ["AAPL", "MSFT"]})
            with self.assertRaisesRegex(UniverseError, "exactly 50"):
                load_core_universe(path)

    def test_non_symbol_token_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_json(Path(tmp), {"version": 1, "symbols": ["AAPL2", "aapl", ""]})
            with self.assertRaisesRegex(UniverseError, "ticker shape|empty"):
                load_core_universe(path)

    def test_missing_file_rejected(self) -> None:
        with self.assertRaisesRegex(UniverseError, "not found"):
            load_core_universe("/nonexistent/core-universe.v1.json")

    def test_invalid_json_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.json"
            path.write_text("{not json", encoding="utf-8")
            with self.assertRaisesRegex(UniverseError, "not valid JSON"):
                load_core_universe(path)

    def test_unsorted_rejected(self) -> None:
        shuffled = list(SYMBOLS)
        shuffled[0], shuffled[1] = shuffled[1], shuffled[0]  # size stays 50
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_json(Path(tmp), {"version": 1, "symbols": shuffled})
            with self.assertRaisesRegex(UniverseError, "sorted"):
                load_core_universe(path)

    def test_symbol_regex_shape(self) -> None:
        self.assertRegex("GOOGL", SYMBOL_RE.pattern)
        self.assertRegex("BRK-B", SYMBOL_RE.pattern)
        self.assertIsNone(SYMBOL_RE.match("aapl"))
        self.assertIsNone(SYMBOL_RE.match("A" * 13))
        self.assertIsNone(SYMBOL_RE.match(""))


if __name__ == "__main__":
    unittest.main()
