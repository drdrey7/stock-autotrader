import unittest
from pathlib import Path
from unittest.mock import patch

from fundamentals_ingestor.config import Settings
from fundamentals_ingestor.finnhub import FinnhubError, MarketData
from fundamentals_ingestor.main import _annual_window_is_safe, run


class FakeD1:
    def __init__(self, *args, **kwargs):
        self.writes = []

    def upsert_market(self, symbol, market, updated_at):
        self.writes.append((symbol, market, updated_at))


class FakeFinnhub:
    def __init__(self, *args, **kwargs):
        pass

    def fetch(self, symbol):
        return MarketData(
            market_cap=3_000_000_000_000,
            pe_ttm=35.5,
            beta=1.1,
            eps_ttm=12.5,
            dividend_yield=0.7,
            checked_at="2026-08-23T12:00:00Z",
            roic_pct=27.5,
            fcf_margin_pct=36.0,
            debt_to_equity=0.2,
            fcf_per_share_ttm=14.25,
        )


class RefreshTests(unittest.TestCase):
    def settings(self):
        return Settings("key", "token", "account", "database", "", Path("unused"))

    def test_successful_finnhub_snapshot_is_written_directly(self):
        d1 = FakeD1()
        with (
            patch("fundamentals_ingestor.main.load_universe", return_value=["MSFT"]),
            patch("fundamentals_ingestor.main.FinnhubClient", FakeFinnhub),
            patch("fundamentals_ingestor.main.MarketD1Client", return_value=d1),
        ):
            result = run(self.settings())

        self.assertEqual(result, {"processed": 1, "failed": 0, "written": 1})
        self.assertEqual(len(d1.writes), 1)
        symbol, market, updated_at = d1.writes[0]
        self.assertEqual(symbol, "MSFT")
        self.assertEqual(market.roic_pct, 27.5)
        self.assertEqual(market.fcf_margin_pct, 36.0)
        self.assertEqual(market.debt_to_equity, 0.2)
        self.assertEqual(market.fcf_per_share_ttm, 14.25)
        self.assertTrue(updated_at.endswith("Z"))

    def test_missing_individual_metric_is_valid_and_written_as_null(self):
        class PartialFinnhub:
            def __init__(self, *args, **kwargs):
                pass

            def fetch(self, symbol):
                return MarketData(
                    market_cap=20_000_000_000,
                    pe_ttm=None,
                    beta=None,
                    eps_ttm=None,
                    dividend_yield=None,
                    checked_at="2026-08-23T12:00:00Z",
                    roic_pct=11.0,
                    fcf_margin_pct=None,
                    debt_to_equity=0.5,
                    fcf_per_share_ttm=None,
                )

        d1 = FakeD1()
        with (
            patch("fundamentals_ingestor.main.load_universe", return_value=["COIN"]),
            patch("fundamentals_ingestor.main.FinnhubClient", PartialFinnhub),
            patch("fundamentals_ingestor.main.MarketD1Client", return_value=d1),
        ):
            result = run(self.settings())

        self.assertEqual(result, {"processed": 1, "failed": 0, "written": 1})
        self.assertIsNone(d1.writes[0][1].pe_ttm)
        self.assertIsNone(d1.writes[0][1].fcf_margin_pct)

    def test_provider_failure_performs_no_write_and_preserves_last_known_good(self):
        class FailingFinnhub:
            def __init__(self, *args, **kwargs):
                pass

            def fetch(self, symbol):
                raise FinnhubError("finnhub_http_429")

        d1 = FakeD1()
        with (
            patch("fundamentals_ingestor.main.load_universe", return_value=["MSFT"]),
            patch("fundamentals_ingestor.main.FinnhubClient", FailingFinnhub),
            patch("fundamentals_ingestor.main.MarketD1Client", return_value=d1),
        ):
            result = run(self.settings())

        self.assertEqual(result, {"processed": 0, "failed": 1, "written": 0})
        self.assertEqual(d1.writes, [])

    def test_dry_run_fetches_but_does_not_write(self):
        d1 = FakeD1()
        with (
            patch("fundamentals_ingestor.main.load_universe", return_value=["MSFT"]),
            patch("fundamentals_ingestor.main.FinnhubClient", FakeFinnhub),
            patch("fundamentals_ingestor.main.MarketD1Client", return_value=d1),
        ):
            result = run(self.settings(), dry_run=True)

        self.assertEqual(result, {"processed": 1, "failed": 0, "written": 0})
        self.assertEqual(d1.writes, [])

    def test_legacy_annual_window_guard_remains_available_for_old_adapter_tests(self):
        class Row:
            def __init__(self, year):
                self.fiscal_year = year

        rows = [Row(year) for year in range(2022, 2027)]
        self.assertTrue(_annual_window_is_safe(set(), rows))


if __name__ == "__main__":
    unittest.main()
