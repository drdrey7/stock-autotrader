"""Tests for weekly maintenance (history ingestor)."""

from __future__ import annotations

import datetime as dt
import tempfile
import unittest
from pathlib import Path

from history_ingestor.config import Settings
from history_ingestor.maintenance import MaintenanceRunner
from history_ingestor.state import StateStore

try:
    from test_bootstrap import NOW, FakeD1, FakeProvider, splits_payload, weekly_payload
except ModuleNotFoundError:  # imported as tests.test_maintenance (module path mode)
    from tests.test_bootstrap import NOW, FakeD1, FakeProvider, splits_payload, weekly_payload  # type: ignore[no-redef]


def settings_with(keys=("K1", "K2")):
    return Settings(
        alpha_vantage_keys=list(keys),
        cloudflare_api_token="t", cloudflare_account_id="a", cloudflare_d1_database_id="d",
        av_min_interval_seconds=0.0, av_max_retries=1, av_retry_base_seconds=0.0,
    )


def make_runner(d1, provider, tmp):
    settings = settings_with()
    store = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
    return MaintenanceRunner(settings, d1, provider, store, now_fn=lambda: NOW), store


class MaintenanceTests(unittest.TestCase):
    def test_no_change_run_updates_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner, store = make_runner(d1, provider, tmp)
            first = runner.run(universe=["NVDA"])
            # First run populates the table (no prior data -> everything writes).
            self.assertGreater(first["symbols"]["NVDA"]["rows_updated"], 0)
            # Second run against identical data -> nothing to rewrite.
            runner2, _ = make_runner(d1, provider, tmp)
            report = runner2.run(universe=["NVDA"])
            self.assertEqual(report["symbols"]["NVDA"]["rows_updated"], 0)
            self.assertEqual(report["symbols"]["NVDA"]["completed_weeks"], 260)
            self.assertTrue(report["symbols"]["NVDA"]["metrics_updated"])
            self.assertEqual(report["anomalies"], [])
            self.assertFalse(report["quota_exhausted"])

    def test_split_history_change_rewrites_affected_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            # First pass: no splits.
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": {"symbol": "NVDA", "data": []}},
            )
            runner, store = make_runner(d1, provider, tmp)
            runner.run(universe=["NVDA"])
            pre_rows = len(d1.weekly["NVDA"])
            self.assertEqual(pre_rows, 260)

            # Second pass: a 10:1 split appears — ALL earlier rows rewrite.
            provider2 = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner2, _ = make_runner(d1, provider2, tmp)
            report2 = runner2.run(universe=["NVDA"])
            rows = d1.weekly["NVDA"]
            pre_split_rows = [r for r in rows if r[1] < "2024-06-10"]
            self.assertEqual(report2["symbols"]["NVDA"]["rows_updated"], len(pre_split_rows))
            # No mixed regime: every pre-split row carries factor 10; the split
            # week (first row at/after the split date) and later rows carry 1.
            for r in rows:
                expected = 10.0 if r[1] < "2024-06-10" else 1.0
                self.assertEqual(r[7], expected, f"{r[1]} factor")
                self.assertAlmostEqual(r[8], r[5] / expected, places=6, msg=f"{r[1]} adjusted")
            self.assertEqual(len(rows), 260)  # no duplicate rows

    def test_second_change_from_10x_to_10x_plus_2x_rewrites_more(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner, store = make_runner(d1, provider, tmp)
            runner.run(universe=["NVDA"])
            provider2 = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA", n_weeks=600)},
                splits_payloads={"NVDA": {"symbol": "NVDA", "data": [
                    {"effective_date": "2021-07-20", "split_factor": "4.0000"},
                    {"effective_date": "2024-06-10", "split_factor": "10.0000"},
                ]}},
            )
            runner2, _ = make_runner(d1, provider2, tmp)
            report2 = runner2.run(universe=["NVDA"])
            # Rows before 2021-07-20 rewrite (factor 40); 2021-2024 rows factor 10;
            # rows at/after 2024-06-10 factor 1.
            for r in d1.weekly["NVDA"]:
                if r[1] < "2021-07-20":
                    expected = 40.0
                elif r[1] < "2024-06-10":
                    expected = 10.0
                else:
                    expected = 1.0
                self.assertEqual(r[7], expected, f"{r[1]} factor")
            self.assertGreater(report2["symbols"]["NVDA"]["rows_updated"], 200)
            self.assertEqual(len(d1.weekly["NVDA"]), 600)  # upsert, never append

    def test_quota_stop_saves_report_and_stops(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={s: weekly_payload(s) for s in ("A", "B")},
                splits_payloads={s: splits_payload(s) for s in ("A", "B")},
                quota_after=3,
            )
            runner, store = make_runner(d1, provider, tmp)
            report = runner.run(universe=["A", "B"])
            self.assertTrue(report["quota_exhausted"])
            self.assertIn("A", report["symbols"])
            self.assertIn("quota", " ".join(report["anomalies"]))
            # app_meta mirror written.
            self.assertIn("historyMaintenanceReport", d1.meta)

    def test_coverage_anomalies_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={"NBIS": weekly_payload("NBIS", n_weeks=90)},
                splits_payloads={"NBIS": {"symbol": "NBIS", "data": []}},
            )
            runner, store = make_runner(d1, provider, tmp)
            report = runner.run(universe=["NBIS"])
            anomalies = report["anomalies"]
            self.assertTrue(any("NotEnoughHistory" in a for a in anomalies))
            self.assertEqual(report["symbols"]["NBIS"]["completed_weeks"], 90)

    def test_dry_run_never_touches_provider_or_d1(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner, _ = make_runner(d1, provider, tmp)
            runner.run(universe=["NVDA"], dry_run=True)
            self.assertEqual(provider.requests_this_run, 0)
            self.assertEqual(d1.written_rows, 0)


if __name__ == "__main__":
    unittest.main()
