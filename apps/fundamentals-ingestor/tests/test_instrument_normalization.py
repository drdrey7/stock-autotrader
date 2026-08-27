import unittest

from fundamentals_ingestor.finnhub import MarketData
from fundamentals_ingestor.instruments import (
    InstrumentMetadata,
    get_instrument,
    needs_normalization,
    normalize_to_quote_currency,
)

FX = {
    ("USD", "TWD"): 31.85,
    ("USD", "DKK"): 6.41,
    ("USD", "EUR"): 0.857,
}


def build_market(eps=87.38, fcf=43.88, revenue=172.35, bvps=248.05, market_cap=6.31e13, pe=27.86):
    return MarketData(
        market_cap=market_cap,
        pe_ttm=pe,
        beta=1.0,
        eps_ttm=eps,
        dividend_yield=1.0,
        checked_at="2026-08-26T00:00:00Z",
        fcf_per_share_ttm=fcf,
        revenue_per_share_ttm=revenue,
        book_value_per_share=bvps,
    )


def synthetic_adr_meta():
    return InstrumentMetadata("X", "USD", "USD", "ADR", 5.0)


class InstrumentNormalizationTests(unittest.TestCase):
    def test_tsm_twd_ordinary_to_usd_adr(self):
        meta = get_instrument("TSM")
        self.assertTrue(needs_normalization(meta))
        self.assertEqual(meta.underlying_shares_per_listing, 5.0)
        market = build_market(eps=87.38, fcf=43.88, revenue=172.35, bvps=248.05, market_cap=6.314532e13)
        canonical = normalize_to_quote_currency(market, meta, FX)
        # canonical per-ADR USD = raw ordinary TWD * 5 / 31.85
        self.assertAlmostEqual(canonical.eps_ttm, 87.38 * 5 / 31.85, places=3)
        self.assertAlmostEqual(canonical.fcf_per_share_ttm, 43.88 * 5 / 31.85, places=3)
        self.assertAlmostEqual(canonical.revenue_per_share_ttm, 172.35 * 5 / 31.85, places=3)
        self.assertAlmostEqual(canonical.book_value_per_share, 248.05 * 5 / 31.85, places=3)
        # market cap is total company value -> FX only, no ADR ratio
        self.assertAlmostEqual(canonical.market_cap, 6.314532e13 / 31.85, places=0)

    def test_nvo_dkk_to_usd_ratio_one(self):
        meta = get_instrument("NVO")
        market = build_market(eps=26.18, revenue=74.27, bvps=49.997, market_cap=1.327639e12)
        canonical = normalize_to_quote_currency(market, meta, FX)
        self.assertAlmostEqual(canonical.eps_ttm, 26.18 / 6.41, places=3)
        self.assertAlmostEqual(canonical.market_cap, 1.327639e12 / 6.41, places=0)

    def test_asml_eur_to_usd_ratio_one(self):
        meta = get_instrument("ASML")
        market = build_market(eps=26.96, revenue=91.69, bvps=67.68, market_cap=5.985702e11)
        canonical = normalize_to_quote_currency(market, meta, FX)
        self.assertAlmostEqual(canonical.eps_ttm, 26.96 / 0.857, places=3)
        self.assertAlmostEqual(canonical.market_cap, 5.985702e11 / 0.857, places=0)

    def test_arm_is_identity_noop(self):
        meta = get_instrument("ARM")
        self.assertFalse(needs_normalization(meta))
        market = build_market(eps=0.975, fcf=1.378, revenue=4.78, bvps=8.08, market_cap=2.9e11)
        canonical = normalize_to_quote_currency(market, meta, {})
        self.assertEqual(canonical.eps_ttm, 0.975)
        self.assertEqual(canonical.fcf_per_share_ttm, 1.378)
        self.assertEqual(canonical.revenue_per_share_ttm, 4.78)
        self.assertEqual(canonical.book_value_per_share, 8.08)
        self.assertEqual(canonical.market_cap, 2.9e11)
        self.assertEqual(canonical.pe_ttm, market.pe_ttm)

    def test_us_ordinary_stock_is_identity(self):
        meta = get_instrument("AAPL")
        self.assertFalse(needs_normalization(meta))
        market = build_market(eps=6.5)
        self.assertEqual(normalize_to_quote_currency(market, meta, {}).eps_ttm, 6.5)

    def test_synthetic_adr_same_currency_ratio_scales_without_fx(self):
        # USD quote, USD fundamentals, ratio 5.0 -> EPS raw 2 => canonical 10,
        # and NO FX rate is needed (identity currency, fx factor 1).
        meta = synthetic_adr_meta()
        self.assertTrue(needs_normalization(meta))
        market = build_market(eps=2.0, revenue=10.0, market_cap=1_000_000)
        canonical = normalize_to_quote_currency(market, meta, {})  # no FX at all
        self.assertAlmostEqual(canonical.eps_ttm, 10.0)
        self.assertAlmostEqual(canonical.revenue_per_share_ttm, 50.0)
        # market cap is volume-independent of ADR ratio -> unchanged (fx factor 1)
        self.assertAlmostEqual(canonical.market_cap, 1_000_000)

    def test_same_currency_ratio_one_is_exact_noop(self):
        meta = InstrumentMetadata("X", "USD", "USD", "domestic_ordinary", 1.0)
        self.assertFalse(needs_normalization(meta))
        market = build_market(eps=6.5)
        self.assertEqual(normalize_to_quote_currency(market, meta, {}).eps_ttm, 6.5)

    def test_different_currency_ratio_one_is_fx_only(self):
        meta = InstrumentMetadata("X", "USD", "EUR", "ADS", 1.0)
        self.assertTrue(needs_normalization(meta))
        market = build_market(eps=26.96, market_cap=5.985702e11)
        canonical = normalize_to_quote_currency(market, meta, FX)
        self.assertAlmostEqual(canonical.eps_ttm, 26.96 / 0.857, places=3)
        self.assertAlmostEqual(canonical.market_cap, 5.985702e11 / 0.857, places=0)

    def test_different_currency_ratio_five_is_adr_times_fx(self):
        # foreign currency and a 5:1 ADR ratio -> per-share scaled by ratio AND fx
        meta = InstrumentMetadata("X", "USD", "TWD", "ADR/ADS", 5.0)
        market = build_market(eps=87.38, market_cap=6.31e13)
        canonical = normalize_to_quote_currency(market, meta, FX)
        self.assertAlmostEqual(canonical.eps_ttm, 87.38 * 5 / 31.85, places=3)
        self.assertAlmostEqual(canonical.market_cap, 6.31e13 / 31.85, places=0)

    def test_missing_fx_fails_closed_to_null(self):
        meta = get_instrument("TSM")
        market = build_market()
        canonical = normalize_to_quote_currency(market, meta, {})  # no rates
        self.assertIsNone(canonical.eps_ttm)
        self.assertIsNone(canonical.fcf_per_share_ttm)
        self.assertIsNone(canonical.revenue_per_share_ttm)
        self.assertIsNone(canonical.book_value_per_share)
        self.assertIsNone(canonical.market_cap)
        # non-unit-dependent facts preserved
        self.assertEqual(canonical.pe_ttm, market.pe_ttm)

    def test_ratios_are_never_converted(self):
        meta = get_instrument("TSM")
        market = build_market(pe=27.86)
        canonical = normalize_to_quote_currency(market, meta, FX)
        self.assertEqual(canonical.pe_ttm, 27.86)

    def test_default_metadata_for_unlisted_symbol(self):
        meta = get_instrument("MSFT")
        self.assertEqual(meta.quote_currency, "USD")
        self.assertEqual(meta.fundamentals_currency, "USD")
        self.assertEqual(meta.underlying_shares_per_listing, 1.0)


if __name__ == "__main__":
    unittest.main()