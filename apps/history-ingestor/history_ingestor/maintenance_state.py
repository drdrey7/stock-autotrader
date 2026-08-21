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
from .state import _payload_updated_at_epoch

ENDPOINTS = ("splits", "weekly", "metrics")
STATUS_PENDING = "pending"
STATUS_DONE = "done"
STATUS_ERROR = "error"

D1_META_KEY = "historyMaintenanceState"


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

        ``pending`` work blocks its phase; a symbol in ``error`` does NOT
        block progression — maintenance falls back to the preserved durable
        state (e.g. stored split_events) and the error is reported/retried
        rather than deadlocking the whole cycle.
        """
        for symbol in self.symbols:
            if self.symbol_status(symbol, "splits") == STATUS_PENDING:
                return "splits"
        for symbol in self.symbols:
            if (self.symbol_status(symbol, "weekly") == STATUS_PENDING
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
        d1_payload: dict | None = None
        mirror_payload: dict | None = None
        try:
            d1_payload = self._d1.read_app_meta(D1_META_KEY)
        except Exception:
            d1_payload = None
        try:
            if self._state_path.is_file():
                mirror_payload = json.loads(self._state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            mirror_payload = None
        if d1_payload is None or (
            mirror_payload is not None
            and _payload_updated_at_epoch(mirror_payload) > _payload_updated_at_epoch(d1_payload)
        ):
            payload = mirror_payload
        else:
            payload = d1_payload
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
