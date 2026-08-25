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
    # Legacy logical-fetch counter kept for backwards compatibility/reporting.
    bootstrap_daily_used: int = 0
    # Exact bootstrap HTTP debits. Updated by BootstrapBudgetLedger on every
    # provider request, including Information/Note attempts and multi-key retry.
    bootstrap_http_used: int = 0
    started_at: str = ""
    updated_at: str = ""

    def to_dict(self) -> dict:
        return {
            "version": 1,
            "day": self.day,
            "keys": self.keys,
            "symbols": self.symbols,
            "bootstrap_daily_used": self.bootstrap_daily_used,
            "bootstrap_http_used": self.bootstrap_http_used,
            "started_at": self.started_at,
            "updated_at": self.updated_at,
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
        try:
            bootstrap_daily_used = int(payload.get("bootstrap_daily_used", 0))
        except (TypeError, ValueError):
            bootstrap_daily_used = 0
        # On first deploy of exact HTTP accounting, seed from the previous
        # logical counter rather than zero. This is conservative and prevents a
        # same-day upgrade from accidentally granting a fresh bootstrap budget.
        try:
            bootstrap_http_used = int(
                payload.get("bootstrap_http_used", payload.get("bootstrap_daily_used", 0))
            )
        except (TypeError, ValueError):
            bootstrap_http_used = 0
        return cls(
            day=day,
            keys=keys,
            symbols=symbols,
            bootstrap_daily_used=max(0, bootstrap_daily_used),
            bootstrap_http_used=max(0, bootstrap_http_used),
            started_at=str(payload.get("started_at", "")),
            updated_at=str(payload.get("updated_at", "")),
        )


def _utc_date() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


def _utc_now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"


def _iso_day_of(iso_timestamp: str) -> str:
    """UTC calendar day of a stored ISO timestamp ('' for unparseable)."""
    try:
        return iso_timestamp[:10] if len(iso_timestamp) >= 10 else ""
    except TypeError:
        return ""


class KeyBudgetLedger:
    """Shared per-key budget ledger with an optional hard per-run HTTP cap.

    The optional cap is enforced at the same provider boundary where every real
    HTTP debit is observed. It is used by bounded provider jobs such as
    ``reconcile-splits`` so an internal multi-key retry cannot overshoot the
    advertised service cap. Maintenance leaves ``run_limit`` unset.
    """

    def __init__(self, store: StateStore, run_limit: int | None = None) -> None:
        self._store = store
        self._run_limit = None if run_limit is None else max(0, int(run_limit))
        self._run_used = 0

    def remaining(self, index: int) -> int:
        shared_remaining = self._store.key_remaining(index)
        if self._run_limit is None:
            return shared_remaining
        return min(shared_remaining, max(0, self._run_limit - self._run_used))

    def mark_used(self, index: int, delta: int = 1) -> None:
        debit = max(0, int(delta))
        if debit == 0:
            return
        self._store.mark_key_used(index, debit)
        self._run_used += debit

    def mark_exhausted(self, index: int) -> None:
        self._store.mark_key_exhausted(index)


class BootstrapBudgetLedger:
    """Provider ledger that enforces bootstrap's real HTTP request budget.

    Alpha Vantage may debit more than one HTTP request inside a single logical
    ``fetch_*`` call (for example key 0 returns ``Information`` and key 1 is
    tried next). Therefore the residual bootstrap cap must live at the provider
    ledger boundary, where every real HTTP debit is observed, rather than after
    a logical fetch returns.

    ``daily_limit`` is persisted in ``StateStore.bootstrap_http_used`` and thus
    survives process/systemd restarts. ``run_limit`` is an optional lower cap
    for this invocation (``--limit``); both are enforced before the provider can
    select another key.
    """

    def __init__(
        self,
        store: StateStore,
        daily_limit: int,
        run_limit: int | None = None,
    ) -> None:
        self._store = store
        self._daily_limit = max(0, int(daily_limit))
        requested = self._daily_limit if run_limit is None else max(0, int(run_limit))
        self._run_limit = min(requested, self._daily_limit)
        self._run_used = 0

    def remaining(self, index: int) -> int:
        daily_remaining = max(0, self._daily_limit - self._store.bootstrap_http_used())
        run_remaining = max(0, self._run_limit - self._run_used)
        return min(self._store.key_remaining(index), daily_remaining, run_remaining)

    def mark_used(self, index: int, delta: int = 1) -> None:
        debit = max(0, int(delta))
        if debit == 0:
            return
        self._store.mark_key_used(index, debit)
        self._store.mark_bootstrap_http_used(debit)
        self._run_used += debit
        # Persist immediately after EACH real HTTP debit. A crash/restart can
        # never forget provider quota already spent by bootstrap.
        self._store.save()

    def mark_exhausted(self, index: int) -> None:
        self._store.mark_key_exhausted(index)
        self._store.save()


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
        payload: dict | None = None
        try:
            payload = self._d1.read_app_meta(D1_META_KEY)
        except Exception:  # D1 unreadable — fall back to the local mirror
            payload = None
        if payload is None:
            try:
                if self._state_path.is_file():
                    payload = json.loads(self._state_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                payload = None
        self._state = Checkpoint.from_dict(payload) if payload else Checkpoint()
        today = _utc_date()
        if self._state.day != today:
            # New day: the provider quota resets; usage counters restart.
            self._state.day = today
            self._state.keys = [
                {"index": index, "used": 0, "status": "ok"}
                for index in range(self._settings.key_count)
            ]
            # Both bootstrap counters reset only on the UTC day boundary.
            self._state.bootstrap_daily_used = 0
            self._state.bootstrap_http_used = 0
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

    def bootstrap_daily_used(self) -> int:
        """Legacy logical bootstrap fetches consumed so far this UTC day."""
        return int(getattr(self._state, "bootstrap_daily_used", 0))

    def mark_bootstrap_daily_used(self, delta: int = 1) -> None:
        """Persist the legacy logical bootstrap fetch counter."""
        self._state.bootstrap_daily_used += delta
        self._state.updated_at = _utc_now_iso()

    def bootstrap_http_used(self) -> int:
        """Exact bootstrap provider HTTP debits consumed this UTC day."""
        return int(getattr(self._state, "bootstrap_http_used", 0))

    def mark_bootstrap_http_used(self, delta: int = 1) -> None:
        """Record exact provider HTTP debits for the residual bootstrap cap."""
        self._state.bootstrap_http_used += delta
        self._state.updated_at = _utc_now_iso()

    def save_bootstrap_daily_used(self) -> None:
        """Persist the bootstrap counters (best-effort, mirror+D1)."""
        self.save()

    def save(self) -> bool:
        """Persist to D1 (primary) and the local file (mirror). Best effort."""
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
