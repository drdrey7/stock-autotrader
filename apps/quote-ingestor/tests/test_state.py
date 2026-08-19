"""In-memory state store tests: newer-wins, changed tracking, flush ack."""

from __future__ import annotations

import unittest

from quote_ingestor.state import QuoteStateStore
from quote_ingestor.types import TradeTick

SYMBOLS = ["AAPL", "MSFT", "NVDA"]


def tick(symbol: str, price: float, ts: int) -> TradeTick:
    return TradeTick(symbol=symbol, price=price, timestamp_ms=ts)


class QuoteStateStoreTest(unittest.TestCase):
    def setUp(self) -> None:
        self.store = QuoteStateStore(SYMBOLS)

    def test_apply_tick_marks_changed(self) -> None:
        self.assertTrue(self.store.apply_tick(tick("AAPL", 100.0, 1_000)))
        self.assertEqual(len(self.store.pending_changed()), 1)
        self.assertEqual(self.store.snapshot()["AAPL"].price, 100.0)
        self.assertEqual(self.store.snapshot()["AAPL"].as_of_ms, 1_000)
        self.assertEqual(self.store.snapshot()["AAPL"].update_count, 1)

    def test_newer_quote_wins(self) -> None:
        self.store.apply_tick(tick("AAPL", 100.0, 1_000))
        self.store.apply_tick(tick("AAPL", 101.0, 2_000))
        state = self.store.snapshot()["AAPL"]
        self.assertEqual(state.price, 101.0)
        self.assertEqual(state.as_of_ms, 2_000)

    def test_older_quote_cannot_overwrite_newer(self) -> None:
        self.store.apply_tick(tick("AAPL", 101.0, 2_000))
        applied = self.store.apply_tick(tick("AAPL", 99.0, 1_000))  # older
        self.assertFalse(applied)
        state = self.store.snapshot()["AAPL"]
        self.assertEqual(state.price, 101.0)
        self.assertEqual(state.as_of_ms, 2_000)
        self.assertEqual(state.update_count, 1)

    def test_equal_ts_same_price_is_noop(self) -> None:
        self.store.apply_tick(tick("AAPL", 100.0, 1_000))
        self.assertFalse(self.store.apply_tick(tick("AAPL", 100.0, 1_000)))

    def test_unknown_symbol_ignored(self) -> None:
        self.assertFalse(self.store.apply_tick(tick("ZZZZ", 1.0, 1_000)))
        self.assertEqual(self.store.pending_changed(), [])

    def test_successful_flush_clears_changed(self) -> None:
        self.store.apply_tick(tick("AAPL", 100.0, 1_000))
        pending = self.store.pending_changed()
        self.assertEqual(pending[0].symbol, "AAPL")
        self.store.ack_flushed({"AAPL"}, {"AAPL": 1_000})
        self.assertEqual(self.store.pending_changed(), [])

    def test_failed_flush_retains_changed(self) -> None:
        self.store.apply_tick(tick("AAPL", 100.0, 1_000))
        # No ack at all == retained.
        self.assertEqual([p.symbol for p in self.store.pending_changed()], ["AAPL"])
        # Explicit mark_failed keeps it pending too.
        self.store.apply_tick(tick("MSFT", 50.0, 1_000))
        self.store.mark_failed({"AAPL", "MSFT"})
        self.assertEqual({p.symbol for p in self.store.pending_changed()}, {"AAPL", "MSFT"})

    def test_partial_ack_clears_only_acked(self) -> None:
        self.store.apply_tick(tick("AAPL", 100.0, 1_000))
        self.store.apply_tick(tick("NVDA", 900.0, 1_000))
        self.store.ack_flushed({"AAPL"}, {"AAPL": 1_000})
        pending = {p.symbol for p in self.store.pending_changed()}
        self.assertEqual(pending, {"NVDA"})

    def test_ack_keeps_pending_if_newer_tick_arrived_during_write(self) -> None:
        self.store.apply_tick(tick("AAPL", 100.0, 1_000))
        pending = self.store.pending_changed()  # snapshot written as 100@1000
        self.assertEqual(len(pending), 1)
        # A newer tick lands while the write is in flight.
        self.store.apply_tick(tick("AAPL", 102.0, 3_000))
        self.store.ack_flushed({"AAPL"}, {"AAPL": pending[0].timestamp_ms})
        # Because current.as_of_ms (3000) > written (1000), AAPL stays pending.
        self.assertEqual([p.symbol for p in self.store.pending_changed()], ["AAPL"])

    def test_symbols_seen_tracks_universe(self) -> None:
        self.assertEqual(self.store.symbols_seen(), 0)
        self.store.apply_tick(tick("AAPL", 1.0, 1_000))
        self.store.apply_tick(tick("MSFT", 1.0, 1_000))
        self.assertEqual(self.store.symbols_seen(), 2)


if __name__ == "__main__":
    unittest.main()
