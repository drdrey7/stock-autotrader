from __future__ import annotations

import unittest

from ai_analysis_runner.earnings_context import format_latest_earnings, latest_reported_row


class EarningsContextTests(unittest.TestCase):
    def test_latest_reported_wins_over_older_reported_and_future_scheduled(self) -> None:
        older = {"status": "reported", "reported": 1, "reported_at": "2026-05-27", "fiscal_quarter": 1}
        newer = {"status": "reported", "reported": 1, "reported_at": "2026-08-26", "fiscal_quarter": 2}
        scheduled = {"status": "scheduled", "reported": 0, "scheduled_date": "2026-11-18", "fiscal_quarter": 3}
        self.assertIs(latest_reported_row([newer, scheduled, older]), newer)

    def test_official_and_adjusted_values_keep_distinct_basis(self) -> None:
        context = format_latest_earnings({
            "status": "reported", "reported": 1, "reported_at": "2026-08-26",
            "fiscal_year": 2027, "fiscal_quarter": 2,
            "revenue_actual_official": 96200000000, "revenue_actual_source": "SEC XBRL",
            "eps_actual_gaap": 1.05, "eps_actual_gaap_source": "SEC XBRL",
            "eps_actual_adjusted": 1.08, "eps_actual_adjusted_source": "provider",
            "data_quality_status": "different-basis", "sec_accession": "000000",
        }, "NVDA")
        self.assertIn("Official quarterly revenue: $96.2B", context)
        self.assertIn("Official GAAP diluted EPS: $1.05", context)
        self.assertIn("Adjusted/provider EPS: $1.08", context)
        self.assertIn("different-basis", context)
        self.assertNotIn("Official GAAP diluted EPS: $1.08", context)

    def test_missing_metrics_still_identifies_reported_fiscal_period(self) -> None:
        context = format_latest_earnings({
            "status": "reported", "reported": 1, "reported_at": "2026-08-26",
            "fiscal_year": 2027, "fiscal_quarter": 2,
        }, "NVDA")
        self.assertIn("Reported: 2026-08-26", context)
        self.assertIn("Fiscal period: FY2027 Q2", context)
        self.assertNotIn("revenue", context.lower())

    def test_no_reported_event_returns_empty_context(self) -> None:
        self.assertEqual(format_latest_earnings(latest_reported_row([
            {"status": "scheduled", "reported": 0},
        ]), "NVDA"), "")

    def test_nvda_context_explicitly_prevents_stale_no_event_claim(self) -> None:
        context = format_latest_earnings({
            "status": "reported", "reported": 1, "reported_at": "2026-08-26",
            "fiscal_year": 2027, "fiscal_quarter": 2,
        }, "NVDA")
        self.assertIn("latest known reported earnings event", context)
        self.assertIn("FY2027 Q2", context)

    def test_context_stays_compact(self) -> None:
        context = format_latest_earnings({
            "status": "reported", "reported": 1, "reported_at": "2026-08-26",
            "fiscal_year": 2027, "fiscal_quarter": 2,
            "fiscal_period_end": "2026-07-26", "revenue_actual_official": 96200000000,
            "eps_actual_gaap": 1.05, "eps_actual_adjusted": 1.08,
            "data_quality_status": "verified", "sec_accession": "000000",
        }, "NVDA")
        self.assertLessEqual(len(context), 2000)

    def test_oversized_d1_text_is_bounded(self) -> None:
        context = format_latest_earnings({
            "status": "reported", "reported": 1, "reported_at": "2026-08-26",
            "fiscal_year": 2027, "fiscal_quarter": 2,
            "data_quality_status": "x" * 10000,
            "eps_actual_adjusted_source": "provider" + ("-detail" * 10000),
        }, "NVDA")
        self.assertLessEqual(len(context), 2000)


if __name__ == "__main__":
    unittest.main()
