"""Durable weekly-maintenance cycle checkpoint.

Kept SEPARATE from the bootstrap checkpoint (``state.py`` /
``app_meta.historyBootstrapState``) on purpose: bootstrap is one-shot
historical loading, maintenance is a recurring cycle, and mixing the two
creates ambiguous semantics.

A maintenance cycle is identified by the completed trading week it targets
(``cycle_week`` = ISO week label of the most recent Friday). Within a cycle
each symbol tracks per-endpoint status:

  splits  — the Sunday SPLITS reconciliation pass
  weekly  — the Monday WEEKLY refresh pass
  metrics — the technical_metrics recomputation (bound to the weekly pass)

Status values: pending | done | error.

Cycle rules:
- A run whose target week differs from ``cycle_week`` STARTS a new cycle
  (all symbols reset to pending) — when a new completed week exists.
- Completed endpoint work is never repeated: a run resumes the first
  unfinished symbol/endpoint and skips what is already ``done``.
- Quota exhaustion preserves the state exactly where it stopped; a new
  process resumes from the checkpoint.
- When every symbol is done in every endpoint, the cycle is ``complete`` and
  another run inside the same cycle performs ZERO provider calls.
- Per-symbol ``error`` statuses are retried on the next permitted run.

Persisted to D1 ``app_meta.historyMaintenanceState`` (primary) with a
local-file mirror, matching the bootstrap checkpoint conventions.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .config import Settings

ENDPOINTS = ("splits", "weekly", "metrics")
STATUS_PENDING = "pending"
STATUS_DONE = "done"
STATUS_ERROR = "error"

D1_META_KEY = "historyMaintenanceState"
RECONCILE_D1_META_KEY = "historyReconcileSplitState"
RECONCILE_STATUS_META_PREFIX = "historyReconcileSplitStatus:"


def _utc_now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"


@dataclass
class MaintenanceState:
    cycle_week: str = ""  # ISO week label of the target completed week, e.g. "2026-W34"
    updated_at: str = ""
    symbols: dict[str, dict[str, str]] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "version": 1,
            "cycle_week": self.cycle_week,
            "updated_at": self.updated_at,
            "symbols": self.symbols,
        }

    @classmethod
    def from_dict(cls, payload: dict | None) -> MaintenanceState:
        if not isinstance(payload, dict):
            return cls()
        symbols: dict[str, dict[str, str]] = {}
        for sym, raw in (payload.get("symbols") or {}).items():
            if not isinstance(raw, dict):
                continue
            cleaned: dict[str, str] = {}
            for endpoint, status in raw.items():
                if endpoint in ENDPOINTS and str(status) in (STATUS_PENDING, STATUS_DONE, STATUS_ERROR):
                    cleaned[endpoint] = str(status)
            if cleaned:
                symbols[str(sym)] = cleaned
        return cls(
            cycle_week=str(payload.get("cycle_week", "")),
            updated_at=str(payload.get("updated_at", "")),
            symbols=symbols,
        )

    def symbol_status(self, symbol: str, endpoint: str) -> str:
        return self.symbols.get(symbol, {}).get(endpoint, STATUS_PENDING)

    def mark_symbol(self, symbol: str, endpoint: str, status: str) -> None:
        self.symbols.setdefault(symbol, {})[endpoint] = status
        self.updated_at = _utc_now_iso()

    def all_done(self, endpoint: str) -> bool:
        return all(self.symbol_status(symbol, endpoint) == STATUS_DONE for symbol in self.symbols)

    def phase(self) -> str:
        """Current cycle phase derived from per-symbol status (self-healing).

        Phase is driven by the WEEKLY refresh + metrics recomputation ONLY.
        Split reconciliation is a SEPARATE low-frequency responsibility
        (``reconcile-splits`` / daily ``apply-due-splits``) and never blocks the
        weekly SMA refresh — a bare weekly cycle must always roll the anchor
        forward even if splits have not yet been re-checked. A symbol in
        ``error`` does NOT block progression — maintenance falls back to the
        preserved durable state (e.g. stored split_events) and the error is
        reported/retried rather than deadlocking the whole cycle.
        """
        for symbol in self.symbols:
            if (self.symbol_status(symbol, "weekly") == STATUS_PENDING
                    or self.symbol_status(symbol, "weekly") == STATUS_ERROR
                    or self.symbol_status(symbol, "metrics") == STATUS_PENDING):
                return "weekly"
        return "complete"


class MaintenanceStore:
    """Load/save the maintenance cycle checkpoint (D1 primary, file mirror)."""

    def __init__(self, settings: Settings, d1: Any, state_path: Path | None = None) -> None:
        self._settings = settings
        self._d1 = d1
        self._state_path = state_path or settings.maintenance_state_path
        self._state: MaintenanceState = MaintenanceState()
        self._loaded = False

    def load(self) -> MaintenanceState:
        """Load the cycle checkpoint from D1, falling back to the local mirror."""
        payload: dict | None = None
        try:
            payload = self._d1.read_app_meta(D1_META_KEY)
        except Exception:
            payload = None
        if payload is None:
            try:
                if self._state_path.is_file():
                    payload = json.loads(self._state_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                payload = None
        self._state = MaintenanceState.from_dict(payload)
        self._loaded = True
        return self._state

    @property
    def state(self) -> MaintenanceState:
        return self._state

    def reset_cycle(self, cycle_week: str, symbols: list[str]) -> None:
        """Start a new cycle: every symbol back to pending for all endpoints."""
        self._state.cycle_week = cycle_week
        self._state.symbols = {symbol: {endpoint: STATUS_PENDING for endpoint in ENDPOINTS} for symbol in symbols}
        self._state.updated_at = _utc_now_iso()

    def save(self) -> bool:
        datum = self._state.to_dict()
        ok = True
        try:
            ok = self._d1.write_app_meta(D1_META_KEY, datum) and ok
        except Exception:
            ok = False
        try:
            self._state_path.parent.mkdir(parents=True, exist_ok=True)
            self._state_path.write_text(json.dumps(datum, indent=2, sort_keys=True), encoding="utf-8")
        except OSError:
            ok = False
        return ok


class ReconcileState:
    """Durable per-symbol SPLITS-reconciliation progress, INDEPENDENT of the
    weekly maintenance cycle.

    Split reconciliation is its own persistent responsibility. It must survive
    ``MaintenanceStore.reset_cycle()`` (which clears the weekly cycle's per-symbol
    endpoints on a new ``cycle_week``) — otherwise a mere weekly rollover would
    forever reset reconciliation progress and re-fetch every symbol. This state
    owns only ``splits`` (pending | done | error) per symbol, persisted to
    ``app_meta.historyReconcileSplitState``. The current pass's membership is
    the set of ``splits`` keys, so it survives serialization/restart. Completed
    symbol markers are also written to ``app_meta`` under
    ``historyReconcileSplitStatus:<SYMBOL>`` so read models can query one
    symbol without parsing the entire checkpoint document.

    Cycle semantics:
    - A capped/partial pass leaves unprocessed symbols ``pending``; the next run
      resumes from the first unfinished symbol (done symbols are skipped).
    - When every symbol in the current pass is ``done`` the pass is ``complete``;
      the next invocation deliberately STARTS a new reconciliation cycle (all
      back to pending) so new splits are re-checked on the next cadence.
    """

    def __init__(self, splits: dict[str, str] | None = None, updated_at: str = "") -> None:
        self.splits: dict[str, str] = dict(splits or {})
        self.updated_at = updated_at or _utc_now_iso()
        self._dirty_symbols: set[str] = set()

    def to_dict(self) -> dict:
        return {
            "version": 1,
            "updated_at": self.updated_at,
            "splits": self.splits,
        }

    @classmethod
    def from_dict(cls, payload: dict | None) -> ReconcileState:
        if not isinstance(payload, dict):
            return cls()
        splits: dict[str, str] = {}
        for sym, status in (payload.get("splits") or {}).items():
            if str(status) in (STATUS_PENDING, STATUS_DONE, STATUS_ERROR):
                splits[str(sym)] = str(status)
        return cls(splits=splits, updated_at=str(payload.get("updated_at", "")))

    def status(self, symbol: str) -> str:
        return self.splits.get(symbol, STATUS_PENDING)

    def mark(self, symbol: str, status: str, *, update_serving_marker: bool = True) -> None:
        """Record job progress, optionally updating the public serving marker.

        A pass reset and a transient provider failure affect retry progress, not
        the already verified historical scale. Only successful verification or
        evidence that changes stored weekly history may update the marker.
        """
        self.splits[symbol] = status
        if update_serving_marker:
            self._dirty_symbols.add(symbol)
        self.updated_at = _utc_now_iso()

    def all_done(self) -> bool:
        # Membership is derived from the persisted splits keys, so a fully
        # reconciled pass round-trips as done across restart/rollover.
        return bool(self.splits) and all(status == STATUS_DONE for status in self.splits.values())

    def pending_in(self, symbols: list[str]) -> list[str]:
        """Symbols not yet reconciled within the current pass, in universe order."""
        return [s for s in symbols if self.status(s) != STATUS_DONE]


class ReconcileStore:
    """Load/save the SPLITS-reconciliation checkpoint (D1 primary, file mirror)."""

    def __init__(self, settings: Settings, d1: Any, state_path: Path | None = None) -> None:
        self._settings = settings
        self._d1 = d1
        self._state_path = state_path or settings.maintenance_state_path.with_name("reconcile.json")
        self._state = ReconcileState()
        self._loaded = False

    def load(self) -> ReconcileState:
        payload: dict | None = None
        try:
            payload = self._d1.read_app_meta(RECONCILE_D1_META_KEY)
        except Exception:
            payload = None
        if payload is None:
            try:
                if self._state_path.is_file():
                    payload = json.loads(self._state_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                payload = None
        self._state = ReconcileState.from_dict(payload)
        self._loaded = True
        return self._state

    @property
    def state(self) -> ReconcileState:
        return self._state

    def start_new_pass(self, symbols: list[str]) -> None:
        """Reset the requested members without erasing unrelated progress.

        A manual ``reconcile-splits --symbols ...`` invocation is a processing
        filter, not a new definition of the persistent universe. Resetting a
        subset therefore updates only those symbols; existing done/pending/error
        state for every other symbol is preserved. A normal full-universe call
        still resets the complete pass because it supplies every member.
        """
        for symbol in symbols:
            self._state.splits[symbol] = STATUS_PENDING
        self._state.updated_at = _utc_now_iso()

    def backfill_verified_markers(self) -> bool:
        """Queue marker rows for legacy durable ``done`` statuses.

        This preserves serving availability on rollout before a new pass resets
        its progress checkpoint. Rewriting an identical marker is idempotent.
        """
        verified = [symbol for symbol, status in self._state.splits.items() if status == STATUS_DONE]
        self._state._dirty_symbols.update(verified)
        return bool(verified)

    def save(self) -> bool:
        """Persist the global checkpoint and all changed per-symbol markers."""
        datum = self._state.to_dict()
        ok = True
        try:
            ok = self._d1.write_app_meta(RECONCILE_D1_META_KEY, datum) and ok
            for symbol in sorted(self._state._dirty_symbols):
                status = self._state.status(symbol)
                status_payload = {
                    "version": 1,
                    "symbol": symbol,
                    "status": status,
                    "updated_at": self._state.updated_at,
                }
                ok = self._d1.write_app_meta(
                    f"{RECONCILE_STATUS_META_PREFIX}{symbol}", status_payload,
                ) and ok
            if ok:
                self._state._dirty_symbols.clear()
        except Exception:
            ok = False
        try:
            self._state_path.parent.mkdir(parents=True, exist_ok=True)
            self._state_path.write_text(json.dumps(datum, indent=2, sort_keys=True), encoding="utf-8")
        except OSError:
            ok = False
        return ok
