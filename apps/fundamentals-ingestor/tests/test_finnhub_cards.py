import unittest

from fundamentals_ingestor.finnhub import normalize_metric


class FinnhubCardNormalizationTests(unittest.TestCase):
    def test_latest_quarterly_card_metrics_and_fcf_share_are_selected(self):
        payload = {
            "metric": {
                "marketCapitalization": 3000,
                "peTTM": 30,
                "totalDebt/totalEquityQuarterly": 9.9,
            },
            "series": {
                "quarterly": {
                    "roicTTM": [
                        {"period": "2025-12-31", "v": 0.2},
                        {"period": "2026-06-30", "v": 0.275},
                    ],
                    "fcfMargin": [
                        {"period": "2025-12-31", "v": 0.25},
                        {"period": "2026-06-30", "v": 0.36},
                    ],
                    "totalDebtToEquity": [
                        {"period": "2025-12-31", "v": 0.3},
                        {"period": "2026-06-30", "v": 0.2},
                    ],
                    "fcfPerShareTTM": [
                        {"period": "2025-12-31", "v": 12.5},
                        {"period": "2026-06-30", "v": 14.25},
                    ],
                },
                "annual": {
                    "roic": [{"period": "2025-12-31", "v": 0.19}],
                    "fcfMargin": [{"period": "2025-12-31", "v": 0.24}],
                },
            },
        }

        value = normalize_metric(payload, "2026-08-23T12:00:00Z")
        self.assertEqual(value.market_cap, 3_000_000_000)
        self.assertEqual(value.pe_ttm, 30)
        self.assertAlmostEqual(value.roic_pct, 27.5)
        self.assertAlmostEqual(value.fcf_margin_pct, 36.0)
        self.assertEqual(value.debt_to_equity, 0.2)
        self.assertEqual(value.fcf_per_share_ttm, 14.25)

    def test_annual_ratio_fallback_and_metric_debt_fallback(self):
        payload = {
            "metric": {
                "marketCapitalization": 100,
                "peTTM": None,
                "totalDebt/totalEquityQuarterly": 0.75,
            },
            "series": {
                "annual": {
                    "roic": [{"period": "2025-12-31", "v": 0.1}],
                    "fcfMargin": [{"period": "2025-12-31", "v": -0.05}],
                },
            },
        }

        value = normalize_metric(payload)
        self.assertEqual(value.roic_pct, 10.0)
        self.assertEqual(value.fcf_margin_pct, -5.0)
        self.assertEqual(value.debt_to_equity, 0.75)
        self.assertIsNone(value.fcf_per_share_ttm)

    def test_zero_quarterly_ratio_is_not_replaced_by_annual_fallback(self):
        payload = {
            "metric": {"marketCapitalization": 100},
            "series": {
                "quarterly": {
                    "roicTTM": [{"period": "2026-06-30", "v": 0.0}],
                    "fcfMargin": [{"period": "2026-06-30", "v": 0.0}],
                },
                "annual": {
                    "roic": [{"period": "2025-12-31", "v": 0.3}],
                    "fcfMargin": [{"period": "2025-12-31", "v": 0.4}],
                },
            },
        }

        value = normalize_metric(payload)
        self.assertEqual(value.roic_pct, 0.0)
        self.assertEqual(value.fcf_margin_pct, 0.0)


if __name__ == "__main__":
    unittest.main()
