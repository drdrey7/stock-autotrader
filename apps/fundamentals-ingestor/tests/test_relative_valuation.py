"""Tests for the relative-valuation FACTS layer (PR 2 input).

Covers revenue_per_share_ttm, book_value_per_share, and the trailing 5-year
P/S and P/B windows computed from the same Finnhub metric=all response. The
window semantics reuse the PR #118 implementation (`_series_percentiles_5y`):
anchor at the latest reported period, then keep only finite positive values.
"""
import unittest
from pathlib import Path
from unittest.mock import patch

from fundamentals_ingestor.config import Settings
from fundamentals_ingestor.finnhub import FinnhubError, MarketData, normalize_metric, percentile
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


def _metric_payload(metric_overrides: dict | None = None, series: dict | None = None) -> dict:
    metric = {"marketCapitalization": 100, "peTTM": 30}
    if metric_overrides:
        metric.update(metric_overrides)
    payload = {"metric": metric}
    if series:
        payload["series"] = series
    return payload


def _quarterly(field: str, values) -> dict:
    return {"quarterly": {field: values}}


class RevenuePerShareTests(unittest.TestCase):
    def test_valid_finite_value_is_stored(self):
        payload = _metric_payload({"revenuePerShareTTM": 11.8166})
        value = normalize_metric(payload)
        self.assertAlmostEqual(value.revenue_per_share_ttm, 11.8166)

    def test_zero_and_negative_are_accepted_as_finite(self):
        # Pure finite-number semantics: P/S multiple is a ratio, so a 0 or
        # negative per-share revenue is still a finite fact we store.
        self.assertAlmostEqual(normalize_metric(_metric_payload({"revenuePerShareTTM": 0})).revenue_per_share_ttm, 0)
        self.assertAlmostEqual(normalize_metric(_metric_payload({"revenuePerShareTTM": -4.5})).revenue_per_share_ttm, -4.5)

    def test_missing_is_null(self):
        value = normalize_metric(_metric_payload())
        self.assertIsNone(value.revenue_per_share_ttm)

    def test_invalid_string_is_null(self):
        value = normalize_metric(_metric_payload({"revenuePerShareTTM": "n/a"}))
        self.assertIsNone(value.revenue_per_share_ttm)

    def test_nan_and_infinite_are_null(self):
        value = normalize_metric(_metric_payload({"revenuePerShareTTM": float("nan")}))
        self.assertIsNone(value.revenue_per_share_ttm)
        value = normalize_metric(_metric_payload({"revenuePerShareTTM": float("inf")}))
        self.assertIsNone(value.revenue_per_share_ttm)
        value = normalize_metric(_metric_payload({"revenuePerShareTTM": float("-inf")}))
        self.assertIsNone(value.revenue_per_share_ttm)


class BookValuePerShareTests(unittest.TestCase):
    def test_quarterly_valid_wins_over_annual(self):
        payload = _metric_payload({"bookValuePerShareQuarterly": 8.9455, "bookValuePerShareAnnual": 6.6434})
        value = normalize_metric(payload)
        self.assertAlmostEqual(value.book_value_per_share, 8.9455)

    def test_quarterly_missing_falls_back_to_annual(self):
        payload = _metric_payload({"bookValuePerShareAnnual": 6.6434})
        value = normalize_metric(payload)
        self.assertAlmostEqual(value.book_value_per_share, 6.6434)

    def test_quarterly_zero_with_annual_positive_is_null(self):
        # A zero/negative quarterly book value is real economic information, not
        # missing data: it must NOT be replaced by an older positive annual figure.
        payload = _metric_payload({"bookValuePerShareQuarterly": 0.0, "bookValuePerShareAnnual": 6.6434})
        value = normalize_metric(payload)
        self.assertIsNone(value.book_value_per_share)

    def test_quarterly_negative_with_annual_positive_is_null(self):
        payload = _metric_payload({"bookValuePerShareQuarterly": -2.0, "bookValuePerShareAnnual": 6.6434})
        value = normalize_metric(payload)
        self.assertIsNone(value.book_value_per_share)

    def test_quarterly_nan_falls_back_to_annual(self):
        # NaN is a non-finite quarterly -> treated as missing -> annual fallback applies.
        payload = _metric_payload({"bookValuePerShareQuarterly": float("nan"), "bookValuePerShareAnnual": 6.6434})
        value = normalize_metric(payload)
        self.assertAlmostEqual(value.book_value_per_share, 6.6434)

    def test_quarterly_invalid_string_falls_back_to_annual(self):
        payload = _metric_payload({"bookValuePerShareQuarterly": "n/a", "bookValuePerShareAnnual": 6.6434})
        value = normalize_metric(payload)
        self.assertAlmostEqual(value.book_value_per_share, 6.6434)

    def test_no_valid_value_is_null(self):
        payload = _metric_payload({"bookValuePerShareQuarterly": 0.0, "bookValuePerShareAnnual": -1.0})
        value = normalize_metric(payload)
        self.assertIsNone(value.book_value_per_share)

    def test_not_derived_from_price_or_pb(self):
        # Even with a P/B multiple present and no BVPS metric, BVPS must stay
        # NULL (never derived from the multiple or a current price).
        payload = _metric_payload({"pb": 2.57, "marketCapitalization": 100})
        value = normalize_metric(payload)
        self.assertIsNone(value.book_value_per_share)


class PsHistoryTests(unittest.TestCase):
    def _normalize(self, values):
        payload = _metric_payload(series=_quarterly("psTTM", values))
        return normalize_metric(payload)

    def test_twenty_sample_window_median_and_quartiles(self):
        periods = list(_period_quarters(2021, 1, 2026, 0))
        rows = [{"period": period, "v": float(index + 1)} for index, period in enumerate(periods)]
        value = self._normalize(rows)
        self.assertEqual(value.ps_5y_samples, 20)
        self.assertAlmostEqual(value.ps_5y_median, 10.5)
        self.assertAlmostEqual(value.ps_5y_p25, 5.75)
        self.assertAlmostEqual(value.ps_5y_p75, 15.25)
        self.assertEqual(value.ps_5y_as_of, periods[-1])

    def test_unordered_dates_are_sorted(self):
        periods = list(_period_quarters(2021, 1, 2026, 0))
        rows = [{"period": period, "v": float(index + 1)} for index, period in enumerate(reversed(periods))]
        value = self._normalize(rows)
        self.assertEqual(value.ps_5y_samples, 20)
        self.assertAlmostEqual(value.ps_5y_median, 10.5)

    def test_points_outside_five_year_window_are_excluded(self):
        rows = [{"period": p, "v": 9999.0 if p == "2020-06-30" else idx}
                for idx, p in enumerate(("2020-06-30", "2021-06-30", "2022-06-30", "2023-06-30",
                                         "2024-06-30", "2025-06-30", "2026-06-30"))]
        value = self._normalize(rows)
        self.assertEqual(value.ps_5y_samples, 6)
        self.assertNotIn(9999.0, (value.ps_5y_p25, value.ps_5y_median, value.ps_5y_p75))

    def test_single_valid_point(self):
        value = self._normalize([{"period": "2026-06-30", "v": 22.0}])
        self.assertEqual(value.ps_5y_samples, 1)
        self.assertAlmostEqual(value.ps_5y_median, 22.0)
        self.assertEqual(value.ps_5y_as_of, "2026-06-30")

    def test_negative_zero_nan_inf_filtered(self):
        rows = [
            {"period": "2026-06-30", "v": -5.0},
            {"period": "2026-03-31", "v": 0.0},
            {"period": "2025-12-31", "v": float("nan")},
            {"period": "2025-09-30", "v": float("inf")},
            {"period": "2025-06-30", "v": 15.0},
        ]
        value = self._normalize(rows)
        self.assertEqual(value.ps_5y_samples, 1)
        self.assertAlmostEqual(value.ps_5y_median, 15.0)

    def test_no_valid_values_keeps_as_of_but_zero_samples(self):
        rows = [{"period": "2026-06-30", "v": None}, {"period": "2026-03-31", "v": float("nan")}]
        value = self._normalize(rows)
        self.assertEqual(value.ps_5y_samples, 0)
        self.assertIsNone(value.ps_5y_median)
        self.assertIsNone(value.ps_5y_p25)
        self.assertIsNone(value.ps_5y_p75)
        self.assertEqual(value.ps_5y_as_of, "2026-06-30")

    def test_anchor_uses_latest_reported_period_not_latest_positive(self):
        rows = [
            {"period": "2020-06-30", "v": 30.0},
            {"period": "2025-06-30", "v": -1.0},
            {"period": "2026-06-30", "v": -5.0},
        ]
        value = self._normalize(rows)
        self.assertEqual(value.ps_5y_as_of, "2026-06-30")
        self.assertEqual(value.ps_5y_samples, 0)
        self.assertIsNone(value.ps_5y_median)

    def test_anchor_fixes_window_before_filtering_positive(self):
        rows = [
            {"period": "2022-06-30", "v": 30.0},
            {"period": "2023-06-30", "v": 10.0},
            {"period": "2024-06-30", "v": 20.0},
            {"period": "2025-06-30", "v": -1.0},
            {"period": "2026-06-30", "v": -5.0},
        ]
        value = self._normalize(rows)
        self.assertEqual(value.ps_5y_as_of, "2026-06-30")
        self.assertEqual(value.ps_5y_samples, 3)
        self.assertAlmostEqual(value.ps_5y_median, 20.0)

    def test_null_value_row_still_anchors(self):
        rows = [
            {"period": "2026-06-30", "v": None},
            {"period": "2024-06-30", "v": 12.0},
            {"period": "2024-12-31", "v": 8.0},
        ]
        value = self._normalize(rows)
        self.assertEqual(value.ps_5y_as_of, "2026-06-30")
        self.assertEqual(value.ps_5y_samples, 2)

    def test_missing_series_gives_zero_samples(self):
        value = normalize_metric(_metric_payload())
        self.assertEqual(value.ps_5y_samples, 0)
        self.assertIsNone(value.ps_5y_median)

    def test_no_parseable_period_gives_null_as_of(self):
        rows = [{"v": 10.0}, {"period": "not-a-date", "v": 20.0}]
        value = self._normalize(rows)
        self.assertEqual(value.ps_5y_samples, 0)
        self.assertIsNone(value.ps_5y_as_of)
        self.assertIsNone(value.ps_5y_median)


class PbHistoryTests(unittest.TestCase):
    def _normalize(self, values):
        payload = _metric_payload(series=_quarterly("pb", values))
        return normalize_metric(payload)

    def test_twenty_sample_window_median_and_quartiles(self):
        periods = list(_period_quarters(2021, 1, 2026, 0))
        rows = [{"period": period, "v": float(index + 1)} for index, period in enumerate(periods)]
        value = self._normalize(rows)
        self.assertEqual(value.pb_5y_samples, 20)
        self.assertAlmostEqual(value.pb_5y_median, 10.5)
        self.assertAlmostEqual(value.pb_5y_p25, 5.75)
        self.assertAlmostEqual(value.pb_5y_p75, 15.25)
        self.assertEqual(value.pb_5y_as_of, periods[-1])

    def test_no_positive_value_keeps_as_of_zero_samples(self):
        rows = [
            {"period": "2020-06-30", "v": 40.0},
            {"period": "2025-06-30", "v": -1.0},
            {"period": "2026-06-30", "v": -5.0},
        ]
        value = self._normalize(rows)
        self.assertEqual(value.pb_5y_as_of, "2026-06-30")
        self.assertEqual(value.pb_5y_samples, 0)
        self.assertIsNone(value.pb_5y_median)

    def test_no_parseable_period_gives_null_as_of(self):
        value = self._normalize([{"v": 10.0}, {"period": "bad", "v": 3.0}])
        self.assertEqual(value.pb_5y_samples, 0)
        self.assertIsNone(value.pb_5y_as_of)

    def test_missing_series_gives_zero_samples(self):
        value = normalize_metric(_metric_payload())
        self.assertEqual(value.pb_5y_samples, 0)


class SanityFixturesTests(unittest.TestCase):
    """Deterministic stand-ins for the observed live coverage (no hardcoded live values)."""

    def test_crwv_ps_history_sparse_pb_history_present(self):
        payload = _metric_payload(
            {"revenuePerShareTTM": 11.8166, "bookValuePerShareQuarterly": 8.9455},
            series=_quarterly("psTTM", [
                {"period": "2025-12-31", "v": 6.64},
                {"period": "2026-03-31", "v": 6.75},
            ]),
        )
        payload["series"]["quarterly"]["pb"] = [
            {"period": "2025-03-31", "v": 8.5},
            {"period": "2025-06-30", "v": 10.7},
            {"period": "2025-09-30", "v": 12.0},
            {"period": "2025-12-31", "v": 15.0},
            {"period": "2026-03-31", "v": 17.4},
        ]
        value = normalize_metric(payload)
        self.assertAlmostEqual(value.revenue_per_share_ttm, 11.8166)
        self.assertAlmostEqual(value.book_value_per_share, 8.9455)
        self.assertEqual(value.ps_5y_samples, 2)
        self.assertAlmostEqual(value.pb_5y_samples, 5)
        self.assertAlmostEqual(value.pb_5y_median, 12.0)

    def test_nbis_dense_ps_and_pb_history(self):
        payload = _metric_payload(
            {"revenuePerShareTTM": 4.8331, "bookValuePerShareQuarterly": 38.0331},
            series=_quarterly("psTTM", []),
        )
        periods = list(_period_quarters(2022, 1, 2026, 2))
        payload["series"]["quarterly"]["psTTM"] = [
            {"period": p, "v": 5.0 + 2.0 * i} for i, p in enumerate(periods)
        ]
        payload["series"]["quarterly"]["pb"] = [
            {"period": p, "v": 2.0 + 0.1 * i} for i, p in enumerate(periods)
        ]
        value = normalize_metric(payload)
        self.assertGreater(value.ps_5y_samples, 10)
        self.assertGreater(value.pb_5y_samples, 10)
        # ps and pb each carry multiple samples (dense history present).

    def test_jpm_no_ps_history_but_pb_and_bvps_present(self):
        payload = _metric_payload(
            {"bookValuePerShareQuarterly": 140.9217},
            series=_quarterly("psTTM", []),
        )
        payload["series"]["quarterly"]["pb"] = [
            {"period": p, "v": 1.5 + 0.05 * i}
            for i, p in enumerate(list(_period_quarters(2021, 1, 2026, 0)))
        ]
        value = normalize_metric(payload)
        self.assertEqual(value.ps_5y_samples, 0)
        self.assertIsNone(value.ps_5y_median)
        self.assertEqual(value.ps_5y_as_of, None)  # empty series -> no reported period
        self.assertGreater(value.pb_5y_samples, 10)
        self.assertAlmostEqual(value.book_value_per_share, 140.9217)

    def test_sofi_no_ps_history_but_pb_and_bvps_present(self):
        payload = _metric_payload(
            {"bookValuePerShareQuarterly": 8.5841},
            series=_quarterly("psTTM", [{"period": "2026-06-30", "v": None}]),
        )
        payload["series"]["quarterly"]["pb"] = [
            {"period": p, "v": 1.2 + 0.02 * i}
            for i, p in enumerate(list(_period_quarters(2021, 1, 2026, 0)))
        ]
        value = normalize_metric(payload)
        self.assertEqual(value.ps_5y_samples, 0)
        # even though the ps series row has a NULL value it is parseable -> as_of kept
        self.assertEqual(value.ps_5y_as_of, "2026-06-30")
        self.assertGreater(value.pb_5y_samples, 10)
        self.assertAlmostEqual(value.book_value_per_share, 8.5841)

    def test_gs_dense_ps_and_pb_history(self):
        payload = _metric_payload(
            {"revenuePerShareTTM": 442.83, "bookValuePerShareQuarterly": 416.94},
            series=_quarterly("psTTM", [
                {"period": p, "v": 1.2 + 0.03 * i}
                for i, p in enumerate(list(_period_quarters(2021, 1, 2026, 0)))
            ]),
        )
        payload["series"]["quarterly"]["pb"] = [
            {"period": p, "v": 0.9 + 0.02 * i}
            for i, p in enumerate(list(_period_quarters(2021, 1, 2026, 0)))
        ]
        value = normalize_metric(payload)
        self.assertGreater(value.ps_5y_samples, 10)
        self.assertGreater(value.pb_5y_samples, 10)


class UpsertTests(unittest.TestCase):
    def test_upsert_writes_relative_valuation_columns(self):
        client = MarketD1Client("token", "account", "database")
        market = MarketData(
            market_cap=3_000_000_000_000,
            pe_ttm=35.5,
            beta=1.1,
            eps_ttm=12.5,
            dividend_yield=0.7,
            checked_at="2026-08-23T12:00:00Z",
            revenue_per_share_ttm=11.8166,
            book_value_per_share=8.9455,
            ps_5y_p25=6.64,
            ps_5y_median=6.75,
            ps_5y_p75=6.85,
            ps_5y_samples=2,
            ps_5y_as_of="2026-03-31",
            pb_5y_p25=8.55,
            pb_5y_median=10.7,
            pb_5y_p75=17.47,
            pb_5y_samples=5,
            pb_5y_as_of="2026-03-31",
        )

        with patch.object(client, "_query", return_value=[]) as query:
            client.upsert_market("CRWV", market, "2026-08-23T12:00:01Z")

        sql, values = query.call_args.args
        for column in (
            "revenue_per_share_ttm", "book_value_per_share",
            "ps_5y_p25", "ps_5y_median", "ps_5y_p75", "ps_5y_samples", "ps_5y_as_of",
            "pb_5y_p25", "pb_5y_median", "pb_5y_p75", "pb_5y_samples", "pb_5y_as_of",
        ):
            self.assertIn(column, sql)
        self.assertIn("ps_5y_median=excluded.ps_5y_median", sql)
        self.assertIn("pb_5y_samples=excluded.pb_5y_samples", sql)
        # accounting columns are never overwritten by this upsert
        self.assertNotIn("revenue_ttm=excluded", sql)
        self.assertNotIn("shareholders_equity=excluded", sql)
        self.assertNotIn("accounting_source=excluded", sql)
        # value order mirrors inserted column order; index 24 is revenue_per_share_ttm
        self.assertAlmostEqual(values[24], 11.8166)
        self.assertAlmostEqual(values[25], 8.9455)
        self.assertAlmostEqual(values[27], 6.75)      # ps_5y_median
        self.assertEqual(values[29], 2)                # ps_5y_samples
        self.assertAlmostEqual(values[32], 10.7)       # pb_5y_median
        self.assertEqual(values[34], 5)                # pb_5y_samples

    def test_upsert_bind_count_matches_placeholder_count(self):
        client = MarketD1Client("token", "account", "database")
        market = MarketData(100.0, None, None, None, None, "2026-08-23T12:00:00Z",
                            ps_5y_samples=0, pb_5y_samples=0)
        with patch.object(client, "_query", return_value=[]) as query:
            client.upsert_market("COIN", market, "2026-08-23T12:00:01Z")
        sql, values = query.call_args.args
        placeholders = sql.count("?")
        self.assertEqual(placeholders, len(values))
        self.assertEqual(len(values), 40)

    def test_upsert_writes_null_for_absent_relative_columns(self):
        client = MarketD1Client("token", "account", "database")
        market = MarketData(100.0, None, None, None, None, "2026-08-23T12:00:00Z",
                            ps_5y_samples=0, pb_5y_samples=0)
        with patch.object(client, "_query", return_value=[]) as query:
            client.upsert_market("SOFI", market, "2026-08-23T12:00:01Z")
        values = query.call_args.args[1]
        self.assertIsNone(values[24])   # revenue_per_share_ttm
        self.assertIsNone(values[25])   # book_value_per_share
        self.assertEqual(values[29], 0)  # ps_5y_samples
        self.assertIsNone(values[26])   # ps_5y_p25
        self.assertEqual(values[34], 0)  # pb_5y_samples


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
                revenue_per_share_ttm=11.8166,
                book_value_per_share=8.9455,
                ps_5y_samples=2,
                ps_5y_median=6.75,
                pb_5y_samples=5,
                pb_5y_median=10.7,
            )

    def settings(self):
        return Settings("key", "token", "account", "database", "", Path("unused"))

    def test_successful_snapshot_writes_relative_valuation(self):
        d1 = self.FakeD1()
        with (
            patch("fundamentals_ingestor.main.load_universe", return_value=["CRWV"]),
            patch("fundamentals_ingestor.main.FinnhubClient", self.FakeFinnhub),
            patch("fundamentals_ingestor.main.MarketD1Client", return_value=d1),
            patch("fundamentals_ingestor.main.FxClient", self.FakeFx),
        ):
            result = run(self.settings())
        self.assertEqual(result, {"processed": 1, "failed": 0, "written": 1})
        market = d1.writes[0][1]
        self.assertAlmostEqual(market.revenue_per_share_ttm, 11.8166)
        self.assertAlmostEqual(market.book_value_per_share, 8.9455)
        self.assertEqual(market.ps_5y_samples, 2)
        self.assertAlmostEqual(market.pb_5y_median, 10.7)

    def test_provider_failure_writes_nothing(self):
        class FailingFinnhub:
            def __init__(self, *args, **kwargs):
                pass

            def fetch(self, symbol):
                raise FinnhubError("finnhub_http_429")

        d1 = self.FakeD1()
        with (
            patch("fundamentals_ingestor.main.load_universe", return_value=["CRWV"]),
            patch("fundamentals_ingestor.main.FinnhubClient", FailingFinnhub),
            patch("fundamentals_ingestor.main.MarketD1Client", return_value=d1),
            patch("fundamentals_ingestor.main.FxClient", self.FakeFx),
        ):
            result = run(self.settings())
        self.assertEqual(result, {"processed": 0, "failed": 1, "written": 0})
        self.assertEqual(d1.writes, [])

    def test_dry_run_normalizes_but_does_not_write(self):
        d1 = self.FakeD1()
        with (
            patch("fundamentals_ingestor.main.load_universe", return_value=["CRWV"]),
            patch("fundamentals_ingestor.main.FinnhubClient", self.FakeFinnhub),
            patch("fundamentals_ingestor.main.MarketD1Client", return_value=d1),
            patch("fundamentals_ingestor.main.FxClient", self.FakeFx),
        ):
            result = run(self.settings(), dry_run=True)
        self.assertEqual(result, {"processed": 1, "failed": 0, "written": 0})
        self.assertEqual(d1.writes, [])


if __name__ == "__main__":
    unittest.main()