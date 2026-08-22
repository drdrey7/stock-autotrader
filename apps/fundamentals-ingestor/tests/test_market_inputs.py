import unittest

from fundamentals_ingestor.finnhub import MarketData
from fundamentals_ingestor.main import _derived_market
from fundamentals_ingestor.metrics import AccountingInputs


class MarketInputTests(unittest.TestCase):
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
