"""In-memory latest-quote state and changed-symbol tracking.

The ingestor keeps a single latest value per Core Universe symbol here and a
``changed`` set of symbols whose price moved since the last *successful* flush.
Ticks are never stored as history. Failed prior-session ticks are isolated from
current-session batches, but a per-symbol rollover candidate is retained when a
new-session tick would otherwise overwrite the only not-yet-durable prior tick.
"""

from __future__ import annotations

import datetime as dt
import threading

from .market_hours import previous_trading_session_date, trading_session_date
from .types import QuoteState, TradeTick


class QuoteStateStore:
    """Thread-safe store of latest per-symbol quote state."""

    def __init__(self, symbols: list[str]) -> None:
        self._symbols = set(symbols)
        self._latest: dict[str, QuoteState] = {}
        self._changed: set[str] = set()
        self._rollover_candidates: dict[str, TradeTick] = {}
        self._lock = threading.RLock()

    @property
    def symbols(self) -> set[str]:
        return set(self._symbols)

    def apply_tick(self, tick: TradeTick) -> bool:
        """Apply one validated tick. Returns True when it changed the state.

        Newer-wins by exchange timestamp: an older/same tick never regresses a
        newer quote already stored (this is the same rule the D1 UPSERT
        enforces against the REST collector).

        If the previous in-memory tick belongs to the immediately preceding
        trading session and is still pending, preserve it before overwriting it
        with the first tick of the new session. D1 decides whether that retained
        tick is close-window proof; state only guarantees it is not lost.
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

            current_session = self._session_of(current.as_of_ms)
            incoming_session = self._session_of(tick.timestamp_ms)
            if (
                tick.symbol in self._changed
                and current_session is not None
                and incoming_session is not None
                and current_session == previous_trading_session_date(incoming_session)
            ):
                self._rollover_candidates[tick.symbol] = TradeTick(
                    symbol=tick.symbol,
                    price=current.price,
                    timestamp_ms=current.as_of_ms,
                )
            elif (
                current_session is not None
                and incoming_session is not None
                and incoming_session > current_session
            ):
                # A gap larger than one trading session can never provide the
                # immediately-prior baseline required for 1D.
                self._rollover_candidates.pop(tick.symbol, None)

            current.price = tick.price
            current.as_of_ms = tick.timestamp_ms
            current.update_count += 1
            self._changed.add(tick.symbol)
            return True

    @staticmethod
    def _session_of(timestamp_ms: int) -> dt.date | None:
        instant = dt.datetime.fromtimestamp(timestamp_ms / 1000, tz=dt.UTC)
        return trading_session_date(instant)

    def _candidate_for(self, current: TradeTick) -> TradeTick | None:
        candidate = self._rollover_candidates.get(current.symbol)
        if candidate is None:
            return None
        candidate_session = self._session_of(candidate.timestamp_ms)
        current_session = self._session_of(current.timestamp_ms)
        if candidate_session is None or current_session is None:
            self._rollover_candidates.pop(current.symbol, None)
            return None
        if candidate_session != previous_trading_session_date(current_session):
            self._rollover_candidates.pop(current.symbol, None)
            return None
        return candidate

    def pending_changed(self) -> list[TradeTick]:
        """Snapshot pending work without letting stale sessions poison a batch.

        Failed pending rows from symbols that have not traded in the new session
        are expired as *current writes* once a newer session exists. Their last
        known price remains in ``_latest``. If that same symbol later trades,
        ``apply_tick`` preserves the overwritten failed row as a rollover
        candidate and this method emits candidate first, current tick second.
        The D1 client processes those sessions in order and only reports the
        symbol written if the latest/current row also lands.
        """
        with self._lock:
            pending = [
                TradeTick(symbol=s, price=self._latest[s].price, timestamp_ms=self._latest[s].as_of_ms)
                for s in sorted(self._changed)
                if s in self._latest
            ]
            dated = [(tick, self._session_of(tick.timestamp_ms)) for tick in pending]
            valid_sessions = [session for _, session in dated if session is not None]
            if valid_sessions:
                newest_session = max(valid_sessions)
                for tick, session in dated:
                    if session is not None and session < newest_session:
                        self._changed.discard(tick.symbol)
                pending = [tick for tick, session in dated if session == newest_session or session is None]

            result: list[TradeTick] = []
            for tick in pending:
                candidate = self._candidate_for(tick)
                if candidate is not None:
                    result.append(candidate)
                result.append(tick)
            return result

    def has_changed(self) -> bool:
        with self._lock:
            return len(self._changed) > 0

    def ack_flushed(self, symbols: set[str], as_of: dict[str, int]) -> None:
        """Mark symbols durably flushed (only after a successful latest write).

        A symbol whose state advanced PAST the written snapshot while the
        write was in flight stays pending — its newer quote still needs a
        flush. ``as_of`` maps symbol to the timestamp of the latest row that was
        durably written. Once that latest row lands, any retained rollover
        candidate for the symbol is no longer needed.
        """
        with self._lock:
            for symbol in symbols:
                current = self._latest.get(symbol)
                if current is None:
                    continue
                if current.as_of_ms <= as_of.get(symbol, 0):
                    self._changed.discard(symbol)
                    self._rollover_candidates.pop(symbol, None)
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
