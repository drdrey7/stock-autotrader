"""Ingestor orchestration tests: parse->state->flush->ack lifecycle + P2 fixes.

Clock and trade timestamps are fixed inside the regular session so the tests
never depend on wall-clock time (America/New_York session, DST-safe module).
"""

from __future__ import annotations

import datetime as dt
import json
import unittest

from quote_ingestor.app import Ingestor
from quote_ingestor.config import Settings
from quote_ingestor.d1 import D1WriteResult
from quote_ingestor.health import HealthTracker

SYMBOLS = ["AAPL", "NVDA", "TSM", "ASML"]

# 2026-08-18 (Tue): 10:00 ET = 14:00 UTC (open session).
OPEN = dt.datetime(2026, 8, 18, 14, 0, tzinfo=dt.UTC)
# 16:03 ET = 20:03 UTC (inside the post-close grace window).
GRACE = dt.datetime(2026, 8, 18, 20, 3, tzinfo=dt.UTC)
# 17:00 ET = 21:00 UTC (well after the grace: closed).
CLOSED = dt.datetime(2026, 8, 18, 21, 0, tzinfo=dt.UTC)


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


def ts_ms(instant: dt.datetime) -> int:
    """Epoch ms of a tz-aware datetime (fixed test clock)."""
    return int(instant.timestamp() * 1000)


# 15:59:59 ET on a normal day — the classic "closing auction" trade that is
# received just after the 16:00 close but still belongs to the regular session.
LATE_REGULAR_TS = ts_ms(dt.datetime(2026, 8, 18, 19, 59, 59, tzinfo=dt.UTC))


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
    def setUp(self) -> None:
        self._now = OPEN
        self._d1 = FakeD1()

    def _ingestor(self, now: dt.datetime | None = None) -> Ingestor:
        if now is not None:
            self._now = now
        return Ingestor(
            make_settings(),
            SYMBOLS,
            d1=self._d1,  # type: ignore[arg-type]
            clock=lambda: self._now,
        )

    def test_parse_to_state_to_flush(self) -> None:
        ing = self._ingestor()
        ing.on_message(trade_raw("AAPL", 310.0, ts_ms(OPEN) - 60_000))
        ing.on_message(trade_raw("NVDA", 900.0, ts_ms(OPEN) - 30_000))
        ing.flush_once()

        self.assertEqual(len(self._d1.calls), 1)
        rows = dict((s, (p, t)) for s, p, t in self._d1.calls[0])
        self.assertEqual(rows["AAPL"], (310.0, ts_ms(OPEN) - 60_000))
        self.assertEqual(rows["NVDA"], (900.0, ts_ms(OPEN) - 30_000))
        # Successful flush cleared the changed set.
        self.assertEqual(ing.store.pending_changed(), [])
        # Health mirror was written (one row per flush).
        self.assertGreaterEqual(len(self._d1.health_writes), 1)
        # A successful flush must NOT be counted as a D1 write error.
        self.assertEqual(ing.health.d1_write_errors, 0)

    def test_failed_flush_retains_pending(self) -> None:
        self._d1 = FakeD1(fail_symbols={"AAPL"})
        ing = self._ingestor()
        ing.on_message(trade_raw("AAPL", 310.0, ts_ms(OPEN) - 60_000))
        ing.on_message(trade_raw("NVDA", 900.0, ts_ms(OPEN) - 30_000))
        ing.flush_once()

        self.assertEqual(len(self._d1.calls), 1)
        pending = {p.symbol for p in ing.store.pending_changed()}
        self.assertEqual(pending, {"AAPL"})
        self.assertEqual(ing.health.d1_write_errors, 1)

        # Next flush (failure cleared) drains the retained symbol.
        self._d1.fail_symbols = set()
        ing.flush_once(OPEN)
        self.assertEqual(len(self._d1.calls), 2)
        self.assertEqual([s for s, _, _ in self._d1.calls[1]], ["AAPL"])

    # ------------------------------------------------- P2 #4 after-hours guard

    def test_after_hours_trade_rejected_not_stored(self) -> None:
        # Clock after the close+grace: an after-hours tick must never enter the
        # regular latest-price state.
        ing = self._ingestor(now=CLOSED)
        ing.on_message(trade_raw("AAPL", 320.0, ts_ms(CLOSED) - 60_000))  # 16:59 ET
        ing.flush_once()
        self.assertEqual(ing.store.snapshot(), {})
        self.assertEqual(ing.health.ignored_non_regular_count, 1)
        self.assertEqual(self._d1.calls, [])

    def test_closed_market_keeps_accepted_state_but_no_writes(self) -> None:
        # A regular-session trade is accepted; closing the window later means
        # flushes stop but the in-memory state is retained.
        ing = self._ingestor()
        ing.on_message(trade_raw("AAPL", 310.0, ts_ms(OPEN) - 60_000))  # 09:59 ET
        self._now = CLOSED
        ing.flush_once()
        self.assertEqual(self._d1.calls, [])
        self.assertEqual(ing.store.snapshot()["AAPL"].price, 310.0)
        # And it stays pending, ready for a future session flush.
        self.assertEqual([p.symbol for p in ing.store.pending_changed()], ["AAPL"])

    def test_late_regular_trade_in_grace_accepted_and_flushed(self) -> None:
        # Trade 15:59:59 ET arriving 16:03 ET (inside grace) -> accepted AND
        # written by the flush that runs during the grace window.
        ing = self._ingestor(now=GRACE)
        ing.on_message(trade_raw("NVDA", 901.0, LATE_REGULAR_TS))
        ing.flush_once(GRACE)
        self.assertEqual(len(self._d1.calls), 1)
        self.assertEqual(self._d1.calls[0][0][:2], ("NVDA", 901.0))
        self.assertEqual(self._d1.calls[0][0][2], LATE_REGULAR_TS)  # real timestamp kept
        self.assertEqual(ing.health.ignored_non_regular_count, 0)

    def test_post_grace_trade_rejected(self) -> None:
        ing = self._ingestor(now=CLOSED)
        ing.on_message(trade_raw("AAPL", 310.0, ts_ms(OPEN) - 60_000))
        self.assertEqual(ing.store.snapshot(), {})
        self.assertNotEqual(ing.health.ignored_non_regular_count, 0)

    # -------------------------------------------- P2 #2B heartbeat (1/min D1)

    def test_tick_in_open_flushes_quotes_and_heartbeat(self) -> None:
        ing = self._ingestor()
        ing.on_message(trade_raw("AAPL", 310.0, ts_ms(OPEN) - 60_000))
        ing.tick()
        self.assertEqual(len(self._d1.calls), 1)
        self.assertGreaterEqual(len(self._d1.health_writes), 1)
        self.assertTrue(ing.health.last_ws_heartbeat_at)

    def test_heartbeat_written_outside_market_no_quote_writes(self) -> None:
        ing = self._ingestor(now=CLOSED)
        ing.on_message(trade_raw("AAPL", 310.0, ts_ms(OPEN) - 60_000))  # rejected (closed)
        ing.tick()
        # Heartbeat-only: quote writes absent, health heartbeat landed.
        self.assertEqual(self._d1.calls, [])
        self.assertGreaterEqual(len(self._d1.health_writes), 1)
        self.assertTrue(ing.health.last_ws_heartbeat_at)
        record = self._d1.health_writes[-1]
        self.assertIsNotNone(record["last_ws_heartbeat_at"])
        self.assertIsNotNone(record["updated_at"])

    def test_malformed_frames_counted_not_crash(self) -> None:
        ing = self._ingestor()
        ing.on_message("not json")
        ing.on_message(trade_raw("ZZZZ", 1.0, ts_ms(OPEN) - 60_000))  # unknown symbol
        ing.on_message(trade_raw("AAPL", 310.0, ts_ms(OPEN) - 60_000))
        self.assertEqual(ing.health.malformed_message_count, 1)
        self.assertEqual(ing.health.unknown_symbol_count, 1)
        self.assertEqual(ing.store.snapshot()["AAPL"].price, 310.0)
        self.assertEqual(ing.store.symbols_seen(), 1)

    def test_newer_wins_state_protects_flush(self) -> None:
        ing = self._ingestor()
        ing.on_message(trade_raw("AAPL", 310.0, ts_ms(OPEN) - 60_000))  # newer
        ing.on_message(trade_raw("AAPL", 311.0, ts_ms(OPEN) - 90_000))  # older -> ignored
        ing.flush_once()
        rows = dict((s, p) for s, p, _ in self._d1.calls[0])
        self.assertEqual(rows["AAPL"], 310.0)

    def test_health_record_shape(self) -> None:
        ing = self._ingestor()
        ing.on_message(trade_raw("AAPL", 310.0, ts_ms(OPEN) - 60_000))
        ing.flush_once()
        record = self._d1.health_writes[-1]
        self.assertEqual(record["provider"], "finnhub-websocket")
        self.assertEqual(record["subscriptions_expected"], len(SYMBOLS))
        self.assertEqual(record["symbols_seen_recently"], 1)
        for key in (
            "connection_status", "connected_at", "last_message_at", "last_flush_at",
            "last_successful_flush_at", "subscriptions_expected", "symbols_seen_recently",
            "reconnect_count", "malformed_message_count", "d1_write_errors", "last_error",
            "last_ws_heartbeat_at", "ignored_non_regular_count",
        ):
            self.assertIn(key, record)

    def test_final_flush_during_grace(self) -> None:
        """Shutdown inside the grace still lands the final regular snapshot."""
        ing = self._ingestor(now=GRACE)
        ing.on_message(trade_raw("TSM", 410.0, LATE_REGULAR_TS))
        ing.final_flush()
        self.assertEqual(len(self._d1.calls), 1)
        self.assertEqual(self._d1.calls[0][0][:2], ("TSM", 410.0))
        # No duplication: a second final flush writes nothing new.
        ing.final_flush()
        self.assertEqual(len(self._d1.calls), 1)

    def test_final_flush_noop_after_grace(self) -> None:
        ing = self._ingestor(now=CLOSED)
        ing.on_message(trade_raw("AAPL", 310.0, ts_ms(OPEN) - 60_000))  # rejected
        ing.final_flush()
        self.assertEqual(self._d1.calls, [])


class HealthStateTest(unittest.TestCase):
    """P2 #2A — runtime connection state transitions must never stick."""

    def test_status_transitions(self) -> None:
        health = HealthTracker()
        self.assertEqual(health.connection_status, "disconnected")

        health.on_ws_status({"event": "connected"})
        self.assertEqual(health.connection_status, "connected")

        # Repeated reconnects keep flipping back to reconnecting and count.
        for _ in range(3):
            health.on_ws_status({"event": "reconnecting", "error": "boom"})
            self.assertEqual(health.connection_status, "reconnecting")
        self.assertEqual(health.reconnect_count, 3)
        self.assertIn("boom", health.last_error or "")

        # A successful reconnect restores connected.
        health.on_ws_status({"event": "connected"})
        self.assertEqual(health.connection_status, "connected")

        # Graceful shutdown flips to disconnected explicitly.
        health.on_ws_status({"event": "disconnected"})
        self.assertEqual(health.connection_status, "disconnected")
        # disconnect_count is NOT incremented by graceful shutdown events
        # (on_disconnect is the counter path).
        self.assertEqual(health.disconnect_count, 0)

    def test_disconnected_event_never_counts_reconnects(self) -> None:
        health = HealthTracker()
        health.on_ws_status({"event": "disconnected"})
        self.assertEqual(health.connection_status, "disconnected")
        self.assertEqual(health.reconnect_count, 0)

    def test_ignored_and_heartbeat_metrics(self) -> None:
        health = HealthTracker()
        health.on_ignored_non_regular(3)
        health.on_heartbeat_written()
        record = health.record(50, 12)
        self.assertEqual(record["ignored_non_regular_count"], 3)
        self.assertIsNotNone(record["last_ws_heartbeat_at"])


if __name__ == "__main__":
    unittest.main()
