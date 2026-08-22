import unittest

from fundamentals_ingestor.metrics import AccountingInputs, calculate_metrics


class MetricsTests(unittest.TestCase):
    def test_formulas(self):
        result = calculate_metrics(AccountingInputs(
            revenue_ttm=1_000,
            operating_income_ttm=200,
            pretax_income_ttm=250,
            income_tax_ttm=50,
            operating_cash_flow_ttm=180,
            capex_ttm=30,
            cash=100,
            short_term_investments=50,
            total_debt=300,
            shareholders_equity=500,
            periods_compatible=True,
        ))
        self.assertEqual(result.free_cash_flow_ttm, 150)
        self.assertEqual(result.fcf_margin_pct, 15)
        self.assertEqual(result.debt_to_equity, 0.6)
        self.assertAlmostEqual(result.roic_pct, 160 / 650 * 100)

    def test_fail_closed_denominators_and_periods(self):
        base = AccountingInputs(
            revenue_ttm=0,
            operating_income_ttm=200,
            pretax_income_ttm=0,
            income_tax_ttm=50,
            operating_cash_flow_ttm=180,
            capex_ttm=30,
            cash=100,
            short_term_investments=50,
            total_debt=300,
            shareholders_equity=0,
            periods_compatible=False,
        )
        result = calculate_metrics(base)
        self.assertEqual(result.free_cash_flow_ttm, 150)
        self.assertIsNone(result.fcf_margin_pct)
        self.assertIsNone(result.debt_to_equity)
        self.assertIsNone(result.roic_pct)

    def test_missing_input_never_becomes_zero(self):
        result = calculate_metrics(AccountingInputs(operating_cash_flow_ttm=10, periods_compatible=True))
        self.assertIsNone(result.free_cash_flow_ttm)
        self.assertIsNone(result.fcf_margin_pct)
