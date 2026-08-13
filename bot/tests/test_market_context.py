import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from bot.config import Settings
from bot.jobs.market_context import market_indices_job, sentiment_job
from bot.market_data import CnnFearGreedProvider, YfinanceMarketContextProvider
from bot.state import StateStore


def _settings(tmp: str, **overrides) -> Settings:
    base = Settings(
        bot_env="production",
        data_dir=Path(tmp),
        market_data_dir=Path(tmp) / "market",
        market_data_cache=Path(tmp) / "latest.json",
        ingest_secret="test-secret",
    )
    return base.model_copy(update=overrides)


def _bar(symbol: str, close: float = 500.0, change: float = 0.5) -> dict:
    return {
        "date": "2026-08-13",
        "open": close - 1.0,
        "high": close + 2.0,
        "low": close - 3.0,
        "close": close,
        "adjusted_close": close,
        "volume": 1000000,
        "change_pct": change,
    }


class YfinanceProviderTests(unittest.TestCase):
    def test_healthy_snapshot_has_four_indices_and_two_benchmarks(self):
        quotes = {
            "^GSPC": _bar("^GSPC", 6427.18, 0.62),
            "^NDX": _bar("^NDX", 23724.31, 0.78),
            "^DJI": _bar("^DJI", 45118.26, 0.48),
            "^VIX": _bar("^VIX", 15.41, -1.26),
            "SPY": _bar("SPY", 642.0, 0.6),
            "QQQ": _bar("QQQ", 573.0, 0.7),
        }
        provider = YfinanceMarketContextProvider(fetch_ohlcv=lambda ticker: quotes[ticker])
        snapshot = provider.build_snapshot(now=datetime(2026, 8, 13, 15, 30, tzinfo=timezone.utc))

        self.assertEqual(snapshot.status, "healthy")
        self.assertEqual([i.symbol for i in snapshot.indices], ["SPX", "NDX", "DJI", "VIX"])
        self.assertEqual([i.value for i in snapshot.indices], [6427.18, 23724.31, 45118.26, 15.41])
        self.assertEqual([b.symbol for b in snapshot.benchmarks], ["SPY", "QQQ"])
        self.assertEqual(snapshot.as_of, "2026-08-13")
        self.assertIsNotNone(snapshot.last_successful_update)

    def test_missing_index_degrades_snapshot_with_warning(self):
        quotes = {
            "^GSPC": _bar("^GSPC"),
            "^NDX": _bar("^NDX"),
            "^DJI": _bar("^DJI"),
            "^VIX": _bar("^VIX"),
            "SPY": _bar("SPY"),
            "QQQ": _bar("QQQ"),
        }
        def flaky(ticker: str) -> dict:
            if ticker == "^VIX":
                raise ValueError("no price history for ^VIX")
            return quotes[ticker]

        provider = YfinanceMarketContextProvider(fetch_ohlcv=flaky)
        snapshot = provider.build_snapshot(now=datetime(2026, 8, 13, 15, 30, tzinfo=timezone.utc))

        self.assertEqual(snapshot.status, "degraded")
        self.assertEqual(len(snapshot.indices), 3)
        self.assertTrue(any("^VIX" in w for w in snapshot.warnings))
        self.assertIsNone(snapshot.last_successful_update)


class CnnFearGreedTests(unittest.TestCase):
    def test_parses_reading(self):
        provider = CnnFearGreedProvider(fetch_json=lambda: {
            "fear_and_greed": {
                "score": 62,
                "rating": "greed",
                "timestamp": "2026-08-13T12:46:16+00:00",
            },
        })
        reading = provider.fetch()
        self.assertEqual(reading.score, 62)
        self.assertEqual(reading.rating, "greed")
        self.assertEqual(reading.as_of, "2026-08-13T12:46:16+00:00")

    def test_normalizes_spaced_ratings(self):
        provider = CnnFearGreedProvider(fetch_json=lambda: {
            "fear_and_greed": {"score": 15, "rating": "Extreme Fear", "timestamp": "2026-08-13T12:00:00Z"},
        })
        self.assertEqual(provider.fetch().rating, "extreme_fear")

    def test_rejects_out_of_range_score(self):
        provider = CnnFearGreedProvider(fetch_json=lambda: {
            "fear_and_greed": {"score": 150, "rating": "greed", "timestamp": "2026-08-13T12:00:00Z"},
        })
        with self.assertRaises(ValueError):
            provider.fetch()

    def test_rejects_unknown_rating(self):
        provider = CnnFearGreedProvider(fetch_json=lambda: {
            "fear_and_greed": {"score": 50, "rating": "panic", "timestamp": "2026-08-13T12:00:00Z"},
        })
        with self.assertRaises(ValueError):
            provider.fetch()


class MarketContextJobTests(unittest.TestCase):
    def _store(self, tmp: str) -> StateStore:
        return StateStore(Path(tmp) / "state.db")

    def _status(self, store: StateStore, job: str) -> dict:
        status = store.last_job_status(job)
        self.assertIsNotNone(status)
        assert status is not None
        return status

    def test_indices_job_skips_before_session(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            try:
                settings = _settings(tmp)
                market_indices_job(settings, store, now=datetime(2026, 8, 13, 8, 0))
                status = self._status(store, "market_indices")
                self.assertEqual(status["status"], "skipped")
                self.assertEqual(status["detail"], "before_session")
            finally:
                store.close()

    def test_indices_job_skips_weekend(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            try:
                settings = _settings(tmp)
                # Saturday 2026-08-15
                market_indices_job(settings, store, now=datetime(2026, 8, 15, 12, 0))
                status = self._status(store, "market_indices")
                self.assertEqual(status["status"], "skipped")
                self.assertEqual(status["detail"], "weekend")
            finally:
                store.close()

    def test_indices_job_publishes_healthy_snapshot(self):
        quotes = {
            "^GSPC": _bar("^GSPC"), "^NDX": _bar("^NDX"), "^DJI": _bar("^DJI"), "^VIX": _bar("^VIX"),
            "SPY": _bar("SPY"), "QQQ": _bar("QQQ"),
        }
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            try:
                settings = _settings(tmp)
                with patch("bot.jobs.market_context.YfinanceMarketContextProvider") as provider_cls, \
                     patch("bot.publishing.publish_market_data") as publish:
                    provider_cls.return_value.build_snapshot.return_value = (
                        YfinanceMarketContextProvider(fetch_ohlcv=lambda t: quotes[t])
                        .build_snapshot(now=datetime(2026, 8, 13, 15, 30, tzinfo=timezone.utc))
                    )
                    market_indices_job(settings, store, now=datetime(2026, 8, 13, 15, 30))
                publish.assert_called_once()
                status = self._status(store, "market_indices")
                self.assertEqual(status["status"], "ok")
                self.assertIn("intraday:2026-08-13", status["detail"])
            finally:
                store.close()

    def test_indices_job_publishes_close_once_per_day(self):
        quotes = {
            "^GSPC": _bar("^GSPC"), "^NDX": _bar("^NDX"), "^DJI": _bar("^DJI"), "^VIX": _bar("^VIX"),
            "SPY": _bar("SPY"), "QQQ": _bar("QQQ"),
        }
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            try:
                settings = _settings(tmp)
                with patch("bot.jobs.market_context.YfinanceMarketContextProvider") as provider_cls, \
                     patch("bot.publishing.publish_market_data") as publish:
                    provider_cls.return_value.build_snapshot.return_value = (
                        YfinanceMarketContextProvider(fetch_ohlcv=lambda t: quotes[t])
                        .build_snapshot(now=datetime(2026, 8, 13, 16, 5, tzinfo=timezone.utc))
                    )
                    market_indices_job(settings, store, now=datetime(2026, 8, 13, 16, 5))
                    self.assertEqual(publish.call_count, 1)
                    market_indices_job(settings, store, now=datetime(2026, 8, 13, 16, 20))
                    self.assertEqual(publish.call_count, 1)
                status = self._status(store, "market_indices")
                self.assertEqual(status["status"], "skipped")
                self.assertEqual(status["detail"], "close_already_published")
            finally:
                store.close()

    def test_sentiment_job_publishes_reading(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            try:
                settings = _settings(tmp)
                with patch("bot.jobs.market_context.CnnFearGreedProvider") as provider_cls, \
                     patch("bot.publishing.publish_sentiment") as publish:
                    provider_cls.return_value.fetch.return_value = (
                        CnnFearGreedProvider(fetch_json=lambda: {
                            "fear_and_greed": {"score": 62, "rating": "greed", "timestamp": "2026-08-13T12:46:16+00:00"},
                        }).fetch()
                    )
                    sentiment_job(settings, store, now=datetime(2026, 8, 13, 9, 0))
                publish.assert_called_once()
                status = self._status(store, "sentiment")
                self.assertEqual(status["status"], "ok")
                self.assertIn('"score": 62', status["detail"])
            finally:
                store.close()

    def test_production_missing_secret_records_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = self._store(tmp)
            try:
                settings = _settings(tmp, ingest_secret="")
                market_indices_job(settings, store, now=datetime(2026, 8, 13, 12, 0))
                status = self._status(store, "market_indices")
                self.assertEqual(status["status"], "error")
                self.assertIn("INGEST_SECRET", status["detail"])
            finally:
                store.close()


if __name__ == "__main__":
    unittest.main()
