"""Tests for the Alpha Vantage provider client (history ingestor)."""

from __future__ import annotations

import json
import time
import unittest
from types import SimpleNamespace

from history_ingestor.config import Settings
from history_ingestor.parser import parse_splits_payload, parse_weekly_payload
from history_ingestor.provider import (
    AllKeysFailedError,
    AlphaVantageClient,
    ProviderError,
    QuotaExhaustedError,
)
from history_ingestor.state import KeyBudgetLedger, StateStore
from history_ingestor.universe import load_core_universe


def settings_with(keys=("K1", "K2"), budget=25, interval=0.0, retries=2, retry_base=0.0):
    return Settings(
        alpha_vantage_keys=list(keys),
        cloudflare_api_token="token",
        cloudflare_account_id="acct",
        cloudflare_d1_database_id="db",
        av_min_interval_seconds=interval,
        av_max_retries=retries,
        av_retry_base_seconds=retry_base,
    )


class FakeResponse:
    def __init__(self, payload, status=200):
        self._payload = payload
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return json.dumps(self._payload).encode("utf-8")


class RecordingURL:
    """Returns canned payloads per (function, symbol) and records requests."""

    def __init__(self, responses=None, error=None):
        # responses: list of (params_dict, payload); consumed in order.
        self._responses = responses or []
        self._error = error
        self.calls: list[dict] = []
        self.counter = 0

    def __call__(self, request, timeout):
        self.calls.append({"url": request.full_url, "timeout": timeout})
        if self._error is not None:
            raise self._error
        index = self.counter
        self.counter += 1
        params, payload = self._responses[min(index, len(self._responses) - 1)]
        for key, value in params.items():
            assert f"{key}={value}" in request.full_url, f"{key}={value} missing in {request.full_url}"
        return FakeResponse(payload)


def weekly_payload(symbol):
    return {
        "Meta Data": {"1. Information": "Weekly Prices", "2. Symbol": symbol,
                      "3. Last Refreshed": "2026-08-18", "4. Time Zone": "US/Eastern"},
        "Weekly Time Series": {
            "2026-08-14": {"1. open": "100", "2. high": "101", "3. low": "99", "4. close": "100.5", "5. volume": "1000"},
            "2026-08-07": {"1. open": "99", "2. high": "100", "3. low": "98", "4. close": "99", "5. volume": "900"},
        },
    }


def splits_payload(symbol):
    return {"symbol": symbol, "data": [{"effective_date": "2024-06-10", "split_factor": "10.0000"}]}


class FakeStore:
    """Checkpoint-like budget for tests (mirrors StateStore interface)."""

    def __init__(self, key_count, used=None):
        self.keys = [{"index": i, "used": (used[i] if used else 0), "status": "ok"} for i in range(key_count)]
        self._budget = 25
        self._count = key_count

    def key_remaining(self, index):
        if index >= self._count:
            return 0
        return max(0, 25 - int(self.keys[index]["used"]))

    def mark_key_used(self, index, delta=1):
        if index < self._count:
            self.keys[index]["used"] = int(self.keys[index]["used"]) + delta

    def mark_key_exhausted(self, index):
        if index < self._count:
            self.keys[index]["status"] = "exhausted"
            self.keys[index]["used"] = 25


class LedgerAdapter:
    def __init__(self, store):
        self._store = store

    def remaining(self, index):
        return self._store.key_remaining(index)

    def mark_used(self, index, delta=1):
        self._store.mark_key_used(index, delta)

    def mark_exhausted(self, index):
        self._store.mark_key_exhausted(index)


class ProviderTests(unittest.TestCase):
    def _client(self, store, url, settings=None):
        settings = settings or settings_with()
        return AlphaVantageClient(settings, LedgerAdapter(store), urlopen=url,
                                  sleep_fn=lambda _: None, rnd=None)

    def test_valid_weekly_fetch(self):
        store = FakeStore(2)
        url = RecordingURL([
            ({"function": "TIME_SERIES_WEEKLY", "symbol": "NVDA"}, weekly_payload("NVDA")),
        ])
        client = self._client(store, url)
        index, bars, _ = client.fetch_weekly("NVDA")
        self.assertEqual(len(bars), 2)
        self.assertEqual(bars[-1].week_end_date, "2026-08-14")
        self.assertEqual(index, 0)
        self.assertEqual(store.keys[0]["used"], 1)

    def test_valid_splits_fetch(self):
        store = FakeStore(2)
        url = RecordingURL([
            ({"function": "SPLITS", "symbol": "NVDA"}, splits_payload("NVDA")),
        ])
        client = self._client(store, url)
        index, events, _ = client.fetch_splits("NVDA")
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].ratio.numerator, 10)

    def test_daily_quota_note_exhausts_key_then_other_key(self):
        store = FakeStore(2)
        url = RecordingURL([
            ({"function": "SPLITS", "symbol": "NVDA"}, {"Note": "Thank you for using Alpha Vantage!"}),
            ({"function": "SPLITS", "symbol": "NVDA"}, splits_payload("NVDA")),
        ])
        client = self._client(store, url)
        index, events, _ = client.fetch_splits("NVDA")
        self.assertEqual(index, 1)
        self.assertEqual(store.keys[0]["status"], "exhausted")
        self.assertEqual(store.keys[1]["used"], 1)

    def test_all_keys_quota_exhausted_raises(self):
        store = FakeStore(1)
        url = RecordingURL([
            ({"function": "SPLITS", "symbol": "NVDA"}, {"Note": "quota"}),
        ])
        client = self._client(store, url)
        with self.assertRaises(QuotaExhaustedError):
            client.fetch_splits("NVDA")
        self.assertIn(0, client.quota_hits_this_run)

    def test_information_throttle_backs_off_then_succeeds(self):
        store = FakeStore(1)
        url = RecordingURL([
            ({"function": "SPLITS", "symbol": "NVDA"}, {"Information": "spread out requests"}),
            ({"function": "SPLITS", "symbol": "NVDA"}, splits_payload("NVDA")),
        ])
        client = self._client(store, url)
        index, events, _ = client.fetch_splits("NVDA")
        self.assertEqual(index, 0)
        self.assertEqual(client.throttle_retries_this_run, 1)
        self.assertEqual(store.keys[0]["used"], 2)  # throttle response also counts

    def test_throttle_loop_is_bounded(self):
        store = FakeStore(1)
        url = RecordingURL([
            ({"function": "SPLITS", "symbol": "NVDA"}, {"Information": "throttle"}),
        ])
        client = self._client(store, url)
        with self.assertRaises(AllKeysFailedError):
            client.fetch_splits("NVDA")

    def test_invalid_key_skipped(self):
        store = FakeStore(2)
        url = RecordingURL([
            ({"function": "SPLITS", "symbol": "NVDA"}, {"Error Message": "the parameter apikey is invalid or missing"}),
            ({"function": "SPLITS", "symbol": "NVDA"}, splits_payload("NVDA")),
        ])
        client = self._client(store, url)
        index, events, _ = client.fetch_splits("NVDA")
        self.assertEqual(index, 1)

    def test_unknown_symbol_message_is_non_retryable_error(self):
        store = FakeStore(2)
        url = RecordingURL([
            ({"function": "TIME_SERIES_WEEKLY", "symbol": "ZZZZ"}, {"Error Message": "Invalid API call"}),
        ])
        client = self._client(store, url)
        with self.assertRaises(ProviderError):
            client.fetch_weekly("ZZZZ")

    def test_network_error_retries_then_all_keys_failed(self):
        import urllib.error
        store = FakeStore(1)
        url = RecordingURL(error=urllib.error.URLError("boom"))
        client = self._client(store, url)
        with self.assertRaises(AllKeysFailedError):
            client.fetch_weekly("NVDA")

    def test_pacing_respects_min_interval(self):
        sleeps = []

        def sleep_fn(seconds):
            sleeps.append(seconds)

        class Clock:
            def __init__(self):
                self.t = 0.0

            def __call__(self):
                return self.t

        store = FakeStore(1)
        settings = settings_with(keys=("K1",), interval=13.0)
        clock = Clock()
        url = RecordingURL([
            ({"function": "SPLITS", "symbol": "NVDA"}, splits_payload("NVDA")),
            ({"function": "SPLITS", "symbol": "AAPL"}, splits_payload("AAPL")),
        ])
        client = AlphaVantageClient(settings, LedgerAdapter(store), now_fn=clock,
                                    sleep_fn=sleep_fn, urlopen=url)
        client.fetch_splits("NVDA")
        clock.t = 5.0  # only 5s elapsed -> must wait 8s
        client.fetch_splits("AAPL")
        self.assertAlmostEqual(sleeps[-1], 8.0, places=6)

    def test_no_pacing_when_interval_elapsed(self):
        sleeps = []

        def sleep_fn(seconds):
            sleeps.append(seconds)

        class Clock:
            def __init__(self):
                self.t = 0.0

            def __call__(self):
                return self.t

        store = FakeStore(1)
        settings = settings_with(keys=("K1",), interval=13.0)
        clock = Clock()
        url = RecordingURL([
            ({"function": "SPLITS", "symbol": "NVDA"}, splits_payload("NVDA")),
            ({"function": "SPLITS", "symbol": "AAPL"}, splits_payload("AAPL")),
        ])
        client = AlphaVantageClient(settings, LedgerAdapter(store), now_fn=clock,
                                    sleep_fn=sleep_fn, urlopen=url)
        client.fetch_splits("NVDA")
        clock.t = 13.0
        client.fetch_splits("AAPL")
        self.assertEqual(sleeps, [])

    def test_budget_exhausted_before_provider_raises(self):
        store = FakeStore(1, used=[25])
        url = RecordingURL([
            ({"function": "SPLITS", "symbol": "NVDA"}, splits_payload("NVDA")),
        ])
        client = self._client(store, url)
        with self.assertRaises(QuotaExhaustedError):
            client.fetch_splits("NVDA")
        self.assertEqual(url.calls, [])  # no request fired

    def test_round_robin_spreads_across_keys(self):
        store = FakeStore(2)
        url = RecordingURL([
            ({"function": "SPLITS", "symbol": "A"}, splits_payload("A")),
            ({"function": "SPLITS", "symbol": "B"}, splits_payload("B")),
            ({"function": "SPLITS", "symbol": "C"}, splits_payload("C")),
            ({"function": "SPLITS", "symbol": "D"}, splits_payload("D")),
        ])
        client = self._client(store, url)
        indexes = [client.fetch_splits(s)[0] for s in ("A", "B", "C", "D")]
        self.assertEqual(sorted(set(indexes)), [0, 1])
        self.assertEqual(store.keys[0]["used"], 2)
        self.assertEqual(store.keys[1]["used"], 2)


if __name__ == "__main__":
    unittest.main()
