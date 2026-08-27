import unittest
from pathlib import Path
from unittest.mock import patch

from fundamentals_ingestor.config import Settings
from fundamentals_ingestor.finnhub import (
    FinnhubError,
    MarketData,
    normalize_metric,
    percentile,
)
from fundamentals_ingestor.main import run
from fundamentals_ingestor.market_d1 import MarketD1Client


def _period_quarters(start_year: int, start_month_offset: int, end_year: int, end_month_offset: int):
    """Yield ISO quarter-end dates between two integer quarter indexes."""
    month_by_offset = {0: "03-31", 1: "06-30", 2: "09-30", 3: "12-31"}
    total = (end_year - start_year) * 4 + (end_month_offset - start_month_offset)
    for index in range(total + 1):
        year = start_year + (start_month_offset + index) // 4
        quarter = (start_month_offset + index) % 4
        yield f"{year}-{month_by_offset[quarter]}"


def _base_metric(payload: dict | None = None) -> dict:
    metric = {"marketCapitalization": 100, "peTTM": 30}
    if payload:
        metric.update(payload)
    return {"metric": metric}


def _market_cap_metric(market_cap: float = 100, pe_ttm: float = 30) -> dict:
    return {"metric": {"marketCapitalization": market_cap, "peTTM": pe_ttm}}


class PercentileFunctionTests(unittest.TestCase):
    def test_median_of_odd_count_is_middle_element(self):
        self.assertEqual(percentile([1, 2, 3, 4, 5], 50), 3)

    def test_median_of_even_count_averages_middle_elements(self):
        self.assertEqual(percentile([1, 2, 3, 4], 50), 2.5)

    def test_single_value_returns_that_value_for_any_percentile(self):
        for point in (25, 50, 75, 0, 100):
            with self.subTest(point=point):
                self.assertEqual(percentile([5], point), 5)

    def test_two_values_linear_interpolation(self):
        self.assertEqual(percentile([1, 2], 25), 1.25)
        self.assertEqual(percentile([1, 2], 50), 1.5)
        self.assertEqual(percentile([1, 2], 75), 1.75)

    def test_future_style_linear_interpolation(self):
        self.assertAlmostEqual(percentile([1, 2, 3, 4], 25), 1.75)
        self.assertAlmostEqual(percentile([1, 2, 3, 4], 75), 3.25)

    def test_is_deterministic(self):
        data = [0.1, 9.9, 4.4, 7.7, 2.2]
        self.assertEqual(percentile(data, 25), percentile(list(reversed(data)), 25))

    def test_empty_raises(self):
        with self.assertRaises(ValueError):
            percentile([], 50)

    def test_out_of_range_percentile_point_raises_value_error(self):
        for point in (-1, 101):
            with self.subTest(point=point):
                with self.assertRaises(ValueError):
                    percentile([1, 2, 3], point)

    def test_boundary_percentile_points_are_accepted(self):
        self.assertEqual(percentile([1, 2, 3], 0), 1)
        self.assertEqual(percentile([1, 2, 3], 100), 3)


class GrowthNormalizationTests(unittest.TestCase):
    def test_finnhub_growth_scalars_are_stored_directly_as_percentage_points(self):
        value = normalize_metric(_base_metric({"revenueGrowthTTMYoy": 39.54, "revenueGrowth3Y": 13.64, "revenueGrowth5Y": 12.0}), "2026-08-23T12:00:00Z")
        self.assertAlmostEqual(value.revenue_growth_ttm_yoy_pct, 39.54)
        self.assertAlmostEqual(value.revenue_growth_3y_pct, 13.64)
        self.assertAlmostEqual(value.revenue_growth_5y_pct, 12.0)

    def test_missing_growth_scalars_are_null(self):
        value = normalize_metric(_base_metric({}))
        self.assertIsNone(value.revenue_growth_ttm_yoy_pct)
        self.assertIsNone(value.revenue_growth_3y_pct)
        self.assertIsNone(value.revenue_growth_5y_pct)

    def test_invalid_growth_scalar_is_null(self):
        value = normalize_metric(_base_metric({"revenueGrowthTTMYoy": "n/a"}))
        self.assertIsNone(value.revenue_growth_ttm_yoy_pct)


class RoeNormalizationTests(unittest.TestCase):
    def test_roe_ratio_becomes_percentage_points(self):
        payload = _market_cap_metric()
        payload["series"] = {"quarterly": {"roeTTM": [{"period": "2026-06-30", "v": 0.1007}]}}
        value = normalize_metric(payload)
        self.assertAlmostEqual(value.roe_ttm_pct, 10.07)

    def test_roe_missing_is_null(self):
        payload = _market_cap_metric()
        payload["series"] = {"quarterly": {}}
        value = normalize_metric(payload)
        self.assertIsNone(value.roe_ttm_pct)

    def test_zero_roe_is_kept_as_zero(self):
        payload = _market_cap_metric()
        payload["series"] = {"quarterly": {"roeTTM": [{"period": "2026-06-30", "v": 0.0}]}}
        value = normalize_metric(payload)
        self.assertEqual(value.roe_ttm_pct, 0.0)


class PeHistoryTests(unittest.TestCase):
    def _payload(self, field: str = "peTTM", values=None):
        payload = _market_cap_metric()
        quarter_rows = values if values is not None else []
        payload["series"] = {"quarterly": {field: quarter_rows}}
        return payload

    def test_twenty_sample_window_median_and_quartiles(self):
        periods = list(_period_quarters(2021, 1, 2026, 0))  # 20 points
        rows = [{"period": period, "v": float(index + 1)} for index, period in enumerate(periods)]
        value = normalize_metric(self._payload(values=rows))
        self.assertEqual(value.pe_5y_samples, 20)
        self.assertAlmostEqual(value.pe_5y_median, 10.5)
        self.assertAlmostEqual(value.pe_5y_p25, 5.75)
        self.assertAlmostEqual(value.pe_5y_p75, 15.25)
        self.assertEqual(value.pe_5y_as_of, periods[-1])

    def test_unordered_dates_are_sorted_before_statistics(self):
        periods = list(_period_quarters(2021, 1, 2026, 0))
        # Reorder rows arbitrarily; result must match the ordered computation.
        unordered_periods = list(reversed(periods))
        rows = [{"period": period, "v": float(index + 1)} for index, period in enumerate(unordered_periods)]
        value = normalize_metric(self._payload(values=rows))
        self.assertAlmostEqual(value.pe_5y_median, 10.5)
        self.assertEqual(value.pe_5y_samples, 20)

    def test_points_outside_five_year_window_are_excluded(self):
        # 2020 point is more than five years before the 2026 anchor.
        rows = [
            {"period": "2020-06-30", "v": 9999.0},
            {"period": "2021-06-30", "v": 10.0},
            {"period": "2022-06-30", "v": 20.0},
            {"period": "2023-06-30", "v": 30.0},
            {"period": "2024-06-30", "v": 40.0},
            {"period": "2025-06-30", "v": 50.0},
            {"period": "2026-06-30", "v": 60.0},
        ]
        value = normalize_metric(self._payload(values=rows))
        self.assertEqual(value.pe_5y_samples, 6)
        self.assertNotIn(9999.0, (value.pe_5y_p25, value.pe_5y_median, value.pe_5y_p75))

    def test_single_valid_point(self):
        rows = [{"period": "2026-06-30", "v": 22.0}]
        value = normalize_metric(self._payload(values=rows))
        self.assertEqual(value.pe_5y_samples, 1)
        self.assertAlmostEqual(value.pe_5y_median, 22.0)
        self.assertAlmostEqual(value.pe_5y_p25, 22.0)
        self.assertAlmostEqual(value.pe_5y_p75, 22.0)
        self.assertEqual(value.pe_5y_as_of, "2026-06-30")

    def test_negative_and_zero_values_are_filtered(self):
        rows = [
            {"period": "2026-06-30", "v": -5.0},
            {"period": "2026-03-31", "v": 0.0},
            {"period": "2025-12-31", "v": 15.0},
        ]
        value = normalize_metric(self._payload(values=rows))
        self.assertEqual(value.pe_5y_samples, 1)
        self.assertAlmostEqual(value.pe_5y_median, 15.0)

    def test_nan_and_infinite_are_filtered(self):
        rows = [
            {"period": "2026-06-30", "v": float("nan")},
            {"period": "2026-03-31", "v": float("inf")},
            {"period": "2025-12-31", "v": float("-inf")},
            {"period": "2025-09-30", "v": None},
            {"period": "2025-06-30", "v": 12.5},
        ]
        value = normalize_metric(self._payload(values=rows))
        self.assertEqual(value.pe_5y_samples, 1)
        self.assertAlmostEqual(value.pe_5y_median, 12.5)

    def test_no_valid_values_gives_zero_samples_and_null_percentiles_but_keeps_as_of(self):
        rows = [{"period": "2026-06-30", "v": None}, {"period": "2026-03-31", "v": float("nan")}]
        value = normalize_metric(self._payload(values=rows))
        self.assertEqual(value.pe_5y_samples, 0)
        self.assertIsNone(value.pe_5y_median)
        self.assertIsNone(value.pe_5y_p25)
        self.assertIsNone(value.pe_5y_p75)
        # as_of reflects the latest reported period even when no value is usable.
        self.assertEqual(value.pe_5y_as_of, "2026-06-30")

    def test_anchor_uses_latest_reported_period_not_latest_positive(self):
        # 2026 and 2025 are non-positive; the only positive (2020) is outside
        # the 5-year window anchored at 2026-06-30, so it must be excluded.
        rows = [
            {"period": "2020-06-30", "v": 30.0},
            {"period": "2025-06-30", "v": -1.0},
            {"period": "2026-06-30", "v": -5.0},
        ]
        value = normalize_metric(self._payload(values=rows))
        self.assertEqual(value.pe_5y_as_of, "2026-06-30")
        self.assertEqual(value.pe_5y_samples, 0)
        self.assertIsNone(value.pe_5y_median)
        self.assertIsNone(value.pe_5y_p25)
        self.assertIsNone(value.pe_5y_p75)

    def test_anchor_fixes_window_before_filtering_positive_values(self):
        # Latest reported period negative (2026) which must still anchor; the
        # window 2021-06 -> 2026-06 keeps only the 2022/2023/2024 positives.
        rows = [
            {"period": "2022-06-30", "v": 30.0},
            {"period": "2023-06-30", "v": 10.0},
            {"period": "2024-06-30", "v": 20.0},
            {"period": "2025-06-30", "v": -1.0},
            {"period": "2026-06-30", "v": -5.0},
        ]
        value = normalize_metric(self._payload(values=rows))
        self.assertEqual(value.pe_5y_as_of, "2026-06-30")
        self.assertEqual(value.pe_5y_samples, 3)
        self.assertAlmostEqual(value.pe_5y_median, 20.0)

    def test_anchor_is_most_recent_parseable_period_when_unordered(self):
        rows = [
            {"period": "2023-06-30", "v": 5.0},
            {"period": "2026-06-30", "v": 25.0},
            {"period": "2024-12-31", "v": 15.0},
            {"period": "2025-12-31", "v": 20.0},
        ]
        value = normalize_metric(self._payload(values=rows))
        self.assertEqual(value.pe_5y_as_of, "2026-06-30")
        self.assertEqual(value.pe_5y_samples, 4)

    def test_null_value_row_still_anchors_the_window(self):
        rows = [
            {"period": "2026-06-30", "v": None},
            {"period": "2024-06-30", "v": 12.0},
            {"period": "2024-12-31", "v": 8.0},
        ]
        value = normalize_metric(self._payload(values=rows))
        self.assertEqual(value.pe_5y_as_of, "2026-06-30")
        self.assertEqual(value.pe_5y_samples, 2)

    def test_missing_series_gives_zero_samples(self):
        value = normalize_metric(_market_cap_metric())  # no series
        self.assertEqual(value.pe_5y_samples, 0)

    def test_no_parseable_period_gives_null_as_of(self):
        rows = [
            {"v": 10.0},
            {"period": "not-a-date", "v": 20.0},
        ]
        value = normalize_metric(self._payload(values=rows))
        self.assertEqual(value.pe_5y_samples, 0)
        self.assertIsNone(value.pe_5y_as_of)
        self.assertIsNone(value.pe_5y_median)


class PfcfHistoryTests(unittest.TestCase):
    def _payload(self, field: str = "pfcfTTM", values=None):
        payload = _market_cap_metric()
        quarter_rows = values if values is not None else []
        payload["series"] = {"quarterly": {field: quarter_rows}}
        return payload

    def test_pfcf_mirrors_pe_logic(self):
        periods = list(_period_quarters(2021, 1, 2026, 0))
        rows = [{"period": period, "v": float(index + 1) * 10} for index, period in enumerate(periods)]
        value = normalize_metric(self._payload(values=rows))
        self.assertEqual(value.pfcf_5y_samples, 20)
        self.assertAlmostEqual(value.pfcf_5y_median, 105.0)
        self.assertAlmostEqual(value.pfcf_5y_p25, 57.5)
        self.assertAlmostEqual(value.pfcf_5y_p75, 152.5)
        self.assertEqual(value.pfcf_5y_as_of, periods[-1])

    def test_pfcf_no_valid_points(self):
        value = normalize_metric(self._payload(values=[{"period": "2026-06-30", "v": -1.0}]))
        self.assertEqual(value.pfcf_5y_samples, 0)
        self.assertIsNone(value.pfcf_5y_median)

    def test_pfcf_anchor_uses_latest_reported_period_not_latest_positive(self):
        rows = [
            {"period": "2020-06-30", "v": 40.0},
            {"period": "2025-06-30", "v": -1.0},
            {"period": "2026-06-30", "v": -5.0},
        ]
        value = normalize_metric(self._payload(values=rows))
        self.assertEqual(value.pfcf_5y_as_of, "2026-06-30")
        self.assertEqual(value.pfcf_5y_samples, 0)
        self.assertIsNone(value.pfcf_5y_median)

    def test_pfcf_anchor_fixes_window_before_filtering_positive_values(self):
        rows = [
            {"period": "2022-06-30", "v": 30.0},
            {"period": "2023-06-30", "v": 10.0},
            {"period": "2024-06-30", "v": 20.0},
            {"period": "2025-06-30", "v": -1.0},
            {"period": "2026-06-30", "v": -5.0},
        ]
        value = normalize_metric(self._payload(values=rows))
        self.assertEqual(value.pfcf_5y_as_of, "2026-06-30")
        self.assertEqual(value.pfcf_5y_samples, 3)
        self.assertAlmostEqual(value.pfcf_5y_median, 20.0)


class SanityCheckFixtures(unittest.TestCase):
    def test_amd_scalars_and_median_fixtures(self):
        payload = _base_metric({"revenueGrowthTTMYoy": 39.54, "revenueGrowth3Y": 13.64, "revenueGrowth5Y": 11.0})
        payload["series"] = {
            "quarterly": {
                "roeTTM": [{"period": "2026-06-30", "v": 0.1007}],
                "peTTM": [{"period": f"{year}-12-31", "v": v} for year, v in ((2022, 50.0), (2023, 60.0), (2024, 80.97), (2025, 90.0), (2026, 100.0))],
                "pfcfTTM": [{"period": f"{year}-12-31", "v": v} for year, v in ((2022, 30.0), (2023, 40.0), (2024, 59.57), (2025, 70.0), (2026, 80.0))],
            }
        }
        value = normalize_metric(payload)
        self.assertAlmostEqual(value.revenue_growth_ttm_yoy_pct, 39.54)
        self.assertAlmostEqual(value.revenue_growth_3y_pct, 13.64)
        self.assertAlmostEqual(value.roe_ttm_pct, 10.07)
        self.assertAlmostEqual(value.pe_5y_median, 80.97)
        self.assertAlmostEqual(value.pfcf_5y_median, 59.57)

    def test_net_no_pe_history_but_pfcf_present(self):
        payload = _market_cap_metric()
        payload["series"] = {"quarterly": {"peTTM": [], "pfcfTTM": [{"period": "2026-06-30", "v": 20.0}]}}
        value = normalize_metric(payload)
        self.assertEqual(value.pe_5y_samples, 0)
        self.assertIsNone(value.pe_5y_median)
        self.assertGreater(value.pfcf_5y_samples, 0)

    def test_crwv_no_pe_and_no_pfcf_history(self):
        payload = _market_cap_metric()
        payload["series"] = {"quarterly": {"peTTM": [], "pfcfTTM": []}}
        value = normalize_metric(payload)
        self.assertEqual(value.pe_5y_samples, 0)
        self.assertIsNone(value.pe_5y_median)
        self.assertEqual(value.pfcf_5y_samples, 0)
        self.assertIsNone(value.pfcf_5y_median)

    def test_wmt_dense_pe_and_pfcf_history(self):
        payload = _market_cap_metric()
        periods = list(_period_quarters(2021, 1, 2026, 0))
        payload["series"] = {
            "quarterly": {
                "peTTM": [{"period": period, "v": 20.0 + index * 0.5} for index, period in enumerate(periods)],
                "pfcfTTM": [{"period": period, "v": 15.0 + index * 0.4} for index, period in enumerate(periods)],
            }
        }
        value = normalize_metric(payload)
        self.assertGreater(value.pe_5y_samples, 10)
        self.assertGreater(value.pfcf_5y_samples, 10)


class UpsertTests(unittest.TestCase):
    def test_upsert_writes_valuation_columns_and_preserves_accounting(self):
        client = MarketD1Client("token", "account", "database")
        market = MarketData(
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
            revenue_growth_ttm_yoy_pct=39.54,
            revenue_growth_3y_pct=13.64,
            revenue_growth_5y_pct=11.0,
            roe_ttm_pct=10.07,
            pe_5y_p25=5.75,
            pe_5y_median=10.5,
            pe_5y_p75=15.25,
            pe_5y_samples=20,
            pe_5y_as_of="2026-03-31",
            pfcf_5y_p25=57.5,
            pfcf_5y_median=105.0,
            pfcf_5y_p75=152.5,
            pfcf_5y_samples=20,
            pfcf_5y_as_of="2026-03-31",
        )

        with patch.object(client, "_query", return_value=[]) as query:
            client.upsert_market("MSFT", market, "2026-08-23T12:00:01Z")

        sql, values = query.call_args.args
        for column in (
            "revenue_growth_ttm_yoy_pct", "revenue_growth_3y_pct", "revenue_growth_5y_pct",
            "roe_ttm_pct", "pe_5y_p25", "pe_5y_median", "pe_5y_p75", "pe_5y_samples",
            "pe_5y_as_of", "pfcf_5y_p25", "pfcf_5y_median", "pfcf_5y_p75",
            "pfcf_5y_samples", "pfcf_5y_as_of",
        ):
            self.assertIn(column, sql)
        self.assertIn("pe_5y_median=excluded.pe_5y_median", sql)
        self.assertIn("pfcf_5y_samples=excluded.pfcf_5y_samples", sql)
        self.assertNotIn("revenue_ttm=excluded", sql)
        self.assertNotIn("accounting_source=excluded", sql)
        # value order mirrors column order inserted
        self.assertAlmostEqual(values[10], 39.54)   # revenue_growth_ttm_yoy_pct
        self.assertAlmostEqual(values[12], 11.0)    # revenue_growth_5y_pct
        self.assertAlmostEqual(values[13], 10.07)   # roe_ttm_pct
        self.assertAlmostEqual(values[15], 10.5)    # pe_5y_median
        self.assertAlmostEqual(values[20], 105.0)   # pfcf_5y_median
        self.assertAlmostEqual(values[21], 152.5)   # pfcf_5y_p75

    def test_upsert_writes_null_valuation_values_when_absent(self):
        client = MarketD1Client("token", "account", "database")
        # Mirrors a normalize_metric result with no valid 5-year history:
        # samples collapse to 0 while the percentile/as_of fields stay NULL.
        market = MarketData(
            100.0, None, None, None, None, "2026-08-23T12:00:00Z",
            pe_5y_samples=0, pfcf_5y_samples=0,
        )

        with patch.object(client, "_query", return_value=[]) as query:
            client.upsert_market("COIN", market, "2026-08-23T12:00:01Z")

        values = query.call_args.args[1]
        # pe_5y_samples is 0 when no valid history; percentiles/as_of are None.
        self.assertEqual(values[17], 0)
        self.assertIsNone(values[18])
        self.assertEqual(values[22], 0)
        self.assertIsNone(values[23])


class RefreshFlowTests(unittest.TestCase):
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
                revenue_growth_ttm_yoy_pct=39.54,
                revenue_growth_3y_pct=13.64,
                revenue_growth_5y_pct=11.0,
                roe_ttm_pct=10.07,
                pe_5y_median=10.5,
                pe_5y_samples=20,
                pfcf_5y_median=105.0,
                pfcf_5y_samples=20,
            )

    def settings(self):
        return Settings("key", "token", "account", "database", "", Path("unused"))

    def test_successful_snapshot_writes_valuation_features(self):
        d1 = self.FakeD1()
        with (
            patch("fundamentals_ingestor.main.load_universe", return_value=["MSFT"]),
            patch("fundamentals_ingestor.main.FinnhubClient", self.FakeFinnhub),
            patch("fundamentals_ingestor.main.MarketD1Client", return_value=d1),
            patch("fundamentals_ingestor.main.FxClient", self.FakeFx),
        ):
            result = run(self.settings())

        self.assertEqual(result, {"processed": 1, "failed": 0, "written": 1, "skipped": 0})
        market = d1.writes[0][1]
        self.assertAlmostEqual(market.revenue_growth_ttm_yoy_pct, 39.54)
        self.assertAlmostEqual(market.roe_ttm_pct, 10.07)
        self.assertEqual(market.pe_5y_samples, 20)
        self.assertAlmostEqual(market.pe_5y_median, 10.5)

    def test_provider_failure_preserves_snapshot_and_writes_nothing(self):
        class FailingFinnhub:
            def __init__(self, *args, **kwargs):
                pass

            def fetch(self, symbol):
                raise FinnhubError("finnhub_http_429")

        d1 = self.FakeD1()
        with (
            patch("fundamentals_ingestor.main.load_universe", return_value=["MSFT"]),
            patch("fundamentals_ingestor.main.FinnhubClient", FailingFinnhub),
            patch("fundamentals_ingestor.main.MarketD1Client", return_value=d1),
            patch("fundamentals_ingestor.main.FxClient", self.FakeFx),
        ):
            result = run(self.settings())

        self.assertEqual(result, {"processed": 0, "failed": 1, "written": 0, "skipped": 0})
        self.assertEqual(d1.writes, [])

    def test_dry_run_does_not_write_but_still_normalizes(self):
        d1 = self.FakeD1()
        with (
            patch("fundamentals_ingestor.main.load_universe", return_value=["MSFT"]),
            patch("fundamentals_ingestor.main.FinnhubClient", self.FakeFinnhub),
            patch("fundamentals_ingestor.main.MarketD1Client", return_value=d1),
            patch("fundamentals_ingestor.main.FxClient", self.FakeFx),
        ):
            result = run(self.settings(), dry_run=True)

        self.assertEqual(result, {"processed": 1, "failed": 0, "written": 0, "skipped": 0})
        self.assertEqual(d1.writes, [])


if __name__ == "__main__":
    unittest.main()
