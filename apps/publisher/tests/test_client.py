import hashlib
import hmac
import json
import unittest
from unittest import mock

from publisher import client


class SignTests(unittest.TestCase):
    def test_sign_is_deterministic_hmac_sha256(self):
        body = b'{"events":[]}'
        sig = client.sign("sekret", body)
        self.assertTrue(sig.startswith("sha256="))
        expected = "sha256=" + hmac.new(
            b"sekret", body, hashlib.sha256
        ).hexdigest()
        self.assertEqual(sig, expected)
        self.assertEqual(client.sign("sekret", body), sig)
        self.assertNotEqual(client.sign("other", body), sig)


class PublishTests(unittest.TestCase):
    def test_publish_sends_signed_batch(self):
        events = [client.make_event("SYSTEM_STATUS", {"engine": "online", "apiHealth": "healthy"})]
        captured = {}

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def read(self):
                return b'{"applied":["e1"],"skipped":[],"rejected":[]}'

        def fake_urlopen(request, timeout=30):
            captured["url"] = request.full_url
            captured["method"] = request.get_method()
            # urllib lowercases header names — do a case-insensitive lookup.
            headers = {k.lower(): v for k, v in request.headers.items()}
            captured["signature"] = headers.get("x-ingest-signature")
            captured["timestamp"] = headers.get("x-ingest-timestamp")
            captured["body"] = request.data
            return FakeResponse()

        with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen) as m:
            result = client.publish("https://example.com/ingest/events", "sekret", events, timeout=5)

        self.assertEqual(result, {"applied": ["e1"], "skipped": [], "rejected": []})
        self.assertEqual(captured["url"], "https://example.com/ingest/events")
        self.assertEqual(captured["method"], "POST")
        parsed = json.loads(captured["body"])
        self.assertEqual(parsed["events"][0]["type"], "SYSTEM_STATUS")
        # Signature must be over the exact body sent.
        self.assertEqual(captured["signature"], client.sign("sekret", captured["body"]))
        m.assert_called_once()


class MakeEventTests(unittest.TestCase):
    def test_make_event_envelope(self):
        ev = client.make_event("SCAN_STARTED", {"universe": 1600}, event_id="scan-1")
        self.assertEqual(ev["type"], "SCAN_STARTED")
        self.assertEqual(ev["event_id"], "scan-1")
        self.assertEqual(ev["payload"], {"universe": 1600})
        self.assertIn("timestamp", ev)

    def test_make_event_generates_id(self):
        ev = client.make_event("SYSTEM_STATUS", {})
        self.assertIn("system_status-", ev["event_id"])


if __name__ == "__main__":
    unittest.main()
