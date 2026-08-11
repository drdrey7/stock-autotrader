import csv
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from bot.market_data import (
    CsvMarketDataProvider,
    MarketDataPipeline,
    PriceBar,
    UniverseConfig,
    build_universe,
)
from bot.market_data.provider import DataValidationError


class MarketDataTests(unittest.TestCase):
    def write_csv(self, path: Path, name: str, fieldnames: list[str], rows: list[dict]) -> None:
        with (path / name).open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(rows)

    def test_provider_rejects_zero_volume(self):
        with self.assertRaises(DataValidationError):
            CsvMarketDataProvider._parse_bar({
                "symbol": "SPY",
                "date": "2026-08-01",
                "open": "1",
                "high": "2",
                "low": "0.9",
                "close": "1.5",
                "adjusted_close": "1.5",
                "volume": "0",
            }, 2)

    def test_negative_universe_threshold_is_rejected(self):
        with self.assertRaises(ValueError):
            UniverseConfig(min_price=-1)

    def test_provider_rejects_non_normalized_dates(self):
        with self.assertRaises(DataValidationError):
            CsvMarketDataProvider._parse_bar({
                "symbol": "SPY",
                "date": "20260801",
                "open": "1",
                "high": "2",
                "low": "0.9",
                "close": "1.5",
                "adjusted_close": "1.5",
                "volume": "1000",
            }, 2)

    def test_universe_normalizes_and_excludes_unsupported_rows(self):
        result = build_universe(
            [
                {
                    "symbol": " msft ",
                    "company": "Microsoft",
                    "sector": "Technology",
                    "exchange": "NASDAQ",
                    "security_type": "common_stock",
                    "index_membership": "NASDAQ",
                    "active": "true",
                    "market_cap": "3000000000000",
                    "avg_volume": "2500000",
                    "price": "500",
                },
                {
                    "symbol": "SPY",
                    "company": "SPDR S&P 500 ETF",
                    "sector": "ETF",
                    "exchange": "ARCA",
                    "security_type": "etf",
                    "index_membership": "SP500",
                    "active": "true",
                    "market_cap": "500000000000",
                    "avg_volume": "10000000",
                    "price": "500",
                },
                {
                    "symbol": "LOWVOL",
                    "company": "Low Volume",
                    "sector": "Industrials",
                    "exchange": "NYSE",
                    "security_type": "common_stock",
                    "index_membership": "SP500",
                    "active": "true",
                    "market_cap": "1000000000",
                    "avg_volume": "1000",
                    "price": "20",
                },
            ],
            UniverseConfig(min_avg_volume=250_000),
        )

        self.assertEqual([item.symbol for item in result.eligible], ["MSFT"])
        self.assertEqual(result.total, 3)
        self.assertEqual(result.excluded, 2)
        self.assertIn("SPY", result.excluded_symbols)
        self.assertIn("LOWVOL", result.excluded_symbols)

    def test_duplicate_empty_symbols_never_become_candidates(self):
        base = {
            "symbol": "",
            "company": "Missing symbol",
            "sector": "Technology",
            "exchange": "NASDAQ",
            "index_membership": "NASDAQ",
            "active": "true",
            "market_cap": "3000000000",
            "avg_volume": "300000",
            "price": "50",
        }
        result = build_universe([
            {**base, "security_type": "ETF"},
            {**base, "security_type": "common_stock"},
        ])
        self.assertEqual(result.eligible, ())
        self.assertEqual(result.total, 2)
        self.assertEqual(result.exclusions["<invalid-symbol>"], "duplicate symbol")

    def test_csv_pipeline_validates_benchmarks_and_writes_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write_csv(
                root,
                "universe.csv",
                ["symbol", "company", "sector", "exchange", "security_type", "index_membership", "active", "market_cap", "avg_volume", "price"],
                [{
                    "symbol": "MSFT",
                    "company": "Microsoft",
                    "sector": "Technology",
                    "exchange": "NASDAQ",
                    "security_type": "common_stock",
                    "index_membership": "NASDAQ",
                    "active": "true",
                    "market_cap": "3000000000000",
                    "avg_volume": "2500000",
                    "price": "500",
                }],
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
            cache = root / "cache" / "latest.json"
            result = MarketDataPipeline(
                CsvMarketDataProvider(root),
                cache_path=cache,
            ).run(now=datetime(2026, 8, 11, tzinfo=timezone.utc))

            self.assertEqual(result.status, "healthy")
            self.assertEqual(len(result.universe.eligible), 1)
            self.assertEqual([bar.symbol for bar in result.benchmarks], ["SPY", "QQQ"])
            self.assertEqual(result.as_of, "2026-08-10")
            cached = json.loads(cache.read_text())
            self.assertEqual(cached["status"], "healthy")
            self.assertEqual(cached["universe"]["eligibleSymbols"], ["MSFT"])

    def test_missing_input_files_are_degraded_without_internal_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = MarketDataPipeline(
                CsvMarketDataProvider(Path(tmp)),
                cache_path=Path(tmp) / "cache" / "latest.json",
            ).run(now=datetime(2026, 8, 11, tzinfo=timezone.utc))

            self.assertEqual(result.status, "degraded")
            self.assertEqual(result.universe.total, 0)
            self.assertEqual(result.benchmarks, ())
            self.assertIn("required input file missing", result.warnings[0])
            self.assertNotIn(tmp, result.warnings[0])

    def test_zero_volume_degrades_with_specific_warning(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write_csv(
                root,
                "universe.csv",
                ["symbol", "company", "sector", "exchange", "security_type", "index_membership", "active", "market_cap", "avg_volume", "price"],
                [],
            )
            self.write_csv(
                root,
                "bars.csv",
                ["symbol", "date", "open", "high", "low", "close", "adjusted_close", "volume"],
                [{"symbol": "SPY", "date": "2026-08-10", "open": "680", "high": "685", "low": "678", "close": "684", "adjusted_close": "684", "volume": "0"}],
            )
            result = MarketDataPipeline(CsvMarketDataProvider(root)).run(
                now=datetime(2026, 8, 11, tzinfo=timezone.utc),
            )
            self.assertEqual(result.status, "degraded")
            self.assertIn("non-positive OHLCV value for SPY", result.warnings[0])

    def test_provider_boundary_rejects_non_normalized_bar_dates(self):
        class InvalidDateProvider:
            name = "test-provider"

            def load_universe(self):
                return []

            def load_bars(self, symbols):
                return [PriceBar("SPY", "20260810", 1, 2, 0.9, 1.5, 1.5, 100)]

        result = MarketDataPipeline(InvalidDateProvider()).run(
            now=datetime(2026, 8, 11, tzinfo=timezone.utc),
        )
        self.assertEqual(result.status, "degraded")
        self.assertIn("source invalid", result.warnings[0])

    def test_missing_benchmark_is_degraded_not_silent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self.write_csv(
                root,
                "universe.csv",
                ["symbol", "company", "sector", "exchange", "security_type", "index_membership", "active", "market_cap", "avg_volume", "price"],
                [],
            )
            self.write_csv(
                root,
                "bars.csv",
                ["symbol", "date", "open", "high", "low", "close", "adjusted_close", "volume"],
                [{"symbol": "SPY", "date": "2026-08-10", "open": "680", "high": "685", "low": "678", "close": "684", "adjusted_close": "684", "volume": "1000000"}],
            )
            result = MarketDataPipeline(CsvMarketDataProvider(root)).run()

            self.assertEqual(result.status, "degraded")
            self.assertIn("missing benchmark: QQQ", result.warnings)

    def test_stale_and_future_benchmarks_are_degraded(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
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
                    {"symbol": "SPY", "date": "2026-08-01", "open": "680", "high": "685", "low": "678", "close": "684", "adjusted_close": "684", "volume": "1000000"},
                    {"symbol": "QQQ", "date": "2026-08-12", "open": "590", "high": "595", "low": "588", "close": "594", "adjusted_close": "594", "volume": "900000"},
                ],
            )
            result = MarketDataPipeline(
                CsvMarketDataProvider(root),
                max_staleness_days=3,
            ).run(now=datetime(2026, 8, 11, 12, tzinfo=timezone.utc))

            self.assertEqual(result.status, "degraded")
            self.assertIn("stale benchmark: SPY (2026-08-01)", result.warnings)
            self.assertIn("future benchmark: QQQ (2026-08-12)", result.warnings)
    def test_negative_price_is_never_eligible_even_with_invalid_thresholds(self):
        row = {
            "symbol": "NEG",
            "company": "Negative",
            "sector": "Test",
            "exchange": "NASDAQ",
            "security_type": "common_stock",
            "index_membership": "NASDAQ",
            "active": "true",
            "market_cap": "100",
            "avg_volume": "100",
            "price": "-1",
        }
        result = build_universe([row], UniverseConfig(min_price=0, min_avg_volume=0, min_market_cap=0))
        self.assertEqual(result.eligible, ())
        self.assertEqual(result.exclusions["NEG"], "invalid numeric field")


if __name__ == "__main__":
    unittest.main()
