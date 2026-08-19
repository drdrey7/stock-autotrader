"""Tests for the bootstrap orchestration (history ingestor)."""

from __future__ import annotations

import datetime as dt
import tempfile
import unittest
from pathlib import Path

from history_ingestor.bootstrap import BootstrapRunner
from history_ingestor.config import Settings
from history_ingestor.state import StateStore


def settings_with(keys=("K1", "K2")):
    return Settings(
        alpha_vantage_keys=list(keys),
        cloudflare_api_token="t", cloudflare_account_id="a", cloudflare_d1_database_id="d",
        av_min_interval_seconds=0.0, av_max_retries=1, av_retry_base_seconds=0.0,
    )


def weekly_payload(symbol, n_weeks=260, end="2026-08-14"):
    """n_weeks completed weekly buckets ending at ``end`` (newest-first like AV)."""
    import datetime as _dt
    series = {}
    end_date = _dt.date.fromisoformat(end)
    for i in range(n_weeks):
        week = end_date - _dt.timedelta(weeks=i)
        price = 100.0 + i * 0.5
        series[week.isoformat()] = {
            "1. open": str(price), "2. high": str(price + 1), "3. low": str(price - 1),
            "4. close": str(price), "5. volume": "100000",
        }
    return {
        "Meta Data": {"1. Information": "Weekly Prices", "2. Symbol": symbol,
                      "3. Last Refreshed": "2026-08-18", "4. Time Zone": "US/Eastern"},
        "Weekly Time Series": series,
    }


def splits_payload(symbol):
    return {"symbol": symbol, "data": [
        {"effective_date": "2024-06-10", "split_factor": "10.0000"},
    ]}


class FakeD1:
    def __init__(self):
        self.weekly: dict[str, list] = {}
        self.metrics: dict[str, dict] = {}
        self.meta: dict[str, dict] = {}
        self.written_rows = 0

    def upsert_weekly_rows(self, rows):
        self.written_rows += len(rows)
        for row in rows:
            # Real D1 semantics: UPSERT keyed by (symbol, week_end_date).
            bucket = self.weekly.setdefault(row[0], [])
            bucket[:] = [existing for existing in bucket if existing[1] != row[1]]
            bucket.append(row)
        return type("R", (), {"written": [r[0] for r in rows], "failed": [], "error": None})()

    def upsert_technical_metrics(self, metrics):
        self.metrics[metrics["symbol"]] = metrics
        return type("R", (), {"written": [metrics["symbol"]], "failed": [], "error": None})()

    def read_technical_metrics(self):
        return [{"symbol": s} for s in self.metrics]

    def read_weekly_rows(self, symbol):
        return [{
            "symbol": r[0], "week_end_date": r[1], "raw_open": r[2], "raw_high": r[3],
            "raw_low": r[4], "raw_close": r[5], "volume": r[6],
            "split_adjustment_factor": r[7], "split_adjusted_close": r[8],
            "source": "alpha-vantage", "source_fetched_at": r[9],
        } for r in self.weekly.get(symbol, [])]

    def write_app_meta(self, key, value):
        self.meta[key] = value
        return True

    def read_app_meta(self, key):
        return self.meta.get(key)


class FakeProvider:
    """Deterministic provider; counts requests; can raise quota on demand.

    Returns PARSED bars/events (like the real client); raw payloads are run
    through the real parsers so the whole ingestion path is exercised.
    """

    def __init__(self, weekly_payloads=None, splits_payloads=None,
                 quota_after=None, weekly_error=None):
        from history_ingestor.parser import parse_splits_payload, parse_weekly_payload
        self._parse_weekly = parse_weekly_payload
        self._parse_splits = parse_splits_payload
        self._weekly = weekly_payloads or {}
        self._splits = splits_payloads or {}
        self.requests_this_run = 0
        self.quota_after = quota_after
        self.weekly_calls = []
        self.splits_calls = []
        self.call_log: list[tuple[str, str]] = []  # (kind, symbol), in order
        self._weekly_error = weekly_error

    def fetch_weekly(self, symbol):
        self.requests_this_run += 1
        self.weekly_calls.append(symbol)
        self.call_log.append(("weekly", symbol))
        if self._weekly_error and symbol in self._weekly_error:
            from history_ingestor.provider import ProviderError
            raise ProviderError(self._weekly_error[symbol])
        if self.quota_after is not None and self.requests_this_run > self.quota_after:
            from history_ingestor.provider import QuotaExhaustedError
            raise QuotaExhaustedError("quota")
        return 0, self._parse_weekly(symbol, self._weekly[symbol]), ""

    def fetch_splits(self, symbol):
        self.requests_this_run += 1
        self.splits_calls.append(symbol)
        self.call_log.append(("splits", symbol))
        if self.quota_after is not None and self.requests_this_run > self.quota_after:
            from history_ingestor.provider import QuotaExhaustedError
            raise QuotaExhaustedError("quota")
        return 0, self._parse_splits(symbol, self._splits[symbol]), ""


class FakeLedger:
    def __init__(self):
        self.used = [0, 0]

    def remaining(self, index):
        return 25 - self.used[index]

    def mark_used(self, index, delta=1):
        self.used[index] += delta

    def mark_exhausted(self, index):
        self.used[index] = 25


def make_runner(d1=None, provider=None, tmp="/tmp/hi-test", now=None):
    settings = settings_with()
    d1 = d1 or FakeD1()
    store = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
    provider = provider or FakeProvider(
        weekly_payloads={"NVDA": weekly_payload("NVDA")},
        splits_payloads={"NVDA": splits_payload("NVDA")},
    )
    runner = BootstrapRunner(settings, d1, provider, store, now_fn=now)
    return runner, d1, provider, store


NOW = dt.datetime(2026, 8, 19, 12, 0, tzinfo=dt.UTC)


class BootstrapTests(unittest.TestCase):
    def test_full_bootstrap_splits_before_weekly(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner, d1, provider, store = make_runner(tmp=tmp, now=lambda: NOW)
            report = runner.run(universe=["NVDA"], symbols_filter=["NVDA"])
            self.assertEqual(report["status"], "complete")
            self.assertEqual(provider.splits_calls, ["NVDA"])
            self.assertEqual(provider.weekly_calls, ["NVDA"])
            # Splits fetched before weekly (adjustment correctness).
            self.assertEqual(provider.call_log, [("splits", "NVDA"), ("weekly", "NVDA")])
            # In-progress week excluded: payload ends 2026-08-14; NOW is 08-19.
            rows = d1.weekly["NVDA"]
            self.assertEqual(len(rows), 260)
            self.assertEqual(rows[-1][1], "2026-08-14")  # ascending order
            self.assertEqual(rows[0][1], "2021-08-27")
            # Split adjustment: rows before the 2024-06-10 split carry factor
            # 10 and adjusted close == raw / 10; the split week and later
            # rows are untouched.
            for r in rows:
                expected = 10.0 if r[1] < "2024-06-10" else 1.0
                self.assertEqual(r[7], expected, f"{r[1]} factor")
                self.assertAlmostEqual(r[8], r[5] / expected, places=6, msg=f"{r[1]} adjusted")
            # Metrics computed and written.
            metrics = d1.metrics["NVDA"]
            self.assertEqual(metrics["status"], "ok")
            self.assertEqual(metrics["completed_weeks_available"], 260)
            self.assertIsNotNone(metrics["sum_199"])
            # Checkpoint marks both endpoints done.
            self.assertEqual(store.symbol_status("NVDA", "splits"), "done")
            self.assertEqual(store.symbol_status("NVDA", "weekly"), "done")

    def test_resume_skips_done_symbols_no_duplicate_downloads(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner, d1, provider, store = make_runner(tmp=tmp, now=lambda: NOW)
            runner.run(universe=["NVDA"], symbols_filter=["NVDA"])
            first_requests = provider.requests_this_run
            runner2 = BootstrapRunner(settings_with(), d1, provider, store, now_fn=lambda: NOW)
            report = runner2.run(universe=["NVDA"], symbols_filter=["NVDA"])
            self.assertEqual(report["status"], "complete")
            self.assertEqual(provider.requests_this_run, first_requests)  # no new requests
            self.assertEqual(report["symbols_done"], 1)

    def test_interrupted_run_resumes_from_checkpoint(self):
        with tempfile.TemporaryDirectory() as tmp:
            # Universe A,B,C; quota stops after 3 requests (A splits+weekly, B splits).
            settings = settings_with()
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={s: weekly_payload(s) for s in ("A", "B", "C")},
                splits_payloads={s: splits_payload(s) for s in ("A", "B", "C")},
                quota_after=3,
            )
            store = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
            runner = BootstrapRunner(settings, d1, provider, store, now_fn=lambda: NOW)
            report = runner.run(universe=["A", "B", "C"])
            self.assertEqual(report["status"], "quota")
            self.assertTrue(report["quota_exhausted"])
            self.assertIn("B", report["remaining_symbols"])
            self.assertIn("C", report["remaining_symbols"])
            # A fully done; B splits done but weekly pending.
            self.assertEqual(store.symbol_status("A", "weekly"), "done")
            self.assertEqual(store.symbol_status("B", "splits"), "done")
            self.assertEqual(store.symbol_status("B", "weekly"), "pending")

            # New day: quota resets; resume completes everything.
            provider2 = FakeProvider(
                weekly_payloads={s: weekly_payload(s) for s in ("A", "B", "C")},
                splits_payloads={s: splits_payload(s) for s in ("A", "B", "C")},
            )
            store2 = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
            runner2 = BootstrapRunner(settings, d1, provider2, store2, now_fn=lambda: NOW)
            report2 = runner2.run(universe=["A", "B", "C"])
            self.assertEqual(report2["status"], "complete")
            self.assertEqual(report2["symbols_done"], 3)
            # No duplicate downloads: A was not refetched.
            self.assertNotIn("A", provider2.weekly_calls)
            self.assertEqual(sorted(provider2.weekly_calls), ["B", "C"])

    def test_quota_mid_weekly_keeps_splits_done(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            provider = FakeProvider(
                weekly_payloads={"A": weekly_payload("A")},
                splits_payloads={"A": splits_payload("A")},
                quota_after=1,  # splits ok (request 1), weekly hits quota (request 2)
            )
            settings = settings_with()
            store = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
            runner = BootstrapRunner(settings, d1, provider, store, now_fn=lambda: NOW)
            report = runner.run(universe=["A"])
            self.assertEqual(report["status"], "quota")
            self.assertEqual(store.symbol_status("A", "splits"), "done")
            self.assertEqual(store.symbol_status("A", "weekly"), "pending")
            self.assertIn("A", report["remaining_symbols"])

    def test_dry_run_no_d1_writes_no_provider_calls(self):
        with tempfile.TemporaryDirectory() as tmp:
            # dry-run mode must not touch the network or D1.
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            d1 = FakeD1()
            settings = settings_with()
            store = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
            runner = BootstrapRunner(settings, d1, provider, store, now_fn=lambda: NOW)
            report = runner.run(universe=["NVDA"], dry_run=True)
            self.assertEqual(report["status"], "plan")
            self.assertEqual(provider.requests_this_run, 0)
            self.assertEqual(d1.written_rows, 0)

    def test_provider_error_marks_symbol_error_and_continues(self):
        with tempfile.TemporaryDirectory() as tmp:
            provider = FakeProvider(
                weekly_payloads={"A": weekly_payload("A"), "B": weekly_payload("B")},
                splits_payloads={"A": splits_payload("A"), "B": splits_payload("B")},
                weekly_error={"B": "provider message: Invalid API call"},
            )
            d1 = FakeD1()
            settings = settings_with()
            store = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
            runner = BootstrapRunner(settings, d1, provider, store, now_fn=lambda: NOW)
            report = runner.run(universe=["A", "B"])
            self.assertEqual(report["status"], "partial")
            self.assertEqual(store.symbol_status("A", "weekly"), "done")
            self.assertEqual(store.symbol_status("B", "weekly"), "error")
            self.assertIn("B", report["remaining_symbols"])
            self.assertTrue(any("B" in e for e in report["errors"]))

    def test_metrics_reconciled_for_previously_done_symbols(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner, d1, provider, store = make_runner(tmp=tmp, now=lambda: NOW)
            runner.run(universe=["NVDA"], symbols_filter=["NVDA"])
            # Simulate a crash: metrics row lost, symbol done in checkpoint.
            del d1.metrics["NVDA"]
            provider2 = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner2 = BootstrapRunner(settings_with(), d1, provider2, store, now_fn=lambda: NOW)
            report = runner2.run(universe=["NVDA"], symbols_filter=["NVDA"])
            self.assertEqual(report["status"], "complete")
            self.assertIn("NVDA", d1.metrics)  # recomputed from D1 rows
            self.assertEqual(provider2.requests_this_run, 0)  # no provider calls


if __name__ == "__main__":
    unittest.main()
