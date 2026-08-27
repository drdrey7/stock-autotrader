"""Crash/restart persistence tests for close-window rollover candidates."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from quote_ingestor.config import from_env
from quote_ingestor.durable_state import CloseCandidateCheckpoint
from quote_ingestor.types import TradeTick

SYMBOLS = ["AAPL", "MSFT"]
NORMAL_CLOSE_FIRST_MS = 1_787_086_500_000  # 2026-08-18T19:55:00Z
NORMAL_CLOSE_LATEST_MS = 1_787_086_799_000  # 2026-08-18T19:59:59Z
OUTSIDE_CLOSE_MS = 1_787_068_800_000  # 2026-08-18T15:00:00Z


class CloseCandidateCheckpointTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.path = Path(self.tempdir.name) / "pending-close-candidates.json"

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def test_first_candidate_is_durable_before_flush_and_survives_restart(self) -> None:
        checkpoint = CloseCandidateCheckpoint(self.path, SYMBOLS)
        tick = TradeTick("AAPL", 100.0, NORMAL_CLOSE_FIRST_MS)

        self.assertTrue(checkpoint.ensure_candidate(tick))
        self.assertTrue(self.path.exists())
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

        restarted = CloseCandidateCheckpoint(self.path, SYMBOLS)
        self.assertEqual(restarted.restore(), [tick])

    def test_same_session_intake_is_coalesced_then_flush_refreshes_latest(self) -> None:
        checkpoint = CloseCandidateCheckpoint(self.path, SYMBOLS)
        first = TradeTick("AAPL", 100.0, NORMAL_CLOSE_FIRST_MS)
        latest = TradeTick("AAPL", 101.0, NORMAL_CLOSE_LATEST_MS)

        self.assertTrue(checkpoint.ensure_candidate(first))
        self.assertFalse(checkpoint.ensure_candidate(latest))
        self.assertEqual(checkpoint.restore(), [first])

        self.assertTrue(checkpoint.record_candidates([latest]))
        self.assertEqual(checkpoint.restore(), [latest])

    def test_ack_removes_only_after_equal_or_newer_durable_timestamp(self) -> None:
        checkpoint = CloseCandidateCheckpoint(self.path, SYMBOLS)
        tick = TradeTick("AAPL", 100.0, NORMAL_CLOSE_LATEST_MS)
        checkpoint.ensure_candidate(tick)

        self.assertFalse(checkpoint.ack_written({"AAPL": tick.timestamp_ms - 1}))
        self.assertEqual(checkpoint.restore(), [tick])
        self.assertTrue(checkpoint.ack_written({"AAPL": tick.timestamp_ms}))
        self.assertEqual(checkpoint.restore(), [])

        restarted = CloseCandidateCheckpoint(self.path, SYMBOLS)
        self.assertEqual(restarted.restore(), [])

    def test_outside_window_and_unknown_symbols_never_persist(self) -> None:
        checkpoint = CloseCandidateCheckpoint(self.path, SYMBOLS)
        self.assertFalse(checkpoint.ensure_candidate(TradeTick("AAPL", 100.0, OUTSIDE_CLOSE_MS)))
        self.assertFalse(checkpoint.ensure_candidate(TradeTick("ZZZZ", 100.0, NORMAL_CLOSE_LATEST_MS)))
        self.assertEqual(checkpoint.restore(), [])
        self.assertFalse(self.path.exists())

    def test_malformed_checkpoint_fails_closed_without_crashing_startup(self) -> None:
        self.path.write_text("{broken-json", encoding="utf-8")
        checkpoint = CloseCandidateCheckpoint(self.path, SYMBOLS)
        self.assertEqual(checkpoint.restore(), [])

    def test_invalid_payload_rows_are_ignored(self) -> None:
        self.path.write_text(json.dumps({
            "version": 1,
            "candidates": {
                "AAPL": {"price": True, "timestamp_ms": NORMAL_CLOSE_LATEST_MS},
                "MSFT": {"price": 50.0, "timestamp_ms": "not-an-int"},
            },
        }), encoding="utf-8")
        checkpoint = CloseCandidateCheckpoint(self.path, SYMBOLS)
        self.assertEqual(checkpoint.restore(), [])


class DurableStateConfigTest(unittest.TestCase):
    def _env(self, **extra: str) -> dict[str, str]:
        env = {
            "FINNHUB_API_KEY": "k",
            "CLOUDFLARE_API_TOKEN": "t",
            "CLOUDFLARE_ACCOUNT_ID": "a",
            "CLOUDFLARE_D1_DATABASE_ID": "d",
        }
        env.update(extra)
        return env

    def test_systemd_state_directory_is_canonical_default(self) -> None:
        settings = from_env(self._env(STATE_DIRECTORY="/var/lib/stock-autotrader-finnhub-ws"))
        self.assertEqual(
            settings.close_candidate_state_path,
            Path("/var/lib/stock-autotrader-finnhub-ws/pending-close-candidates.json"),
        )

    def test_explicit_state_path_override_supports_local_validation(self) -> None:
        settings = from_env(self._env(
            STATE_DIRECTORY="/var/lib/ignored",
            QUOTE_INGESTOR_STATE_PATH="/tmp/quote-test-state.json",
        ))
        self.assertEqual(settings.close_candidate_state_path, Path("/tmp/quote-test-state.json"))


class SystemdStateContractTest(unittest.TestCase):
    def test_unit_provisions_only_required_persistent_writable_state(self) -> None:
        unit_path = Path(__file__).resolve().parents[1] / "deploy" / "stock-autotrader-finnhub-ws.service"
        unit = unit_path.read_text(encoding="utf-8")
        self.assertIn("StateDirectory=stock-autotrader-finnhub-ws", unit)
        self.assertIn("StateDirectoryMode=0750", unit)
        self.assertIn("UMask=0077", unit)
        self.assertIn("ProtectSystem=full", unit)
        self.assertIn("ProtectHome=read-only", unit)
        self.assertNotIn("ReadWritePaths=/home", unit)


if __name__ == "__main__":
    unittest.main()
