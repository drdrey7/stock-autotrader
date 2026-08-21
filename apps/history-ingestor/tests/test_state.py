"""Tests for the bootstrap checkpoint state (history ingestor)."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from history_ingestor.config import Settings, from_env
from history_ingestor.state import AmbiguousLegacyCheckpointError, Checkpoint, StateStore, _resolve_checkpoint_payload

META_KEY = "historyBootstrapState"
TEST_TODAY = "2030-01-02"
TEST_PREVIOUS_DAY = "2030-01-01"


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
    def setUp(self):
        # StateStore intentionally uses the real UTC date in production. Freeze
        # only that date boundary in this test class so same-day and rollover
        # fixtures are deterministic regardless of when CI runs.
        utc_date_patcher = patch("history_ingestor.state._utc_date", return_value=TEST_TODAY)
        utc_date_patcher.start()
        self.addCleanup(utc_date_patcher.stop)

    def test_maintenance_state_path_can_use_service_state_directory(self):
        settings = from_env({
            "ALPHA_VANTAGE_API_KEYS": "K",
            "CLOUDFLARE_API_TOKEN": "t",
            "CLOUDFLARE_ACCOUNT_ID": "a",
            "CLOUDFLARE_D1_DATABASE_ID": "d",
            "HISTORY_INGESTOR_MAINTENANCE_STATE": "/var/lib/history-ingestor/maintenance.json",
        })
        self.assertEqual(
            settings.maintenance_state_path,
            Path("/var/lib/history-ingestor/maintenance.json"),
        )

    def _store(self, d1, tmp):
        return StateStore(settings_with(), d1, state_path=Path(tmp) / "checkpoint.json")

    def test_fresh_state_has_all_keys_zeroed(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(FakeD1(), tmp)
            state = store.load()
            self.assertEqual(len(state.keys), 2)
            self.assertTrue(all(k["used"] == 0 for k in state.keys))
            self.assertEqual(state.day, TEST_TODAY)

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
                "version": 1, "day": TEST_TODAY,
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

    def test_newer_local_mirror_beats_stale_d1_checkpoint(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.meta[META_KEY] = {
                "version": 1, "day": TEST_TODAY,
                "keys": [{"index": 0, "used": 1, "status": "ok"}, {"index": 1, "used": 0, "status": "ok"}],
                "symbols": {},
                "started_at": "", "updated_at": "2030-01-02T00:00:01Z",
            }
            path = Path(tmp) / "checkpoint.json"
            path.write_text(json.dumps({
                "version": 1, "day": TEST_TODAY,
                "keys": [{"index": 0, "used": 7, "status": "ok"}, {"index": 1, "used": 0, "status": "ok"}],
                "symbols": {"NVDA": {"splits": "done", "weekly": "done"}},
                "started_at": "", "updated_at": "2030-01-02T00:00:02Z",
            }))
            store = self._store(d1, tmp)
            store.load()
            self.assertEqual(store.key_used(0), 7)
            self.assertEqual(store.symbol_status("NVDA", "weekly"), "done")

    def test_equal_timestamp_different_payloads_mirror_wins_with_revision(self):
        """Non-legacy checkpoints (revision>0) with equal timestamps → mirror wins."""
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            timestamp = "2030-01-02T00:00:01Z"
            d1.meta[META_KEY] = {
                "version": 1, "day": TEST_TODAY, "revision": 5,
                "keys": [{"index": 0, "used": 1, "status": "ok"}, {"index": 1, "used": 0, "status": "ok"}],
                "symbols": {}, "started_at": "", "updated_at": timestamp,
            }
            path = Path(tmp) / "checkpoint.json"
            path.write_text(json.dumps({
                "version": 1, "day": TEST_TODAY, "revision": 5,
                "keys": [{"index": 0, "used": 2, "status": "ok"}, {"index": 1, "used": 0, "status": "ok"}],
                "symbols": {}, "started_at": "", "updated_at": timestamp,
            }))
            store = self._store(d1, tmp)
            store.load()
            self.assertEqual(store.key_used(0), 2)

    def test_equal_timestamp_different_payloads_fails_closed_for_legacy(self):
        """Legacy checkpoints (revision=0) with equal timestamps but different payloads → fail closed."""
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            timestamp = "2030-01-02T00:00:01Z"
            d1.meta[META_KEY] = {
                "version": 1, "day": TEST_TODAY,
                "keys": [{"index": 0, "used": 1, "status": "ok"}, {"index": 1, "used": 0, "status": "ok"}],
                "symbols": {}, "started_at": "", "updated_at": timestamp,
            }
            path = Path(tmp) / "checkpoint.json"
            path.write_text(json.dumps({
                "version": 1, "day": TEST_TODAY,
                "keys": [{"index": 0, "used": 2, "status": "ok"}, {"index": 1, "used": 0, "status": "ok"}],
                "symbols": {}, "started_at": "", "updated_at": timestamp,
            }))
            store = self._store(d1, tmp)
            with self.assertRaises(AmbiguousLegacyCheckpointError):
                store.load()

    def test_higher_revision_wins_over_stale_d1(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.meta[META_KEY] = {
                "version": 1, "day": TEST_TODAY, "revision": 10,
                "keys": [{"index": 0, "used": 1, "status": "ok"}, {"index": 1, "used": 0, "status": "ok"}],
                "symbols": {}, "started_at": "", "updated_at": "2030-01-02T00:00:02Z",
            }
            path = Path(tmp) / "checkpoint.json"
            path.write_text(json.dumps({
                "version": 1, "day": TEST_TODAY, "revision": 11,
                "keys": [{"index": 0, "used": 7, "status": "ok"}, {"index": 1, "used": 0, "status": "ok"}],
                "symbols": {"NVDA": {"splits": "done", "weekly": "done"}},
                "started_at": "", "updated_at": "2030-01-02T00:00:01Z",
            }))
            store = self._store(d1, tmp)
            store.load()
            self.assertEqual(store.key_used(0), 7)
            self.assertEqual(store.symbol_status("NVDA", "weekly"), "done")

    def test_equal_revision_prefers_newer_timestamp(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.meta[META_KEY] = {
                "version": 1, "day": TEST_TODAY, "revision": 5,
                "keys": [{"index": 0, "used": 1, "status": "ok"}, {"index": 1, "used": 0, "status": "ok"}],
                "symbols": {}, "started_at": "", "updated_at": "2030-01-02T00:00:02Z",
            }
            path = Path(tmp) / "checkpoint.json"
            path.write_text(json.dumps({
                "version": 1, "day": TEST_TODAY, "revision": 5,
                "keys": [{"index": 0, "used": 3, "status": "ok"}, {"index": 1, "used": 0, "status": "ok"}],
                "symbols": {}, "started_at": "", "updated_at": "2030-01-02T00:00:01Z",
            }))
            store = self._store(d1, tmp)
            store.load()
            self.assertEqual(store.key_used(0), 1)

    def test_legacy_checkpoint_without_revision_loads(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.meta[META_KEY] = {
                "version": 1, "day": TEST_TODAY,
                "keys": [{"index": 0, "used": 4, "status": "ok"}, {"index": 1, "used": 0, "status": "ok"}],
                "symbols": {"NVDA": {"splits": "done", "weekly": "done"}},
                "started_at": "", "updated_at": "",
            }
            store = self._store(d1, tmp)
            store.load()
            self.assertEqual(store.key_used(0), 4)
            self.assertEqual(store.symbol_status("NVDA", "weekly"), "done")

    def test_save_increments_revision(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            store = self._store(d1, tmp)
            store.load()
            self.assertEqual(store.state.revision, 0)
            store.mark_key_used(0, 1)
            store.save()
            self.assertEqual(store.state.revision, 1)
            store.mark_key_used(0, 1)
            store.save()
            self.assertEqual(store.state.revision, 2)

    def test_quota_never_goes_backward_after_reload(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            store = self._store(d1, tmp)
            store.load()
            store.mark_key_used(0, 5)
            store.save()
            self.assertEqual(store.key_used(0), 5)
            store2 = self._store(d1, tmp)
            store2.load()
            self.assertGreaterEqual(store2.key_used(0), 5)

    def test_day_rollover_resets_usage_keeps_symbol_status(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.meta[META_KEY] = {
                "version": 1, "day": TEST_PREVIOUS_DAY,
                "keys": [{"index": 0, "used": 25, "status": "exhausted"}, {"index": 1, "used": 10, "status": "ok"}],
                "symbols": {"NVDA": {"weekly": "done", "splits": "done"}},
                "started_at": "", "updated_at": "",
            }
            store = self._store(d1, tmp)
            state = store.load()
            self.assertEqual(state.day, TEST_TODAY)
            self.assertEqual(store.key_used(0), 0)
            self.assertEqual(store.key_used(1), 0)
            self.assertEqual(store.symbol_status("NVDA", "weekly"), "done")

    def test_key_count_change_reconciles(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.meta[META_KEY] = {
                "version": 1, "day": TEST_TODAY,
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


class LegacyCheckpointResolutionTests(unittest.TestCase):
    """Tests for fail-closed behavior with ambiguous legacy checkpoints."""

    def test_legacy_identical_payloads_load_normally(self):
        """Legacy checkpoints (revision=0) with same timestamp and same payloads → load normally."""
        d1 = {
            "version": 1, "day": "2030-01-02",
            "keys": [{"index": 0, "used": 5, "status": "ok"}],
            "symbols": {"NVDA": {"splits": "done"}},
            "updated_at": "2030-01-02T00:00:00Z",
        }
        mirror = dict(d1)
        result = _resolve_checkpoint_payload(d1, mirror)
        self.assertEqual(result, d1)

    def test_legacy_different_timestamps_newer_wins(self):
        """Legacy checkpoints with different timestamps → newer timestamp wins."""
        d1 = {
            "version": 1, "day": "2030-01-02",
            "keys": [{"index": 0, "used": 5, "status": "ok"}],
            "symbols": {},
            "updated_at": "2030-01-02T00:00:00Z",
        }
        mirror = {
            "version": 1, "day": "2030-01-02",
            "keys": [{"index": 0, "used": 10, "status": "ok"}],
            "symbols": {},
            "updated_at": "2030-01-02T00:00:01Z",
        }
        result = _resolve_checkpoint_payload(d1, mirror)
        self.assertEqual(result, mirror)

    def test_legacy_same_timestamp_different_payloads_fails_closed(self):
        """Legacy checkpoints (revision=0) with same timestamp but different payloads → fail closed."""
        d1 = {
            "version": 1, "day": "2030-01-02",
            "keys": [{"index": 0, "used": 5, "status": "ok"}],
            "symbols": {"NVDA": {"splits": "done"}},
            "updated_at": "2030-01-02T00:00:00Z",
        }
        mirror = {
            "version": 1, "day": "2030-01-02",
            "keys": [{"index": 0, "used": 10, "status": "ok"}],
            "symbols": {"AAPL": {"splits": "done"}},
            "updated_at": "2030-01-02T00:00:00Z",
        }
        with self.assertRaises(AmbiguousLegacyCheckpointError) as ctx:
            _resolve_checkpoint_payload(d1, mirror)
        self.assertIn("Ambiguous legacy checkpoint", str(ctx.exception))
        self.assertIn("Manual reconciliation required", str(ctx.exception))

    def test_revision_greater_than_zero_same_timestamp_different_payloads_mirror_wins(self):
        """Non-legacy checkpoints (revision>0) with same timestamp → mirror wins (newer write)."""
        d1 = {
            "version": 1, "day": "2030-01-02", "revision": 5,
            "keys": [{"index": 0, "used": 5, "status": "ok"}],
            "symbols": {},
            "updated_at": "2030-01-02T00:00:00Z",
        }
        mirror = {
            "version": 1, "day": "2030-01-02", "revision": 5,
            "keys": [{"index": 0, "used": 10, "status": "ok"}],
            "symbols": {},
            "updated_at": "2030-01-02T00:00:00Z",
        }
        result = _resolve_checkpoint_payload(d1, mirror)
        self.assertEqual(result, mirror)

    def test_different_revisions_higher_wins(self):
        """Checkpoints with different revisions → higher revision wins."""
        d1 = {
            "version": 1, "day": "2030-01-02", "revision": 3,
            "keys": [{"index": 0, "used": 5, "status": "ok"}],
            "symbols": {},
            "updated_at": "2030-01-02T00:00:05Z",
        }
        mirror = {
            "version": 1, "day": "2030-01-02", "revision": 7,
            "keys": [{"index": 0, "used": 10, "status": "ok"}],
            "symbols": {},
            "updated_at": "2030-01-02T00:00:00Z",
        }
        result = _resolve_checkpoint_payload(d1, mirror)
        self.assertEqual(result, mirror)

    def test_only_d1_exists(self):
        """Only D1 exists → D1."""
        d1 = {
            "version": 1, "day": "2030-01-02",
            "keys": [{"index": 0, "used": 5, "status": "ok"}],
            "symbols": {},
        }
        result = _resolve_checkpoint_payload(d1, None)
        self.assertEqual(result, d1)

    def test_only_mirror_exists(self):
        """Only mirror exists → mirror."""
        mirror = {
            "version": 1, "day": "2030-01-02",
            "keys": [{"index": 0, "used": 5, "status": "ok"}],
            "symbols": {},
        }
        result = _resolve_checkpoint_payload(None, mirror)
        self.assertEqual(result, mirror)

    def test_neither_exists(self):
        """Neither exists → None."""
        result = _resolve_checkpoint_payload(None, None)
        self.assertIsNone(result)

    def test_ambiguous_legacy_raises_before_provider_calls(self):
        """Verify that ambiguous legacy checkpoint raises immediately on load, before any provider work."""
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.meta[META_KEY] = {
                "version": 1, "day": TEST_TODAY,
                "keys": [{"index": 0, "used": 5, "status": "ok"}],
                "symbols": {"NVDA": {"splits": "done"}},
                "updated_at": "2030-01-02T00:00:00Z",
            }
            path = Path(tmp) / "checkpoint.json"
            path.write_text(json.dumps({
                "version": 1, "day": TEST_TODAY,
                "keys": [{"index": 0, "used": 10, "status": "ok"}],
                "symbols": {"AAPL": {"splits": "done"}},
                "updated_at": "2030-01-02T00:00:00Z",
            }))
            store = StateStore(settings_with(), d1, state_path=path)
            with self.assertRaises(AmbiguousLegacyCheckpointError):
                store.load()


if __name__ == "__main__":
    unittest.main()
