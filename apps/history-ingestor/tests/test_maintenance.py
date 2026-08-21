"""Tests for cycle-based weekly maintenance (history ingestor)."""

from __future__ import annotations

import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path

from history_ingestor.config import Settings
from history_ingestor.maintenance import MaintenanceRunner
from history_ingestor.maintenance_state import MaintenanceStore, _resolve_checkpoint_payload
from history_ingestor.state import AmbiguousLegacyCheckpointError

try:
    from test_bootstrap import FakeD1, FakeProvider, future_splits_payload, splits_payload, weekly_payload
except ModuleNotFoundError:  # imported as tests.test_maintenance (module path mode)
    from tests.test_bootstrap import FakeD1, FakeProvider, future_splits_payload, splits_payload, weekly_payload  # type: ignore[no-redef]


def settings_with(keys=("K1", "K2")):
    return Settings(
        alpha_vantage_keys=list(keys),
        cloudflare_api_token="t", cloudflare_account_id="a", cloudflare_d1_database_id="d",
        av_min_interval_seconds=0.0, av_max_retries=1, av_retry_base_seconds=0.0,
    )


def make_runner(d1, provider, tmp, now):
    settings = settings_with()
    store = MaintenanceStore(settings, d1, state_path=Path(tmp) / "maintenance.json")
    return MaintenanceRunner(settings, d1, provider, store, now_fn=lambda: now), store


class MaintenanceStoreTests(unittest.TestCase):
    def test_newer_local_mirror_beats_stale_d1_checkpoint(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.meta["historyMaintenanceState"] = {
                "version": 1, "cycle_week": "2026-W33",
                "updated_at": "2030-01-02T00:00:01Z",
                "symbols": {"NVDA": {"splits": "pending", "weekly": "pending", "metrics": "pending"}},
            }
            path = Path(tmp) / "maintenance.json"
            path.write_text(json.dumps({
                "version": 1, "cycle_week": "2026-W33",
                "updated_at": "2030-01-02T00:00:02Z",
                "symbols": {"NVDA": {"splits": "done", "weekly": "done", "metrics": "done"}},
            }))
            store = MaintenanceStore(settings_with(), d1, state_path=path)
            store.load()
            self.assertEqual(store.state.symbol_status("NVDA", "metrics"), "done")

    def test_equal_timestamp_different_payloads_mirror_wins_with_revision(self):
        """Non-legacy maintenance checkpoints (revision>0) with equal timestamps → mirror wins."""
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            timestamp = "2030-01-02T00:00:01Z"
            d1.meta["historyMaintenanceState"] = {
                "version": 1, "cycle_week": "2026-W33", "revision": 5, "updated_at": timestamp,
                "symbols": {"NVDA": {"splits": "pending", "weekly": "pending", "metrics": "pending"}},
            }
            path = Path(tmp) / "maintenance.json"
            path.write_text(json.dumps({
                "version": 1, "cycle_week": "2026-W33", "revision": 5, "updated_at": timestamp,
                "symbols": {"NVDA": {"splits": "done", "weekly": "done", "metrics": "done"}},
            }))
            store = MaintenanceStore(settings_with(), d1, state_path=path)
            store.load()
            self.assertEqual(store.state.symbol_status("NVDA", "metrics"), "done")

    def test_equal_timestamp_different_payloads_fails_closed_for_legacy(self):
        """Legacy maintenance checkpoints (revision=0) with equal timestamps but different payloads → fail closed."""
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            timestamp = "2030-01-02T00:00:01Z"
            d1.meta["historyMaintenanceState"] = {
                "version": 1, "cycle_week": "2026-W33", "updated_at": timestamp,
                "symbols": {"NVDA": {"splits": "pending", "weekly": "pending", "metrics": "pending"}},
            }
            path = Path(tmp) / "maintenance.json"
            path.write_text(json.dumps({
                "version": 1, "cycle_week": "2026-W33", "updated_at": timestamp,
                "symbols": {"NVDA": {"splits": "done", "weekly": "done", "metrics": "done"}},
            }))
            store = MaintenanceStore(settings_with(), d1, state_path=path)
            with self.assertRaises(AmbiguousLegacyCheckpointError):
                store.load()

    def test_higher_revision_wins_over_stale_d1(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.meta["historyMaintenanceState"] = {
                "version": 1, "cycle_week": "2026-W33", "revision": 10,
                "updated_at": "2030-01-02T00:00:02Z",
                "symbols": {"NVDA": {"splits": "pending", "weekly": "pending", "metrics": "pending"}},
            }
            path = Path(tmp) / "maintenance.json"
            path.write_text(json.dumps({
                "version": 1, "cycle_week": "2026-W33", "revision": 11,
                "updated_at": "2030-01-02T00:00:01Z",
                "symbols": {"NVDA": {"splits": "done", "weekly": "done", "metrics": "done"}},
            }))
            store = MaintenanceStore(settings_with(), d1, state_path=path)
            store.load()
            self.assertEqual(store.state.symbol_status("NVDA", "metrics"), "done")

    def test_equal_revision_prefers_newer_timestamp(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.meta["historyMaintenanceState"] = {
                "version": 1, "cycle_week": "2026-W33", "revision": 5,
                "updated_at": "2030-01-02T00:00:02Z",
                "symbols": {"NVDA": {"splits": "pending", "weekly": "pending", "metrics": "pending"}},
            }
            path = Path(tmp) / "maintenance.json"
            path.write_text(json.dumps({
                "version": 1, "cycle_week": "2026-W33", "revision": 5,
                "updated_at": "2030-01-02T00:00:01Z",
                "symbols": {"NVDA": {"splits": "done", "weekly": "done", "metrics": "done"}},
            }))
            store = MaintenanceStore(settings_with(), d1, state_path=path)
            store.load()
            self.assertEqual(store.state.symbol_status("NVDA", "splits"), "pending")

    def test_legacy_checkpoint_without_revision_loads(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.meta["historyMaintenanceState"] = {
                "version": 1, "cycle_week": "2026-W33",
                "updated_at": "",
                "symbols": {"NVDA": {"splits": "done", "weekly": "done", "metrics": "done"}},
            }
            path = Path(tmp) / "maintenance.json"
            store = MaintenanceStore(settings_with(), d1, state_path=path)
            store.load()
            self.assertEqual(store.state.symbol_status("NVDA", "metrics"), "done")

    def test_save_increments_revision(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            store = MaintenanceStore(settings_with(), d1, state_path=Path(tmp) / "maintenance.json")
            store.load()
            self.assertEqual(store.state.revision, 0)
            store.state.mark_symbol("NVDA", "splits", "done")
            store.save()
            self.assertEqual(store.state.revision, 1)
            store.state.mark_symbol("NVDA", "weekly", "done")
            store.save()
            self.assertEqual(store.state.revision, 2)

    def test_save_persists_new_revision_to_both_copies(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            store = MaintenanceStore(settings_with(), d1, state_path=Path(tmp) / "maintenance.json")
            store.load()
            store.state.mark_symbol("NVDA", "splits", "done")
            store.save()
            self.assertEqual(store.state.revision, 1)
            self.assertEqual(d1.meta["historyMaintenanceState"]["revision"], 1)
            with open(Path(tmp) / "maintenance.json") as f:
                import json
                mirror = json.load(f)
            self.assertEqual(mirror["revision"], 1)


class LegacyMaintenanceCheckpointTests(unittest.TestCase):
    """Tests for fail-closed behavior with ambiguous legacy maintenance checkpoints."""

    def test_legacy_identical_payloads_load_normally(self):
        """Legacy maintenance checkpoints (revision=0) with same timestamp and same payloads → load normally."""
        d1 = {
            "version": 1, "cycle_week": "2026-W33",
            "symbols": {"NVDA": {"splits": "done", "weekly": "done", "metrics": "done"}},
            "updated_at": "2030-01-02T00:00:00Z",
        }
        mirror = dict(d1)
        result = _resolve_checkpoint_payload(d1, mirror)
        self.assertEqual(result, d1)

    def test_legacy_different_timestamps_newer_wins(self):
        """Legacy maintenance checkpoints with different timestamps → newer timestamp wins."""
        d1 = {
            "version": 1, "cycle_week": "2026-W33",
            "symbols": {"NVDA": {"splits": "pending", "weekly": "pending", "metrics": "pending"}},
            "updated_at": "2030-01-02T00:00:00Z",
        }
        mirror = {
            "version": 1, "cycle_week": "2026-W33",
            "symbols": {"NVDA": {"splits": "done", "weekly": "done", "metrics": "done"}},
            "updated_at": "2030-01-02T00:00:01Z",
        }
        result = _resolve_checkpoint_payload(d1, mirror)
        self.assertEqual(result, mirror)

    def test_legacy_same_timestamp_different_payloads_fails_closed(self):
        """Legacy maintenance checkpoints (revision=0) with same timestamp but different payloads → fail closed."""
        d1 = {
            "version": 1, "cycle_week": "2026-W33",
            "symbols": {"NVDA": {"splits": "done", "weekly": "pending", "metrics": "pending"}},
            "updated_at": "2030-01-02T00:00:00Z",
        }
        mirror = {
            "version": 1, "cycle_week": "2026-W33",
            "symbols": {"NVDA": {"splits": "pending", "weekly": "done", "metrics": "done"}},
            "updated_at": "2030-01-02T00:00:00Z",
        }
        with self.assertRaises(AmbiguousLegacyCheckpointError) as ctx:
            _resolve_checkpoint_payload(d1, mirror)
        self.assertIn("Ambiguous legacy checkpoint", str(ctx.exception))

    def test_ambiguous_legacy_maintenance_raises_before_provider_calls(self):
        """Verify that ambiguous legacy maintenance checkpoint raises immediately on load."""
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.meta["historyMaintenanceState"] = {
                "version": 1, "cycle_week": "2026-W33",
                "symbols": {"NVDA": {"splits": "done", "weekly": "pending", "metrics": "pending"}},
                "updated_at": "2030-01-02T00:00:00Z",
            }
            path = Path(tmp) / "maintenance.json"
            path.write_text(json.dumps({
                "version": 1, "cycle_week": "2026-W33",
                "symbols": {"NVDA": {"splits": "pending", "weekly": "done", "metrics": "done"}},
                "updated_at": "2030-01-02T00:00:00Z",
            }))
            store = MaintenanceStore(settings_with(), d1, state_path=path)
            with self.assertRaises(AmbiguousLegacyCheckpointError):
                store.load()


# --- cycle calendars ---------------------------------------------------------
MON_1 = dt.datetime(2026, 8, 17, 5, 10, tzinfo=dt.UTC)   # NY Monday, cycle W33
SUN_1 = dt.datetime(2026, 8, 16, 5, 10, tzinfo=dt.UTC)   # NY Sunday, cycle W33
MON_2 = dt.datetime(2026, 8, 24, 5, 10, tzinfo=dt.UTC)   # NY Monday, cycle W34
WED_1 = dt.datetime(2026, 8, 19, 12, 0, tzinfo=dt.UTC)   # NY Wednesday, cycle W33


class MaintenanceCycleTests(unittest.TestCase):
    def test_first_run_ingests_whole_cycle_monday(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner, store = make_runner(d1, provider, tmp, MON_1)
            report = runner.run(universe=["NVDA"])
            self.assertEqual(report["status"], "complete")
            self.assertEqual(report["cycle_week"], "2026-W33")
            self.assertEqual(report["phase"], "complete")
            # split_events durable, weekly factors correct, metrics present.
            self.assertEqual(len(d1.read_split_events("NVDA")), 1)
            rows = d1.weekly["NVDA"]
            self.assertEqual(len(rows), 260)
            self.assertTrue(any(r[7] == 10.0 for r in rows))
            self.assertIn("NVDA", d1.metrics)
            # splits fetched once, weekly fetched once (Monday).
            self.assertEqual(provider.splits_calls, ["NVDA"])
            self.assertEqual(provider.weekly_calls, ["NVDA"])

    def test_complete_cycle_second_run_makes_zero_provider_calls(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner, _ = make_runner(d1, provider, tmp, MON_1)
            first = runner.run(universe=["NVDA"])
            self.assertEqual(first["status"], "complete")
            used = provider.requests_this_run
            runner2, _ = make_runner(d1, provider, tmp, MON_1)
            report = runner2.run(universe=["NVDA"])
            self.assertEqual(report["status"], "noop_complete")
            self.assertEqual(provider.requests_this_run, used)  # ZERO new requests
            self.assertEqual(report["rows_updated"], 0)

    def test_sunday_runs_splits_but_never_fetches_weekly(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner, store = make_runner(d1, provider, tmp, SUN_1)
            report = runner.run(universe=["NVDA"])
            self.assertEqual(report["status"], "partial")  # weekly still pending
            self.assertEqual(provider.splits_calls, ["NVDA"])
            self.assertEqual(provider.weekly_calls, [])  # never fetched on Sunday
            self.assertTrue(any("Monday" in a for a in report["anomalies"]))
            # The week is not storable Sunday; no weekly rows were written.
            self.assertNotIn("NVDA", d1.weekly)
            self.assertEqual(store.state.symbol_status("NVDA", "splits"), "done")

            # Monday resumes SPLITS (already done) and finishes WEEKLY.
            provider2 = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner2, store2 = make_runner(d1, provider2, tmp, MON_1)
            report2 = runner2.run(universe=["NVDA"])
            self.assertEqual(report2["status"], "complete")
            self.assertEqual(provider2.splits_calls, [])          # no repeat
            self.assertEqual(provider2.weekly_calls, ["NVDA"])    # weekly only
            self.assertIn("NVDA", d1.weekly)

    def test_new_week_second_monday_writes_exactly_one_row(self):
        # Fix 10: normally one new completed week -> exactly one changed row,
        # never a ~1000-row blanket rewrite.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA", n_weeks=260, end="2026-08-14")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner, _ = make_runner(d1, provider, tmp, MON_1)
            first = runner.run(universe=["NVDA"])
            self.assertEqual(first["status"], "complete")
            self.assertEqual(len(d1.weekly["NVDA"]), 260)

            # Next week: cycle W34 with one additional completed bucket.
            provider2 = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA", n_weeks=261, end="2026-08-21")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner2, _ = make_runner(d1, provider2, tmp, MON_2)
            report2 = runner2.run(universe=["NVDA"])
            self.assertEqual(report2["status"], "complete")
            self.assertEqual(report2["cycle_week"], "2026-W34")
            nv = report2["symbols"]["NVDA"]
            self.assertEqual(nv["rows_updated"], 1)  # only the new week
            self.assertEqual(len(d1.weekly["NVDA"]), 261)
            # Metrics re-anchored to the new week.
            self.assertIn("2026-08-21", d1.metrics["NVDA"]["anchor_week"])

    def test_quota_resume_across_days(self):
        # Sunday SPLITS quota-blocked mid-way; next permitted run (Monday)
        # resumes splits then completes weekly without repeating done work.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider1 = FakeProvider(
                weekly_payloads={s: weekly_payload(s) for s in ("A", "B")},
                splits_payloads={s: splits_payload(s) for s in ("A", "B")},
                quota_after=1,  # A splits ok (1); B splits hits quota (2)
            )
            runner1, store1 = make_runner(d1, provider1, tmp, SUN_1)
            report1 = runner1.run(universe=["A", "B"])
            self.assertTrue(report1["quota_exhausted"])
            self.assertEqual(report1["status"], "quota")
            self.assertEqual(store1.state.symbol_status("A", "splits"), "done")
            self.assertEqual(store1.state.symbol_status("B", "splits"), "pending")

            provider2 = FakeProvider(
                weekly_payloads={s: weekly_payload(s) for s in ("A", "B")},
                splits_payloads={s: splits_payload(s) for s in ("A", "B")},
            )
            runner2, store2 = make_runner(d1, provider2, tmp, MON_1)
            report2 = runner2.run(universe=["A", "B"])
            self.assertEqual(report2["status"], "complete")
            # A splits NOT repeated; B splits resumed; both weekly on Monday.
            self.assertEqual(provider2.splits_calls, ["B"])
            self.assertEqual(sorted(provider2.weekly_calls), ["A", "B"])
            self.assertIn("A", d1.weekly)
            self.assertIn("B", d1.weekly)
            self.assertEqual(store2.state.phase(), "complete")

    def test_split_history_change_rewrites_affected_rows_and_metrics(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            # Week 1: no splits.
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": {"symbol": "NVDA", "data": []}},
            )
            runner, _ = make_runner(d1, provider, tmp, MON_1)
            runner.run(universe=["NVDA"])
            self.assertEqual(len(d1.weekly["NVDA"]), 260)
            self.assertTrue(all(r[7] == 1.0 for r in d1.weekly["NVDA"]))

            # Next cycle: a 10:1 split appears — pre-split rows rewrite; no
            # mixed regime; metrics recomputed; no weekly provider row changes.
            provider2 = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner2, store2 = make_runner(d1, provider2, tmp, MON_2)
            report2 = runner2.run(universe=["NVDA"])
            self.assertEqual(report2["status"], "complete")
            rows = d1.weekly["NVDA"]
            pre = [r for r in rows if r[1] < "2024-06-10"]
            self.assertTrue(all(r[7] == 10.0 for r in pre))
            self.assertTrue(all(r[7] == 1.0 for r in rows if r[1] >= "2024-06-10"))
            self.assertEqual(len(rows), 260)
            # split_events durable and reconciled.
            self.assertEqual(len(d1.read_split_events("NVDA")), 1)
            self.assertEqual(d1.read_split_events("NVDA")[0]["split_factor"], 10.0)
            self.assertEqual(store2.state.phase(), "complete")

    def test_malformed_splits_keep_existing_events_history_intact(self):
        # Spec #5: NVDA has stored split_events + adjusted history; the provider
        # returns a MALFORMED SPLITS payload. Existing events MUST survive, the
        # adjusted history MUST survive (no factor-1 rewrite), and maintenance
        # must report the error.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner, _ = make_runner(d1, provider, tmp, MON_1)
            runner.run(universe=["NVDA"])
            self.assertEqual(len(d1.read_split_events("NVDA")), 1)
            pre_factors = {r[1]: r[7] for r in d1.weekly["NVDA"]}
            pre_adjs = {r[1]: r[8] for r in d1.weekly["NVDA"]}

            # New cycle; SPLITS payload is now garbage (data: "oops").
            provider2 = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": {"symbol": "NVDA", "data": "oops"}},
            )
            runner2, store2 = make_runner(d1, provider2, tmp, MON_2)
            report2 = runner2.run(universe=["NVDA"])
            # Error surfaced in the report.
            self.assertTrue(any("splits" in a for a in report2["anomalies"]))
            self.assertEqual(store2.state.symbol_status("NVDA", "splits"), "error")
            # Existing durable events intact; factors/adjusted EXACTLY unchanged.
            self.assertEqual(d1.read_split_events("NVDA")[0]["split_factor"], 10.0)
            for r in d1.weekly["NVDA"]:
                self.assertEqual(r[7], pre_factors[r[1]])
                self.assertEqual(r[8], pre_adjs[r[1]])

    def test_unchanged_splits_do_not_rewrite_history(self):
        # The Sunday SPLITS pass with an UNCHANGED history performs no
        # historical rewrite and no metrics change beyond the normal pass.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner, _ = make_runner(d1, provider, tmp, MON_1)
            runner.run(universe=["NVDA"])

            # Monday of the next week, same split history -> no rewrite of
            # existing rows beyond the single new week.
            provider2 = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA", n_weeks=261, end="2026-08-21")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner2, _ = make_runner(d1, provider2, tmp, MON_2)
            report2 = runner2.run(universe=["NVDA"])
            nv = report2["symbols"]["NVDA"]
            self.assertFalse(nv["split_changed"])
            self.assertEqual(nv["rows_updated"], 1)

    def test_dry_run_never_touches_provider_or_d1(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner, _ = make_runner(d1, provider, tmp, MON_1)
            report = runner.run(universe=["NVDA"], dry_run=True)
            self.assertEqual(report["status"], "plan")
            self.assertEqual(provider.requests_this_run, 0)
            self.assertEqual(d1.written_rows, 0)
            self.assertEqual(d1.read_split_events("NVDA"), [])

    def test_shared_key_ledger_store_is_loaded_before_provider_use(self):
        # Regression (cmd_maintenance path): the provider's per-key ldger wraps
        # the bootstrap StateStore, which arrives UNloaded. MaintenanceRunner
        # must load it before the first provider request or the first
        # KeyBudgetLedger.remaining() call IndexErrors on an empty Checkpoint.
        from history_ingestor.provider import AlphaVantageClient
        from history_ingestor.state import KeyBudgetLedger, StateStore
        try:
            from test_provider import RecordingURL
        except ModuleNotFoundError:
            from tests.test_provider import RecordingURL  # type: ignore[no-redef]

        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            settings = settings_with()
            key_store = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
            ledger = KeyBudgetLedger(key_store)
            url = RecordingURL([
                ({"function": "SPLITS", "symbol": "NVDA"},
                 {"symbol": "NVDA", "data": [{"effective_date": "2024-06-10", "split_factor": "10.0000"}]}),
                ({"function": "TIME_SERIES_WEEKLY", "symbol": "NVDA", "outputsize": "full"}, weekly_payload("NVDA")),
            ])
            provider = AlphaVantageClient(settings, ledger, sleep_fn=lambda _: None, urlopen=url)
            mstore = MaintenanceStore(settings, d1, state_path=Path(tmp) / "maintenance.json")
            runner = MaintenanceRunner(settings, d1, provider, mstore, key_store=key_store, now_fn=lambda: MON_1)
            report = runner.run(universe=["NVDA"])
            self.assertEqual(report["status"], "complete")
            # Per-key budget worked: exactly one SPLITS + one WEEKLY used.
            self.assertEqual(report["requests_used_total"], 2)
            self.assertEqual(len(report["keys_used"]), 2)
            self.assertEqual(sum(k["used"] for k in report["keys_used"]), 2)
            self.assertTrue(d1.read_split_events("NVDA"))
            self.assertIn("NVDA", d1.weekly)

    def test_maintenance_persists_shared_key_budget_ledger(self):
        # Maintenance must persist the shared per-key budget ledger so
        # bootstrap + maintenance draw from the same daily quota.
        from unittest.mock import MagicMock, patch

        from history_ingestor.state import StateStore

        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            key_store = StateStore(settings_with(), d1, state_path=Path(tmp) / "bootstrap.json")
            runner = MaintenanceRunner(
                settings_with(), d1, provider,
                MaintenanceStore(settings_with(), d1, state_path=Path(tmp) / "maintenance.json"),
                key_store=key_store,
                now_fn=lambda: MON_1,
            )
            # Patch save to verify it gets called during maintenance run.
            with patch.object(key_store, 'save', wraps=key_store.save) as mock_save:
                runner.run(universe=["NVDA"])
                # The shared key budget ledger MUST be persisted after maintenance.
                self.assertTrue(mock_save.called)

    def test_non_monday_weekly_phase_waits(self):
        # Mid-week runs never fabricate a new weekly ingest.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner, store = make_runner(d1, provider, tmp, WED_1)
            report = runner.run(universe=["NVDA"])
            # Wednesday catch-up: weekly phase runs because current ISO week (W34)
            # is strictly after target week (W33, closed Friday).
            self.assertEqual(report["status"], "complete")
            self.assertTrue(provider.weekly_calls)
            self.assertEqual(store.state.phase(), "complete")


class WeeklySkipOnUnconfirmedSplitsTests(unittest.TestCase):
    """WEEKLY phase must skip symbols whose splits are not confirmed done."""

    def test_weekly_skips_symbol_with_split_error(self):
        # If SPLITS fetch errored for a symbol, the WEEKLY phase must NOT
        # write unadjusted weekly rows + metrics (Worker guard can't detect).
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.split_write_fail = True  # SPLITS fetch will fail → splits=error
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner, store = make_runner(d1, provider, tmp, MON_1)
            report = runner.run(universe=["NVDA"])
            # Splits failed → weekly rows NOT written for NVDA.
            self.assertNotIn("NVDA", d1.weekly)
            self.assertNotIn("NVDA", d1.metrics)
            # Anomaly reported explaining the skip.
            self.assertTrue(any("splits not confirmed done" in a for a in report["anomalies"]))


class SplitErrorRetryTests(unittest.TestCase):
    """A transient SPLITS error must be retried on the next run."""

    def test_split_error_retried_on_next_run(self):
        # Run 1: B SPLITS fails → splits=error, WEEKLY not written.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.split_write_fail = True
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner, store = make_runner(d1, provider, tmp, MON_1)
            runner.run(universe=["NVDA"])
            self.assertEqual(store.state.symbol_status("NVDA", "splits"), "error")
            self.assertNotIn("NVDA", d1.weekly)

            # Run 2: provider succeeds → error retried → splits=DONE → WEEKLY proceeds.
            d1.split_write_fail = False
            provider2 = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner2, store2 = make_runner(d1, provider2, tmp, MON_1)
            runner2.run(universe=["NVDA"])
            self.assertEqual(store2.state.symbol_status("NVDA", "splits"), "done")
            self.assertIn("NVDA", d1.weekly)

    def test_persistent_split_error_does_not_block_other_symbols(self):
        # A persistent SPLITS error for B must NOT block other symbols,
        # and B must never store unconfirmed/unadjusted WEEKLY data.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.split_write_fail = True  # B always fails
            provider = FakeProvider(
                weekly_payloads={
                    "NVDA": weekly_payload("NVDA"),
                    "AAPL": weekly_payload("AAPL"),
                },
                splits_payloads={
                    "NVDA": splits_payload("NVDA"),
                    "AAPL": splits_payload("AAPL"),
                },
            )
            runner, store = make_runner(d1, provider, tmp, MON_1)
            runner.run(universe=["NVDA", "AAPL"])
            # Both fail (split_write_fail is global) → both error, no weekly.
            self.assertEqual(store.state.symbol_status("NVDA", "splits"), "error")
            self.assertEqual(store.state.symbol_status("AAPL", "splits"), "error")
            self.assertNotIn("NVDA", d1.weekly)
            self.assertNotIn("AAPL", d1.weekly)

            # Run 2: both succeed → both retried → both done.
            d1.split_write_fail = False
            provider2 = FakeProvider(
                weekly_payloads={
                    "NVDA": weekly_payload("NVDA"),
                    "AAPL": weekly_payload("AAPL"),
                },
                splits_payloads={
                    "NVDA": splits_payload("NVDA"),
                    "AAPL": splits_payload("AAPL"),
                },
            )
            runner2, store2 = make_runner(d1, provider2, tmp, MON_1)
            runner2.run(universe=["NVDA", "AAPL"])
            self.assertEqual(store2.state.symbol_status("NVDA", "splits"), "done")
            self.assertEqual(store2.state.symbol_status("AAPL", "splits"), "done")
            self.assertIn("NVDA", d1.weekly)
            self.assertIn("AAPL", d1.weekly)


class WeeklyCatchUpTests(unittest.TestCase):
    """Weekly maintenance can catch up after Monday (Tue-Sat)."""

    def test_monday_weekly_processing_allowed(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner, store = make_runner(d1, provider, tmp, MON_1)
            report = runner.run(universe=["NVDA"])
            self.assertEqual(report["status"], "complete")
            self.assertTrue(provider.weekly_calls)

    def test_tuesday_catch_up_allowed(self):
        # Tuesday can catch up if Monday did not finish.
        TUE = dt.datetime(2026, 8, 18, 12, 0, tzinfo=dt.UTC)
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner, store = make_runner(d1, provider, tmp, TUE)
            report = runner.run(universe=["NVDA"])
            # Target week W33 (closed Friday 2026-08-14) is strictly before current NY
            # ISO week (W34 on Tuesday 2026-08-18) -> weekly phase runs.
            self.assertEqual(report["status"], "complete")
            self.assertTrue(provider.weekly_calls)

    def test_sunday_in_progress_week_blocked(self):
        # Sunday: target week is still the current NY week -> weekly phase blocked.
        SUN = dt.datetime(2026, 8, 16, 12, 0, tzinfo=dt.UTC)
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner, store = make_runner(d1, provider, tmp, SUN)
            report = runner.run(universe=["NVDA"])
            # Sunday: target week W33 is still current -> weekly phase skipped.
            self.assertEqual(report["status"], "partial")
            self.assertEqual(provider.weekly_calls, [])

    def test_already_completed_maintenance_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner, store = make_runner(d1, provider, tmp, MON_1)
            runner.run(universe=["NVDA"])
            # Second run (same cycle, same MON_1): already complete -> no-op.
            provider2 = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner2, store2 = make_runner(d1, provider2, tmp, MON_1)
            report = runner2.run(universe=["NVDA"])
            self.assertEqual(report["status"], "noop_complete")
            self.assertEqual(provider2.weekly_calls, [])


class MetricsRepairTests(unittest.TestCase):
    """Metrics-only retry must use ZERO provider WEEKLY calls."""

    def test_metrics_retry_zero_provider_calls(self):
        # weekly DONE + metrics ERROR → repair from D1, zero WEEKLY calls.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner, store = make_runner(d1, provider, tmp, MON_1)
            # Run 1: normal — weekly + metrics done.
            runner.run(universe=["NVDA"])
            self.assertIn("NVDA", d1.weekly)
            self.assertIn("NVDA", d1.metrics)
            self.assertEqual(store.state.symbol_status("NVDA", "weekly"), "done")
            self.assertEqual(store.state.symbol_status("NVDA", "metrics"), "done")

            # Simulate metrics row loss (e.g. D1 metrics write failed before).
            d1.metrics.clear()
            # Re-mark maintenance store: weekly=DONE, metrics=ERROR.
            store.state.mark_symbol("NVDA", "weekly", "done")
            store.state.mark_symbol("NVDA", "metrics", "error")
            store.save()

            # Run 2: retry — zero WEEKLY calls, metrics repaired from D1.
            provider2 = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner2, store2 = make_runner(d1, provider2, tmp, MON_1)
            runner2.run(universe=["NVDA"])
            self.assertEqual(provider2.weekly_calls, [])
            self.assertEqual(store2.state.symbol_status("NVDA", "metrics"), "done")
            self.assertIn("NVDA", d1.metrics)

    def test_metrics_retry_write_failures_remain_error(self):
        # weekly DONE + metrics ERROR + D1 metrics write fails → ERROR persists.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner, store = make_runner(d1, provider, tmp, MON_1)
            runner.run(universe=["NVDA"])
            self.assertIn("NVDA", d1.metrics)

            # Simulate metrics row loss + D1 metrics write failure.
            d1.metrics.clear()
            d1.metrics_write_fail = True
            store.state.mark_symbol("NVDA", "weekly", "done")
            store.state.mark_symbol("NVDA", "metrics", "error")
            store.save()

            provider2 = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner2, store2 = make_runner(d1, provider2, tmp, MON_1)
            runner2.run(universe=["NVDA"])
            self.assertEqual(provider2.weekly_calls, [])
            self.assertEqual(store2.state.symbol_status("NVDA", "metrics"), "error")
            self.assertNotIn("NVDA", d1.metrics)

            # Run 3: D1 write succeeds → metrics repaired.
            d1.metrics_write_fail = False
            provider3 = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner3, store3 = make_runner(d1, provider3, tmp, MON_1)
            runner3.run(universe=["NVDA"])
            self.assertEqual(provider3.weekly_calls, [])
            self.assertEqual(store3.state.symbol_status("NVDA", "metrics"), "done")
            self.assertIn("NVDA", d1.metrics)

    def test_weekly_pending_still_fetches_provider(self):
        # weekly pending → normal provider WEEKLY behavior.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner, store = make_runner(d1, provider, tmp, MON_1)
            runner.run(universe=["NVDA"])
            self.assertTrue(provider.weekly_calls)
            self.assertIn("NVDA", d1.weekly)
            self.assertEqual(store.state.symbol_status("NVDA", "weekly"), "done")

    def test_weekly_done_metrics_done_no_recomputation(self):
        # weekly DONE + metrics DONE → no provider call, no recomputation.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner, store = make_runner(d1, provider, tmp, MON_1)
            runner.run(universe=["NVDA"])

            provider2 = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner2, store2 = make_runner(d1, provider2, tmp, MON_1)
            report = runner2.run(universe=["NVDA"])
            # Second run: no new WEEKLY calls (cycle already complete).
            self.assertEqual(provider2.weekly_calls, [])
            self.assertEqual(report["status"], "noop_complete")


class MaintenanceSubsetTests(unittest.TestCase):
    """P2-2: --symbols must NOT shrink the durable cycle (always 50 canonical)."""

    def test_subset_first_run_durable_cycle_contains_all_canonical(self):
        # First run with --symbols NVDA only: durable cycle must contain all
        # canonical symbols (50), not just NVDA.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner, store = make_runner(d1, provider, tmp, MON_1)
            report = runner.run(symbols_filter=["NVDA"])
            # Durable cycle contains all canonical symbols
            self.assertGreater(len(store.state.symbols), 1)
            # But only NVDA was processed
            self.assertIn("NVDA", report["symbols"])

    def test_subset_complete_does_not_mark_cycle_complete(self):
        # Completing only NVDA must NOT mark the cycle as globally complete.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner, store = make_runner(d1, provider, tmp, MON_1)
            report = runner.run(symbols_filter=["NVDA"])
            # Cycle is NOT complete (other symbols still pending)
            self.assertNotEqual(store.state.phase(), "complete")
            self.assertNotEqual(report["status"], "complete")

    def test_later_full_run_processes_remaining(self):
        # After a subset run, a full run processes the remaining symbols.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={
                    "NVDA": weekly_payload("NVDA"),
                    "AAPL": weekly_payload("AAPL"),
                },
                splits_payloads={
                    "NVDA": splits_payload("NVDA"),
                    "AAPL": splits_payload("AAPL"),
                },
            )
            runner, store = make_runner(d1, provider, tmp, MON_1)
            # First run: only NVDA (from a 2-symbol universe)
            runner.run(universe=["NVDA", "AAPL"], symbols_filter=["NVDA"])
            # Second run: full universe (includes AAPL)
            report = runner.run(universe=["NVDA", "AAPL"])
            # AAPL should be processed in the second run
            self.assertIn("AAPL", report["symbols"])


class DueSplitReconciliationTests(unittest.TestCase):
    """P2-1: apply-due-splits applies splits whose effective date is reached."""

    def test_apply_due_splits_before_effective_date(self):
        # Split effective 2024-06-10; today is 2024-06-09 -> no change
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            # Pre-populate split_events with a future split
            d1.upsert_split_events([("NVDA", "2024-06-10", 10.0, "2026-08-19T00:00:00Z")])
            # Pre-populate weekly rows using upsert (tuple format)
            d1.upsert_weekly_rows([(
                "NVDA", "2024-06-03", 400, 401, 399, 400, 1000, 1.0, 400.0, "2026-08-19T00:00:00Z",
            )])
            provider = FakeProvider()
            runner, store = make_runner(d1, provider, tmp, MON_1)
            # Today is 2026-08-19 (after effective date 2024-06-10) -> should apply
            report = runner.apply_due_splits()
            self.assertEqual(report["status"], "applied")
            self.assertEqual(report["splits_applied"], 1)

    def test_apply_due_splits_noop_when_nothing_due(self):
        # No splits stored -> noop
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider()
            runner, store = make_runner(d1, provider, tmp, MON_1)
            report = runner.apply_due_splits()
            self.assertEqual(report["status"], "noop")
            self.assertEqual(report["splits_applied"], 0)

    def test_apply_due_splits_metrics_write_failure_reports_error(self):
        # If the metrics UPSERT fails in apply_due_splits, the error must be
        # reported per-symbol (not abort the whole run).
        from history_ingestor.bootstrap import BootstrapRunner
        from history_ingestor.state import StateStore

        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.metrics_write_fail = True
            settings = settings_with()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": future_splits_payload("NVDA", future_date="2026-08-17")},
            )
            # Bootstrap first to populate weekly rows + split_events.
            bootstrap_store = StateStore(settings, d1, state_path=Path(tmp) / "bootstrap.json")
            bootstrap_runner = BootstrapRunner(settings, d1, provider, bootstrap_store, now_fn=lambda: MON_1)
            bootstrap_runner.run(universe=["NVDA"])
            self.assertIn("NVDA", d1.weekly)
            self.assertTrue(d1.read_split_events("NVDA"))

            # apply_due_splits: split effective 2026-08-17 (Monday), run on Tuesday.
            TUE = dt.datetime(2026, 8, 18, 12, 0, tzinfo=dt.UTC)
            maintenance_store = MaintenanceStore(settings, d1, state_path=Path(tmp) / "maintenance.json")
            maintenance_runner = MaintenanceRunner(settings, d1, provider, maintenance_store, now_fn=lambda: TUE)
            report = maintenance_runner.apply_due_splits(symbols_filter=["NVDA"])
            # The metrics write failure must surface in the report.
            self.assertIn("NVDA", report["symbols"])
            self.assertEqual(report["symbols"]["NVDA"]["status"], "error")
            self.assertIn("technical_metrics write failed", report["symbols"]["NVDA"]["error"])


class D1MetricsWriteFailureTests(unittest.TestCase):
    """P2: _upsert_metrics must check D1WriteResult.failure."""

    def test_metrics_write_fail_not_done_retried_next_run(self):
        # D1 metrics write fails -> metrics STATUS_ERROR, not DONE
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.metrics_write_fail = True
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner, store = make_runner(d1, provider, tmp, MON_1)
            runner.run(universe=["NVDA"])
            # Metrics should be in error state (write failed)
            self.assertEqual(store.state.symbol_status("NVDA", "metrics"), "error")
            # Weekly should be done (write succeeded)
            self.assertEqual(store.state.symbol_status("NVDA", "weekly"), "done")

    def test_metrics_write_fail_retried_on_next_run(self):
        # First run: write fails -> metrics=error. Next cycle: retry -> metrics=done.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.metrics_write_fail = True
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner, store = make_runner(d1, provider, tmp, MON_1)
            # First run: write fails
            runner.run(universe=["NVDA"])
            self.assertEqual(store.state.symbol_status("NVDA", "metrics"), "error")

            # Second run (new cycle, write succeeds)
            d1.metrics_write_fail = False
            provider2 = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner2, store2 = make_runner(d1, provider2, tmp, MON_2)
            runner2.run(universe=["NVDA"])
            self.assertEqual(store2.state.symbol_status("NVDA", "metrics"), "done")


if __name__ == "__main__":
    unittest.main()
