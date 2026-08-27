import unittest

from fundamentals_ingestor.config import ConfigError, from_env

BASE = {
    "FINNHUB_API_KEY": "finnhub",
    "CLOUDFLARE_API_TOKEN": "token",
    "CLOUDFLARE_ACCOUNT_ID": "account",
    "CLOUDFLARE_D1_DATABASE_ID": "database",
    "EXCHANGE_RATE_API_KEY": "fx-key",
}


class FinnhubOnlyConfigTests(unittest.TestCase):
    def test_edgar_identity_is_not_required_by_daily_runtime(self):
        settings = from_env(dict(BASE))
        self.assertEqual(settings.edgar_identity, "")

    def test_exchange_rate_api_key_is_required(self):
        environ = {k: v for k, v in BASE.items() if k != "EXCHANGE_RATE_API_KEY"}
        with self.assertRaises(ConfigError):
            from_env(environ)

    def test_fx_url_defaults_to_keyed_endpoint_when_override_missing(self):
        settings = from_env(dict(BASE))
        self.assertEqual(settings.fx_url, "https://v6.exchangerate-api.com/v6/fx-key/latest/USD")

    def test_fx_url_defaults_when_overrides_empty_or_whitespace(self):
        for value in ("", "   ", "   \t  "):
            environ = dict(BASE)
            environ["FUNDAMENTALS_FX_URL"] = value
            self.assertEqual(from_env(environ).fx_url, "https://v6.exchangerate-api.com/v6/fx-key/latest/USD")

    def test_fx_url_uses_stripped_custom_url(self):
        environ = dict(BASE)
        environ["FUNDAMENTALS_FX_URL"] = "  https://example.com/rates  "
        self.assertEqual(from_env(environ).fx_url, "https://example.com/rates")

    def test_settings_repr_redacts_the_fx_key(self):
        self.assertNotIn("fx-key", repr(from_env(dict(BASE))))
        self.assertIn("exchange_rate_api_key='<redacted>'", repr(from_env(dict(BASE))))


if __name__ == "__main__":
    unittest.main()