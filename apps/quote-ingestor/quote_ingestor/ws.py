"""Finnhub WebSocket client: single connection, 50 symbols.

Behaviour (all learned from the live POC — see the stock-autotrader skill
reference ``finnhub-websocket-poc.md``):

- ONE connection hosts all 50 symbols on the free tier; we never open a second
  parallel connection.
- The client MUST send a WS ping every ~9s or the server drops the socket.
  websocket-client auto-pongs during ``recv()``, which is NOT enough — a
  dedicated heartbeat thread sends a ping on the cadence.
- Liveness is decided by the HEARTBEAT, not by trade traffic. Outside market
  hours the exchange sends zero trade frames for hours while the socket is
  perfectly alive — a "no frames for N seconds" guard would force an endless
  reconnect storm. Instead: when the heartbeat (the only traffic we own)
  starts failing, the connection is dead and the heartbeat thread force-closes
  the socket; the recv loop then raises and the reconnect+resubscribe path
  runs. A quiet-but-alive socket simply stays connected.
- No per-symbol subscription ack exists; after every (re)connect we send the
  full subscribe command for each Core Universe symbol and count that the
  number sent equals the universe size.
- Reconnect uses exponential backoff with jitter and a sane cap; the
  connection is always fully closed before the next attempt (never two live
  sockets). After reconnect the whole universe is re-subscribed.

The connection factory is injectable so the reconnect/backoff/resubscribe
orchestration is unit-tested without any network.
"""

from __future__ import annotations

import json
import logging
import random
import threading
import time
from collections.abc import Callable
from typing import Protocol

from .config import Settings

logger = logging.getLogger("quote_ingestor.ws")

HEARTBEAT_FAILURE_THRESHOLD = 3

# A recv timeout on a live socket is NORMAL idle (weekends/overnight the
# exchange sends zero frames for hours). It is NOT an error and must never
# trigger a reconnect. websocket-client 1.7.x raises its own
# WebSocketTimeoutException (a WebSocketException, not socket.timeout); when
# the library is absent (unit tests) _WS_TIMEOUT stays None and generic
# exceptions are judged by socket state / a consecutive-error ceiling.
try:
    from websocket import WebSocketTimeoutException as _WS_TIMEOUT
except Exception:  # library not importable in this environment
    _WS_TIMEOUT = None  # type: ignore[assignment]

# A live socket whose recv() keeps raising unknown errors this many times in a
# row (no frame, no timeout) is a zombie — force a reconnect rather than spin.
RECV_CONSECUTIVE_ERROR_LIMIT = 8


class NotConnectedError(RuntimeError):
    """Raised when the socket cannot be used because it is closed/dead."""


class WebSocketConnection(Protocol):
    """Minimal WS surface used by the client (matches websocket-client)."""

    @property
    def connected(self) -> bool: ...

    def recv(self) -> str: ...

    def send(self, data: str) -> None: ...

    def ping(self, payload: str | None = None) -> None: ...

    def close(self, status: int | None = None, reason: str | None = None) -> None: ...


ConnectFactory = Callable[[], WebSocketConnection]


def build_finnhub_url(host: str, api_key: str) -> str:
    """Build the endpoint URL. The token lives only in this string in memory —
    the caller must never log it."""
    return f"{host}/?token={api_key}"


def create_production_connection(
    host: str,
    api_key: str,
    connect_timeout: float,
    recv_timeout: float,
) -> WebSocketConnection:
    """Connect to Finnhub via websocket-client (the only network path used in
    production). Raises on connection failure; caller retries with backoff."""
    from websocket import (  # local import keeps module importable without the dep
        create_connection,
    )

    raw = create_connection(
        build_finnhub_url(host, api_key),
        timeout=recv_timeout,
        connect_timeout=connect_timeout,
        suppress_origin=True,
        enable_multithread=True,
    )

    class _Adapted(WebSocketConnection):
        @property
        def connected(self) -> bool:
            return bool(raw.connected)

        def recv(self) -> str:
            # websocket-client raises WebSocketTimeoutException on timeout and
            # a ConnectionError on a closed socket — both bubble up to the
            # client's reconnect logic.
            text = raw.recv()
            return text.decode("utf-8") if isinstance(text, bytes) else text

        def send(self, data: str) -> None:
            raw.send(data)

        def ping(self, payload: str | None = None) -> None:
            # websocket-client exposes the PING method as `ping()` (1.7.x);
            # very old/very new builds used `send_ping()`. Support both.
            method = getattr(raw, "ping", None) or getattr(raw, "send_ping", None)
            if method is None:  # pragma: no cover
                raise AttributeError("websocket client has neither ping() nor send_ping()")
            method(payload or "hk")

        def close(self, status: int | None = None, reason: str | None = None) -> None:
            try:
                raw.close(
                    status=status or 1000,
                    reason=(reason.encode("utf-8") if isinstance(reason, str) else b""),
                )  # type: ignore[arg-type]
            except Exception:  # already closed -> fine
                pass

    return _Adapted()


class StopRequested(RuntimeError):
    """Internal sentinel: graceful shutdown requested."""


class FinnhubWebSocketClient:
    """Owner of the single Finnhub connection, reconnects and resubscribes.

    ``on_message(raw)`` receives every non-empty frame; the caller owns
    parsing/validation.
    """

    def __init__(
        self,
        settings: Settings,
        symbols: list[str],
        on_message: Callable[[str], None],
        on_status: Callable[[dict], None] | None = None,
        connect_factory: ConnectFactory | None = None,
        monotonic: Callable[[], float] = time.monotonic,
        random_source: random.Random | None = None,
    ) -> None:
        self._settings = settings
        self._symbols = list(symbols)
        self._on_message = on_message
        self._on_status = on_status or (lambda _event: None)
        self._connect_factory = connect_factory or (
            lambda: create_production_connection(
                settings.finnhub_ws_host,
                settings.finnhub_api_key,
                settings.ws_connect_timeout_seconds,
                settings.ws_recv_timeout_seconds,
            )
        )
        self._monotonic = monotonic
        self._rnd = random_source or random.Random()
        self._stop = threading.Event()
        self._connected = False
        self._connected_at: float | None = None
        self.reconnect_count = 0
        self.connect_count = 0
        self.disconnect_count = 0
        self.last_message_mono: float | None = None
        self.last_error: str | None = None
        self.subscriptions_sent = 0
        self.heartbeat_dead = False

    # --- control -----------------------------------------------------------

    def stop(self) -> None:
        self._stop.set()

    @property
    def is_connected(self) -> bool:
        return self._connected

    # --- heartbeat ---------------------------------------------------------

    def _heartbeat_loop(self, conn: WebSocketConnection, stop_event: threading.Event) -> None:
        """Send pings on the cadence; a dead peer surfaces here, not in recv.

        On HEARTBEAT_FAILURE_THRESHOLD consecutive failed pings the socket is
        dead: force-close it (from the heartbeat thread) so the main recv loop
        raises and the reconnect path runs with bounded backoff. A quiet-but-
        alive connection (no trade frames, e.g. overnight) never reconnects.
        """
        interval = self._settings.ws_ping_interval_seconds
        failures = 0
        while not stop_event.wait(interval):
            if self._stop.is_set():
                return
            if not conn.connected:
                return
            try:
                conn.ping("hk")
                failures = 0
            except Exception:
                failures += 1
                if failures >= HEARTBEAT_FAILURE_THRESHOLD:
                    logger.warning(json.dumps({"event": "ws_heartbeat_dead"}, sort_keys=True))
                    self.heartbeat_dead = True
                    try:
                        conn.close()
                    except Exception:
                        pass
                    return

    # --- reconnect bookkeeping ----------------------------------------------

    def _backoff(self, attempt: int) -> float:
        base = min(
            self._settings.ws_reconnect_base_seconds * (2 ** max(0, attempt - 1)),
            self._settings.ws_reconnect_max_seconds,
        )
        jitter = 1.0 + self._rnd.uniform(-self._settings.ws_reconnect_jitter, self._settings.ws_reconnect_jitter)
        return max(0.0, base * jitter)

    def _scrub(self, message: str) -> str:
        """Defensive leak guard: if a provider/transport error ever embeds the
        API key, replace it before it reaches last_error or the logs."""
        key = self._settings.finnhub_api_key
        if key and key in message:
            return message.replace(key, "***")
        return message

    # --- main loop -----------------------------------------------------------

    def run(self) -> None:
        """Blocking main loop: connect -> subscribe -> consume -> reconnect.

        Only returns on stop(); every failure path is a reconnect with
        exponential backoff + jitter, capped, with full resubscribe.
        """
        attempt = 0
        while not self._stop.is_set():
            attempt += 1
            if attempt > 1:
                self.reconnect_count += 1
                delay = self._backoff(attempt)
                logger.info(
                    json.dumps({
                        "event": "ws_reconnect_scheduled",
                        "attempt": attempt,
                        "delay_seconds": round(delay, 2),
                    }, sort_keys=True),
                )
                if self._stop.wait(delay):
                    break
            try:
                self._run_once()
                attempt = 0
            except StopRequested:
                break
            except Exception as exc:  # reconnect on any provider/transport error
                message = self._scrub(str(exc) or exc.__class__.__name__)
                self.last_error = message[:300]
                # Drive the runtime health state (P2 #2A): the socket was lost,
                # we are about to retry — never leave connection_status stuck
                # at "connected" across a failure (the error is already
                # scrubbed of any key material).
                self._on_status({"event": "reconnecting", "error": message[:300]})
                logger.error(
                    json.dumps({"event": "ws_connection_lost", "error": message[:300]}, sort_keys=True),
                )

    def _run_once(self) -> None:
        conn = self._connect_factory()
        self.connect_count += 1
        self._connected = True
        self._connected_at = self._monotonic()
        if not conn.connected:
            raise NotConnectedError("connection not established")
        self._send_subscriptions(conn)
        self._on_status({"event": "connected", "subscriptions": self.subscriptions_sent, "symbols": len(self._symbols)})
        logger.info(
            json.dumps({
                "event": "ws_connected",
                "subscriptions_sent": self.subscriptions_sent,
                "expected": len(self._symbols),
            }, sort_keys=True),
        )
        try:
            self._consume(conn)
        finally:
            self._connected = False
            stopped = self._stop.is_set()
            try:
                conn.close()
            except Exception:
                pass
            if not stopped:
                self.disconnect_count += 1

    def _send_subscriptions(self, conn: WebSocketConnection) -> None:
        """Full (re)subscribe of the Core Universe after every connect."""
        sent = 0
        for symbol in self._symbols:
            conn.send(json.dumps({"type": "subscribe", "symbol": symbol}))
            sent += 1
        if sent != len(self._symbols):
            self.last_error = f"subscribe count mismatch: sent {sent} expected {len(self._symbols)}"
        self.subscriptions_sent = sent

    def _consume(self, conn: WebSocketConnection) -> None:
        heartbeat_stop = threading.Event()
        heartbeat = threading.Thread(target=self._heartbeat_loop, args=(conn, heartbeat_stop), daemon=True)
        heartbeat.start()
        consecutive_errors = 0
        try:
            while not self._stop.is_set():
                try:
                    raw = conn.recv()
                except TimeoutError:
                    consecutive_errors = 0  # idle-ish, live socket
                    continue
                except ConnectionError:
                    raise NotConnectedError("socket closed while receiving") from None
                except Exception as exc:
                    if self._stop.is_set():
                        raise StopRequested() from None
                    if _WS_TIMEOUT is not None and isinstance(exc, _WS_TIMEOUT):
                        # Normal idle: live socket, nothing to read. The recv
                        # timeout keeps firing all night — never reconnect.
                        consecutive_errors = 0
                        continue
                    if not conn.connected:
                        # The peer/library closed the socket underneath us.
                        raise NotConnectedError(
                            f"socket closed while receiving: {self._scrub(str(exc))[:200]}"
                        ) from None
                    consecutive_errors += 1
                    if consecutive_errors >= RECV_CONSECUTIVE_ERROR_LIMIT:
                        # Unknown errors on a "live" socket in a tight loop —
                        # treat as a zombie and let the reconnect path handle it.
                        raise NotConnectedError(
                            f"recv failing in a loop: {self._scrub(str(exc))[:200]}"
                        ) from None
                    self.last_error = self._scrub(str(exc))[:300]
                    continue
                if raw is None or raw == "":
                    continue
                consecutive_errors = 0
                self.last_message_mono = self._monotonic()
                self._on_message(raw)
        finally:
            heartbeat_stop.set()
            heartbeat.join(timeout=5)
