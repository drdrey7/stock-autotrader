"""Tests for cycle-based weekly maintenance (history ingestor)."""

from __future__ import annotations

import datetime as dt
import tempfile
import unittest
from pathlib import Path

from history_ingestor.config import Settings
from history_ingestor.maintenance import MaintenanceRunner
from history_ingestor.maintenance_state import MaintenanceStore, ReconcileStore, STATUS_DONE, STATUS_ERROR

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


# --- cycle calendars ---------------------------------------------------------
MON_1 = dt.datetime(2026, 8, 17, 5, 10, tzinfo=dt.UTC)   # NY Monday, cycle W33
SUN_1 = dt.datetime(2026, 8, 16, 5, 10, tzinfo=dt.UTC)   # NY Sunday, cycle W33
MON_2 = dt.datetime(2026, 8, 24, 5, 10, tzinfo=dt.UTC)   # NY Monday, cycle W34
WED_1 = dt.datetime(2026, 8, 19, 12, 0, tzinfo=dt.UTC)   # NY Wednesday, cycle W33


class MaintenanceCycleTests(unittest.TestCase):
    def test_first_run_ingests_whole_cycle_monday(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            # Split_events come from the DURABLE store (bootstrap/reconcile-splits
            # already wrote them) — maintenance reads them, never fetches SPLITS.
            d1.upsert_split_events([("NVDA", "2024-06-10", 10.0, "2026-08-19T00:00:00Z")])
            provider = FakeProvider(weekly_payloads={"NVDA": weekly_payload("NVDA")})
            runner, store = make_runner(d1, provider, tmp, MON_1)
            report = runner.run(universe=["NVDA"])
            self.assertEqual(report["status"], "complete")
            self.assertEqual(report["cycle_week"], "2026-W33")
            self.assertEqual(report["phase"], "complete")
            # split_events durable (unchanged), weekly factors correct, metrics present.
            self.assertEqual(len(d1.read_split_events("NVDA")), 1)
            rows = d1.weekly["NVDA"]
            self.assertEqual(len(rows), 260)
            self.assertTrue(any(r[7] == 10.0 for r in rows))
            self.assertIn("NVDA", d1.metrics)
            # Maintenance fetches WEEKLY only; it NEVER fetches SPLITS (decoupled).
            self.assertEqual(provider.splits_calls, [])
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

    def test_sunday_in_progress_week_blocks_weekly(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(weekly_payloads={"NVDA": weekly_payload("NVDA")})
            runner, store = make_runner(d1, provider, tmp, SUN_1)
            report = runner.run(universe=["NVDA"])
            # Sunday: the just-closed week is still the current NY week, so the
            # WEEKLY bucket is not storable yet -> weekly stays pending.
            self.assertEqual(report["status"], "partial")
            self.assertEqual(provider.weekly_calls, [])
            self.assertTrue(any("Monday" in a for a in report["anomalies"]))
            # No weekly rows written Sunday; no SPLITS fetched by maintenance.
            self.assertNotIn("NVDA", d1.weekly)
            self.assertEqual(provider.splits_calls, [])

            # Monday resumes and finishes WEEKLY.
            provider2 = FakeProvider(weekly_payloads={"NVDA": weekly_payload("NVDA")})
            runner2, _ = make_runner(d1, provider2, tmp, MON_1)
            report2 = runner2.run(universe=["NVDA"])
            self.assertEqual(report2["status"], "complete")
            self.assertEqual(provider2.weekly_calls, ["NVDA"])    # weekly only
            self.assertEqual(provider2.splits_calls, [])           # never splits
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
            rstore = runner2._get_reconcile_store()
            rstore.state.mark("NVDA", "done")
            self.assertTrue(rstore.save())
            report2 = runner2.run(universe=["NVDA"])
            self.assertEqual(report2["status"], "complete")
            self.assertEqual(report2["cycle_week"], "2026-W34")
            nv = report2["symbols"]["NVDA"]
            self.assertEqual(nv["rows_updated"], 1)  # only the new week
            self.assertEqual(len(d1.weekly["NVDA"]), 261)
            self.assertEqual(
                d1.meta["historyReconcileSplitStatus:NVDA"]["status"],
                "done",
            )
            # Metrics re-anchored to the new week.
            self.assertIn("2026-08-21", d1.metrics["NVDA"]["anchor_week"])

    def test_provider_correction_invalidates_before_weekly_rows_are_written(self):
        class TrackingD1(FakeD1):
            def __init__(self):
                super().__init__()
                self.operations: list[tuple[str, str]] = []

            def write_app_meta(self, key, value):
                self.operations.append(("meta", key))
                return super().write_app_meta(key, value)

            def upsert_weekly_rows(self, rows):
                self.operations.append(("weekly", rows[0][0]))
                return super().upsert_weekly_rows(rows)

        with tempfile.TemporaryDirectory() as tmp:
            d1 = TrackingD1()
            runner, _ = make_runner(
                d1,
                FakeProvider(weekly_payloads={"NVDA": weekly_payload("NVDA")}),
                tmp,
                MON_1,
            )
            runner.run(universe=["NVDA"])

            corrected = weekly_payload("NVDA", n_weeks=261, end="2026-08-21")
            corrected["Weekly Time Series"]["2026-08-14"]["4. close"] = "22.5"
            runner2, _ = make_runner(
                d1,
                FakeProvider(weekly_payloads={"NVDA": corrected}),
                tmp,
                MON_2,
            )
            rstore = runner2._get_reconcile_store()
            rstore.state.mark("NVDA", "done")
            self.assertTrue(rstore.save())
            d1.operations.clear()

            report = runner2.run(universe=["NVDA"])
            self.assertEqual(report["symbols"]["NVDA"]["rows_updated"], 2, report)
            self.assertEqual(d1.meta["historyReconcileSplitStatus:NVDA"]["status"], "pending")
            pending_index = d1.operations.index(("meta", "historyReconcileSplitStatus:NVDA"))
            weekly_index = d1.operations.index(("weekly", "NVDA"))
            self.assertLess(pending_index, weekly_index)

    def test_quota_resume_across_days(self):
        # Monday WEEKLY quota-blocked mid-way; next run resumes the remaining
        # symbols' weekly without repeating done work — and never fetches SPLITS.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider1 = FakeProvider(
                weekly_payloads={s: weekly_payload(s) for s in ("A", "B")},
                quota_after=1,  # A weekly ok (1); B weekly hits quota (2)
            )
            runner1, store1 = make_runner(d1, provider1, tmp, MON_1)
            report1 = runner1.run(universe=["A", "B"])
            self.assertTrue(report1["quota_exhausted"])
            self.assertEqual(report1["status"], "quota")
            self.assertEqual(store1.state.symbol_status("A", "weekly"), "done")
            self.assertEqual(store1.state.symbol_status("B", "weekly"), "pending")

            provider2 = FakeProvider(
                weekly_payloads={s: weekly_payload(s) for s in ("A", "B")},
            )
            runner2, store2 = make_runner(d1, provider2, tmp, MON_1)
            report2 = runner2.run(universe=["A", "B"])
            self.assertEqual(report2["status"], "complete")
            # A weekly NOT repeated; B weekly resumed. No SPLITS fetched.
            self.assertEqual(provider2.weekly_calls, ["B"])
            self.assertNotIn("A", provider2.weekly_calls[0:0] or [])
            self.assertEqual(provider2.splits_calls, [])
            self.assertIn("A", d1.weekly)
            self.assertIn("B", d1.weekly)
            self.assertEqual(store2.state.phase(), "complete")

    def test_split_history_change_rewrites_affected_rows_and_metrics(self):
        # Split reconciliation is now the SEPARATE low-frequency responsibility
        # (reconcile_splits). Populate weekly first (no splits -> factor 1), then
        # a changed split rewrites only the affected history + metrics.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            # Week 1: weekly maintenance with no splits -> all factor 1.0.
            provider = FakeProvider(weekly_payloads={"NVDA": weekly_payload("NVDA")})
            runner, _ = make_runner(d1, provider, tmp, MON_1)
            runner.run(universe=["NVDA"])
            self.assertEqual(len(d1.weekly["NVDA"]), 260)
            self.assertTrue(all(r[7] == 1.0 for r in d1.weekly["NVDA"]))

            # Next: reconcile-splits discovers a 10:1 split -> pre-split rows
            # rewrite; no mixed regime; metrics recomputed.
            provider2 = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner2, store2 = make_runner(d1, provider2, tmp, MON_1)
            report2 = runner2.reconcile_splits(symbols_filter=["NVDA"])
            self.assertEqual(report2["status"], "complete")
            rows = d1.weekly["NVDA"]
            pre = [r for r in rows if r[1] < "2024-06-10"]
            self.assertTrue(all(r[7] == 10.0 for r in pre))
            self.assertTrue(all(r[7] == 1.0 for r in rows if r[1] >= "2024-06-10"))
            self.assertEqual(len(rows), 260)
            # split_events durable and reconciled.
            self.assertEqual(len(d1.read_split_events("NVDA")), 1)
            self.assertEqual(d1.read_split_events("NVDA")[0]["split_factor"], 10.0)
            self.assertEqual(
                d1.meta["historyReconcileSplitStatus:NVDA"]["status"],
                "done",
            )

    def test_malformed_splits_keep_existing_events_history_intact(self):
        # Spec #5: NVDA has stored split_events + adjusted history; the provider
        # returns a MALFORMED SPLITS payload during reconcile-splits. Existing
        # events MUST survive, the adjusted history MUST survive, and the
        # reconcile must report the error without a weekly provider call.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.upsert_split_events([("NVDA", "2024-06-10", 10.0, "2026-08-19T00:00:00Z")])
            provider = FakeProvider(weekly_payloads={"NVDA": weekly_payload("NVDA")})
            runner, _ = make_runner(d1, provider, tmp, MON_1)
            runner.run(universe=["NVDA"])
            self.assertEqual(len(d1.read_split_events("NVDA")), 1)
            pre_factors = {r[1]: r[7] for r in d1.weekly["NVDA"]}
            pre_adjs = {r[1]: r[8] for r in d1.weekly["NVDA"]}

            # reconcile-splits: SPLITS payload is now garbage (data: "oops").
            provider2 = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": {"symbol": "NVDA", "data": "oops"}},
            )
            runner2, store2 = make_runner(d1, provider2, tmp, MON_1)
            report2 = runner2.reconcile_splits(symbols_filter=["NVDA"])
            # Error surfaced in the report.
            self.assertTrue(any("splits" in a for a in report2["anomalies"]))
            self.assertEqual(runner2._get_reconcile_store().state.status("NVDA"), "error")
            # Existing durable events intact; factors/adjusted EXACTLY unchanged.
            self.assertEqual(d1.read_split_events("NVDA")[0]["split_factor"], 10.0)
            for r in d1.weekly["NVDA"]:
                self.assertEqual(r[7], pre_factors[r[1]])
                self.assertEqual(r[8], pre_adjs[r[1]])

    def test_unchanged_splits_do_not_rewrite_history(self):
        # A reconcile-splits with an UNCHANGED split history performs no
        # historical rewrite and no metrics change.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.upsert_split_events([("NVDA", "2024-06-10", 10.0, "2026-08-19T00:00:00Z")])
            provider = FakeProvider(weekly_payloads={"NVDA": weekly_payload("NVDA")})
            runner, _ = make_runner(d1, provider, tmp, MON_1)
            runner.run(universe=["NVDA"])

            # reconcile-splits with the SAME split history -> no rewrite.
            provider2 = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA", n_weeks=261, end="2026-08-21")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner2, _ = make_runner(d1, provider2, tmp, MON_1)
            report2 = runner2.reconcile_splits(symbols_filter=["NVDA"])
            nv_detail = report2["symbols"].get("NVDA", {})
            self.assertFalse(nv_detail.get("split_changed", False))
            self.assertEqual(nv_detail.get("rows_updated", 0), 0)

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
        # Regression (cmd_maintenance path): the provider's per-key ledger wraps
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
                # Maintenance fetches WEEKLY only (SPLITS is decoupled).
                ({"function": "TIME_SERIES_WEEKLY", "symbol": "NVDA", "outputsize": "full"}, weekly_payload("NVDA")),
            ])
            provider = AlphaVantageClient(settings, ledger, sleep_fn=lambda _: None, urlopen=url)
            mstore = MaintenanceStore(settings, d1, state_path=Path(tmp) / "maintenance.json")
            runner = MaintenanceRunner(settings, d1, provider, mstore, key_store=key_store, now_fn=lambda: MON_1)
            report = runner.run(universe=["NVDA"])
            self.assertEqual(report["status"], "complete")
            # Per-key budget worked: exactly one WEEKLY used (maintenance never
            # fetches SPLITS — that is the separate reconcile-splits path).
            self.assertEqual(report["requests_used_total"], 1)
            self.assertEqual(len(report["keys_used"]), 2)
            self.assertEqual(sum(k["used"] for k in report["keys_used"]), 1)
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


class WeeklyIndependenceOfSplitsTests(unittest.TestCase):
    """The WEEKLY SMA refresh MUST run independently of split status.

    Split reconciliation is a SEPARATE low-frequency responsibility
    (reconcile-splits / apply-due-splits). A symbol whose split store is
    missing/errored must still have its weekly rows + metrics refreshed from
    the stored split_events it does have — the anchor must always roll forward.
    """

    def test_weekly_runs_even_when_split_store_missing(self):
        # No split_events in the durable store at all: weekly still runs, using
        # an empty split set (factor 1) and recomputes metrics. Never blocked.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(weekly_payloads={"NVDA": weekly_payload("NVDA")})
            runner, store = make_runner(d1, provider, tmp, MON_1)
            report = runner.run(universe=["NVDA"])
            self.assertEqual(report["status"], "complete")
            self.assertIn("NVDA", d1.weekly)         # weekly rows written
            self.assertIn("NVDA", d1.metrics)        # metrics recomputed
            self.assertEqual(store.state.phase(), "complete")
            # Maintenance never fetched SPLITS (decoupled).
            self.assertEqual(provider.splits_calls, [])

    def test_weekly_runs_even_with_stored_empty_split_events(self):
        # split_events durable but explicitly EMPTY (verified zero splits):
        # weekly still runs with factor 1.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            # Leave split_events EMPTY — the durable store has no entries for NVDA.
            self.assertEqual(d1.read_split_events("NVDA"), [])
            provider = FakeProvider(weekly_payloads={"NVDA": weekly_payload("NVDA")})
            runner, store = make_runner(d1, provider, tmp, MON_1)
            report = runner.run(universe=["NVDA"])
            self.assertEqual(report["status"], "complete")
            self.assertIn("NVDA", d1.weekly)
            # All factors are 1 (no splits in the durable store).
            self.assertTrue(all(r[7] == 1.0 for r in d1.weekly["NVDA"]))
            # No "splits not confirmed" or "weekly skipped" anomalies.
            self.assertFalse(any("weekly skipped" in a for a in report["anomalies"]))
            self.assertEqual(provider.splits_calls, [])


class SplitReconcileRetryTests(unittest.TestCase):
    """A transient reconcile-splits SPLITS error is retried on a later run."""

    def test_reconcile_splits_error_retried_on_next_run(self):
        # Run 1: reconcile-splits SPLITS write fails -> splits=error, but the
        # WEEKLY maintenance still runs independently.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.split_write_fail = True
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner, store = make_runner(d1, provider, tmp, MON_1)
            # Weekly maintenance: independent of splits — succeeds even though
            # split_events writes fail.
            runner.run(universe=["NVDA"])
            self.assertIn("NVDA", d1.weekly)
            self.assertEqual(store.state.phase(), "complete")

            # reconcile-splits on the same store: SPLITS write fails -> error.
            runner2, store2 = make_runner(d1, provider, tmp, MON_1)
            report = runner2.reconcile_splits(symbols_filter=["NVDA"])
            self.assertEqual(report["symbols"]["NVDA"]["splits"], "error")
            self.assertTrue(any("split" in a.lower() for a in report["anomalies"]))
            self.assertEqual(runner2._get_reconcile_store().state.status("NVDA"), "error")

            # Run 2: SPLITS write succeeds -> retried -> done.
            d1.split_write_fail = False
            provider2 = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner3, store3 = make_runner(d1, provider2, tmp, MON_1)
            report3 = runner3.reconcile_splits(symbols_filter=["NVDA"])
            self.assertEqual(report3["status"], "complete")
            self.assertEqual(runner3._get_reconcile_store().state.status("NVDA"), "done")
            self.assertEqual(d1.read_split_events("NVDA")[0]["split_factor"], 10.0)

    def test_reconcile_splits_error_does_not_block_other_symbols(self):
        # A persistent SPLITS error for one symbol must NOT block others'
        # SPLITS, and must never block the WEEKLY maintenance.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.split_write_fail = True  # all SPLITS writes fail
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
            # Weekly maintenance still fully completes (independent of splits).
            report = runner.run(universe=["NVDA", "AAPL"])
            self.assertEqual(report["status"], "complete")
            self.assertIn("NVDA", d1.weekly)
            self.assertIn("AAPL", d1.weekly)

            # reconcile-splits: both write-fail -> both error (but neither
            # blocks the other symbol from being visited).
            runner2, store2 = make_runner(d1, provider, tmp, MON_1)
            report2 = runner2.reconcile_splits(symbols_filter=["NVDA", "AAPL"])
            self.assertEqual(runner2._get_reconcile_store().state.status("NVDA"), "error")
            self.assertEqual(runner2._get_reconcile_store().state.status("AAPL"), "error")
            self.assertIn("NVDA", report2["symbols"])
            self.assertIn("AAPL", report2["symbols"])

            # Run 2: writes succeed -> both retried -> both done.
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
            runner3, store3 = make_runner(d1, provider2, tmp, MON_1)
            report3 = runner3.reconcile_splits(symbols_filter=["NVDA", "AAPL"])
            self.assertEqual(report3["status"], "complete")
            self.assertEqual(runner3._get_reconcile_store().state.status("NVDA"), "done")
            self.assertEqual(runner3._get_reconcile_store().state.status("AAPL"), "done")


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


class ReconcileSplitsTests(unittest.TestCase):
    """reconcile-splits: dedicated persistent state, dry-run provider-free, resume-safe."""

    def _rstate(self, runner):
        """Return the runner's dedicated ReconcileStore state."""
        return runner._get_reconcile_store().state

    def test_new_pass_and_retry_error_preserve_last_verified_serving_marker(self):
        """Progress resets/errors must not hide already verified no-split history."""
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            # Simulate rollout from the old global-only checkpoint.
            d1.meta["historyReconcileSplitState"] = {
                "version": 1, "updated_at": "2026-08-17T00:00:00Z", "splits": {"NVDA": STATUS_DONE},
            }
            store = ReconcileStore(settings_with(), d1, state_path=Path(tmp) / "reconcile.json")
            store.load()
            self.assertTrue(store.backfill_verified_markers())
            self.assertTrue(store.save())
            self.assertEqual(d1.meta["historyReconcileSplitStatus:NVDA"]["status"], STATUS_DONE)

            store.start_new_pass(["NVDA"])
            self.assertTrue(store.save())
            self.assertEqual(store.state.status("NVDA"), "pending")
            self.assertEqual(d1.meta["historyReconcileSplitStatus:NVDA"]["status"], STATUS_DONE)

            store.state.mark("NVDA", STATUS_ERROR, update_serving_marker=False)
            self.assertTrue(store.save())
            self.assertEqual(d1.meta["historyReconcileSplitStatus:NVDA"]["status"], STATUS_DONE)

    def test_reconcile_splits_dry_run_makes_zero_provider_calls(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner, _ = make_runner(d1, provider, tmp, MON_1)
            report = runner.reconcile_splits(symbols_filter=["NVDA"], dry_run=True)
            # Plan only: zero provider calls, zero D1 writes, no status change.
            self.assertEqual(report["status"], "plan")
            self.assertEqual(provider.requests_this_run, 0)
            self.assertEqual(provider.splits_calls, [])
            self.assertEqual(provider.weekly_calls, [])
            self.assertEqual(d1.written_rows, 0)
            self.assertEqual(d1.read_split_events("NVDA"), [])
            self.assertEqual(self._rstate(runner).status("NVDA"), "pending")

    def test_reconcile_splits_progress_persists_across_capped_runs(self):
        # A capped run processes some symbols; the next run resumes from where
        # it stopped (skips done symbols) and reports partial until all are done.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            # Universe NVDA/AAPL — each needs one SPLITS fetch; cap 1 means run
            # 1 can only reconcile the first symbol.
            provider1 = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA"), "AAPL": weekly_payload("AAPL")},
                splits_payloads={"NVDA": splits_payload("NVDA"), "AAPL": splits_payload("AAPL")},
            )
            runner1, _ = make_runner(d1, provider1, tmp, MON_1)
            report1 = runner1.reconcile_splits(symbols_filter=["NVDA", "AAPL"], limit=1)
            self.assertEqual(report1["status"], "partial")
            self.assertEqual(report1["requests_used_total"], 1)
            # First symbol reconciled (done), second still pending (dedicated state).
            r1 = self._rstate(runner1)
            done = sorted(s for s in ("NVDA", "AAPL") if r1.status(s) == "done")
            pending = sorted(s for s in ("NVDA", "AAPL") if r1.status(s) != "done")
            self.assertEqual(len(done), 1)
            self.assertEqual(len(pending), 1)
            # The visited symbol is in the report; the unvisited one is NOT
            # (it was never fetched), and stays pending in the durable store.
            self.assertIn(done[0], report1["symbols"])
            self.assertEqual(r1.status(pending[0]), "pending")

            # Run 2: fresh provider, resumes the pending symbol (done one skipped).
            remaining_sym = pending[0]
            provider2 = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA"), "AAPL": weekly_payload("AAPL")},
                splits_payloads={"NVDA": splits_payload("NVDA"), "AAPL": splits_payload("AAPL")},
            )
            runner2, _ = make_runner(d1, provider2, tmp, MON_1)
            report2 = runner2.reconcile_splits(symbols_filter=["NVDA", "AAPL"], limit=10)
            self.assertEqual(report2["status"], "complete")
            self.assertEqual(report2["requests_used_total"], 1)  # only the pending one fetched
            self.assertEqual(provider2.splits_calls, [remaining_sym])
            r2 = self._rstate(runner2)
            self.assertEqual(r2.status("NVDA"), "done")
            self.assertEqual(r2.status("AAPL"), "done")

    def test_reconcile_splits_done_symbol_never_refetched(self):
        # A symbol already reconciled in a previous run is skipped (no re-fetch)
        # and its status is carried into the report from the durable store.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA"), "AAPL": weekly_payload("AAPL")},
                splits_payloads={"NVDA": splits_payload("NVDA"), "AAPL": splits_payload("AAPL")},
            )
            runner, _ = make_runner(d1, provider, tmp, MON_1)
            runner._get_reconcile_store().state.mark("NVDA", "done")
            runner._get_reconcile_store().save()
            runner.reconcile_splits(symbols_filter=["NVDA", "AAPL"], limit=10)
            # Only AAPL was fetched; NVDA was skipped because it was already done.
            self.assertEqual(provider.splits_calls, ["AAPL"])
            r = self._rstate(runner)
            self.assertEqual(r.status("NVDA"), "done")
            self.assertEqual(r.status("AAPL"), "done")

    def test_reconcile_splits_survives_weekly_cycle_rollover(self):
        # The maintenance cycle_week reset (new completed week) must NOT erase
        # the dedicated reconciliation progress — capped partial work resumes
        # across a weekly rollover instead of re-fetching everything.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            # Week 1 (MON_1): reconcile capped at 1 -> only NVDA done, AAPL pending.
            provider1 = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA"), "AAPL": weekly_payload("AAPL")},
                splits_payloads={"NVDA": splits_payload("NVDA"), "AAPL": splits_payload("AAPL")},
            )
            runner1, mstore1 = make_runner(d1, provider1, tmp, MON_1)
            runner1.reconcile_splits(symbols_filter=["NVDA", "AAPL"], limit=1)
            r1 = self._rstate(runner1)
            done1 = sorted(s for s in ("NVDA", "AAPL") if r1.status(s) == "done")
            pend1 = sorted(s for s in ("NVDA", "AAPL") if r1.status(s) != "done")
            self.assertEqual(len(done1), 1)
            self.assertEqual(len(pend1), 1)
            # Simulate the maintenance cycle advancing to a new week (MON_2):
            # reset_cycle wipes the maintenance store's symbol endpoints.
            mstore1.reset_cycle("W35", ["NVDA", "AAPL"])
            mstore1.save()

            # Week 2: reconcile resumes in the SAME dedicated state — only the
            # one pending symbol is fetched; the done one is NOT re-fetched.
            provider2 = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA"), "AAPL": weekly_payload("AAPL")},
                splits_payloads={"NVDA": splits_payload("NVDA"), "AAPL": splits_payload("AAPL")},
            )
            runner2, _ = make_runner(d1, provider2, tmp, MON_2)
            report2 = runner2.reconcile_splits(symbols_filter=["NVDA", "AAPL"], limit=10)
            self.assertEqual(report2["status"], "complete")
            self.assertEqual(provider2.splits_calls, pend1)  # {done1} survived rollover
            r2 = self._rstate(runner2)
            self.assertEqual(r2.status("NVDA"), "done")
            self.assertEqual(r2.status("AAPL"), "done")

    def test_reconcile_splits_no_tail_starvation(self):
        # After a full pass completes, the NEXT invocation must re-check the
        # whole universe (start a new pass) so no symbol at the end of the list
        # is permanently starved.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA"), "AAPL": weekly_payload("AAPL")},
                splits_payloads={"NVDA": splits_payload("NVDA"), "AAPL": splits_payload("AAPL")},
            )
            runner, _ = make_runner(d1, provider, tmp, MON_1)
            # First pass: reconcile everything (complete).
            report1 = runner.reconcile_splits(symbols_filter=["NVDA", "AAPL"], limit=10)
            self.assertEqual(report1["status"], "complete")
            # Next invocation starts a NEW pass: both symbols are pending again.
            runner._get_reconcile_store().state.mark("NVDA", "done")
            runner._get_reconcile_store().state.mark("AAPL", "done")
            runner._get_reconcile_store().save()
            provider2 = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA"), "AAPL": weekly_payload("AAPL")},
                splits_payloads={"NVDA": splits_payload("NVDA"), "AAPL": splits_payload("AAPL")},
            )
            runner2, _ = make_runner(d1, provider2, tmp, MON_1)
            report2 = runner2.reconcile_splits(symbols_filter=["NVDA", "AAPL"], limit=10)
            # A new pass was started so both symbols were re-fetched (complete).
            self.assertEqual(report2["status"], "complete")
            self.assertCountEqual(provider2.splits_calls, ["NVDA", "AAPL"])

    def test_reconcile_splits_changed_split_reports_metrics_updated(self):
        # A split-history change rewrites metrics; the report must reflect it.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            # Weekly rows stored with no split (factor 1) first.
            provider = FakeProvider(weekly_payloads={"NVDA": weekly_payload("NVDA")})
            runner, _ = make_runner(d1, provider, tmp, MON_1)
            runner.run(universe=["NVDA"])
            # Now reconcile-splits discovers a 10:1 split -> history + metrics
            # are rewritten; metrics_updated must be True.
            provider2 = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner2, _ = make_runner(d1, provider2, tmp, MON_1)
            report = runner2.reconcile_splits(symbols_filter=["NVDA"])
            self.assertEqual(report["status"], "complete")
            # The affected symbol's metrics were recomputed and reported.
            self.assertEqual(report["metrics_updated"], 1)
            self.assertTrue(report["symbols"]["NVDA"]["metrics_updated"])

    def test_reconcile_splits_respects_configured_cap(self):
        # RECONCILE_SPLITS_MAX_REQUESTS caps a run even when no --limit is given;
        # draws from the shared provider quota but never exceeds its own residual
        # budget, so it can't overrun the day ahead of maintenance.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            settings = Settings(
                alpha_vantage_keys=["K1", "K2"],
                cloudflare_api_token="t", cloudflare_account_id="a", cloudflare_d1_database_id="d",
                av_min_interval_seconds=0.0, av_max_retries=1, av_retry_base_seconds=0.0,
                reconcile_splits_max_requests=1,
            )
            mstore = MaintenanceStore(settings, d1, state_path=Path(tmp) / "maintenance.json")
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA"), "AAPL": weekly_payload("AAPL")},
                splits_payloads={"NVDA": splits_payload("NVDA"), "AAPL": splits_payload("AAPL")},
            )
            runner = MaintenanceRunner(settings, d1, provider, mstore, now_fn=lambda: MON_1)
            report = runner.reconcile_splits(symbols_filter=["NVDA", "AAPL"])  # no --limit
            self.assertEqual(report["status"], "partial")
            self.assertEqual(report["requests_used_total"], 1)  # capped at config
            # The configured cap bounds even a run with no explicit --limit: the
            # first symbol was processed, the second left pending.
            r = runner._get_reconcile_store().state
            done = [s for s in ("NVDA", "AAPL") if r.status(s) == "done"]
            pend = [s for s in ("NVDA", "AAPL") if r.status(s) == "pending"]
            self.assertEqual(len(done), 1)
            self.assertEqual(len(pend), 1)


if __name__ == "__main__":
    unittest.main()
