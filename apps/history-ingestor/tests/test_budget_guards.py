from __future__ import annotations

import json
import unittest
from types import SimpleNamespace

from history_ingestor.maintenance_state import (
    STATUS_DONE,
    STATUS_PENDING,
    ReconcileStore,
)
from history_ingestor.provider import AlphaVantageClient, QuotaExhaustedError, ThrottleExhaustedError
from history_ingestor.state import BootstrapBudgetLedger, BudgetPersistenceError, Checkpoint, KeyBudgetLedger


class _FakeBootstrapStore:
    def __init__(self) -> None:
        self.key_used = [0, 0]
        self.http_used = 0
        self.save_calls = 0

    def key_remaining(self, index: int) -> int:
        return max(0, 25 - self.key_used[index])

    def mark_key_used(self, index: int, delta: int = 1) -> None:
        self.key_used[index] += delta

    def mark_key_exhausted(self, index: int) -> None:
        self.key_used[index] = 25

    def bootstrap_http_used(self) -> int:
        return self.http_used

    def mark_bootstrap_http_used(self, delta: int = 1) -> None:
        self.http_used += delta

    def save(self) -> bool:
        self.save_calls += 1
        return True


class _InformationResponse:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps({"Information": "rate limited"}).encode("utf-8")


class _QuotaResponse:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps({"Note": "daily limit"}).encode("utf-8")


class _FakeD1:
    def __init__(self) -> None:
        self.meta: dict[str, dict] = {}

    def read_app_meta(self, key: str):
        return self.meta.get(key)

    def write_app_meta(self, key: str, value: dict) -> bool:
        self.meta[key] = value
        return True


class _MirrorOnlyFailureStore(_FakeBootstrapStore):
    last_d1_save_ok = True

    def key_remaining(self, index: int) -> int:
        if index != 0:
            return 0
        return super().key_remaining(index)

    def save(self) -> bool:
        self.save_calls += 1
        return False


class _D1FailureStore(_FakeBootstrapStore):
    last_d1_save_ok = False

    def save(self) -> bool:
        self.save_calls += 1
        return False


class BudgetGuardTests(unittest.TestCase):
    @staticmethod
    def _provider(ledger, urlopen) -> AlphaVantageClient:
        settings = SimpleNamespace(
            alpha_vantage_keys=("key-0", "key-1"),
            av_min_interval_seconds=0.0,
            av_base_url="https://example.invalid/query",
            av_timeout_seconds=1.0,
        )
        return AlphaVantageClient(
            settings,
            ledger,
            now_fn=lambda: 0.0,
            sleep_fn=lambda _seconds: None,
            urlopen=urlopen,
        )

    def test_bootstrap_cap_stops_internal_multi_key_retry_at_real_http_boundary(self) -> None:
        store = _FakeBootstrapStore()
        ledger = BootstrapBudgetLedger(store, daily_limit=1, run_limit=1)
        calls = 0

        def urlopen(_request, _timeout):
            nonlocal calls
            calls += 1
            return _InformationResponse()

        provider = self._provider(ledger, urlopen)

        with self.assertRaises(ThrottleExhaustedError):
            provider.fetch_splits("AAPL")

        self.assertEqual(calls, 1)
        self.assertEqual(provider.requests_this_run, 1)
        self.assertEqual(store.http_used, 1)
        self.assertEqual(ledger.remaining(1), 0)
        self.assertGreaterEqual(store.save_calls, 1)

    def test_reconcile_run_cap_stops_internal_multi_key_retry(self) -> None:
        store = _FakeBootstrapStore()
        ledger = KeyBudgetLedger(store, run_limit=1)
        calls = 0

        def urlopen(_request, _timeout):
            nonlocal calls
            calls += 1
            return _InformationResponse()

        provider = self._provider(ledger, urlopen)

        with self.assertRaises(ThrottleExhaustedError):
            provider.fetch_splits("AAPL")

        # The cap is an actual HTTP-request boundary, not a logical-symbol cap.
        self.assertEqual(calls, 1)
        self.assertEqual(provider.requests_this_run, 1)
        self.assertEqual(sum(store.key_used), 1)
        self.assertEqual(ledger.remaining(1), 0)
        self.assertGreaterEqual(store.save_calls, 1)

    def test_quota_response_survives_mirror_only_checkpoint_failure(self) -> None:
        store = _MirrorOnlyFailureStore()
        provider = self._provider(KeyBudgetLedger(store), lambda _request, _timeout: _QuotaResponse())

        with self.assertRaises(QuotaExhaustedError):
            provider.fetch_splits("AAPL")

        self.assertEqual(provider.requests_this_run, 1)
        self.assertEqual(store.key_used[0], 25)

    def test_quota_ledger_failure_does_not_retry_after_http_debit(self) -> None:
        store = _D1FailureStore()
        calls = 0

        def urlopen(_request, _timeout):
            nonlocal calls
            calls += 1
            return _QuotaResponse()

        provider = self._provider(KeyBudgetLedger(store), urlopen)

        with self.assertRaises(BudgetPersistenceError):
            provider.fetch_splits("AAPL")

        self.assertEqual(calls, 1)
        self.assertEqual(provider.requests_this_run, 1)

    def test_bootstrap_daily_http_counter_survives_new_ledger_instance(self) -> None:
        store = _FakeBootstrapStore()
        first = BootstrapBudgetLedger(store, daily_limit=2, run_limit=2)
        first.mark_used(0)
        first.mark_used(1)

        # Simulates a new systemd process on the same UTC day: local run usage
        # resets, persisted HTTP usage does not.
        second = BootstrapBudgetLedger(store, daily_limit=2, run_limit=2)
        self.assertEqual(second.remaining(0), 0)
        self.assertEqual(second.remaining(1), 0)

    def test_checkpoint_upgrade_seeds_exact_http_counter_conservatively(self) -> None:
        checkpoint = Checkpoint.from_dict({
            "day": "2026-08-25",
            "keys": [],
            "symbols": {},
            "bootstrap_daily_used": 4,
        })
        self.assertEqual(checkpoint.bootstrap_http_used, 4)


class ReconcileStateGuardTests(unittest.TestCase):
    def test_filtered_new_pass_preserves_unrelated_symbol_progress(self) -> None:
        settings = SimpleNamespace(maintenance_state_path=SimpleNamespace())
        d1 = _FakeD1()
        # Avoid using the default path; the store does not touch disk in this test.
        store = ReconcileStore.__new__(ReconcileStore)
        store._settings = settings
        store._d1 = d1
        store._state_path = None
        store._loaded = True
        from history_ingestor.maintenance_state import ReconcileState

        store._state = ReconcileState({
            "AAPL": STATUS_DONE,
            "MSFT": STATUS_DONE,
            "NVDA": STATUS_PENDING,
        })

        store.start_new_pass(["AAPL"])

        self.assertEqual(store.state.status("AAPL"), STATUS_PENDING)
        self.assertEqual(store.state.status("MSFT"), STATUS_DONE)
        self.assertEqual(store.state.status("NVDA"), STATUS_PENDING)
        self.assertEqual(set(store.state.splits), {"AAPL", "MSFT", "NVDA"})


if __name__ == "__main__":
    unittest.main()
