import unittest
from unittest.mock import patch

from fundamentals_ingestor.finnhub import MarketData
from fundamentals_ingestor.market_d1 import MarketD1Client


class MarketD1Tests(unittest.TestCase):
    def test_upsert_updates_only_finnhub_owned_columns(self):
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
        )

        with patch.object(client, "_query", return_value=[]) as query:
            client.upsert_market("MSFT", market, "2026-08-23T12:00:01Z")

        sql, values = query.call_args.args
        self.assertIn("fcf_per_share_ttm", sql)
        self.assertIn("roic_pct=excluded.roic_pct", sql)
        self.assertNotIn("revenue_ttm=excluded", sql)
        self.assertNotIn("accounting_source=excluded", sql)
        self.assertEqual(values[0], "MSFT")
        self.assertEqual(values[6:10], [27.5, 36.0, 0.2, 14.25])

    def test_null_metric_is_written_as_null_on_successful_snapshot(self):
        client = MarketD1Client("token", "account", "database")
        market = MarketData(100.0, None, None, None, None, "2026-08-23T12:00:00Z")

        with patch.object(client, "_query", return_value=[]) as query:
            client.upsert_market("COIN", market, "2026-08-23T12:00:01Z")

        values = query.call_args.args[1]
        self.assertIsNone(values[2])
        self.assertIsNone(values[7])


if __name__ == "__main__":
    unittest.main()
