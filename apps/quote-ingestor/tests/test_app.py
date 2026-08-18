"""Ingestor orchestration tests: parse->state->flush->ack lifecycle."""

from __future__ import annotations

import json
import time
import unittest

from quote_ingestor.app import Ingestor
from quote_ingestor.config import Settings
from quote_ingestor.d1 import D1WriteResult

SYMBOLS = ["AAPL", "NVDA", "TSM", "ASML"]
T = int(time.time() * 1000)  # realistic "now" for trade timestamps


def make_settings(**overrides: object) -> Settings:
    defaults: dict[str, object] = {
        "finnhub_api_key": "k-app-test",
        "cloudflare_api_token": "t",
        "cloudflare_account_id": "c",
        "cloudflare_d1_database_id": "d",
    }
    defaults.update(overrides)
    return Settings(**defaults)  # type: ignore[arg-type]


def trade_raw(symbol: str, price: float, ts: int) -> str:
    return json.dumps({"type": "trade", "data": [{"s": symbol, "p": price, "t": ts, "v": 10}]})


class FakeD1:
    def __init__(self, fail_symbols: set[str] | None = None) -> None:
        self.calls: list[list[tuple[str, float, int]]] = []
        self.health_writes: list[dict] = []
        self.fail_symbols = fail_symbols or set()

    def upsert_quotes(self, rows):
        self.calls.append(list(rows))
        written = [s for s, _, _ in rows if s not in self.fail_symbols]
        failed = [s for s, _, _ in rows if s in self.fail_symbols]
        return D1WriteResult(written=written, failed=failed, http_status=200)

    def write_health(self, record: dict) -> bool:
        self.health_writes.append(record)
        return True

    def read_latest_quotes_count(self) -> dict:
        return {"total": 0, "rows": []}


class IngestorTest(unittest.TestCase):
    def _ingestor(self, d1: FakeD1, window: bool = True) -> Ingestor:
        return Ingestor(
            make_settings(),
            SYMBOLS,
            d1=d1,  # type: ignore[arg-type]
            flush_window_fn=lambda _now: window,
        )

    def test_parse_to_state_to_flush(self) -> None:
        d1 = FakeD1()
        ingestor = self._ingestor(d1)
        ingestor.on_message(trade_raw("AAPL", 310.0, T - 2_000))
        ingestor.on_message(trade_raw("NVDA", 900.0, T - 1_000))
        ingestor.flush_once()

        self.assertEqual(len(d1.calls), 1)
        rows = dict((s, (p, t)) for s, p, t in d1.calls[0])
        self.assertEqual(rows["AAPL"], (310.0, T - 2_000))
        self.assertEqual(rows["NVDA"], (900.0, T - 1_000))
        # Successful flush cleared the changed set.
        self.assertEqual(ingestor.store.pending_changed(), [])
        # Health mirror was written (one row per flush).
        self.assertGreaterEqual(len(d1.health_writes), 1)
        # A successful flush must NOT be counted as a D1 write error.
        self.assertEqual(ingestor.health.d1_write_errors, 0)

    def test_failed_flush_retains_pending(self) -> None:
        d1 = FakeD1(fail_symbols={"AAPL"})
        ingestor = self._ingestor(d1)
        ingestor.on_message(trade_raw("AAPL", 310.0, T - 2_000))
        ingestor.on_message(trade_raw("NVDA", 900.0, T - 1_000))
        ingestor.flush_once()

        self.assertEqual(len(d1.calls), 1)
        # Only NVDA was written + acked; AAPL stayed pending.
        self.assertEqual(d1.calls[0], [("AAPL", 310.0, T - 2_000), ("NVDA", 900.0, T - 1_000)])
        pending = {p.symbol for p in ingestor.store.pending_changed()}
        self.assertEqual(pending, {"AAPL"})
        self.assertEqual(ingestor.health.d1_write_errors, 1)

        # Next flush (failure cleared) drains the retained symbol.
        d1.fail_symbols = set()
        ingestor.flush_once()
        self.assertEqual(len(d1.calls), 2)
        self.assertEqual(d1.calls[1], [("AAPL", 310.0, T - 2_000)])

    def test_market_closed_no_writes(self) -> None:
        d1 = FakeD1()
        ingestor = self._ingestor(d1, window=False)
        ingestor.on_message(trade_raw("AAPL", 310.0, T - 2_000))
        ingestor.flush_once()
        self.assertEqual(d1.calls, [])
        # State is still kept in memory while the market is closed.
        self.assertEqual(ingestor.store.snapshot()["AAPL"].price, 310.0)

    def test_malformed_frames_counted_not_crash(self) -> None:
        d1 = FakeD1()
        ingestor = self._ingestor(d1)
        ingestor.on_message("not json")
        ingestor.on_message(trade_raw("ZZZZ", 1.0, T - 1_000))  # unknown symbol
        ingestor.on_message(trade_raw("AAPL", 310.0, T - 2_000))
        self.assertEqual(ingestor.health.malformed_message_count, 1)
        self.assertEqual(ingestor.health.unknown_symbol_count, 1)
        self.assertEqual(ingestor.store.snapshot()["AAPL"].price, 310.0)
        # Parser never accepted the unknown symbol into state.
        self.assertEqual(ingestor.store.symbols_seen(), 1)

    def test_newer_wins_state_protects_flush(self) -> None:
        d1 = FakeD1()
        ingestor = self._ingestor(d1)
        ingestor.on_message(trade_raw("AAPL", 310.0, T - 1_000))  # newer
        ingestor.on_message(trade_raw("AAPL", 311.0, T - 5_000))  # older -> ignored
        ingestor.flush_once()
        rows = dict((s, p) for s, p, _ in d1.calls[0])
        self.assertEqual(rows["AAPL"], 310.0)

    def test_health_record_shape(self) -> None:
        d1 = FakeD1()
        ingestor = self._ingestor(d1)
        ingestor.on_message(trade_raw("AAPL", 310.0, T - 2_000))
        ingestor.flush_once()
        record = d1.health_writes[-1]
        self.assertEqual(record["provider"], "finnhub-websocket")
        self.assertEqual(record["subscriptions_expected"], len(SYMBOLS))
        self.assertEqual(record["symbols_seen_recently"], 1)
        for key in (
            "connection_status", "connected_at", "last_message_at", "last_flush_at",
            "last_successful_flush_at", "subscriptions_expected", "symbols_seen_recently",
            "reconnect_count", "malformed_message_count", "d1_write_errors", "last_error",
        ):
            self.assertIn(key, record)


if __name__ == "__main__":
    unittest.main()
