import json
import math
import unittest

from fundamentals_ingestor.fx import FxClient, FxError, _first_number, _rate_as_of, parse_rates

VALID = {
    "result": "success",
    "base_code": "USD",
    "time_last_update_utc": "Wed, 26 Aug 2026 00:02:31 +0000",
    "rates": {"USD": 1.0, "TWD": 31.847672, "DKK": 6.40946, "EUR": 0.856908},
}


class FakeResponse:
    status = 200

    def __init__(self, payload):
        self._payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return json.dumps(self._payload).encode("utf-8")


class FakeOpener:
    def __init__(self, payload):
        self._payload = payload

    def __call__(self, request, timeout):
        return FakeResponse(self._payload)


class FxTests(unittest.TestCase):
    def test_parse_returns_quote_to_local_pairs_and_as_of(self):
        rates, as_of = parse_rates(VALID)
        self.assertEqual(as_of, "2026-08-26")
        self.assertEqual(rates, {
            ("USD", "TWD"): 31.847672,
            ("USD", "DKK"): 6.40946,
            ("USD", "EUR"): 0.856908,
        })

    def test_parse_uses_date_field_when_update_label_absent(self):
        payload = {"result": "success", "base_code": "USD", "date": "2026-08-25", "rates": {"TWD": 31.0, "DKK": 6.3, "EUR": 0.85}}
        rates, as_of = parse_rates(payload)
        self.assertEqual(as_of, "2026-08-25")
        self.assertEqual(rates[("USD", "TWD")], 31.0)

    def test_parse_accepts_keyed_conversion_rates_field(self):
        # The official keyed endpoint v6.exchangerate-api.com returns rates under
        # ``conversion_rates``, unlike the legacy keyless ``rates`` field.
        payload = {"result": "success", "base_code": "USD", "time_last_update_utc": "Thu, 27 Aug 2026 00:02:31 +0000", "conversion_rates": {"USD": 1.0, "TWD": 31.8, "DKK": 6.4, "EUR": 0.86}}
        rates, as_of = parse_rates(payload)
        self.assertEqual(as_of, "2026-08-27")
        self.assertEqual(rates, {("USD", "TWD"): 31.8, ("USD", "DKK"): 6.4, ("USD", "EUR"): 0.86})

    def test_parse_raises_when_required_pair_missing(self):
        payload = {"result": "success", "base_code": "USD", "date": "2026-08-26", "rates": {"TWD": 31.0, "EUR": 0.85}}  # no DKK
        with self.assertRaises(FxError):
            parse_rates(payload)

    def test_parse_raises_on_nonpositive_or_invalid_rate(self):
        payload = {"result": "success", "base_code": "USD", "date": "2026-08-26", "rates": {"TWD": 0.0, "DKK": 6.3, "EUR": 0.85}}
        with self.assertRaises(FxError):
            parse_rates(payload)

    def test_parse_rejects_boolean_rates(self):
        payload = {"result": "success", "base_code": "USD", "date": "2026-08-26", "rates": {"TWD": True, "DKK": 6.3, "EUR": 0.85}}
        with self.assertRaises(FxError):
            parse_rates(payload)

    def test_parse_rejects_nan_and_inf_rates(self):
        for bad in (float("nan"), float("inf"), float("-inf")):
            payload = {"result": "success", "base_code": "USD", "date": "2026-08-26", "rates": {"TWD": bad, "DKK": 6.3, "EUR": 0.85}}
            with self.assertRaises(FxError):
                parse_rates(payload)

    def test_parse_rejects_wrong_base_currency(self):
        # A misconfigured FUNDAMENTALS_FX_URL pointing at /latest/EUR must not
        # be accepted as (USD, TWD) rates -> fail closed.
        payload = {"result": "success", "base_code": "EUR", "time_last_update_utc": "Thu, 27 Aug 2026 00:02:31 +0000", "rates": {"TWD": 31.8, "DKK": 6.4, "EUR": 1.0, "USD": 0.86}}
        with self.assertRaises(FxError):
            parse_rates(payload)

    def test_parse_rejects_missing_base_currency(self):
        payload = {"result": "success", "time_last_update_utc": "Thu, 27 Aug 2026 00:02:31 +0000", "rates": {"TWD": 31.8, "DKK": 6.4, "EUR": 0.86}}
        with self.assertRaises(FxError):
            parse_rates(payload)

    def test_parse_rejects_non_success_result(self):
        payload = {"result": "error", "error-type": "invalid-key", "rates": {"TWD": 31.8, "DKK": 6.4, "EUR": 0.86}}
        with self.assertRaises(FxError):
            parse_rates(payload)

    def test_first_number_rejects_boolean_and_non_finite(self):
        self.assertIsNone(_first_number(True))
        self.assertIsNone(_first_number(False))
        self.assertIsNone(_first_number(float("nan")))
        self.assertIsNone(_first_number(float("inf")))
        self.assertIsNone(_first_number(float("-inf")))
        self.assertIsNone(_first_number({}))
        self.assertIsNone(_first_number([]))
        self.assertIsNone(_first_number(None))
        self.assertEqual(_first_number(6), 6.0)
        self.assertEqual(_first_number(6.4), 6.4)
        self.assertEqual(_first_number("0.857"), 0.857)
        self.assertIsNone(_first_number("not-a-rate"))

    def test_rate_as_of_treats_non_string_as_absent(self):
        self.assertIsNone(_rate_as_of(None))
        self.assertIsNone(_rate_as_of(True))
        self.assertIsNone(_rate_as_of(31.8))
        self.assertIsNone(_rate_as_of(31))
        self.assertIsNone(_rate_as_of([]))
        self.assertIsNone(_rate_as_of({}))
        self.assertIsNone(_rate_as_of("   "))
        self.assertEqual(_rate_as_of("Wed, 26 Aug 2026 00:02:31 +0000"), "2026-08-26")
        self.assertEqual(_rate_as_of("2026-08-25T00:00:00Z"), "2026-08-25")

    def test_client_fetch_uses_opener(self):
        client = FxClient(opener=FakeOpener(VALID))
        rates, as_of = client.fetch_rates()
        self.assertEqual(as_of, "2026-08-26")
        self.assertAlmostEqual(rates[("USD", "TWD")], 31.847672)

    def test_client_raises_on_non_200(self):
        class R:
            status = 429

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return b"{}"

        class FailingOpener:
            def __call__(self, request, timeout):
                return R()

        client = FxClient(opener=FailingOpener())
        with self.assertRaises(FxError):
            client.fetch_rates()

    def test_client_raises_fxerror_not_valueerror_on_malformed_url(self):
        # A malformed non-empty FUNDAMENTALS_FX_URL (e.g. "garbage") must produce
        # FxError so _load_fx falls back to LKG, never a raw ValueError that would
        # abort the whole refresh.
        client = FxClient(url="garbage")  # Request("garbage") would raise ValueError
        with self.assertRaises(FxError):
            client.fetch_rates()

    def test_client_raises_fxerror_on_missing_protocol_url(self):
        client = FxClient(url="not-a-url")
        with self.assertRaises(FxError):
            client.fetch_rates()


if __name__ == "__main__":
    unittest.main()