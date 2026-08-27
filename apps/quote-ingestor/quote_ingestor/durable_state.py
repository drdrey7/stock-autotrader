"""Crash-safe local checkpoint for not-yet-durable close candidates.

D1 is the canonical serving store, but it cannot also be the fallback when the
failure being recovered is a D1 write outage. During the final close-proof
window we therefore keep a tiny local checkpoint in systemd's ``StateDirectory``.
It contains only symbol/price/provider timestamp, never secrets or history.

The checkpoint is replay-only workflow state: a candidate is removed only after
D1 confirms that the latest submitted row for that symbol is durable. Writes
use fsync + atomic rename so a process crash cannot expose a partially-written
JSON document. Replaying after a crash between the D1 success and local cleanup
is idempotent because the D1 writer has a newer-timestamp guard.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import math
import os
import threading
from collections.abc import Iterable
from pathlib import Path

from .market_hours import is_close_baseline_candidate, trading_session_date
from .types import TradeTick

logger = logging.getLogger("quote_ingestor.durable_state")

CHECKPOINT_VERSION = 1


class CloseCandidateCheckpoint:
    """Small atomic JSON checkpoint keyed by Core Universe symbol."""

    def __init__(self, path: Path, symbols: Iterable[str]) -> None:
        self.path = path
        self._symbols = set(symbols)
        self._lock = threading.RLock()
        self._candidates = self._load()

    def restore(self) -> list[TradeTick]:
        """Return persisted candidates for replay, oldest timestamp first."""
        with self._lock:
            return sorted(self._candidates.values(), key=lambda tick: (tick.timestamp_ms, tick.symbol))

    def ensure_candidate(self, tick: TradeTick) -> bool:
        """Durably record the first close-proof tick for a symbol/session.

        This runs on intake so a crash before the next 60-second flush still
        leaves at least one valid close-window proof. Later ticks in the same
        session are coalesced in RAM and refreshed by ``record_candidates`` at
        flush cadence, avoiding a filesystem write per market tick.
        """
        if not self._eligible(tick):
            return False
        with self._lock:
            existing = self._candidates.get(tick.symbol)
            if existing is not None and self._same_session(existing, tick):
                return False
            next_candidates = dict(self._candidates)
            next_candidates[tick.symbol] = tick
            self._persist_locked(next_candidates)
            self._candidates = next_candidates
            return True

    def record_candidates(self, ticks: Iterable[TradeTick]) -> bool:
        """Refresh close-proof candidates in one atomic write before D1 I/O."""
        latest: dict[str, TradeTick] = {}
        for tick in ticks:
            if not self._eligible(tick):
                continue
            current = latest.get(tick.symbol)
            if current is None or tick.timestamp_ms > current.timestamp_ms:
                latest[tick.symbol] = tick
        if not latest:
            return False

        with self._lock:
            next_candidates = dict(self._candidates)
            changed = False
            for symbol, tick in latest.items():
                existing = next_candidates.get(symbol)
                if existing is None or tick.timestamp_ms > existing.timestamp_ms:
                    next_candidates[symbol] = tick
                    changed = True
            if not changed:
                return False
            self._persist_locked(next_candidates)
            self._candidates = next_candidates
            return True

    def ack_written(self, written_as_of: dict[str, int]) -> bool:
        """Forget candidates only after an equal/newer row is durable in D1."""
        with self._lock:
            next_candidates = dict(self._candidates)
            changed = False
            for symbol, durable_timestamp in written_as_of.items():
                candidate = next_candidates.get(symbol)
                if candidate is not None and candidate.timestamp_ms <= durable_timestamp:
                    del next_candidates[symbol]
                    changed = True
            if not changed:
                return False
            self._persist_locked(next_candidates)
            self._candidates = next_candidates
            return True

    def _eligible(self, tick: TradeTick) -> bool:
        if tick.symbol not in self._symbols:
            return False
        if not math.isfinite(tick.price) or tick.price <= 0 or tick.timestamp_ms <= 0:
            return False
        return is_close_baseline_candidate(tick.timestamp_ms)

    @staticmethod
    def _same_session(left: TradeTick, right: TradeTick) -> bool:
        left_session = trading_session_date_from_ms(left.timestamp_ms)
        right_session = trading_session_date_from_ms(right.timestamp_ms)
        return left_session is not None and left_session == right_session

    def _load(self) -> dict[str, TradeTick]:
        try:
            raw = self.path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return {}
        except OSError as exc:
            logger.warning("close checkpoint read failed", extra={"error": exc.__class__.__name__})
            return {}

        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("close checkpoint is malformed; failing closed")
            return {}
        if not isinstance(payload, dict) or payload.get("version") != CHECKPOINT_VERSION:
            logger.warning("close checkpoint version/shape invalid; failing closed")
            return {}
        rows = payload.get("candidates")
        if not isinstance(rows, dict):
            logger.warning("close checkpoint candidates invalid; failing closed")
            return {}

        restored: dict[str, TradeTick] = {}
        for symbol, value in rows.items():
            if symbol not in self._symbols or not isinstance(value, dict):
                continue
            price = value.get("price")
            timestamp_ms = value.get("timestamp_ms")
            if isinstance(price, bool) or not isinstance(price, (int, float)):
                continue
            if isinstance(timestamp_ms, bool) or not isinstance(timestamp_ms, int):
                continue
            tick = TradeTick(symbol=symbol, price=float(price), timestamp_ms=timestamp_ms)
            if self._eligible(tick):
                restored[symbol] = tick
        return restored

    def _persist_locked(self, candidates: dict[str, TradeTick]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temp_path = self.path.with_name(f".{self.path.name}.tmp")
        payload = {
            "version": CHECKPOINT_VERSION,
            "candidates": {
                symbol: {"price": tick.price, "timestamp_ms": tick.timestamp_ms}
                for symbol, tick in sorted(candidates.items())
            },
        }
        try:
            with temp_path.open("w", encoding="utf-8") as handle:
                os.chmod(temp_path, 0o600)
                json.dump(payload, handle, sort_keys=True, separators=(",", ":"))
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_path, self.path)
            self._fsync_parent()
        except OSError:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass
            raise

    def _fsync_parent(self) -> None:
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
        try:
            fd = os.open(self.path.parent, flags)
        except OSError:
            return
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def trading_session_date_from_ms(timestamp_ms: int) -> dt.date | None:
    """Resolve a trade epoch-ms to the shared New York trading-session date."""
    instant = dt.datetime.fromtimestamp(timestamp_ms / 1000, tz=dt.UTC)
    return trading_session_date(instant)
