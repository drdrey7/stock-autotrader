"""Crash-safety and automatic recovery tests for split serving state."""

from __future__ import annotations

import datetime as dt
import tempfile
import unittest
from pathlib import Path

from history_ingestor.maintenance import MaintenanceRunner
from history_ingestor.maintenance_state import (
    RECONCILE_D1_META_KEY,
    RECONCILE_STATUS_META_PREFIX,
    SERVING_BLOCKED,
    SERVING_READY,
    MaintenanceStore,
    split_recovery_key,
    split_serving_state_key,
)

try:
    from test_bootstrap import FakeD1, FakeProvider, splits_payload, weekly_payload
except ModuleNotFoundError:  # imported as tests.test_split_recovery
    from tests.test_bootstrap import FakeD1, FakeProvider, splits_payload, weekly_payload  # type: ignore[no-redef]


NOW = dt.datetime(2026, 8, 18, 12, 0, tzinfo=dt.UTC)
SUNDAY = dt.datetime(2026, 8, 23, 15, 0, tzinfo=dt.UTC)
MONDAY = dt.datetime(2026, 8, 24, 6, 0, tzinfo=dt.UTC)


def settings_with(**overrides):
    from history_ingestor.config import Settings

    values = {
        "alpha_vantage_keys": ["K1", "K2"],
        "cloudflare_api_token": "t",
        "cloudflare_account_id": "a",
        "cloudflare_d1_database_id": "d",
        "av_min_interval_seconds": 0.0,
        "av_max_retries": 1,
        "av_retry_base_seconds": 0.0,
        "split_recovery_max_requests": 2,
    }
    values.update(overrides)
    return Settings(**values)


def make_runner(d1, provider, tmp, now=NOW, **settings_overrides):
    settings = settings_with(**settings_overrides)
    store = MaintenanceStore(settings, d1, state_path=Path(tmp) / "maintenance.json")
    return MaintenanceRunner(settings, d1, provider, store, now_fn=lambda: now)


def seed_weekly_row(d1, *, date="2024-06-03", raw=1_200, factor=1.0, adjusted=None):
    factor = float(factor)
    d1.upsert_weekly_rows([(
        "NVDA", date, raw - 10, raw + 20, raw - 20, raw, 1000,
        factor, raw / factor if adjusted is None else adjusted,
        "2026-08-16T00:00:00Z",
    )])


def seed_recovery_request(d1, symbol="NVDA", reason="unexpected_scale_mismatch", at=NOW):
    observed = at.astimezone(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    d1.write_app_meta(split_serving_state_key(symbol), {
        "version": 1, "symbol": symbol, "state": SERVING_BLOCKED, "reason": reason,
        "updated_at": observed,
    })
    d1.write_app_meta(split_recovery_key(symbol), {
        "version": 1, "symbol": symbol, "status": "pending", "reason": reason,
        "attempts": 0, "next_attempt_at": observed, "updated_at": observed,
    })


class SplitMutationCrashSafetyTests(unittest.TestCase):
    def _reconcile_change(self, d1, tmp, **d1_options):
        seed_weekly_row(d1)
        for key, value in d1_options.items():
            setattr(d1, key, value)
        provider = FakeProvider(
            weekly_payloads={"NVDA": weekly_payload("NVDA")},
            splits_payloads={"NVDA": splits_payload("NVDA")},
        )
        return make_runner(d1, provider, tmp).reconcile_splits(symbols_filter=["NVDA"])

    def _assert_blocked_and_queued(self, d1):
        self.assertEqual(d1.meta[split_serving_state_key("NVDA")]["state"], SERVING_BLOCKED)
        self.assertEqual(d1.meta[split_recovery_key("NVDA")]["status"], "pending")

    def test_blocked_is_durable_before_split_events_mutation(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            report = self._reconcile_change(d1, tmp)
            self.assertEqual(report["status"], "complete")
            serving_index = d1.operations.index(("meta", split_serving_state_key("NVDA")))
            split_index = d1.operations.index(("split_events", "NVDA"))
            self.assertLess(serving_index, split_index)
            self.assertEqual(d1.meta[split_serving_state_key("NVDA")]["state"], SERVING_READY)
            self.assertNotIn(split_recovery_key("NVDA"), d1.meta)

    def test_split_events_write_failure_leaves_blocked_and_does_not_publish_ready(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            report = self._reconcile_change(d1, tmp, split_write_fail=True)
            self.assertEqual(report["status"], "partial")
            self._assert_blocked_and_queued(d1)
            self.assertEqual(d1.read_split_events("NVDA"), [])

    def test_split_events_delete_failure_leaves_blocked_after_upsert(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            report = self._reconcile_change(d1, tmp, split_delete_fail=True)
            self.assertEqual(report["status"], "partial")
            self._assert_blocked_and_queued(d1)
            self.assertEqual(d1.read_split_events("NVDA")[0]["split_factor"], 10.0)
            self.assertEqual(d1.weekly["NVDA"][0][7], 1.0)

    def test_weekly_rewrite_failure_leaves_blocked_after_events_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            report = self._reconcile_change(d1, tmp, weekly_write_fail=True)
            self.assertEqual(report["status"], "partial")
            self._assert_blocked_and_queued(d1)
            self.assertEqual(d1.read_split_events("NVDA")[0]["split_factor"], 10.0)
            self.assertEqual(d1.weekly["NVDA"][0][7], 1.0)

    def test_metrics_failure_leaves_rewritten_history_blocked(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            report = self._reconcile_change(d1, tmp, metrics_write_fail=True)
            self.assertEqual(report["status"], "partial")
            self._assert_blocked_and_queued(d1)
            self.assertEqual(d1.weekly["NVDA"][0][7], 10.0)
            self.assertEqual(d1.weekly["NVDA"][0][8], 120.0)

    def test_ready_publication_failure_leaves_blocked_after_all_data_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.serving_state_write_fail_states.add(SERVING_READY)
            report = self._reconcile_change(d1, tmp)
            self.assertEqual(report["status"], "partial")
            self._assert_blocked_and_queued(d1)
            self.assertEqual(d1.weekly["NVDA"][0][7], 10.0)
            self.assertEqual(d1.weekly["NVDA"][0][8], 120.0)

    def test_checkpoint_failure_cannot_report_complete_after_ready(self):
        class FailDoneCheckpointD1(FakeD1):
            def write_app_meta(self, key, value):
                if (
                    key == RECONCILE_D1_META_KEY
                    and isinstance(value, dict)
                    and isinstance(value.get("splits"), dict)
                    and value["splits"].get("NVDA") == "done"
                    and self.meta.get(split_serving_state_key("NVDA"), {}).get("state") == SERVING_READY
                ):
                    return False
                return super().write_app_meta(key, value)

        with tempfile.TemporaryDirectory() as tmp:
            d1 = FailDoneCheckpointD1()
            report = self._reconcile_change(d1, tmp)
            self.assertNotEqual(report["status"], "complete")
            self.assertTrue(any("completion write" in item for item in report["anomalies"]))
            self.assertEqual(d1.meta[split_serving_state_key("NVDA")]["state"], SERVING_READY)

    def test_last_split_removal_rewrites_factor_one_before_ready(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.upsert_split_events([("NVDA", "2024-06-10", 10.0, "2026-08-16T00:00:00Z")])
            seed_weekly_row(d1, factor=10.0, adjusted=120.0)
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": {"symbol": "NVDA", "data": []}},
            )
            report = make_runner(d1, provider, tmp).reconcile_splits(symbols_filter=["NVDA"])
            self.assertEqual(report["status"], "complete")
            self.assertEqual(d1.read_split_events("NVDA"), [])
            self.assertEqual(d1.weekly["NVDA"][0][7], 1.0)
            self.assertEqual(d1.weekly["NVDA"][0][8], 1_200.0)
            self.assertEqual(d1.meta[split_serving_state_key("NVDA")]["state"], SERVING_READY)

    def test_second_split_multiplies_existing_factor(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.upsert_split_events([("NVDA", "2024-06-10", 10.0, "2026-08-16T00:00:00Z")])
            seed_weekly_row(d1, factor=10.0, adjusted=120.0)
            first_provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner = make_runner(d1, first_provider, tmp)
            runner.reconcile_splits(symbols_filter=["NVDA"])
            second_provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": {"symbol": "NVDA", "data": [
                    {"effective_date": "2024-06-10", "split_factor": "10"},
                    {"effective_date": "2026-08-17", "split_factor": "4"},
                ]}},
            )
            report = make_runner(d1, second_provider, tmp).reconcile_splits(symbols_filter=["NVDA"])
            self.assertEqual(report["status"], "complete")
            self.assertEqual(d1.weekly["NVDA"][0][7], 40.0)
            self.assertEqual(d1.weekly["NVDA"][0][8], 30.0)
            self.assertEqual(d1.meta[split_serving_state_key("NVDA")]["state"], SERVING_READY)


class SplitRecoveryQueueTests(unittest.TestCase):
    def test_empty_queue_makes_zero_provider_requests(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider()
            report = make_runner(d1, provider, tmp).recover_split_mismatches()
            self.assertEqual(report["status"], "noop")
            self.assertEqual(provider.splits_calls, [])
            self.assertEqual(provider.requests_this_run, 0)

    def test_only_pending_symbol_is_queried_and_other_symbols_continue(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            seed_recovery_request(d1, "NVDA")
            seed_weekly_row(d1)
            provider = FakeProvider(
                splits_payloads={"NVDA": splits_payload("NVDA")},
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
            )
            report = make_runner(d1, provider, tmp).recover_split_mismatches(
                symbols_filter=["NVDA", "AAPL"],
            )
            self.assertEqual(provider.splits_calls, ["NVDA"])
            self.assertEqual(report["recovered"], 1)
            self.assertEqual(d1.meta[split_serving_state_key("NVDA")]["state"], SERVING_READY)
            self.assertNotIn(split_recovery_key("NVDA"), d1.meta)
            self.assertNotIn(split_serving_state_key("AAPL"), d1.meta)

    def test_provider_without_new_split_keeps_symbol_blocked_and_retries(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            seed_recovery_request(d1)
            seed_weekly_row(d1)
            provider = FakeProvider(
                splits_payloads={"NVDA": {"symbol": "NVDA", "data": []}},
            )
            report = make_runner(d1, provider, tmp).recover_split_mismatches()
            self.assertEqual(report["symbols"]["NVDA"]["status"], "pending")
            self.assertEqual(d1.meta[split_serving_state_key("NVDA")]["state"], SERVING_BLOCKED)
            self.assertEqual(d1.meta[split_recovery_key("NVDA")]["status"], "retry")
            self.assertEqual(d1.meta[split_recovery_key("NVDA")]["attempts"], 1)
            self.assertEqual(d1.read_split_events("NVDA"), [])

    def test_malformed_json_object_is_normalized_to_pending_recovery_work(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            seed_weekly_row(d1)
            d1.write_app_meta(split_serving_state_key("NVDA"), {
                "version": 1, "symbol": "NVDA", "state": SERVING_BLOCKED,
                "reason": "unexpected_scale_mismatch",
            })
            # Valid JSON is not enough: the missing status must not make this
            # durable request silently disappear from the recovery scan.
            d1.meta[split_recovery_key("NVDA")] = {"symbol": "NVDA"}
            provider = FakeProvider(
                splits_payloads={"NVDA": {"symbol": "NVDA", "data": []}},
            )

            report = make_runner(d1, provider, tmp).recover_split_mismatches()

            self.assertEqual(provider.splits_calls, ["NVDA"])
            self.assertEqual(report["symbols"]["NVDA"]["status"], "pending")
            self.assertEqual(d1.meta[split_recovery_key("NVDA")]["status"], "retry")

    def test_pending_symbol_marker_cannot_be_overridden_by_legacy_done_checkpoint(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.meta[RECONCILE_D1_META_KEY] = {
                "version": 1, "splits": {"NVDA": "done"},
            }
            d1.meta[f"{RECONCILE_STATUS_META_PREFIX}NVDA"] = {
                "version": 1, "symbol": "NVDA", "status": "pending",
            }

            runner = make_runner(d1, FakeProvider(), tmp)

            self.assertEqual(runner._backfill_legacy_serving_states(["NVDA"]), 0)
            self.assertNotIn(split_serving_state_key("NVDA"), d1.meta)

    def test_quote_scale_block_is_not_cleared_by_verified_history_rewrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            seed_recovery_request(d1, reason="quote_history_scale_mismatch")
            d1.upsert_split_events([("NVDA", "2024-06-10", 10.0, "2026-08-16T00:00:00Z")])
            seed_weekly_row(d1, factor=10.0, adjusted=120.0)
            provider = FakeProvider(splits_payloads={"NVDA": splits_payload("NVDA")})

            report = make_runner(d1, provider, tmp).recover_split_mismatches()

            self.assertEqual(report["symbols"]["NVDA"]["status"], "pending")
            self.assertEqual(d1.meta[split_serving_state_key("NVDA")]["state"], SERVING_BLOCKED)
            self.assertEqual(d1.meta[split_recovery_key("NVDA")]["status"], "retry")
            self.assertEqual(d1.read_split_events("NVDA")[0]["split_factor"], 10.0)

    def test_retry_after_restart_recovers_when_provider_publishes_split(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            seed_recovery_request(d1)
            seed_weekly_row(d1)
            old_provider = FakeProvider(
                splits_payloads={"NVDA": {"symbol": "NVDA", "data": []}},
            )
            first = make_runner(d1, old_provider, tmp).recover_split_mismatches()
            self.assertEqual(first["symbols"]["NVDA"]["status"], "pending")

            new_provider = FakeProvider(
                splits_payloads={"NVDA": splits_payload("NVDA")},
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
            )
            second = make_runner(d1, new_provider, tmp, now=NOW + dt.timedelta(hours=2)).recover_split_mismatches()
            self.assertEqual(second["status"], "complete")
            self.assertEqual(d1.meta[split_serving_state_key("NVDA")]["state"], SERVING_READY)
            self.assertNotIn(split_recovery_key("NVDA"), d1.meta)
            self.assertEqual(d1.weekly["NVDA"][0][7], 10.0)

    def test_recovered_queue_is_idempotent_and_does_not_corrupt_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            seed_recovery_request(d1)
            seed_weekly_row(d1)
            provider = FakeProvider(
                splits_payloads={"NVDA": splits_payload("NVDA")},
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
            )
            first = make_runner(d1, provider, tmp).recover_split_mismatches()
            self.assertEqual(first["status"], "complete")
            row_after = tuple(d1.weekly["NVDA"][0])
            second_provider = FakeProvider()
            second = make_runner(d1, second_provider, tmp).recover_split_mismatches()
            self.assertEqual(second["status"], "noop")
            self.assertEqual(second_provider.requests_this_run, 0)
            self.assertEqual(tuple(d1.weekly["NVDA"][0]), row_after)

    def test_recovery_retries_after_split_events_are_durable_but_history_write_failed(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            seed_recovery_request(d1)
            seed_weekly_row(d1)
            d1.weekly_write_fail = True
            provider = FakeProvider(
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            first = make_runner(d1, provider, tmp).recover_split_mismatches()
            self.assertEqual(first["symbols"]["NVDA"]["status"], "retry")
            self.assertEqual(d1.read_split_events("NVDA")[0]["split_factor"], 10.0)
            self.assertEqual(d1.meta[split_serving_state_key("NVDA")]["state"], SERVING_BLOCKED)

            d1.weekly_write_fail = False
            retry_provider = FakeProvider(
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            second = make_runner(
                d1,
                retry_provider,
                tmp,
                now=NOW + dt.timedelta(hours=2),
            ).recover_split_mismatches()
            self.assertEqual(second["status"], "complete")
            self.assertEqual(d1.weekly["NVDA"][0][7], 10.0)
            self.assertEqual(d1.weekly["NVDA"][0][8], 120.0)
            self.assertEqual(d1.meta[split_serving_state_key("NVDA")]["state"], SERVING_READY)
            self.assertNotIn(split_recovery_key("NVDA"), d1.meta)

    def test_legacy_completed_checkpoint_backfills_serving_state_without_provider(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.meta["historyReconcileSplitState"] = {
                "version": 1, "splits": {"NVDA": "done"},
            }
            runner = make_runner(d1, FakeProvider(), tmp)
            self.assertEqual(runner._backfill_legacy_serving_states(["NVDA"]), 1)
            self.assertEqual(d1.meta[split_serving_state_key("NVDA")]["state"], SERVING_READY)

    def test_legacy_done_checkpoint_does_not_publish_ready_for_mixed_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.meta["historyReconcileSplitState"] = {
                "version": 1, "splits": {"NVDA": "done"},
            }
            d1.upsert_split_events([("NVDA", "2024-06-10", 10.0, "2026-08-16T00:00:00Z")])
            seed_weekly_row(d1, raw=1_200, factor=1.0, adjusted=1_200)
            runner = make_runner(d1, FakeProvider(), tmp)
            self.assertEqual(runner._backfill_legacy_serving_states(["NVDA"]), 0)
            self.assertEqual(d1.meta[split_serving_state_key("NVDA")]["state"], SERVING_BLOCKED)
            self.assertEqual(d1.meta[split_recovery_key("NVDA")]["status"], "pending")
            self.assertNotIn(f"{RECONCILE_STATUS_META_PREFIX}NVDA", d1.meta)

    def test_legacy_done_checkpoint_fails_closed_for_factor_one_mixed_raw_regime(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.meta["historyReconcileSplitState"] = {
                "version": 1, "splits": {"NVDA": "done"},
            }
            d1.upsert_weekly_rows([
                (
                    "NVDA", "2024-06-07", 1_190, 1_220, 1_180, 1_200, 1_000,
                    1.0, 1_200.0, "2026-08-16T00:00:00Z",
                ),
                (
                    "NVDA", "2024-06-14", 1_170, 1_210, 1_150, 1_180, 1_000,
                    1.0, 1_180.0, "2026-08-16T00:00:00Z",
                ),
                (
                    "NVDA", "2024-06-21", 117, 121, 115, 118, 1_000,
                    1.0, 118.0, "2026-08-16T00:00:00Z",
                ),
                (
                    "NVDA", "2024-06-28", 119, 122, 118, 120, 1_000,
                    1.0, 120.0, "2026-08-16T00:00:00Z",
                ),
            ])
            runner = make_runner(d1, FakeProvider(), tmp)
            self.assertEqual(runner._backfill_legacy_serving_states(["NVDA"]), 0)
            self.assertEqual(d1.meta[split_serving_state_key("NVDA")]["state"], SERVING_BLOCKED)
            self.assertEqual(d1.meta[split_recovery_key("NVDA")]["status"], "pending")


class FutureSplitOrderingTests(unittest.TestCase):
    def test_sunday_discovery_then_monday_zero_provider_apply(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            seed_weekly_row(d1, date="2026-08-21", raw=1_200)
            sunday_provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": {"symbol": "NVDA", "data": [
                    {"effective_date": "2026-08-24", "split_factor": "4"},
                ]}},
            )
            sunday = make_runner(d1, sunday_provider, tmp, now=SUNDAY)
            sunday_report = sunday.reconcile_splits(symbols_filter=["NVDA"])
            self.assertEqual(sunday_report["status"], "complete")
            self.assertEqual(sunday_provider.splits_calls, ["NVDA"])
            self.assertEqual(d1.weekly["NVDA"][0][7], 1.0)

            monday_provider = FakeProvider()
            monday = make_runner(d1, monday_provider, tmp, now=MONDAY)
            monday_report = monday.apply_due_splits(symbols_filter=["NVDA"])
            self.assertEqual(monday_report["status"], "applied")
            self.assertEqual(monday_provider.requests_this_run, 0)
            self.assertEqual(d1.weekly["NVDA"][0][7], 4.0)
            self.assertEqual(d1.weekly["NVDA"][0][8], 300.0)
            self.assertEqual(d1.meta[split_serving_state_key("NVDA")]["state"], SERVING_READY)


if __name__ == "__main__":
    unittest.main()
