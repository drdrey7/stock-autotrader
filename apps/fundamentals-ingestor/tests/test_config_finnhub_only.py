import unittest

from fundamentals_ingestor.config import from_env


class FinnhubOnlyConfigTests(unittest.TestCase):
    def test_edgar_identity_is_not_required_by_daily_runtime(self):
        settings = from_env({
            "FINNHUB_API_KEY": "finnhub",
            "CLOUDFLARE_API_TOKEN": "token",
            "CLOUDFLARE_ACCOUNT_ID": "account",
            "CLOUDFLARE_D1_DATABASE_ID": "database",
        })
        self.assertEqual(settings.edgar_identity, "")


if __name__ == "__main__":
    unittest.main()
