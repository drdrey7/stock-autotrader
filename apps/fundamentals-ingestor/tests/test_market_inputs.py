import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fundamentals_ingestor.d1 import D1Client
from fundamentals_ingestor.finnhub import MarketData
from fundamentals_ingestor.main import _derived_market
from fundamentals_ingestor.metrics import AccountingInputs


class MarketInputTests(unittest.TestCase):
    def test_quote_is_withheld_when_a_split_changes_basis(self):
        client = D1Client("token", "account", "database")
        with patch.object(client, "_query", side_effect=[[{"price": 100, "provider_timestamp": "2026-08-22T00:00:00Z"}], [{"effective_date": "2026-08-01"}]]):
            result = client.get_latest_quote("NVDA", "2026-07-31")
        self.assertIsNotNone(result)
        self.assertFalse(result.basis_compatible)

    def test_annual_upsert_prunes_years_outside_refreshed_window(self):
        client = D1Client("token", "account", "database")
        row = SimpleNamespace(
            fiscal_year=2026, revenue=None, operating_income=None, pretax_income=None,
            income_tax=None, net_income=None, diluted_eps=None, operating_cash_flow=None,
            capex=None, free_cash_flow=None, depreciation_amortization=None, cash=None,
            total_debt=None, shareholders_equity=None, shares_outstanding=None,
            as_of="FY 2026", source="edgartools",
        )
        with patch.object(client, "_query", return_value=[]) as query:
            client.upsert_annual([("MSFT", row)])
        self.assertIn("DELETE FROM stock_fundamentals_annual", query.call_args_list[1].args[0])

    def test_derived_market_values_use_quote_timestamp_and_current_inputs(self):
        accounting = AccountingInputs(shares_outstanding=10, diluted_eps_ttm=5)
        result = _derived_market(accounting, (20, "2026-08-22T15:00:00Z"), MarketData(None, None, None))
        self.assertEqual(result.market_cap, 200)
        self.assertEqual(result.pe_ttm, 4)
        self.assertEqual(result.market_as_of, "2026-08-22T15:00:00Z")

    def test_derived_market_fails_closed_for_missing_basis(self):
        accounting = AccountingInputs(shares_outstanding=None, diluted_eps_ttm=None)
        result = _derived_market(accounting, (20, "2026-08-22T15:00:00Z"), MarketData(None, None, None))
        self.assertIsNone(result.market_cap)
        self.assertIsNone(result.pe_ttm)


if __name__ == "__main__":
    unittest.main()
