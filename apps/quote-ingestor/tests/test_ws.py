"""WebSocket client tests: reconnect, backoff, resubscribe, graceful stop.

Run entirely against fake connections — no network, no real key required.
"""

from __future__ import annotations

import json
import random
import threading
import time
import unittest

from quote_ingestor.config import Settings
from quote_ingestor.ws import FinnhubWebSocketClient

SYMBOLS = ["AAPL", "NVDA"]


def make_settings(**overrides: object) -> Settings:
    defaults: dict[str, object] = {
        "finnhub_api_key": "k-test-only",
        "cloudflare_api_token": "t",
        "cloudflare_account_id": "c",
        "cloudflare_d1_database_id": "d",
        "ws_reconnect_base_seconds": 0.01,
        "ws_reconnect_max_seconds": 0.1,
        "ws_reconnect_jitter": 0.1,
        "ws_recv_timeout_seconds": 0.05,
        "ws_ping_interval_seconds": 60.0,  # keep the heartbeat quiet in tests
    }
    defaults.update(overrides)
    return Settings(**defaults)  # type: ignore[arg-type]


class FakeConn:
    def __init__(
        self,
        messages: list[object],
        ping_error: Exception | None = None,
        recv_exception: Exception | None = None,
    ) -> None:
        self.messages = list(messages)
        self.ping_error = ping_error
        self.recv_exception = recv_exception
        self.sent: list[str] = []
        self.pings = 0
        self.closed = False

    @property
    def connected(self) -> bool:
        return not self.closed

    def recv(self) -> str:
        if self.recv_exception is not None:
            raise self.recv_exception
        if self.closed:
            raise ConnectionError("socket closed")
        if self.messages:
            item = self.messages.pop(0)
            if isinstance(item, Exception):
                raise item
            return str(item)
        raise TimeoutError("idle")

    def send(self, data: str) -> None:
        self.sent.append(data)

    def ping(self, payload: str | None = None) -> None:
        self.pings += 1
        if self.ping_error is not None:
            raise self.ping_error

    def close(self, status: int | None = None, reason: str | None = None) -> None:
        self.closed = True


class WebSocketClientTest(unittest.TestCase):
    def test_connect_subscribes_every_symbol_once(self) -> None:
        received: list[str] = []
        conn = FakeConn(['{"type":"trade","data":[{"s":"AAPL","p":1,"t":1000}]}'])
        client = FinnhubWebSocketClient(
            make_settings(),
            SYMBOLS,
            on_message=received.append,
            connect_factory=lambda: conn,
            random_source=random.Random(1),
        )
        thread = threading.Thread(target=client.run, daemon=True)
        thread.start()
        time.sleep(0.15)
        client.stop()
        thread.join(timeout=2)
        # Full subscribe sent for both symbols on the one connection.
        subs = [json.loads(s) for s in conn.sent if "subscribe" in s]
        self.assertEqual(len(subs), len(SYMBOLS))
        self.assertEqual({s["symbol"] for s in subs}, set(SYMBOLS))
        # Trade frame was delivered to the caller callback.
        self.assertTrue(any("trade" in r for r in received))

    def test_reconnect_and_full_resubscribe_after_disconnect(self) -> None:
        received: list[str] = []
        first = FakeConn([
            '{"type":"trade","data":[{"s":"NVDA","p":9,"t":2000}]}',
            ConnectionError("socket closed while receiving"),
        ])
        second = FakeConn([])  # idles until stop — a live connection must NOT reconnect
        state = {"index": 0}

        def connect_factory() -> FakeConn:
            if state["index"] == 0:
                state["index"] += 1
                return first
            state["index"] += 1
            return second

        client = FinnhubWebSocketClient(
            make_settings(),
            SYMBOLS,
            on_message=received.append,
            connect_factory=connect_factory,
            random_source=random.Random(2),
        )
        thread = threading.Thread(target=client.run, daemon=True)
        thread.start()
        time.sleep(0.4)
        client.stop()
        thread.join(timeout=2)

        # One disconnect on the first connection -> exactly one reconnect to
        # the (alive, idle) second connection. No reconnect storm.
        self.assertEqual(client.connect_count, 2)
        self.assertEqual(client.reconnect_count, 1)
        # Every connect re-sent the full universe subscription (no drift).
        for conn in (first, second):
            subs = [json.loads(s) for s in conn.sent if "subscribe" in s]
            self.assertEqual({s["symbol"] for s in subs}, set(SYMBOLS))

    def test_heartbeat_death_forces_reconnect(self) -> None:
        """A dead peer (heartbeat stops succeeding) must reconnect, while a
        quiet-but-alive connection must stay connected."""
        conns: list[FakeConn] = []

        def connect_factory() -> FakeConn:
            conn = FakeConn([], ping_error=ConnectionError("peer unreachable"))
            conns.append(conn)
            return conn

        client = FinnhubWebSocketClient(
            make_settings(
                ws_ping_interval_seconds=0.05,
                ws_reconnect_base_seconds=0.01,
                ws_reconnect_max_seconds=0.1,
            ),
            SYMBOLS,
            on_message=lambda _r: None,
            connect_factory=connect_factory,
            random_source=random.Random(6),
        )
        thread = threading.Thread(target=client.run, daemon=True)
        thread.start()
        time.sleep(0.6)
        client.stop()
        thread.join(timeout=2)

        self.assertTrue(client.heartbeat_dead)
        self.assertGreaterEqual(client.connect_count, 2)
        self.assertGreaterEqual(client.reconnect_count, 1)
        # The dead heartbeats force-closed the candidate socket each time.
        self.assertTrue(all(conn.closed for conn in conns))

    def test_idle_recv_timeout_does_not_reconnect(self) -> None:
        """A quiet-but-alive socket (recv timeout while the market is closed)
        must NEVER reconnect — that would be a reconnect storm overnight."""
        try:
            import websocket
            idle_error = websocket.WebSocketTimeoutException("idle")
        except Exception:  # noqa: BLE001
            idle_error = TimeoutError("idle")

        conn = FakeConn([], recv_exception=idle_error)
        client = FinnhubWebSocketClient(
            make_settings(),
            SYMBOLS,
            on_message=lambda _r: None,
            connect_factory=lambda: conn,
            random_source=random.Random(7),
        )
        thread = threading.Thread(target=client.run, daemon=True)
        thread.start()
        time.sleep(0.4)
        client.stop()
        thread.join(timeout=2)

        self.assertEqual(client.connect_count, 1)
        self.assertEqual(client.reconnect_count, 0)
        self.assertFalse(client.heartbeat_dead)

    def test_generic_recv_error_on_closed_socket_reconnects(self) -> None:
        """The real library raises its OWN generic exception (not
        ConnectionError) when the socket closes underneath recv. A closed
        socket must reconnect, never spin."""
        conns: list[FakeConn] = []

        def connect_factory() -> FakeConn:
            conn = FakeConn([], recv_exception=RuntimeError("weird library exception"))
            conn.closed = True  # peer/library closed the socket
            conns.append(conn)
            return conn

        client = FinnhubWebSocketClient(
            make_settings(
                ws_reconnect_base_seconds=0.01,
                ws_reconnect_max_seconds=0.1,
            ),
            SYMBOLS,
            on_message=lambda _r: None,
            connect_factory=connect_factory,
            random_source=random.Random(8),
        )
        thread = threading.Thread(target=client.run, daemon=True)
        thread.start()
        time.sleep(0.4)
        client.stop()
        thread.join(timeout=2)

        self.assertGreaterEqual(client.connect_count, 2)
        self.assertGreaterEqual(client.reconnect_count, 1)
        self.assertTrue(conns and all(c.closed for c in conns))

    def test_backoff_bounded_and_jittered(self) -> None:
        client = FinnhubWebSocketClient(
            make_settings(ws_reconnect_base_seconds=1.0, ws_reconnect_max_seconds=8.0, ws_reconnect_jitter=0.25),
            SYMBOLS,
            on_message=lambda _r: None,
            connect_factory=lambda: FakeConn([]),
            random_source=random.Random(3),
        )
        first = client._backoff(1)
        self.assertGreaterEqual(first, 0.75)
        self.assertLessEqual(first, 1.25)
        for attempt in (2, 3, 10, 40):
            with self.subTest(attempt=attempt):
                self.assertLessEqual(client._backoff(attempt), 8.0 * 1.25)

    def test_error_message_scrubbed_of_api_key(self) -> None:
        fake_key = "SECRET_WS_KEY_ABC"
        client = FinnhubWebSocketClient(
            make_settings(finnhub_api_key=fake_key),
            SYMBOLS,
            on_message=lambda _r: None,
            connect_factory=lambda: FakeConn([]),
            random_source=random.Random(4),
        )
        scrubbed = client._scrub(f"handshake 401 for {fake_key} at {fake_key}")
        self.assertNotIn(fake_key, scrubbed)
        self.assertIn("***", scrubbed)

    def test_graceful_stop_closes_connection(self) -> None:
        conn = FakeConn([])
        client = FinnhubWebSocketClient(
            make_settings(),
            SYMBOLS,
            on_message=lambda _r: None,
            connect_factory=lambda: conn,
            random_source=random.Random(5),
        )
        thread = threading.Thread(target=client.run, daemon=True)
        thread.start()
        time.sleep(0.1)
        client.stop()
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertTrue(conn.closed)

    def test_url_built_with_token_never_exposed_by_assertions(self) -> None:
        from quote_ingestor.ws import build_finnhub_url

        url = build_finnhub_url("wss://ws.finnhub.io", "k-shape-check")
        self.assertTrue(url.startswith("wss://ws.finnhub.io/?token="), "url must carry token param")


if __name__ == "__main__":
    unittest.main()
