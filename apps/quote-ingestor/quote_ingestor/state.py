"""In-memory latest-quote state and changed-symbol tracking.

The ingestor keeps a single latest value per Core Universe symbol here and a
``changed`` set of symbols whose price moved since the last *successful* flush.
Ticks are never stored as history. ``drain``/``ack`` are split so that a failed
flush does not lose pending symbols (only success clears the flag).
"""

from __future__ import annotations

import threading

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

    def pending_changed(self) -> list[TradeTick]:
        """Snapshot of changed symbols as ticks (symbol, latest price, ts).

        Does not clear anything — a failed flush must not lose pendings.
        """
        with self._lock:
            return [
                TradeTick(symbol=s, price=self._latest[s].price, timestamp_ms=self._latest[s].as_of_ms)
                for s in sorted(self._changed)
                if s in self._latest
            ]

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
