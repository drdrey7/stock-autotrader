"""Tests for the bootstrap orchestration (history ingestor)."""

from __future__ import annotations

import datetime as dt
import tempfile
import unittest
from pathlib import Path

from history_ingestor.bootstrap import BootstrapRunner
from history_ingestor.config import Settings
from history_ingestor.provider import ProviderError
from history_ingestor.state import StateStore


def settings_with(keys=("K1", "K2")):
    return Settings(
        alpha_vantage_keys=list(keys),
        cloudflare_api_token="t", cloudflare_account_id="a", cloudflare_d1_database_id="d",
        av_min_interval_seconds=0.0, av_max_retries=1, av_retry_base_seconds=0.0,
    )


def weekly_payload(symbol, n_weeks=260, end="2026-08-14"):
    """n_weeks completed weekly buckets ending at ``end`` (newest-first like AV).

    Prices are DATE-DETERMINISTIC (a given week_end_date always yields the same
    non-uniform close, independent of ``n_weeks``), so a second run that adds
    one week changes exactly one row — the new week. The provider-correction
    and new-split tests rely on this identity.
    """
    import datetime as _dt
    series = {}
    end_date = _dt.date.fromisoformat(end)
    for i in range(n_weeks):
        week = end_date - _dt.timedelta(weeks=i)
        # Date-keyed deterministic series: same date -> same price; consecutive
        # weeks differ (0.05 per ordinal day ~ 0.35/week, non-uniform).
        price = 10.0 + ((week.toordinal()) % 400) * 0.05
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


def future_splits_payload(symbol, future_date="2026-09-15"):
    """Splits payload with one past and one future-dated split."""
    return {"symbol": symbol, "data": [
        {"effective_date": "2024-06-10", "split_factor": "10.0000"},
        {"effective_date": future_date, "split_factor": "4.0000"},
    ]}


class FakeD1:
    def __init__(self):
        self.weekly: dict[str, list] = {}
        self.metrics: dict[str, dict] = {}
        self.meta: dict[str, dict] = {}
        self.split_events: dict[str, list] = {}
        self.written_rows = 0
        self.split_write_fail = False
        self.metrics_write_fail = False

    def upsert_weekly_rows(self, rows):
        self.written_rows += len(rows)
        for row in rows:
            # Real D1 semantics: UPSERT keyed by (symbol, week_end_date).
            bucket = self.weekly.setdefault(row[0], [])
            bucket[:] = [existing for existing in bucket if existing[1] != row[1]]
            bucket.append(row)
        return type("R", (), {"written": [r[0] for r in rows], "failed": [], "error": None})()

    def upsert_technical_metrics(self, metrics):
        if self.metrics_write_fail:
            return type("R", (), {"written": [], "failed": [metrics["symbol"]], "error": "D1 metrics write failed"})()
        self.metrics[metrics["symbol"]] = metrics
        return type("R", (), {"written": [metrics["symbol"]], "failed": [], "error": None})()

    def upsert_split_events(self, rows):
        if self.split_write_fail:
            return type("R", (), {"written": [], "failed": [r[0] for r in rows], "error": "D1 split write failed"})()
        for row in rows:
            # (symbol, effective_date, split_factor, source_fetched_at)
            bucket = self.split_events.setdefault(row[0], [])
            bucket[:] = [e for e in bucket if e["effective_date"] != row[1]]
            bucket.append({
                "symbol": row[0], "effective_date": row[1], "split_factor": row[2],
                "source": "alpha-vantage", "source_fetched_at": row[3],
            })
            bucket.sort(key=lambda e: e["effective_date"])
        return type("R", (), {"written": [r[0] for r in rows], "failed": [], "error": None})()

    def delete_extra_split_events(self, symbol, keep_dates):
        bucket = self.split_events.setdefault(symbol, [])
        keep = set(keep_dates)
        self.split_events[symbol] = [e for e in bucket if e["effective_date"] in keep]
        return type("R", (), {"written": [symbol], "failed": [], "error": None})()

    def read_split_events(self, symbol):
        return list(self.split_events.get(symbol, []))

    def read_all_split_events(self):
        return {s: list(v) for s, v in self.split_events.items()}

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
                 quota_after=None, weekly_error=None, throttle_on=None):
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
        # throttle_on: set of (kind, symbol) that raise ThrottleExhaustedError
        self._throttle_on = set(throttle_on or [])
        self.attempt_log: list[dict] = []

    def fetch_weekly(self, symbol):
        self.requests_this_run += 1
        self.weekly_calls.append(symbol)
        self.call_log.append(("weekly", symbol))
        if ("weekly", symbol) in self._throttle_on:
            from history_ingestor.provider import ThrottleExhaustedError
            raise ThrottleExhaustedError("provider throttle on 2 key(s)")
        if self._weekly_error and symbol in self._weekly_error:
            from history_ingestor.provider import ProviderError
            raise ProviderError(self._weekly_error[symbol])
        if self.quota_after is not None and self.requests_this_run > self.quota_after:
            from history_ingestor.provider import QuotaExhaustedError
            raise QuotaExhaustedError("quota")
        from history_ingestor.parser import PayloadError
        from history_ingestor.provider import ProviderError as PE
        try:
            return 0, self._parse_weekly(symbol, self._weekly[symbol]), ""
        except PayloadError as exc:
            raise PE(f"WEEKLY {symbol}: {exc}") from exc

    def fetch_splits(self, symbol):
        self.requests_this_run += 1
        self.splits_calls.append(symbol)
        self.call_log.append(("splits", symbol))
        if ("splits", symbol) in self._throttle_on:
            from history_ingestor.provider import ThrottleExhaustedError
            raise ThrottleExhaustedError("provider throttle on 2 key(s)")
        if self.quota_after is not None and self.requests_this_run > self.quota_after:
            from history_ingestor.provider import QuotaExhaustedError
            raise QuotaExhaustedError("quota")
        from history_ingestor.parser import PayloadError
        from history_ingestor.provider import ProviderError as PE
        try:
            return 0, self._parse_splits(symbol, self._splits[symbol]), ""
        except PayloadError as exc:
            raise PE(f"SPLITS {symbol}: {exc}") from exc


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

    def test_split_events_persisted_durably_on_fetch(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner, d1, provider, store = make_runner(tmp=tmp, now=lambda: NOW)
            runner.run(universe=["NVDA"], symbols_filter=["NVDA"])
            rows = d1.read_split_events("NVDA")
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["effective_date"], "2024-06-10")
            self.assertEqual(rows[0]["split_factor"], 10.0)
            self.assertEqual(rows[0]["source"], "alpha-vantage")

    def test_resume_after_splits_does_not_refetch_splits(self):
        # Spec #4: Day 1 SPLITS completes, quota dies before WEEKLY; Day 2
        # resumes: SPLITS must be loaded from D1 (split_events), NEVER requested
        # again; WEEKLY continues; result identical.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            settings = settings_with()
            provider1 = FakeProvider(
                weekly_payloads={"A": weekly_payload("A")},
                splits_payloads={"A": splits_payload("A")},
                quota_after=1,  # splits ok (req 1), weekly hits quota (req 2)
            )
            store1 = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
            runner1 = BootstrapRunner(settings, d1, provider1, store1, now_fn=lambda: NOW)
            report1 = runner1.run(universe=["A"])
            self.assertEqual(report1["status"], "quota")
            self.assertEqual(store1.symbol_status("A", "splits"), "done")
            self.assertEqual(store1.symbol_status("A", "weekly"), "pending")
            # Split history is durable — NOT RAM-only.
            self.assertEqual(len(d1.read_split_events("A")), 1)

            # Day 2: fresh process, fresh provider — resumes from the checkpoint.
            provider2 = FakeProvider(
                weekly_payloads={"A": weekly_payload("A")},
                splits_payloads={"A": splits_payload("A")},
            )
            store2 = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
            runner2 = BootstrapRunner(settings, d1, provider2, store2, now_fn=lambda: NOW)
            report2 = runner2.run(universe=["A"])
            self.assertEqual(report2["status"], "complete")
            # THE regression: A's SPLITS are NOT requested again.
            self.assertEqual(provider2.splits_calls, [])
            self.assertEqual(provider2.weekly_calls, ["A"])
            # WEEKLY continued and the result is identical to a same-day run.
            rows = d1.weekly["A"]
            self.assertEqual(len(rows), 260)
            self.assertEqual(rows[-1][1], "2026-08-14")
            self.assertIn("A", d1.metrics)

    def test_verified_zero_splits_resume_without_refetch(self):
        # A symbol with data: [] persists ZERO split_events rows, yet resume
        # must still NOT refetch SPLITS (the empty durable store IS the record
        # of "no splits" for a post-fix symbol).
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            settings = settings_with()
            provider1 = FakeProvider(
                weekly_payloads={"NBIS": weekly_payload("NBIS")},
                splits_payloads={"NBIS": {"symbol": "NBIS", "data": []}},
                quota_after=1,
            )
            store1 = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
            runner1 = BootstrapRunner(settings, d1, provider1, store1, now_fn=lambda: NOW)
            report1 = runner1.run(universe=["NBIS"])
            self.assertEqual(report1["status"], "quota")
            self.assertEqual(store1.symbol_status("NBIS", "weekly"), "pending")

            provider2 = FakeProvider(
                weekly_payloads={"NBIS": weekly_payload("NBIS")},
                splits_payloads={"NBIS": {"symbol": "NBIS", "data": []}},
            )
            store2 = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
            runner2 = BootstrapRunner(settings, d1, provider2, store2, now_fn=lambda: NOW)
            report2 = runner2.run(universe=["NBIS"])
            self.assertEqual(report2["status"], "complete")
            self.assertEqual(provider2.splits_calls, [])
            self.assertEqual(provider2.weekly_calls, ["NBIS"])
            # All factors are 1 for a no-split symbol.
            for r in d1.weekly["NBIS"]:
                self.assertEqual(r[7], 1.0)

    def test_malformed_splits_payload_does_not_ingest_weekly(self):
        # A malformed SPLITS payload (missing data array) is a parser error:
        # the symbol is marked error and WEEKLY is NOT ingested with factor 1.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            settings = settings_with()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": {"symbol": "NVDA", "data": "oops"}},
            )
            store = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
            runner = BootstrapRunner(settings, d1, provider, store, now_fn=lambda: NOW)
            report = runner.run(universe=["NVDA"])
            self.assertEqual(report["status"], "partial")
            self.assertEqual(store.symbol_status("NVDA", "splits"), "error")
            self.assertEqual(store.symbol_status("NVDA", "weekly"), "pending")
            self.assertNotIn("NVDA", d1.weekly)  # nothing written with factor 1
            self.assertEqual(d1.read_split_events("NVDA"), [])

    def test_split_durable_write_failure_keeps_symbol_pending(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.split_write_fail = True
            settings = settings_with()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            store = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
            runner = BootstrapRunner(settings, d1, provider, store, now_fn=lambda: NOW)
            report = runner.run(universe=["NVDA"])
            # Durable write failed -> splits NOT marked done; weekly not run.
            self.assertEqual(store.symbol_status("NVDA", "splits"), "error")
            self.assertEqual(store.symbol_status("NVDA", "weekly"), "pending")
            self.assertIn("NVDA", report["remaining_symbols"])
            self.assertNotIn("NVDA", d1.weekly)

    def test_metrics_write_failure_keeps_symbol_error_not_done(self):
        # A failed technical_metrics D1 write must NOT silently mark the symbol done.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            d1.metrics_write_fail = True
            settings = settings_with()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            store = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
            runner = BootstrapRunner(settings, d1, provider, store, now_fn=lambda: NOW)
            report = runner.run(universe=["NVDA"])
            # Metrics write failed -> weekly marked error (retried next run).
            self.assertEqual(store.symbol_status("NVDA", "weekly"), "error")
            self.assertIn("NVDA", report["remaining_symbols"])
            self.assertIn("technical_metrics write failed", report["errors"][0])

    def test_metrics_write_success_completes_normally(self):
        # Normal successful metrics write still completes normally.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            settings = settings_with()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            store = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
            runner = BootstrapRunner(settings, d1, provider, store, now_fn=lambda: NOW)
            report = runner.run(universe=["NVDA"])
            self.assertEqual(report["status"], "complete")
            self.assertEqual(store.symbol_status("NVDA", "weekly"), "done")
            self.assertIn("NVDA", d1.metrics)

    def test_bootstrap_does_not_apply_future_dated_splits(self):
        # A future-dated split must NOT be applied to the historical basis at bootstrap.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            settings = settings_with()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": future_splits_payload("NVDA", future_date="2026-09-15")},
            )
            store = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
            runner = BootstrapRunner(settings, d1, provider, store, now_fn=lambda: NOW)
            report = runner.run(universe=["NVDA"])
            self.assertEqual(report["status"], "complete")
            # Future split (2026-09-15) must NOT be applied: rows before 2024-06-10
            # should have factor 10 (past split), rows after 2024-06-10 should have
            # factor 1 (future split not yet effective).
            rows = d1.weekly["NVDA"]
            for r in rows:
                if r[1] < "2024-06-10":
                    self.assertEqual(r[7], 10.0, f"{r[1]} factor should be 10 (past split only)")
                else:
                    self.assertEqual(r[7], 1.0, f"{r[1]} factor should be 1 (future split not applied)")

    def test_reconcile_previous_metrics_write_failure_surfaces_error(self):
        # Repair path: failed metrics write must surface, not silently succeed.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            settings = settings_with()
            provider = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            store = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
            # First run: succeeds.
            runner = BootstrapRunner(settings, d1, provider, store, now_fn=lambda: NOW)
            runner.run(universe=["NVDA"])
            self.assertEqual(store.symbol_status("NVDA", "weekly"), "done")

            # Simulate metrics row loss + failed repair write.
            d1.metrics.clear()
            d1.metrics_write_fail = True
            provider2 = FakeProvider(
                weekly_payloads={"NVDA": weekly_payload("NVDA")},
                splits_payloads={"NVDA": splits_payload("NVDA")},
            )
            runner2 = BootstrapRunner(settings, d1, provider2, store, now_fn=lambda: NOW)
            # Repair path must surface the failure (not silently return success).
            with self.assertRaises(ProviderError) as ctx:
                runner2.run(universe=["NVDA"])
            self.assertIn("technical_metrics write failed", str(ctx.exception))

    def test_provider_throttle_stops_run_without_permanent_error(self):
        """All-keys throttle must stop bootstrap and leave symbol pending."""
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            settings = settings_with()
            provider = FakeProvider(
                weekly_payloads={"A": weekly_payload("A"), "B": weekly_payload("B")},
                splits_payloads={"A": splits_payload("A"), "B": splits_payload("B")},
                throttle_on={("splits", "A")},
            )
            store = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
            runner = BootstrapRunner(settings, d1, provider, store, now_fn=lambda: NOW)
            report = runner.run(universe=["A", "B"])
            self.assertEqual(report["status"], "throttled")
            self.assertTrue(report["throttled"])
            self.assertFalse(report["quota_exhausted"])
            # No permanent ticker error from provider-wide throttle.
            self.assertEqual(store.symbol_status("A", "splits"), "pending")
            self.assertEqual(store.symbol_status("A", "weekly"), "pending")
            # Did not continue burning quota on B after throttle.
            self.assertEqual(provider.splits_calls, ["A"])
            self.assertEqual(provider.weekly_calls, [])
            self.assertEqual(d1.written_rows, 0)

    def test_throttle_preserves_prior_done_checkpoint(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            settings = settings_with()
            # First: complete A.
            provider1 = FakeProvider(
                weekly_payloads={"A": weekly_payload("A"), "B": weekly_payload("B")},
                splits_payloads={"A": splits_payload("A"), "B": splits_payload("B")},
            )
            store = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
            BootstrapRunner(settings, d1, provider1, store, now_fn=lambda: NOW).run(
                universe=["A", "B"], symbols_filter=["A"]
            )
            self.assertEqual(store.symbol_status("A", "weekly"), "done")
            # Second: throttle on B.
            provider2 = FakeProvider(
                weekly_payloads={"A": weekly_payload("A"), "B": weekly_payload("B")},
                splits_payloads={"A": splits_payload("A"), "B": splits_payload("B")},
                throttle_on={("splits", "B")},
            )
            store2 = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
            report = BootstrapRunner(settings, d1, provider2, store2, now_fn=lambda: NOW).run(
                universe=["A", "B"]
            )
            self.assertEqual(report["status"], "throttled")
            self.assertEqual(store2.symbol_status("A", "splits"), "done")
            self.assertEqual(store2.symbol_status("A", "weekly"), "done")
            self.assertEqual(store2.symbol_status("B", "splits"), "pending")
            self.assertNotIn("A", provider2.splits_calls)
            self.assertNotIn("A", provider2.weekly_calls)

    def test_fairness_pending_before_transient_errors(self):
        """Never-tried symbols must be attempted before sticky error symbols."""
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            settings = settings_with()
            store = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
            store.load()
            # ORCL-like sticky error head-of-line; SHOP never tried.
            store.mark_symbol("ORCL", "splits", "error")
            store.save()
            provider = FakeProvider(
                weekly_payloads={
                    "ORCL": weekly_payload("ORCL"),
                    "SHOP": weekly_payload("SHOP"),
                },
                splits_payloads={
                    "ORCL": splits_payload("ORCL"),
                    "SHOP": splits_payload("SHOP"),
                },
            )
            runner = BootstrapRunner(settings, d1, provider, store, now_fn=lambda: NOW)
            report = runner.run(universe=["ORCL", "SHOP"])
            self.assertEqual(report["status"], "complete")
            # SHOP (pending) before ORCL (error) in provider call order.
            self.assertEqual(provider.splits_calls[0], "SHOP")
            self.assertEqual(provider.splits_calls[1], "ORCL")
            self.assertEqual(store.symbol_status("SHOP", "weekly"), "done")
            self.assertEqual(store.symbol_status("ORCL", "weekly"), "done")

    def test_fairness_partial_before_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            settings = settings_with()
            store = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
            store.load()
            store.mark_symbol("ERR", "splits", "error")
            store.mark_symbol("PART", "splits", "done")  # weekly still pending
            # Seed durable empty splits for PART so weekly can proceed without refetch.
            d1.split_events["PART"] = []
            store.save()
            provider = FakeProvider(
                weekly_payloads={
                    "ERR": weekly_payload("ERR"),
                    "PART": weekly_payload("PART"),
                    "NEW": weekly_payload("NEW"),
                },
                splits_payloads={
                    "ERR": splits_payload("ERR"),
                    "PART": splits_payload("PART"),
                    "NEW": splits_payload("NEW"),
                },
            )
            runner = BootstrapRunner(settings, d1, provider, store, now_fn=lambda: NOW)
            report = runner.run(universe=["ERR", "PART", "NEW"])
            self.assertEqual(report["status"], "complete")
            # pending NEW first, then partial PART, then error ERR.
            first_symbols = []
            for _kind, sym in provider.call_log:
                if sym not in first_symbols:
                    first_symbols.append(sym)
            self.assertEqual(first_symbols, ["NEW", "PART", "ERR"])

    def test_report_counts_done_from_checkpoint_on_early_throttle(self):
        """A=done, B=pending; B throttles before loop visits A → done still 1."""
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            settings = settings_with()
            store = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
            store.load()
            store.mark_symbol("A", "splits", "done")
            store.mark_symbol("A", "weekly", "done")
            store.save()
            provider = FakeProvider(
                weekly_payloads={"A": weekly_payload("A"), "B": weekly_payload("B")},
                splits_payloads={"A": splits_payload("A"), "B": splits_payload("B")},
                throttle_on={("splits", "B")},
            )
            report = BootstrapRunner(settings, d1, provider, store, now_fn=lambda: NOW).run(
                universe=["A", "B"]
            )
            self.assertEqual(report["status"], "throttled")
            self.assertEqual(report["symbols_done"], 1)
            self.assertEqual(report["symbols_remaining"], 1)
            self.assertEqual(report["remaining_symbols"], ["B"])
            self.assertNotIn("A", report["remaining_symbols"])

    def test_report_remaining_excludes_all_done_on_mixed_early_throttle(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            settings = settings_with()
            store = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
            store.load()
            for sym in ("D1", "D2", "D3"):
                store.mark_symbol(sym, "splits", "done")
                store.mark_symbol(sym, "weekly", "done")
            store.mark_symbol("ERR", "splits", "error")
            store.save()
            provider = FakeProvider(
                weekly_payloads={
                    "D1": weekly_payload("D1"), "D2": weekly_payload("D2"),
                    "D3": weekly_payload("D3"), "PEND": weekly_payload("PEND"),
                    "ERR": weekly_payload("ERR"),
                },
                splits_payloads={
                    "D1": splits_payload("D1"), "D2": splits_payload("D2"),
                    "D3": splits_payload("D3"), "PEND": splits_payload("PEND"),
                    "ERR": splits_payload("ERR"),
                },
                throttle_on={("splits", "PEND")},
            )
            report = BootstrapRunner(settings, d1, provider, store, now_fn=lambda: NOW).run(
                universe=["D1", "D2", "D3", "PEND", "ERR"]
            )
            self.assertEqual(report["status"], "throttled")
            self.assertEqual(report["symbols_done"], 3)
            self.assertEqual(set(report["remaining_symbols"]), {"PEND", "ERR"})
            for done_sym in ("D1", "D2", "D3"):
                self.assertNotIn(done_sym, report["remaining_symbols"])

    def test_report_counts_done_from_checkpoint_on_early_quota(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            settings = settings_with()
            store = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
            store.load()
            store.mark_symbol("A", "splits", "done")
            store.mark_symbol("A", "weekly", "done")
            store.save()
            provider = FakeProvider(
                weekly_payloads={"A": weekly_payload("A"), "B": weekly_payload("B")},
                splits_payloads={"A": splits_payload("A"), "B": splits_payload("B")},
                quota_after=0,  # first provider call hits quota
            )
            report = BootstrapRunner(settings, d1, provider, store, now_fn=lambda: NOW).run(
                universe=["A", "B"]
            )
            self.assertEqual(report["status"], "quota")
            self.assertEqual(report["symbols_done"], 1)
            self.assertEqual(report["remaining_symbols"], ["B"])

    def test_report_counts_correct_on_full_complete_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            settings = settings_with()
            provider = FakeProvider(
                weekly_payloads={"A": weekly_payload("A"), "B": weekly_payload("B")},
                splits_payloads={"A": splits_payload("A"), "B": splits_payload("B")},
            )
            store = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
            report = BootstrapRunner(settings, d1, provider, store, now_fn=lambda: NOW).run(
                universe=["A", "B"]
            )
            self.assertEqual(report["status"], "complete")
            self.assertEqual(report["symbols_done"], 2)
            self.assertEqual(report["symbols_remaining"], 0)
            self.assertEqual(report["remaining_symbols"], [])


class BootstrapResidualBudgetTests(unittest.TestCase):
    """Once residual, bootstrap is hard request-capped so one problem symbol
    can never exhaust the day's Alpha Vantage quota ahead of maintenance."""

    def test_no_explicit_limit_applies_default_residual_cap(self):
        # Two symbols need 2 requests each (SPLITS+WEEKLY). Default cap 6 would
        # allow both — but set a tight default (2) and prove only 2 requests run,
        # leaving B pending.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            settings = Settings(
                alpha_vantage_keys=["K1", "K2"],
                cloudflare_api_token="t", cloudflare_account_id="a", cloudflare_d1_database_id="d",
                av_min_interval_seconds=0.0, av_max_retries=1, av_retry_base_seconds=0.0,
                bootstrap_max_requests_per_day=2,
            )
            store = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
            provider = FakeProvider(
                weekly_payloads={"A": weekly_payload("A"), "B": weekly_payload("B")},
                splits_payloads={"A": splits_payload("A"), "B": splits_payload("B")},
            )
            # No --limit passed: the residual default caps the run at 2 requests.
            report = BootstrapRunner(settings, d1, provider, store, now_fn=lambda: NOW).run(
                universe=["A", "B"]
            )
            self.assertEqual(report["status"], "partial")
            self.assertEqual(provider.requests_this_run, 2)
            self.assertEqual(report["requests_used_total"], 2)
            # A done; B pending (not exhausted by a runaway problem symbol).
            self.assertEqual(report["symbols_done"], 1)
            self.assertEqual(report["remaining_symbols"], ["B"])
            # B still honest pending — next day resumes it.
            self.assertEqual(store.symbol_status("B", "weekly"), "pending")

    def test_explicit_limit_overrides_default(self):
        # An explicit --limit larger than the default lets a full run complete.
        with tempfile.TemporaryDirectory() as tmp:
            d1 = FakeD1()
            settings = Settings(
                alpha_vantage_keys=["K1", "K2"],
                cloudflare_api_token="t", cloudflare_account_id="a", cloudflare_d1_database_id="d",
                av_min_interval_seconds=0.0, av_max_retries=1, av_retry_base_seconds=0.0,
                bootstrap_max_requests_per_day=1,
            )
            store = StateStore(settings, d1, state_path=Path(tmp) / "checkpoint.json")
            provider = FakeProvider(
                weekly_payloads={"A": weekly_payload("A"), "B": weekly_payload("B")},
                splits_payloads={"A": splits_payload("A"), "B": splits_payload("B")},
            )
            report = BootstrapRunner(settings, d1, provider, store, now_fn=lambda: NOW).run(
                universe=["A", "B"], limit=10
            )
            self.assertEqual(report["status"], "complete")
            self.assertEqual(report["symbols_done"], 2)


if __name__ == "__main__":
    unittest.main()
