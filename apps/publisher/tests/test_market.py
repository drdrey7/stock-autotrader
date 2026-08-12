"""Market snapshot and candidate quote tests (unittest — CI-compatible)."""
from __future__ import annotations

import json
import unittest
from pathlib import Path

from publisher.market import load_benchmarks, load_candidate_quotes

REPO_ROOT = Path(__file__).resolve().parents[1]


def _benchmark(name: str, symbol: str, value: str = "1.00", change: str = "+0.1%") -> dict:
    return {
        "name": name,
        "symbol": symbol,
        "value": value,
        "change": change,
        "state": "Constructive",
        "note": "Note",
    }


def _quote(ratio: float | None = 2.6, reward_text: str = "2.6R") -> dict:
    return {
        "symbol": "NVDA",
        "company": "NVIDIA Corporation",
        "price": "$183.10",
        "change": "+1.75%",
        "thesis": "Setup intact.",
        "technical": ["Above 20D."],
        "financial": ["Large cap."],
        "news": ["No adverse headline."],
        "risks": ["Gap risk."],
        "levels": {
            "trigger": "Hold $183.60",
            "invalidation": "Close $179.20",
            "objective": "$194.00",
            "rewardRisk": reward_text,
            "rewardRiskRatio": ratio,
        },
    }


class MarketTests(unittest.TestCase):
    def test_valid_benchmarks(self) -> None:
        items = [
            _benchmark("S&P 500", "SP:SPX"),
            _benchmark("Nasdaq-100", "NASDAQ:NDX"),
            _benchmark("VIX", "CBOE:VIX"),
        ]
        parsed = load_benchmarks(items)
        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual([item.name for item in parsed], ["S&P 500", "Nasdaq-100", "VIX"])

    def test_invalid_benchmarks(self) -> None:
        cases = [
            [],
            [_benchmark("S&P 500", "SP:SPX")],
            [
                _benchmark("S&P 500", "SP:SPX"),
                _benchmark("Nasdaq-100", "NASDAQ:NDX"),
                _benchmark("VIX", "WRONG:SYM"),
            ],
            [
                _benchmark("S&P 500", "SP:SPX"),
                _benchmark("S&P 500", "SP:SPX"),
                _benchmark("VIX", "CBOE:VIX"),
            ],
        ]
        for items in cases:
            with self.subTest(items=items):
                self.assertIsNone(load_benchmarks(items))

    def test_candidate_quote_complete(self) -> None:
        quotes = load_candidate_quotes([_quote()])
        self.assertIn("NVDA", quotes)
        self.assertTrue(quotes["NVDA"].is_complete())

    def test_candidate_quote_ratio_mismatch_fails_gate(self) -> None:
        quotes = load_candidate_quotes([_quote(ratio=2.6, reward_text="3.0R")])
        self.assertIn("NVDA", quotes)
        self.assertFalse(quotes["NVDA"].is_complete())

    def test_candidate_quote_null_ratio_fails_gate(self) -> None:
        quotes = load_candidate_quotes([_quote(ratio=None, reward_text="No defined risk")])
        self.assertIn("NVDA", quotes)
        self.assertFalse(quotes["NVDA"].is_complete())

    def test_malformed_candidate_skipped(self) -> None:
        quotes = load_candidate_quotes([{"symbol": "NVDA", "company": "X"}])
        self.assertEqual(quotes, {})

    def test_sample_quote_fixture(self) -> None:
        payload = json.loads((REPO_ROOT / "fixtures" / "quotes.sample.json").read_text())
        benchmarks = load_benchmarks(payload["benchmarks"])
        self.assertIsNotNone(benchmarks)
        quotes = load_candidate_quotes(payload["candidates"])
        self.assertIn("NVDA", quotes)
        self.assertTrue(quotes["NVDA"].is_complete())
        self.assertIn("AAPL", quotes)
        self.assertTrue(quotes["AAPL"].is_complete())
        # TSLA's empty invalidation/objective makes it malformed -> skipped at load
        self.assertNotIn("TSLA", quotes)


if __name__ == "__main__":
    unittest.main()
