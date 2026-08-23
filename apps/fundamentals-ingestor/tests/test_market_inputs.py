import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fundamentals_ingestor.d1 import SNAPSHOT_COLUMNS, D1Client, snapshot_values
from fundamentals_ingestor.edgar import AnnualFundamental
from fundamentals_ingestor.finnhub import MarketData
from fundamentals_ingestor.metrics import AccountingInputs


class InputPersistenceTests(unittest.TestCase):
    def test_snapshot_persists_direct_finnhub_values_without_quote_derivation(self):
        values = snapshot_values(
            "MSFT",
            MarketData(100.0, 20.0, 1.1, 5.0, 0.5, "2026-08-22T23:30:00Z"),
            AccountingInputs(revenue_ttm=100, free_cash_flow_ttm=25, periods_compatible=True),
            "2026-08-22T23:30:00Z",
            "accession",
            "10-K",
        )
        self.assertEqual(values[0], "MSFT")
        self.assertEqual(values[1:6], [100.0, 20.0, 1.1, 5.0, 0.5])
        self.assertEqual(values[SNAPSHOT_COLUMNS.index("accounting_periods_compatible")], 1)
        self.assertEqual(values[-3], "2026-08-22T23:30:00Z")

    def test_annual_upsert_prunes_years_outside_refreshed_window(self):
        client = D1Client("token", "account", "database")
        row = AnnualFundamental(
            fiscal_year=2026, revenue=None, operating_income=None, pretax_income=None,
            income_tax=None, net_income=None, diluted_eps=None, operating_cash_flow=None,
            capex=None, free_cash_flow=None, depreciation_amortization=None, cash=None,
            total_debt=None, shareholders_equity=None, shares_outstanding=None,
            current_assets=None, current_liabilities=None, as_of="FY 2026", source="edgartools",
        )
        with patch.object(client, "_query", return_value=[]) as query:
            client.upsert_annual([("MSFT", row)])
        self.assertIn("DELETE FROM stock_fundamentals_annual", query.call_args_list[1].args[0])

    def test_annual_upsert_updates_current_balance_inputs_on_conflict(self):
        client = D1Client("token", "account", "database")
        row = AnnualFundamental(
            fiscal_year=2026, revenue=None, operating_income=None, pretax_income=None,
            income_tax=None, net_income=None, diluted_eps=None, operating_cash_flow=None,
            capex=None, free_cash_flow=None, depreciation_amortization=None, cash=None,
            total_debt=None, shareholders_equity=None, shares_outstanding=None,
            current_assets=120, current_liabilities=80, as_of="FY 2026", source="edgartools",
        )
        with patch.object(client, "_query", return_value=[]) as query:
            client.upsert_annual([("MSFT", row)])
        sql = query.call_args_list[0].args[0]
        self.assertIn("current_assets=excluded.current_assets", sql)
        self.assertIn("current_liabilities=excluded.current_liabilities", sql)

    def test_annual_upsert_rejects_more_than_five_rows(self):
        client = D1Client("token", "account", "database")
        row = SimpleNamespace(fiscal_year=2026)
        with self.assertRaisesRegex(RuntimeError, "annual_history_window_invalid"):
            client.upsert_annual([("MSFT", row)] * 6)


if __name__ == "__main__":
    unittest.main()
