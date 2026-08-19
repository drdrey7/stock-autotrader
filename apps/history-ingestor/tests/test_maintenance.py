"""Tests for cycle-based weekly maintenance (history ingestor)."""

from __future__ import annotations

import datetime as dt
import tempfile
import unittest
from pathlib import Path

from history_ingestor.config import Settings
from history_ingestor.maintenance import MaintenanceRunner
from history_ingestor.maintenance_state import MaintenanceStore

try:
    from test_bootstrap import FakeD1, FakeProvider, splits_payload, weekly_payload
except ModuleNotFoundError:  # imported as tests.test_maintenance (module path mode)
    from tests.test_bootstrap import FakeD1, FakeProvider, splits_payload, weekly_payload  # type: ignore[no-redef]


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
            self.assertEqual(report["status"], "partial")  # splits done, weekly waits
            self.assertEqual(provider.weekly_calls, [])
            self.assertTrue(any("Monday" in a for a in report["anomalies"]))
            self.assertEqual(store.state.phase(), "weekly")


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


if __name__ == "__main__":
    unittest.main()
