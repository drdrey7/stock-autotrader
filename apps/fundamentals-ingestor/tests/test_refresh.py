import unittest
from pathlib import Path
from unittest.mock import patch

from fundamentals_ingestor.config import Settings
from fundamentals_ingestor.finnhub import FinnhubError, MarketData
from fundamentals_ingestor.fx import FxError
from fundamentals_ingestor.main import _annual_window_is_safe, run


class FakeD1:
    def __init__(self, *args, **kwargs):
        self.writes = []
        self.fx_rates = {}

    def upsert_market(self, symbol, market, updated_at):
        self.writes.append((symbol, market, updated_at))

    def upsert_fx_rates(self, rates, rates_as_of, updated_at):
        self.fx_rates.update(rates)

    def get_fx_rates(self):
        return dict(self.fx_rates)

    def get_fx_last_as_of(self):
        return None


class FakeFx:
    def __init__(self, *args, **kwargs):
        pass

    def fetch_rates(self):
        return {("USD", "TWD"): 31.85, ("USD", "DKK"): 6.41, ("USD", "EUR"): 0.857}, "2026-08-26"


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
            patch("fundamentals_ingestor.main.FxClient", FakeFx),
        ):
            result = run(self.settings())

        self.assertEqual(result, {"processed": 1, "failed": 0, "written": 1, "skipped": 0})
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
            patch("fundamentals_ingestor.main.FxClient", FakeFx),
        ):
            result = run(self.settings())

        self.assertEqual(result, {"processed": 1, "failed": 0, "written": 1, "skipped": 0})
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
            patch("fundamentals_ingestor.main.FxClient", FakeFx),
        ):
            result = run(self.settings())

        self.assertEqual(result, {"processed": 0, "failed": 1, "written": 0, "skipped": 0})
        self.assertEqual(d1.writes, [])

    def test_dry_run_fetches_but_does_not_write(self):
        d1 = FakeD1()
        with (
            patch("fundamentals_ingestor.main.load_universe", return_value=["MSFT"]),
            patch("fundamentals_ingestor.main.FinnhubClient", FakeFinnhub),
            patch("fundamentals_ingestor.main.MarketD1Client", return_value=d1),
            patch("fundamentals_ingestor.main.FxClient", FakeFx),
        ):
            result = run(self.settings(), dry_run=True)

        self.assertEqual(result, {"processed": 1, "failed": 0, "written": 0, "skipped": 0})
        self.assertEqual(d1.writes, [])

    def test_legacy_annual_window_guard_remains_available_for_old_adapter_tests(self):
        class Row:
            def __init__(self, year):
                self.fiscal_year = year

        rows = [Row(year) for year in range(2022, 2027)]
        self.assertTrue(_annual_window_is_safe(set(), rows))

    def test_missing_fx_skips_foreign_write_preserving_snapshot(self):
        class NoFxFlaky:
            def __init__(self, *args, **kwargs):
                pass

            def fetch_rates(self):
                raise FxError("fx_request_failed")

        class TsmFinnhub:
            def __init__(self, *args, **kwargs):
                pass

            def fetch(self, symbol):
                return MarketData(
                    market_cap=6.314532e13,  # TWD
                    pe_ttm=27.86,
                    beta=1.1,
                    eps_ttm=87.38,  # TWD / ordinary
                    dividend_yield=1.3,
                    checked_at="2026-08-26T00:00:00Z",
                    fcf_per_share_ttm=43.88,
                    revenue_per_share_ttm=172.35,
                    book_value_per_share=248.05,
                )

        d1 = FakeD1()  # no stored FX -> no fresh and no last-known-good
        with (
            patch("fundamentals_ingestor.main.load_universe", return_value=["TSM"]),
            patch("fundamentals_ingestor.main.FinnhubClient", TsmFinnhub),
            patch("fundamentals_ingestor.main.MarketD1Client", return_value=d1),
            patch("fundamentals_ingestor.main.FxClient", NoFxFlaky),
        ):
            result = run(self.settings())

        # A foreign listing with no fresh and no valid LKG FX must NOT overwrite
        # its last-known-good canonical snapshot: upsert_market is never called.
        self.assertEqual(result, {"processed": 0, "failed": 0, "written": 0, "skipped": 1})
        self.assertEqual(d1.writes, [])

    def test_domestic_usd_stock_still_refreshes_when_fx_unavailable(self):
        class NoFxFlaky:
            def __init__(self, *args, **kwargs):
                pass

            def fetch_rates(self):
                raise FxError("fx_request_failed")

        d1 = FakeD1()  # no FX at all
        with (
            patch("fundamentals_ingestor.main.load_universe", return_value=["MSFT"]),
            patch("fundamentals_ingestor.main.FinnhubClient", FakeFinnhub),
            patch("fundamentals_ingestor.main.MarketD1Client", return_value=d1),
            patch("fundamentals_ingestor.main.FxClient", NoFxFlaky),
        ):
            result = run(self.settings())

        # Domestic USD names require no FX and must refresh normally even with FX down.
        self.assertEqual(result, {"processed": 1, "failed": 0, "written": 1, "skipped": 0})
        self.assertEqual(len(d1.writes), 1)
        self.assertEqual(d1.writes[0][0], "MSFT")

    def test_fx_fetch_failure_uses_last_known_good_for_foreign_symbol(self):
        class NoFxFlaky:
            def __init__(self, *args, **kwargs):
                pass

            def fetch_rates(self):
                raise FxError("fx_http_503")

        class TsmFinnhub:
            def __init__(self, *args, **kwargs):
                pass

            def fetch(self, symbol):
                return MarketData(
                    market_cap=6.314532e13,
                    pe_ttm=27.86,
                    beta=1.1,
                    eps_ttm=87.38,
                    dividend_yield=1.3,
                    checked_at="2026-08-26T00:00:00Z",
                    fcf_per_share_ttm=43.88,
                    revenue_per_share_ttm=172.35,
                    book_value_per_share=248.05,
                )

        d1 = FakeD1()
        d1.fx_rates = {("USD", "TWD"): 31.85, ("USD", "DKK"): 6.41, ("USD", "EUR"): 0.857}
        with (
            patch("fundamentals_ingestor.main.load_universe", return_value=["TSM"]),
            patch("fundamentals_ingestor.main.FinnhubClient", TsmFinnhub),
            patch("fundamentals_ingestor.main.MarketD1Client", return_value=d1),
            patch("fundamentals_ingestor.main.FxClient", NoFxFlaky),
        ):
            result = run(self.settings())

        self.assertEqual(result["processed"], 1)
        market = d1.writes[0][1]
        # last-known-good rate 31.85 applied to raw ordinary TWD, ratio 5
        self.assertAlmostEqual(market.eps_ttm, 87.38 * 5 / 31.85, places=3)


if __name__ == "__main__":
    unittest.main()
