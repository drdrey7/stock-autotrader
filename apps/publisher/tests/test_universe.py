"""Universe snapshot tests (unittest — CI-compatible)."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from publisher.universe import UniverseSnapshot, canonical_symbol, load_universe

REPO_ROOT = Path(__file__).resolve().parents[1]


def _write_snapshot(directory: Path, name: str, index: str, version: str, symbols: list[str]) -> Path:
    path = directory / name
    path.write_text(json.dumps({"version": version, "index": index, "symbols": symbols}))
    return path


class UniverseSnapshotTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = Path(self._tmp.name)

    def _load(self, sp_symbols: list[str], nd_symbols: list[str]) -> UniverseSnapshot:
        sp = _write_snapshot(self.dir, "sp.json", "S&P 500", "2026-08-11", sp_symbols)
        nd = _write_snapshot(self.dir, "nd.json", "Nasdaq-100", "2026-08-11", nd_symbols)
        return load_universe(sp, nd)

    def test_canonical_symbol(self) -> None:
        self.assertEqual(canonical_symbol("$NVDA"), "NVDA")
        self.assertEqual(canonical_symbol("nvda"), "NVDA")
        self.assertEqual(canonical_symbol("$BRK/B"), "BRK-B")

    def test_index_of_and_labels(self) -> None:
        universe = self._load(["NVDA", "AAPL"], ["NVDA"])
        self.assertEqual(universe.version, "2026-08-11")
        self.assertEqual(universe.index_of("NVDA"), "S&P 500")
        self.assertEqual(universe.index_labels("NVDA"), ("S&P 500", "Nasdaq-100"))
        self.assertEqual(universe.index_of("AAPL"), "S&P 500")
        self.assertIsNone(universe.index_of("TSLA"))
        self.assertTrue(universe.contains("NVDA"))
        self.assertFalse(universe.contains("DOGE"))

    def test_version_mismatch_rejected(self) -> None:
        sp = _write_snapshot(self.dir, "sp.json", "S&P 500", "2026-08-11", ["NVDA"])
        nd = _write_snapshot(self.dir, "nd.json", "Nasdaq-100", "2026-08-12", ["NVDA"])
        with self.assertRaises(ValueError):
            load_universe(sp, nd)

    def test_duplicate_symbols_rejected(self) -> None:
        with self.assertRaises(ValueError):
            self._load(["NVDA", "NVDA"], ["NVDA"])

    def test_malformed_symbol_rejected(self) -> None:
        with self.assertRaises(ValueError):
            self._load(["NOT A TICKER"], ["NVDA"])

    def test_generated_snapshots_are_valid(self) -> None:
        universe = load_universe(
            REPO_ROOT / "data" / "sp500.v1.json",
            REPO_ROOT / "data" / "nasdaq100.v1.json",
        )
        self.assertEqual(universe.version, "2026-08-11")
        self.assertTrue(universe.contains("NVDA"))
        self.assertTrue(universe.contains("AAPL"))
        self.assertTrue(universe.contains("MSFT"))
        self.assertFalse(universe.contains("DOGE"))


if __name__ == "__main__":
    unittest.main()
