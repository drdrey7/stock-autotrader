"""Thread-safe health/observability tracker for the ingestor.

Reuses the project's health vocabulary (no second status system): the record
is mirrored into D1 ``app_meta['quoteIngestorHealth']`` so a future /status
enhancement can read it without touching the API surface today. It also backs
the JSON lines the service emits to journald.
"""

from __future__ import annotations

import threading
import time
from typing import Any


def _iso(epoch_float: float | None) -> str | None:
    if epoch_float is None:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(epoch_float)) + f".{int(epoch_float % 1 * 1000):03d}Z"


class HealthTracker:
    provider = "finnhub-websocket"

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.started_at = time.time()
        self.connection_status = "disconnected"
        self.connected_at: float | None = None
        self.last_message_at: float | None = None
        self.last_flush_at: float | None = None
        self.last_successful_flush_at: float | None = None
        self.last_flush_rows = 0
        self.reconnect_count = 0
        self.disconnect_count = 0
        self.malformed_message_count = 0
        self.non_trade_message_count = 0
        self.unknown_symbol_count = 0
        self.tick_count = 0
        self.message_count = 0
        self.d1_write_errors = 0
        self.rows_written_total = 0
        self.last_error: str | None = None
        self.last_ws_heartbeat_at: float | None = None
        self.ignored_non_regular_count = 0

    # ---------------------------------------------------------------- updates

    def on_ws_status(self, event: dict) -> None:
        """Runtime WebSocket state transitions (2A).

        Every connect / loss / reconnect / shutdown path must drive the status
        explicitly so `quoteIngestorHealth.connection_status` never gets stuck
        on the first "connected".
        """
        with self._lock:
            event_kind = event.get("event")
            if event_kind == "connected":
                self.connection_status = "connected"
                self.connected_at = time.time()
            elif event_kind == "reconnecting":
                self.connection_status = "reconnecting"
                self.reconnect_count += 1
            elif event_kind == "disconnected":
                # Graceful shutdown / explicit close: never stays "connected".
                self.connection_status = "disconnected"
            error = event.get("error")
            if error:
                self.last_error = str(error)[:300]

    def on_message(self) -> None:
        with self._lock:
            self.message_count += 1
            self.last_message_at = time.time()

    def on_malformed(self, count: int = 1) -> None:
        with self._lock:
            self.malformed_message_count += count

    def on_non_trade(self) -> None:
        with self._lock:
            self.non_trade_message_count += 1

    def on_unknown_symbol(self, count: int) -> None:
        with self._lock:
            self.unknown_symbol_count += count

    def on_tick(self) -> None:
        with self._lock:
            self.tick_count += 1

    def on_flush_attempt(self) -> None:
        with self._lock:
            self.last_flush_at = time.time()

    def on_flush_success(self, rows: int) -> None:
        with self._lock:
            self.last_successful_flush_at = time.time()
            self.last_flush_rows = rows
            self.rows_written_total += rows

    def on_d1_error(self, message: str | None) -> None:
        if message is None:
            return  # success path: do not count as an error
        with self._lock:
            self.d1_write_errors += 1
            self.last_error = message[:300]

    def on_ws_error(self, message: str | None) -> None:
        with self._lock:
            if self.connection_status != "connected":
                self.connection_status = "disconnected"
            if message:
                self.last_error = message[:300]

    def on_disconnect(self) -> None:
        with self._lock:
            self.connection_status = "disconnected"
            self.disconnect_count += 1

    def on_ignored_non_regular(self, count: int = 1) -> None:
        """A trade was rejected because its timestamp falls outside the regular
        session (after-hours tick that must not contaminate the regular close)."""
        with self._lock:
            self.ignored_non_regular_count += count

    def on_heartbeat_written(self) -> None:
        """The 1/minute D1 health heartbeat landed (process-alive proof)."""
        with self._lock:
            self.last_ws_heartbeat_at = time.time()

    # ---------------------------------------------------------------- output

    def record(self, subscriptions_expected: int, symbols_seen: int) -> dict[str, Any]:
        """D1-mirrorable health snapshot (all keys serialisable JSON)."""
        with self._lock:
            return {
                "provider": self.provider,
                "connection_status": self.connection_status,
                "connected_at": _iso(self.connected_at),
                "last_message_at": _iso(self.last_message_at),
                "last_flush_at": _iso(self.last_flush_at),
                "last_successful_flush_at": _iso(self.last_successful_flush_at),
                "subscriptions_expected": subscriptions_expected,
                "symbols_seen_recently": symbols_seen,
                "reconnect_count": self.reconnect_count,
                "disconnect_count": self.disconnect_count,
                "malformed_message_count": self.malformed_message_count,
                "non_trade_message_count": self.non_trade_message_count,
                "unknown_symbol_count": self.unknown_symbol_count,
                "message_count": self.message_count,
                "tick_count": self.tick_count,
                "d1_write_errors": self.d1_write_errors,
                "last_flush_rows": self.last_flush_rows,
                "rows_written_total": self.rows_written_total,
                "last_error": self.last_error,
                "last_ws_heartbeat_at": _iso(self.last_ws_heartbeat_at),
                "ignored_non_regular_count": self.ignored_non_regular_count,
                "uptime_seconds": round(time.time() - self.started_at, 1),
                "updated_at": _iso(time.time()),
            }
