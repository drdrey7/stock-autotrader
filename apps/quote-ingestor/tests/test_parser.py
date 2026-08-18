"""WebSocket trade-frame parser tests."""

from __future__ import annotations

import json
import math
import unittest

from quote_ingestor.parser import TradeFrameParser

SYMBOLS = ["AAPL", "NVDA", "TSM", "ASML"]
NOW = 1_787_073_678_242  # epoch ms (matches the POC frame vocabulary)


def trade_frame(data: list[dict]) -> str:
    return json.dumps({"type": "trade", "data": data})


class TradeFrameParserTest(unittest.TestCase):
    def setUp(self) -> None:
        self.parser = TradeFrameParser(SYMBOLS, now_ms=NOW)

    def test_valid_single_tick(self) -> None:
        raw = trade_frame([{"s": "AAPL", "p": 310.63, "t": NOW - 10_000, "v": 100}])
        result = self.parser.parse(raw, max_future_ms=300, max_age_ms=86400)
        self.assertEqual(result.malformed, 0)
        self.assertEqual(len(result.ticks), 1)
        tick = result.ticks[0]
        self.assertEqual(tick.symbol, "AAPL")
        self.assertAlmostEqual(tick.price, 310.63)
        self.assertEqual(tick.timestamp_ms, NOW - 10_000)
        self.assertEqual(tick.size, 100)

    def test_multiple_entries_and_unknown_symbol_ignored(self) -> None:
        raw = trade_frame([
            {"s": "AAPL", "p": 310.0, "t": NOW - 1000, "v": 10},
            {"s": "ZZZZ", "p": 1.0, "t": NOW - 1000, "v": 1},  # unknown symbol
            {"s": "NVDA", "p": 900.0, "t": NOW - 2000, "v": 4},
        ])
        result = self.parser.parse(raw, max_future_ms=300, max_age_ms=86400)
        self.assertEqual([t.symbol for t in result.ticks], ["AAPL", "NVDA"])
        self.assertEqual(result.unknown_symbols, ["ZZZZ"])
        self.assertEqual(result.malformed, 0)

    def test_malformed_payloads(self) -> None:
        cases = [
            "not json",
            json.dumps({"type": "trade"}),  # no data key
            json.dumps({"type": "trade", "data": "nope"}),
            json.dumps([1, 2, 3]),
            json.dumps({"type": "trade", "data": [{"s": "AAPL"}]}),  # no price/t
            json.dumps({"type": "trade", "data": [{"s": "AAPL", "p": -5, "t": NOW}]}),  # negative price
            json.dumps({"type": "trade", "data": [{"s": "AAPL", "p": 0, "t": NOW}]}),  # zero price
            json.dumps({"type": "trade", "data": [{"s": "AAPL", "p": math.nan, "t": NOW}]}),  # NaN price
            json.dumps({"type": "trade", "data": [{"s": "aapl", "p": 100, "t": NOW}]}),  # bad ticker shape
            json.dumps({"type": "trade", "data": [{"s": 42, "p": 100, "t": NOW}]}),  # non-string symbol
        ]
        for raw in cases:
            with self.subTest(raw=raw[:40]):
                result = self.parser.parse(raw, max_future_ms=300, max_age_ms=86400)
                self.assertEqual(result.ticks, [])
                self.assertGreaterEqual(result.malformed, 1)

    def test_invalid_price_ignored_but_symbol_would_be_parsed_next_time(self) -> None:
        raw = trade_frame([{"s": "NVDA", "p": "abc", "t": NOW}])
        result = self.parser.parse(raw, max_future_ms=300, max_age_ms=86400)
        self.assertEqual(result.ticks, [])
        self.assertEqual(result.malformed, 1)

    def test_invalid_timestamps_rejected(self) -> None:
        future = trade_frame([{"s": "AAPL", "p": 100, "t": NOW + 400_000}])  # > 300s future
        ancient = trade_frame([{"s": "AAPL", "p": 100, "t": NOW - 90_000_000_000}])  # > 1 day
        for raw in (future, ancient):
            result = self.parser.parse(raw, max_future_ms=300, max_age_ms=86400)
            self.assertEqual(result.ticks, [])
            self.assertEqual(result.malformed, 1)

    def test_non_trade_frame_classified(self) -> None:
        raw = json.dumps({"type": "ping", "data": []})
        result = self.parser.parse(raw, max_future_ms=300, max_age_ms=86400)
        self.assertEqual(result.ticks, [])
        self.assertEqual(result.non_trade_messages, 1)
        self.assertEqual(result.malformed, 0)

    def test_missing_type_is_malformed(self) -> None:
        raw = json.dumps({"data": []})
        result = self.parser.parse(raw, max_future_ms=300, max_age_ms=86400)
        self.assertEqual(result.malformed, 1)

    def test_provider_error_frame_is_non_trade(self) -> None:
        # Finnhub sends type "error" frames to signal subscription problems —
        # classified (not crash), surfaced as non-trade for operators.
        raw = json.dumps({"type": "error", "data": [{"message": "no connection"}]})
        result = self.parser.parse(raw, max_future_ms=300, max_age_ms=86400)
        self.assertEqual(result.non_trade_messages, 1)
        self.assertEqual(result.malformed, 0)


if __name__ == "__main__":
    unittest.main()
