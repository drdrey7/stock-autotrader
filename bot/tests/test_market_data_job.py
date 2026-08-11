import csv
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from bot.config import Settings
from bot.jobs.market_data import market_data_job
from bot.state import StateStore


class MarketDataJobTests(unittest.TestCase):
    def write_csv(self, root: Path, name: str, fieldnames: list[str], rows: list[dict[str, str]]) -> None:
        with (root / name).open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)

    def test_invalid_staleness_config_does_not_leave_job_running(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = StateStore(Path(tmp) / "state.db")
            try:
                settings = Settings(
                    market_data_dir=Path(tmp) / "market",
                    market_data_cache=Path(tmp) / "latest.json",
                ).model_copy(update={"market_max_staleness_days": -1})
                market_data_job(settings, store)
                status = store.last_job_status("data_refresh")
                self.assertIsNotNone(status)
                assert status is not None
                self.assertEqual(status["status"], "error")
            finally:
                store.close()


    def test_production_missing_ingest_secret_records_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = StateStore(Path(tmp) / "state.db")
            try:
                settings = Settings(
                    bot_env="production",
                    market_data_dir=Path(tmp) / "market",
                    market_data_cache=Path(tmp) / "latest.json",
                    ingest_secret="",
                )
                market_data_job(settings, store)
                status = store.last_job_status("data_refresh")
                self.assertIsNotNone(status)
                assert status is not None
                self.assertEqual(status["status"], "error")
                self.assertIn("INGEST_SECRET", status["detail"])
            finally:
                store.close()

    def test_publish_failure_records_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = StateStore(Path(tmp) / "state.db")
            try:
                settings = Settings(
                    bot_env="production",
                    market_data_dir=Path(tmp) / "market",
                    market_data_cache=Path(tmp) / "latest.json",
                    ingest_secret="configured",
                )
                with patch("bot.publishing.publish_market_data", side_effect=RuntimeError("ingest rejected")):
                    market_data_job(settings, store)
                status = store.last_job_status("data_refresh")
                self.assertIsNotNone(status)
                assert status is not None
                self.assertEqual(status["status"], "error")
                self.assertIn("ingest rejected", status["detail"])
            finally:
                store.close()

    def test_refresh_job_records_success_and_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "market"
            root.mkdir()
            self.write_csv(
                root,
                "universe.csv",
                ["symbol", "company", "sector", "exchange", "security_type", "index_membership", "active", "market_cap", "avg_volume", "price"],
                [{"symbol": "MSFT", "company": "Microsoft", "sector": "Technology", "exchange": "NASDAQ", "security_type": "common_stock", "index_membership": "NASDAQ", "active": "true", "market_cap": "3000000000000", "avg_volume": "2500000", "price": "500"}],
            )
            self.write_csv(
                root,
                "bars.csv",
                ["symbol", "date", "open", "high", "low", "close", "adjusted_close", "volume"],
                [
                    {"symbol": "SPY", "date": "2026-08-10", "open": "680", "high": "685", "low": "678", "close": "684", "adjusted_close": "684", "volume": "1000000"},
                    {"symbol": "QQQ", "date": "2026-08-10", "open": "590", "high": "595", "low": "588", "close": "594", "adjusted_close": "594", "volume": "900000"},
                ],
            )
            data_cache = root / "latest.json"
            store = StateStore(Path(tmp) / "state.db")
            try:
                settings = Settings(
                    market_data_dir=root,
                    market_data_cache=data_cache,
                )
                market_data_job(settings, store, now=datetime(2026, 8, 11, tzinfo=timezone.utc))
                self.assertEqual(store.last_job_status("data_refresh")["status"], "ok")
                self.assertTrue(data_cache.is_file())
                self.assertIn("Market data healthy", store.recent_events(1)[0]["message"])
            finally:
                store.close()


if __name__ == "__main__":
    unittest.main()
