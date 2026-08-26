import json
import unittest

from fundamentals_ingestor.fx import FxClient, FxError, parse_rates

VALID = {
    "result": "success",
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
        payload = {"date": "2026-08-25", "rates": {"TWD": 31.0, "DKK": 6.3, "EUR": 0.85}}
        rates, as_of = parse_rates(payload)
        self.assertEqual(as_of, "2026-08-25")
        self.assertEqual(rates[("USD", "TWD")], 31.0)

    def test_parse_raises_when_required_pair_missing(self):
        payload = {"date": "2026-08-26", "rates": {"TWD": 31.0, "EUR": 0.85}}  # no DKK
        with self.assertRaises(FxError):
            parse_rates(payload)

    def test_parse_raises_on_nonpositive_or_invalid_rate(self):
        payload = {"date": "2026-08-26", "rates": {"TWD": 0.0, "DKK": 6.3, "EUR": 0.85}}
        with self.assertRaises(FxError):
            parse_rates(payload)

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


if __name__ == "__main__":
    unittest.main()