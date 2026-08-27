import unittest

from fundamentals_ingestor.config import from_env
from fundamentals_ingestor.fx import DEFAULT_FX_URL


class FinnhubOnlyConfigTests(unittest.TestCase):
    def _base_env(self):
        return {
            "FINNHUB_API_KEY": "finnhub",
            "CLOUDFLARE_API_TOKEN": "token",
            "CLOUDFLARE_ACCOUNT_ID": "account",
            "CLOUDFLARE_D1_DATABASE_ID": "database",
        }

    def test_edgar_identity_is_not_required_by_daily_runtime(self):
        settings = from_env(self._base_env())
        self.assertEqual(settings.edgar_identity, "")

    def test_whitespace_fx_url_uses_default(self):
        environ = self._base_env()
        environ["FUNDAMENTALS_FX_URL"] = "   "
        settings = from_env(environ)
        self.assertEqual(settings.fx_url, DEFAULT_FX_URL)


if __name__ == "__main__":
    unittest.main()
