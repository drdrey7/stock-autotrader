"""In-memory latest-quote state and changed-symbol tracking.

The ingestor keeps a single latest value per Core Universe symbol here and a
``changed`` set of symbols whose price moved since the last *successful* flush.
Ticks are never stored as history. ``pending_changed`` is session-aware: once a
new regular session has produced a tick, failed pending snapshots from an older
session are expired rather than replayed or allowed to block the current one.
"""

from __future__ import annotations

import datetime as dt
import threading

from .market_hours import trading_session_date
from .types import QuoteState, TradeTick


class QuoteStateStore:
    """Thread-safe store of latest per-symbol quote state."""

    def __init__(self, symbols: list[str]) -> None:
        self._symbols = set(symbols)
        self._latest: dict[str, QuoteState] = {}
        self._changed: set[str] = set()
        self._lock = threading.RLock()

    @property
    def symbols(self) -> set[str]:
        return set(self._symbols)

    def apply_tick(self, tick: TradeTick) -> bool:
        """Apply one validated tick. Returns True when it changed the state.

        Newer-wins by exchange timestamp: an older/same tick never regresses a
        newer quote already stored (this is the same rule the D1 UPSERT
        enforces against the REST collector).
        """
        if tick.symbol not in self._symbols:
            return False
        with self._lock:
            current = self._latest.get(tick.symbol)
            if current is None:
                self._latest[tick.symbol] = QuoteState(
                    symbol=tick.symbol, price=tick.price, as_of_ms=tick.timestamp_ms, update_count=1
                )
                self._changed.add(tick.symbol)
                return True
            if tick.timestamp_ms < current.as_of_ms:
                return False
            if tick.timestamp_ms == current.as_of_ms and tick.price == current.price:
                return False
            current.price = tick.price
            current.as_of_ms = tick.timestamp_ms
            current.update_count += 1
            self._changed.add(tick.symbol)
            return True

    @staticmethod
    def _session_of(timestamp_ms: int) -> dt.date | None:
        instant = dt.datetime.fromtimestamp(timestamp_ms / 1000, tz=dt.UTC)
        return trading_session_date(instant)

    def pending_changed(self) -> list[TradeTick]:
        """Snapshot pending symbols, expiring older-session leftovers.

        A failed final flush intentionally remains pending for retry during the
        same session/grace. If the process stays alive into a later session,
        however, replaying those old rows is invalid and a mixed-session D1
        batch would block current data. Once any newer-session tick exists,
        older pending flags are therefore expired. The latest value itself is
        retained in memory until a fresh tick replaces it; only the obsolete
        *pending write* is discarded.
        """
        with self._lock:
            pending = [
                TradeTick(symbol=s, price=self._latest[s].price, timestamp_ms=self._latest[s].as_of_ms)
                for s in sorted(self._changed)
                if s in self._latest
            ]
            dated = [(tick, self._session_of(tick.timestamp_ms)) for tick in pending]
            valid_sessions = [session for _, session in dated if session is not None]
            if not valid_sessions:
                return pending
            newest_session = max(valid_sessions)
            for tick, session in dated:
                if session is not None and session < newest_session:
                    self._changed.discard(tick.symbol)
            return [tick for tick, session in dated if session == newest_session or session is None]

    def has_changed(self) -> bool:
        with self._lock:
            return len(self._changed) > 0

    def ack_flushed(self, symbols: set[str], as_of: dict[str, int]) -> None:
        """Mark symbols durably flushed (only after a successful write).

        A symbol whose state advanced PAST the written snapshot while the
        write was in flight stays pending — its newer quote still needs a
        flush. ``as_of`` maps symbol to the timestamp that was actually
        written.
        """
        with self._lock:
            for symbol in symbols:
                current = self._latest.get(symbol)
                if current is None:
                    continue
                if current.as_of_ms <= as_of.get(symbol, 0):
                    self._changed.discard(symbol)
                # else: newer tick arrived during the write — keep pending

    def mark_failed(self, symbols: set[str]) -> None:
        """Ensure failed symbols stay pending (defensive; normally a no-op)."""
        with self._lock:
            for symbol in symbols:
                if symbol in self._latest:
                    self._changed.add(symbol)

    def snapshot(self) -> dict[str, QuoteState]:
        with self._lock:
            return {s: QuoteState(**vars(q)) for s, q in self._latest.items()}

    def symbols_seen(self) -> int:
        with self._lock:
            return len(self._latest)
