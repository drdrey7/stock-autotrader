"""Bootstrap checkpoint state — resumable across days and interruptions.

The checkpoint records, per run-day, how many Alpha Vantage requests each
key consumed (indexes only — never key values) and the per-symbol,
per-endpoint status (weekly/splits: pending | done | error). Persisted to D1
``app_meta`` (survives restarts and machines) with a local-file mirror for
offline/dry-run contexts. A restart continues from unfinished work; a day
rollover resets per-key usage but keeps completed symbols done — no
duplicate downloads, no double-spending the day quota.
"""

from __future__ import annotations

import datetime as dt
import json
import time
from dataclasses import dataclass, field
from pathlib import Path

from .config import Settings

ENDPOINTS = ("weekly", "splits")
STATUS_PENDING = "pending"
STATUS_DONE = "done"
STATUS_ERROR = "error"

D1_META_KEY = "historyBootstrapState"


@dataclass
class Checkpoint:
    day: str = ""  # UTC date the per-key usage refers to ("YYYY-MM-DD")
    keys: list[dict] = field(default_factory=list)  # [{"index": 0, "used": 12, "status": "ok"}]
    symbols: dict[str, dict[str, str]] = field(default_factory=dict)
    started_at: str = ""
    updated_at: str = ""
    revision: int = 0  # monotonic persistence counter; higher = newer

    def to_dict(self) -> dict:
        return {
            "version": 1,
            "day": self.day,
            "keys": self.keys,
            "symbols": self.symbols,
            "started_at": self.started_at,
            "updated_at": self.updated_at,
            "revision": self.revision,
        }

    @classmethod
    def from_dict(cls, payload: dict) -> Checkpoint:
        day = str(payload.get("day", ""))
        keys = payload.get("keys") or []
        keys = [k for k in keys if isinstance(k, dict) and isinstance(k.get("index"), int)]
        symbols = payload.get("symbols") or {}
        symbols = {
            str(sym): {
                endpoint: str(status) if str(status) in (STATUS_PENDING, STATUS_DONE, STATUS_ERROR) else STATUS_PENDING
                for endpoint, status in (raw or {}).items()
                if endpoint in ENDPOINTS
            }
            for sym, raw in symbols.items()
            if isinstance(raw, dict)
        }
        return cls(
            day=day,
            keys=keys,
            symbols=symbols,
            started_at=str(payload.get("started_at", "")),
            updated_at=str(payload.get("updated_at", "")),
            revision=int(payload.get("revision", 0) or 0),
        )


def _utc_date() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


def _utc_now_iso() -> str:
    return dt.datetime.now(dt.UTC).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _payload_updated_at_epoch(payload: dict | None) -> float:
    """Return comparable freshness for a persisted checkpoint payload."""
    if not isinstance(payload, dict):
        return -1.0
    raw = payload.get("updated_at", "")
    if not isinstance(raw, str) or not raw:
        return -1.0
    try:
        return dt.datetime.fromisoformat(raw.replace("Z", "+00:00")).timestamp()
    except (ValueError, OverflowError):
        return -1.0


def _payload_revision(payload: dict | None) -> int:
    """Return the revision of a persisted checkpoint payload (0 if missing)."""
    if not isinstance(payload, dict):
        return 0
    return int(payload.get("revision", 0) or 0)


class AmbiguousLegacyCheckpointError(RuntimeError):
    """Raised when two legacy checkpoints (revision=0) have the same timestamp
    but different payloads — the code cannot determine which is newer and
    must NOT choose arbitrarily. Requires manual reconciliation."""


def _resolve_checkpoint_payload(
    d1_payload: dict | None,
    mirror_payload: dict | None,
) -> dict | None:
    """Resolve which payload to load, with fail-closed behavior for ambiguous legacy checkpoints.

    Rules:
    - Only D1 exists → D1
    - Only mirror exists → mirror
    - Both exist:
      - Higher revision wins
      - Same revision + different timestamps → newer timestamp wins
      - Same revision + same timestamp + same payload → either (deterministic)
      - Same revision=0 + same timestamp + DIFFERENT payloads → FAIL CLOSED
      - Same revision>0 + same timestamp + different payloads → mirror wins (newer write)
    - Neither exists → None
    """
    if d1_payload is None:
        return mirror_payload
    if mirror_payload is None:
        return d1_payload

    d1_rev = _payload_revision(d1_payload)
    mirror_rev = _payload_revision(mirror_payload)

    # Different revisions → higher wins
    if mirror_rev > d1_rev:
        return mirror_payload
    if d1_rev > mirror_rev:
        return d1_payload

    # Same revision — compare timestamps
    d1_epoch = _payload_updated_at_epoch(d1_payload)
    mirror_epoch = _payload_updated_at_epoch(mirror_payload)

    if mirror_epoch > d1_epoch:
        return mirror_payload
    if d1_epoch > mirror_epoch:
        return d1_payload

    # Same revision AND same timestamp
    if d1_payload == mirror_payload:
        # Identical payloads — deterministic, return either
        return d1_payload

    # Same revision, same timestamp, different payloads
    if d1_rev == 0:
        # Legacy ambiguity — cannot determine which is newer, fail closed
        raise AmbiguousLegacyCheckpointError(
            "Ambiguous legacy checkpoint: D1 and mirror have revision=0, "
            "identical timestamps, but different payloads. "
            "Manual reconciliation required."
        )

    # revision > 0 with same timestamp — mirror is the newer write
    return mirror_payload


def _iso_day_of(iso_timestamp: str) -> str:
    """UTC calendar day of a stored ISO timestamp ('' for unparseable)."""
    try:
        return iso_timestamp[:10] if len(iso_timestamp) >= 10 else ""
    except TypeError:
        return ""


class KeyBudgetLedger:
    """Adapts a StateStore to the provider's BudgetLedger protocol."""

    def __init__(self, store: StateStore) -> None:
        self._store = store

    def remaining(self, index: int) -> int:
        return self._store.key_remaining(index)

    def mark_used(self, index: int, delta: int = 1) -> None:
        self._store.mark_key_used(index, delta)

    def mark_exhausted(self, index: int) -> None:
        self._store.mark_key_exhausted(index)


class StateStore:
    """Load/save the bootstrap checkpoint; D1 app_meta primary, file mirror."""

    def __init__(self, settings: Settings, d1, state_path: Path | None = None) -> None:
        self._settings = settings
        self._d1 = d1
        self._state_path = state_path or settings.state_path
        self._state: Checkpoint = Checkpoint()
        self._loaded = False

    def load(self) -> Checkpoint:
        """Load state: D1 first, then the local file mirror, else fresh.

        A state from a previous day is normalised: per-key usage resets for
        the new day, symbol statuses are kept (completed work stays done).
        """
        d1_payload: dict | None = None
        mirror_payload: dict | None = None
        try:
            d1_payload = self._d1.read_app_meta(D1_META_KEY)
        except Exception:  # D1 unreadable — fall back to the local mirror
            d1_payload = None
        try:
            if self._state_path.is_file():
                mirror_payload = json.loads(self._state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            mirror_payload = None
        payload = _resolve_checkpoint_payload(d1_payload, mirror_payload)
        self._state = Checkpoint.from_dict(payload) if payload else Checkpoint()
        today = _utc_date()
        if self._state.day != today:
            # New day: the provider quota resets; usage counters restart.
            self._state.day = today
            self._state.keys = [
                {"index": index, "used": 0, "status": "ok"}
                for index in range(self._settings.key_count)
            ]
        # Ensure one entry per configured key (keys added/removed between runs).
        by_index = {int(k.get("index", -1)): k for k in self._state.keys}
        self._state.keys = [
            by_index.get(index, {"index": index, "used": 0, "status": "ok"})
            for index in range(self._settings.key_count)
        ]
        self._loaded = True
        return self._state

    @property
    def state(self) -> Checkpoint:
        return self._state

    def key_used(self, index: int) -> int:
        return int(self._state.keys[index].get("used", 0))

    def key_remaining(self, index: int) -> int:
        return max(0, self._settings.av_budget_per_key_per_day - self.key_used(index))

    def any_budget_remaining(self) -> bool:
        return any(self.key_remaining(index) > 0 for index in range(self._settings.key_count))

    def mark_key_used(self, index: int, delta: int = 1) -> None:
        self._state.keys[index]["used"] = self.key_used(index) + delta
        self._state.keys[index]["status"] = "ok"
        self._state.updated_at = _utc_now_iso()

    def mark_key_exhausted(self, index: int) -> None:
        """The provider reported quota exhaustion: burn the remaining budget
        so this key is not retried today."""
        self._state.keys[index]["used"] = self._settings.av_budget_per_key_per_day
        self._state.keys[index]["status"] = "exhausted"
        self._state.updated_at = _utc_now_iso()

    def symbol_status(self, symbol: str, endpoint: str) -> str:
        return self._state.symbols.get(symbol, {}).get(endpoint, STATUS_PENDING)

    def mark_symbol(self, symbol: str, endpoint: str, status: str) -> None:
        entry = self._state.symbols.setdefault(symbol, {})
        entry[endpoint] = status
        self._state.updated_at = _utc_now_iso()

    def pending_symbols(self, symbols: list[str]) -> list[str]:
        return [
            symbol
            for symbol in symbols
            if any(self.symbol_status(symbol, endpoint) != STATUS_DONE for endpoint in ENDPOINTS)
        ]

    def save(self) -> bool:
        """Persist to D1 (primary) and the local file (mirror). Best effort."""
        self._state.revision += 1
        payload = self._state.to_dict()
        ok = True
        try:
            ok = self._d1.write_app_meta(D1_META_KEY, payload) and ok
        except Exception:
            ok = False
        try:
            self._state_path.parent.mkdir(parents=True, exist_ok=True)
            self._state_path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
        except OSError:
            ok = False
        return ok
