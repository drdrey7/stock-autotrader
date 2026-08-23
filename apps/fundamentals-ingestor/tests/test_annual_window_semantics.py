import unittest
from types import SimpleNamespace

from fundamentals_ingestor.main import _annual_window_is_safe


def _row(year: int, *, cashflow: bool = True, balance: bool = True) -> SimpleNamespace:
    return SimpleNamespace(
        fiscal_year=year,
        revenue=100.0,
        operating_income=None,
        pretax_income=None,
        income_tax=None,
        net_income=None,
        diluted_eps=None,
        operating_cash_flow=10.0 if cashflow else None,
        capex=None,
        free_cash_flow=None,
        depreciation_amortization=None,
        cash=None,
        total_debt=None,
        shareholders_equity=50.0 if balance else None,
        current_assets=None,
        current_liabilities=None,
    )


class AnnualWindowSemanticsTests(unittest.TestCase):
    def test_confirmed_history_growth_rejects_same_length_shift(self):
        existing = {2024, 2025}
        transient = [_row(2025), _row(2026)]

        self.assertFalse(_annual_window_is_safe(existing, transient, annual_periods_available=3))

    def test_confirmed_history_growth_accepts_complete_window(self):
        existing = {2024, 2025}
        complete = [_row(2024), _row(2025), _row(2026)]

        self.assertTrue(_annual_window_is_safe(existing, complete, annual_periods_available=3))

    def test_rejects_year_missing_cash_flow_statement_coverage(self):
        existing = {2022, 2023, 2024, 2025}
        partial = [_row(2022), _row(2023), _row(2024, cashflow=False), _row(2025)]

        self.assertFalse(_annual_window_is_safe(existing, partial, annual_periods_available=4))

    def test_rejects_year_missing_balance_statement_coverage(self):
        existing = {2022, 2023, 2024, 2025}
        partial = [_row(2022), _row(2023), _row(2024, balance=False), _row(2025)]

        self.assertFalse(_annual_window_is_safe(existing, partial, annual_periods_available=4))

    def test_allows_individual_nullable_metrics_when_each_statement_is_present(self):
        complete = [_row(2023), _row(2024), _row(2025)]

        self.assertTrue(_annual_window_is_safe(set(), complete, annual_periods_available=3))


if __name__ == "__main__":
    unittest.main()
