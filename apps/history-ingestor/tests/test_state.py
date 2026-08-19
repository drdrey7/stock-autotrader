"""Tests for the bootstrap checkpoint state (history ingestor)."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from history_ingestor.config import Settings
from history_ingestor.state import Checkpoint, StateStore

META_KEY = "historyBootstrapState"


def settings_with(key_count=2):
    return Settings(
        alpha_vantage_keys=[f"K{i}" for i in range(key_count)],
        cloudflare_api_token="t", cloudflare_account_id="a", cloudflare_d1_database_id="d",
    )


class FakeD1:
    def __init__(self):
        self.meta: dict[str, dict] = {}
        self.saved: list = []

    def read_app_meta(self, key):
        return self.meta.get(key)

    def write_app_meta(self, key, value):
        self.meta[key] = value
        self.saved.append((key, value))
        return True


class StateTests(unittest.TestCase):
    def _store(self, d1, tmp):
        return StateStore(settings_with(), d1, state_path=Path(tmp) / "checkpoint.json")

    def test_fresh_state_has_all_keys_zeroed(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(FakeD1(), tmp)
            state = store.load()
            self.assertEqual(len(state.keys), 2)
            self.assertTrue(all(k["used"] == 0 for k in state.keys))
            self.assertTrue(state.day)

    def test_save_and_load_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            store = self._store(d1, tmp)
            store.load()
            store.mark_key_used(0, 3)
            store.mark_symbol("NVDA", "splits", "done")
            store.mark_symbol("NVDA", "weekly", "done")
            store.mark_symbol("AAPL", "splits", "error")
            self.assertTrue(store.save())

            store2 = self._store(d1, tmp)
            store2.load()
            self.assertEqual(store2.key_used(0), 3)
            self.assertEqual(store2.symbol_status("NVDA", "splits"), "done")
            self.assertEqual(store2.symbol_status("NVDA", "weekly"), "done")
            self.assertEqual(store2.symbol_status("AAPL", "splits"), "error")
            self.assertEqual(store2.symbol_status("AAPL", "weekly"), "pending")

    def test_local_file_fallback_when_d1_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            path = Path(tmp) / "checkpoint.json"
            payload = {
                "version": 1, "day": "2026-08-19",
                "keys": [{"index": 0, "used": 7, "status": "ok"}, {"index": 1, "used": 0, "status": "ok"}],
                "symbols": {"NVDA": {"weekly": "done", "splits": "done"}},
                "started_at": "", "updated_at": "",
            }
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(payload))
            store = self._store(d1, tmp)
            store.load()
            self.assertEqual(store.key_used(0), 7)
            self.assertEqual(store.symbol_status("NVDA", "weekly"), "done")

    def test_day_rollover_resets_usage_keeps_symbol_status(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.meta[META_KEY] = {
                "version": 1, "day": "2026-08-18",
                "keys": [{"index": 0, "used": 25, "status": "exhausted"}, {"index": 1, "used": 10, "status": "ok"}],
                "symbols": {"NVDA": {"weekly": "done", "splits": "done"}},
                "started_at": "", "updated_at": "",
            }
            store = self._store(d1, tmp)
            state = store.load()
            today = state.day
            self.assertNotEqual(today, "2026-08-18")
            self.assertEqual(store.key_used(0), 0)
            self.assertEqual(store.key_used(1), 0)
            self.assertEqual(store.symbol_status("NVDA", "weekly"), "done")

    def test_key_count_change_reconciles(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.meta[META_KEY] = {
                "version": 1, "day": "2026-08-19",
                "keys": [{"index": 0, "used": 5, "status": "ok"}],
                "symbols": {},
                "started_at": "", "updated_at": "",
            }
            store = self._store(d1, tmp)
            store.load()
            self.assertEqual(len(store.state.keys), 2)
            self.assertEqual(store.key_used(0), 5)
            self.assertEqual(store.key_used(1), 0)

    def test_pending_symbols_resume(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            store = self._store(d1, tmp)
            store.load()
            store.mark_symbol("NVDA", "splits", "done")
            store.mark_symbol("NVDA", "weekly", "done")
            pending = store.pending_symbols(["NVDA", "AAPL", "MSFT"])
            self.assertEqual(pending, ["AAPL", "MSFT"])

    def test_mark_exhausted_and_remaining(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            settings = settings_with(key_count=1)
            store = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
            store.load()
            self.assertEqual(store.key_remaining(0), 25)
            store.mark_key_used(0, 24)
            self.assertEqual(store.key_remaining(0), 1)
            store.mark_key_exhausted(0)
            self.assertEqual(store.key_remaining(0), 0)
            self.assertFalse(store.any_budget_remaining())


if __name__ == "__main__":
    unittest.main()
