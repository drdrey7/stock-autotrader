"""Market-data stall watchdog tests (incident 2026-08-19).

Each test injects a controllable clock and a fake WebSocket so the watchdog
thread can be exercised deterministically — no sleeps, no real network.
"""

from __future__ import annotations

import datetime as dt
import json
import threading
import time
import unittest
from unittest.mock import MagicMock, patch

from quote_ingestor.app import Ingestor
from quote_ingestor.config import ConfigError, Settings
from quote_ingestor.health import HealthTracker
from quote_ingestor.ws import FinnhubWebSocketClient

# Canonical 4-symbol universe for fast tests.
SYMBOLS = ["AAPL", "NVDA", "TSM", "ASML"]

# 2026-08-18 (Tue): US regular session, EDT is UTC-4.
ET_OPEN = dt.datetime(2026, 8, 18, 13, 30, tzinfo=dt.UTC)  # 09:30 ET
ET_10AM = dt.datetime(2026, 8, 18, 14, 0, tzinfo=dt.UTC)  # 10:00 ET
ET_1700 = dt.datetime(2026, 8, 18, 21, 0, tzinfo=dt.UTC)  # 17:00 ET
ET_PRE = dt.datetime(2026, 8, 18, 13, 0, tzinfo=dt.UTC)  # 09:00 ET
SATURDAY = dt.datetime(2026, 8, 15, 14, 0, tzinfo=dt.UTC)


def make_settings(**overrides: object) -> Settings:
    defaults: dict[str, object] = {
        "finnhub_api_key": "k-watchdog-test",
        "cloudflare_api_token": "t",
        "cloudflare_account_id": "c",
        "cloudflare_d1_database_id": "d",
        "ws_market_stall_seconds": 2.0,
        "ws_market_stall_cooldown_seconds": 3.0,
        "ws_reconnect_base_seconds": 0.01,
        "ws_reconnect_max_seconds": 0.1,
        "ws_reconnect_jitter": 0.1,
        "ws_recv_timeout_seconds": 0.05,
        "ws_ping_interval_seconds": 60.0,
    }
    defaults.update(overrides)
    return Settings(**defaults)  # type: ignore[arg-type]


class FakeD1:
    def __init__(self, fail_symbols: set[str] | None = None) -> None:
        self.calls: list[list[tuple[str, float, int]]] = []
        self.health_writes: list[dict] = []
        self.fail_symbols = fail_symbols or set()

    def upsert_quotes(self, rows):
        self.calls.append(list(rows))
        written = [s for s, _, _ in rows if s not in self.fail_symbols]
        failed = [s for s, _, _ in rows if s in self.fail_symbols]
        from quote_ingestor.d1 import D1WriteResult
        return D1WriteResult(written=written, failed=failed, http_status=200)

    def write_health(self, record: dict) -> bool:
        self.health_writes.append(record)
        return True

    def read_latest_quotes_count(self) -> dict:
        return {"total": 0, "rows": []}


class FakeConn:
    def __init__(
        self,
        messages: list[object] | None = None,
        recv_exception: Exception | None = None,
    ) -> None:
        self.messages = list(messages or [])
        self.recv_exception = recv_exception
        self.sent: list[str] = []
        self.pings = 0
        self.closed = False
        self._lock = threading.Lock()

    @property
    def connected(self) -> bool:
        return not self.closed

    def recv(self) -> str:
        if self.recv_exception is not None:
            raise self.recv_exception
        if self.closed:
            raise ConnectionError("socket closed")
        with self._lock:
            if self.messages:
                item = self.messages.pop(0)
                if isinstance(item, Exception):
                    raise item
                return str(item)
        raise TimeoutError("idle")

    def send(self, data: str) -> None:
        with self._lock:
            self.sent.append(data)

    def ping(self, payload: str | None = None) -> None:
        self.pings += 1

    def close(self, status: int | None = None, reason: str | None = None) -> None:
        with self._lock:
            self.closed = True


def trade_raw(symbol: str, price: float, ts: int) -> str:
    return json.dumps({"type": "trade", "data": [{"s": symbol, "p": price, "t": ts, "v": 10}]})


def ts_ms(instant: dt.datetime) -> int:
    return int(instant.timestamp() * 1000)


class WatchdogTest(unittest.TestCase):
    """Direct unit tests on the watchdog decision logic."""

    def _ingestor(self, now: dt.datetime, connected: bool = True, subs_ok: bool = True,
                  last_tick_mono: float | None = None,
                  last_grace_mono: float | None = None,
                  last_stall_mono: float | None = None,
                  phase: str | None = None,
                  connect_count: int = 1,
                  observed_connect_count: int = 1) -> tuple[Ingestor, MagicMock]:
        settings = make_settings()
        ing = Ingestor(settings, SYMBOLS, FakeD1(), clock=lambda: now)
        ws_mock = MagicMock(spec=FinnhubWebSocketClient)
        ws_mock.is_connected = connected
        ws_mock.subscriptions_sent = len(SYMBOLS) if subs_ok else 0
        ws_mock.last_message_mono = None
        ws_mock.connect_count = connect_count
        ing.set_ws_client(ws_mock)
        if last_tick_mono is not None:
            ing.health._last_accepted_regular_tick_monotonic = last_tick_mono
        ing._last_market_phase = phase
        ing._last_connected = connected
        ing._last_observed_connect_count = observed_connect_count
        if last_grace_mono is not None:
            ing._grace_mono = last_grace_mono
        if last_stall_mono is not None:
            ing._last_stall_reconnect_mono = last_stall_mono
        return ing, ws_mock

    def test_1_healthy_ticks_no_reconnect(self) -> None:
        """OPEN + recent accepted tick -> no reconnect."""
        ing, ws_mock = self._ingestor(
            now=ET_10AM, connected=True, subs_ok=True,
            last_tick_mono=100.0, last_grace_mono=100.0,
            phase="open",
        )
        with patch("quote_ingestor.health.time") as mock_time:
            mock_time.monotonic.return_value = 101.0  # 1s after tick, threshold 2s
            mock_time.time.return_value = time.time()
            ing._watchdog_tick()
        ws_mock.request_reconnect.assert_not_called()

    def test_2_stall_triggers_reconnect(self) -> None:
        """OPEN + no accepted tick for > threshold -> reconnect."""
        ing, ws_mock = self._ingestor(
            now=ET_10AM, connected=True, subs_ok=True,
            last_tick_mono=100.0, last_grace_mono=100.0, phase="open",
        )
        with patch("quote_ingestor.health.time") as mock_time:
            mock_time.monotonic.return_value = 105.0  # 5s after tick, threshold 2s
            mock_time.time.return_value = time.time()
            ing._watchdog_tick()
        ws_mock.request_reconnect.assert_called_once()

    def test_3_non_trade_messages_only(self) -> None:
        """OPEN + only non-trade messages + no regular ticks -> reconnect."""
        ing, ws_mock = self._ingestor(
            now=ET_10AM, connected=True, subs_ok=True,
            last_tick_mono=None, last_grace_mono=100.0, phase="open",
        )
        with patch("quote_ingestor.health.time") as mock_time:
            mock_time.monotonic.return_value = 105.0
            mock_time.time.return_value = time.time()
            ing._watchdog_tick()
        ws_mock.request_reconnect.assert_called_once()

    def test_4_pre_market_no_reconnect(self) -> None:
        """PRE-MARKET + zero trades for hours -> no reconnect."""
        ing, ws_mock = self._ingestor(
            now=ET_PRE, connected=True, subs_ok=True,
            last_tick_mono=None, last_grace_mono=None, phase="pre_open",
        )
        ing._watchdog_tick()
        ws_mock.request_reconnect.assert_not_called()

    def test_5_closed_no_reconnect(self) -> None:
        """CLOSED + zero trades for hours -> no reconnect."""
        ing, ws_mock = self._ingestor(
            now=ET_1700, connected=True, subs_ok=True,
            last_tick_mono=None, last_grace_mono=None, phase="closed",
        )
        ing._watchdog_tick()
        ws_mock.request_reconnect.assert_not_called()

    def test_6_weekend_no_reconnect(self) -> None:
        """WEEKEND + zero trades -> no reconnect."""
        ing, ws_mock = self._ingestor(
            now=SATURDAY, connected=True, subs_ok=True,
            last_tick_mono=None, last_grace_mono=None, phase="closed",
        )
        ing._watchdog_tick()
        ws_mock.request_reconnect.assert_not_called()

    def test_7_open_transition_grace(self) -> None:
        """Transition closed -> open resets grace. No immediate reconnect."""
        ing, ws_mock = self._ingestor(
            now=ET_OPEN, connected=True, subs_ok=True,
            last_tick_mono=None, last_grace_mono=None, phase="pre_open",
        )
        with patch("quote_ingestor.health.time") as mock_time:
            mock_time.monotonic.return_value = 200.0
            mock_time.time.return_value = time.time()
            ing._watchdog_tick()
        ws_mock.request_reconnect.assert_not_called()
        self.assertEqual(ing._grace_mono, 200.0)

    def test_8_after_ws_reconnect_grace_resets(self) -> None:
        """A fresh WS connect (generation change) resets grace. No immediate second reconnect."""
        ing, ws_mock = self._ingestor(
            now=ET_10AM, connected=True, subs_ok=True,
            last_tick_mono=None, last_grace_mono=None, phase="open",
            connect_count=2, observed_connect_count=1,  # generation changed
        )
        with patch("quote_ingestor.health.time") as mock_time:
            mock_time.monotonic.return_value = 300.0
            mock_time.time.return_value = time.time()
            ing._watchdog_tick()
        ws_mock.request_reconnect.assert_not_called()
        self.assertEqual(ing._grace_mono, 300.0)

    def test_9_cooldown_prevents_storm(self) -> None:
        """After a watchdog reconnect, cooldown blocks another reconnect."""
        ing, ws_mock = self._ingestor(
            now=ET_10AM, connected=True, subs_ok=True,
            last_tick_mono=100.0, last_grace_mono=100.0,
            last_stall_mono=101.0, phase="open",
        )
        with patch("quote_ingestor.health.time") as mock_time:
            mock_time.monotonic.return_value = 102.0  # 1s after stall, cooldown 3s
            mock_time.time.return_value = time.time()
            ing._watchdog_tick()
        ws_mock.request_reconnect.assert_not_called()

    def test_10_cooldown_expires_allows_reconnect(self) -> None:
        """After cooldown expires, another reconnect is allowed."""
        ing, ws_mock = self._ingestor(
            now=ET_10AM, connected=True, subs_ok=True,
            last_tick_mono=100.0, last_grace_mono=100.0,
            last_stall_mono=100.0, phase="open",
        )
        with patch("quote_ingestor.health.time") as mock_time:
            mock_time.monotonic.return_value = 105.0  # 5s after stall, cooldown 3s
            mock_time.time.return_value = time.time()
            ing._watchdog_tick()
        ws_mock.request_reconnect.assert_called_once()

    def test_11_connected_but_not_subscribed_no_reconnect(self) -> None:
        """WS connected but subscriptions not sent yet -> no reconnect."""
        ing, ws_mock = self._ingestor(
            now=ET_10AM, connected=True, subs_ok=False,
            last_tick_mono=None, last_grace_mono=None, phase="open",
        )
        ing._watchdog_tick()
        ws_mock.request_reconnect.assert_not_called()

    def test_12_disconnected_no_reconnect(self) -> None:
        """WS disconnected -> no reconnect (heartbeat handles that)."""
        ing, ws_mock = self._ingestor(
            now=ET_10AM, connected=False, subs_ok=False,
            last_tick_mono=None, last_grace_mono=None, phase="open",
        )
        ing._watchdog_tick()
        ws_mock.request_reconnect.assert_not_called()

    def test_13_d1_failure_does_not_trigger_stall(self) -> None:
        """Valid ticks accepted; D1 flush fails. Watchdog must NOT flag stall."""
        settings = make_settings()
        d1 = FakeD1(fail_symbols=set(SYMBOLS))
        ing = Ingestor(settings, SYMBOLS, d1, clock=lambda: ET_10AM)
        ws_mock = MagicMock(spec=FinnhubWebSocketClient)
        ws_mock.is_connected = True
        ws_mock.subscriptions_sent = len(SYMBOLS)
        ws_mock.last_message_mono = None
        ws_mock.connect_count = 1
        ing.set_ws_client(ws_mock)
        ing._last_market_phase = "open"
        ing._last_connected = True
        ing._last_observed_connect_count = 1
        ing._grace_mono = 0.0

        tick = trade_raw("AAPL", 310.0, ts_ms(ET_10AM) - 60_000)
        ing.on_message(tick)
        self.assertEqual(ing.health.tick_count, 1)

        with patch("quote_ingestor.health.time") as mock_time:
            mock_time.monotonic.return_value = 1.0
            mock_time.time.return_value = time.time()
            ing._watchdog_tick()
        ws_mock.request_reconnect.assert_not_called()

    def test_14_secret_not_in_stall_log(self) -> None:
        """FINNHUB_API_KEY must never appear in watchdog log events."""
        settings = make_settings(finnhub_api_key="SUPER_SECRET_KEY_12345")
        ing = Ingestor(settings, SYMBOLS, FakeD1(), clock=lambda: ET_10AM)
        ws_mock = MagicMock(spec=FinnhubWebSocketClient)
        ws_mock.is_connected = True
        ws_mock.subscriptions_sent = len(SYMBOLS)
        ws_mock.last_message_mono = None
        ws_mock.connect_count = 1
        ing.set_ws_client(ws_mock)
        ing._last_market_phase = "open"
        ing._last_connected = True
        ing._last_observed_connect_count = 1
        ing._grace_mono = 0.0
        ing.health._last_accepted_regular_tick_monotonic = 0.0

        with self.assertLogs("quote_ingestor", level="WARNING") as cm:
            with patch("quote_ingestor.health.time") as mock_time:
                mock_time.monotonic.return_value = 10.0
                mock_time.time.return_value = time.time()
                ing._trigger_stall_reconnect(ws_mock, 10.0)
        for line in cm.output:
            self.assertNotIn("SUPER_SECRET_KEY_12345", line)

    def test_15_duplicate_accepted_regular_tick_refreshes_liveness(self) -> None:
        """P2 #3: A duplicate accepted regular tick refreshes watchdog liveness
        even though QuoteStateStore does not change state."""
        settings = make_settings()
        ing = Ingestor(settings, SYMBOLS, FakeD1(), clock=lambda: ET_10AM)

        tick = trade_raw("AAPL", 310.0, ts_ms(ET_10AM) - 60_000)
        ing.on_message(tick)
        self.assertEqual(ing.health.tick_count, 1)
        first_liveness = ing.health.last_accepted_regular_tick_monotonic()
        self.assertIsNotNone(first_liveness)

        # Send the same tick again (duplicate — apply_tick returns False).
        ing.on_message(tick)
        second_liveness = ing.health.last_accepted_regular_tick_monotonic()

        # Liveness must be refreshed even though state didn't change.
        self.assertIsNotNone(second_liveness)
        self.assertGreaterEqual(second_liveness, first_liveness)
        # tick_count stays 1 because apply_tick deduplicated.
        self.assertEqual(ing.health.tick_count, 1)

    def test_16_rejected_non_regular_tick_does_not_refresh_liveness(self) -> None:
        """P2 #3: A rejected non-regular tick must NOT refresh watchdog liveness."""
        settings = make_settings()
        # Use a time after market close so regular trades are rejected.
        after_close = dt.datetime(2026, 8, 18, 21, 0, tzinfo=dt.UTC)  # 17:00 ET
        ing = Ingestor(settings, SYMBOLS, FakeD1(), clock=lambda: after_close)

        # A trade at 15:00 ET (regular timestamp) but received at 17:00 ET is rejected.
        trade_ts = ts_ms(dt.datetime(2026, 8, 18, 19, 0, tzinfo=dt.UTC))  # 15:00 ET
        tick = trade_raw("AAPL", 310.0, trade_ts)
        ing.on_message(tick)

        # Liveness must NOT be refreshed.
        self.assertIsNone(ing.health.last_accepted_regular_tick_monotonic())
        self.assertEqual(ing.health.ignored_non_regular_count, 1)

    def test_17_connection_generation_grace(self) -> None:
        """P2 #4: Watchdog detects reconnect via connect_count generation,
        even if disconnect/reconnect happens entirely between watchdog polls."""
        ing, ws_mock = self._ingestor(
            now=ET_10AM, connected=True, subs_ok=True,
            last_tick_mono=None, last_grace_mono=0.0, phase="open",
            connect_count=5, observed_connect_count=3,  # generation changed
        )
        with patch("quote_ingestor.health.time") as mock_time:
            mock_time.monotonic.return_value = 500.0
            mock_time.time.return_value = time.time()
            ing._watchdog_tick()
        # Grace must be reset due to generation change.
        self.assertEqual(ing._grace_mono, 500.0)
        ws_mock.request_reconnect.assert_not_called()


class WatchdogIntegrationTest(unittest.TestCase):
    """Integration tests: full WS consume -> watchdog -> reconnect."""

    def test_watchdog_reconnect_single_socket(self) -> None:
        """Watchdog closes current socket; existing reconnect creates ONE new."""
        settings = make_settings()
        conns: list[FakeConn] = []

        def connect_factory() -> FakeConn:
            conn = FakeConn([])
            conns.append(conn)
            return conn

        received: list[str] = []
        ws = FinnhubWebSocketClient(
            settings,
            SYMBOLS,
            on_message=received.append,
            connect_factory=connect_factory,
        )

        ing = Ingestor(settings, SYMBOLS, FakeD1(), clock=lambda: ET_10AM)
        ing.set_ws_client(ws)
        ing._last_market_phase = "open"
        ing._last_connected = True
        # Match the current connect_count so the watchdog does NOT see a generation change.
        ing._last_observed_connect_count = 1
        ing._grace_mono = 0.0

        ws_thread = threading.Thread(target=ws.run, daemon=True)
        ws_thread.start()
        time.sleep(0.3)

        self.assertGreaterEqual(len(conns), 1)
        first_conn = conns[0]
        self.assertTrue(first_conn.connected)

        # Trigger watchdog: no accepted ticks, past grace, past stall threshold.
        ing.health._last_accepted_regular_tick_monotonic = 0.0

        with patch("quote_ingestor.health.time") as mock_time:
            mock_time.monotonic.return_value = 1010.0
            mock_time.time.return_value = time.time()
            ing._watchdog_tick()

        self.assertTrue(first_conn.closed)
        time.sleep(0.5)
        self.assertGreaterEqual(len(conns), 2)

        ws.stop()
        ws_thread.join(timeout=3)


class HealthWatchdogTest(unittest.TestCase):
    def test_on_accepted_regular_tick_monotonic(self) -> None:
        """P2 #2: on_accepted_regular_tick sets both monotonic and wall-clock."""
        h = HealthTracker()
        self.assertIsNone(h.last_accepted_regular_tick_monotonic())
        with patch("quote_ingestor.health.time") as mock_time:
            mock_time.monotonic.return_value = 42.0
            mock_time.time.return_value = 1700000000.0  # fixed wall-clock
            h.on_accepted_regular_tick()
        self.assertEqual(h.last_accepted_regular_tick_monotonic(), 42.0)
        self.assertEqual(h.last_accepted_regular_tick_at, 1700000000.0)

    def test_wall_clock_timestamp_is_realistic_utc(self) -> None:
        """P2 #2 regression: serialized timestamp must be a realistic current UTC time,
        not a monotonic/1970-derived value."""
        h = HealthTracker()
        before = time.time()
        h.on_accepted_regular_tick()
        after = time.time()
        record = h.record(len(SYMBOLS), 10)
        iso = record["last_accepted_regular_tick_at"]
        self.assertIsNotNone(iso)
        # Parse the ISO string and verify it's within the test's wall-clock window.
        parsed = dt.datetime.fromisoformat(iso.replace("Z", "+00:00"))
        parsed_ts = parsed.timestamp()
        self.assertGreaterEqual(parsed_ts, before - 1.0)
        self.assertLessEqual(parsed_ts, after + 1.0)

    def test_on_market_stall_reconnect_count(self) -> None:
        h = HealthTracker()
        self.assertEqual(h.market_stall_reconnect_count, 0)
        h.on_market_stall_reconnect()
        h.on_market_stall_reconnect()
        self.assertEqual(h.market_stall_reconnect_count, 2)

    def test_record_includes_watchdog_fields(self) -> None:
        h = HealthTracker()
        record = h.record(len(SYMBOLS), 10)
        self.assertIn("last_accepted_regular_tick_at", record)
        self.assertIn("market_stall_reconnect_count", record)


class ConfigEnvTest(unittest.TestCase):
    """P2 #1: WS_MARKET_STALL_SECONDS / WS_MARKET_STALL_COOLDOWN_SECONDS env loading."""

    def test_defaults(self) -> None:
        """Defaults are 180.0 / 300.0 when env not set."""
        s = Settings(
            finnhub_api_key="k", cloudflare_api_token="t",
            cloudflare_account_id="c", cloudflare_d1_database_id="d",
        )
        self.assertEqual(s.ws_market_stall_seconds, 180.0)
        self.assertEqual(s.ws_market_stall_cooldown_seconds, 300.0)

    def test_custom_env_values(self) -> None:
        """Custom env values are loaded correctly."""
        import os
        old = {}
        for key in ["FINNHUB_API_KEY", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_D1_DATABASE_ID",
                    "WS_MARKET_STALL_SECONDS", "WS_MARKET_STALL_COOLDOWN_SECONDS"]:
            old[key] = os.environ.get(key)
        try:
            os.environ["FINNHUB_API_KEY"] = "test-key"
            os.environ["CLOUDFLARE_API_TOKEN"] = "test-token"
            os.environ["CLOUDFLARE_ACCOUNT_ID"] = "test-account"
            os.environ["CLOUDFLARE_D1_DATABASE_ID"] = "test-db"
            os.environ["WS_MARKET_STALL_SECONDS"] = "60"
            os.environ["WS_MARKET_STALL_COOLDOWN_SECONDS"] = "120"
            from quote_ingestor.config import from_env
            s = from_env()
            self.assertEqual(s.ws_market_stall_seconds, 60.0)
            self.assertEqual(s.ws_market_stall_cooldown_seconds, 120.0)
        finally:
            for key, val in old.items():
                if val is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = val

    def test_invalid_stall_rejected(self) -> None:
        """Invalid WS_MARKET_STALL_SECONDS raises ConfigError."""
        import os
        old = os.environ.get("WS_MARKET_STALL_SECONDS")
        try:
            os.environ["WS_MARKET_STALL_SECONDS"] = "not-a-number"
            from quote_ingestor.config import from_env
            with self.assertRaises(ConfigError):
                from_env()
        finally:
            if old is None:
                os.environ.pop("WS_MARKET_STALL_SECONDS", None)
            else:
                os.environ["WS_MARKET_STALL_SECONDS"] = old

    def test_negative_cooldown_rejected(self) -> None:
        """Negative WS_MARKET_STALL_COOLDOWN_SECONDS raises ConfigError."""
        import os
        old = os.environ.get("WS_MARKET_STALL_COOLDOWN_SECONDS")
        try:
            os.environ["WS_MARKET_STALL_COOLDOWN_SECONDS"] = "-5"
            from quote_ingestor.config import from_env
            with self.assertRaises(ConfigError):
                from_env()
        finally:
            if old is None:
                os.environ.pop("WS_MARKET_STALL_COOLDOWN_SECONDS", None)
            else:
                os.environ["WS_MARKET_STALL_COOLDOWN_SECONDS"] = old

    def test_zero_stall_rejected(self) -> None:
        """Zero WS_MARKET_STALL_SECONDS raises ConfigError (must be positive)."""
        import os
        old = os.environ.get("WS_MARKET_STALL_SECONDS")
        try:
            os.environ["WS_MARKET_STALL_SECONDS"] = "0"
            from quote_ingestor.config import from_env
            with self.assertRaises(ConfigError):
                from_env()
        finally:
            if old is None:
                os.environ.pop("WS_MARKET_STALL_SECONDS", None)
            else:
                os.environ["WS_MARKET_STALL_SECONDS"] = old


if __name__ == "__main__":
    unittest.main()
