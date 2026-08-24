from __future__ import annotations

import base64
import json
import unittest
import urllib.error
import uuid
from typing import Any

from ai_analysis_runner.http import HttpError
from ai_analysis_runner.queue_client import LeasedQueueProtocolError, QueueClient, QueueProtocolError

from tests.helpers import FakeResponse


class QueueOpener:
    def __init__(self, payloads: list[dict[str, Any]]) -> None:
        self.payloads = payloads
        self.requests: list[dict[str, Any]] = []

    def __call__(self, request: Any, timeout: float) -> FakeResponse:
        self.requests.append({"url": request.full_url, "body": json.loads(request.data), "timeout": timeout})
        return FakeResponse(self.payloads.pop(0))


class QueueFailingOpener:
    def __init__(self) -> None:
        self.attempts = 0

    def __call__(self, request: Any, timeout: float) -> FakeResponse:
        self.attempts += 1
        raise urllib.error.URLError("connection reset after a server-side pull")


def queue_payload(
    body: str,
    content_type: str = "text",
    attempts: Any = 2,
    lease_id: Any = "opaque-lease",
) -> dict[str, Any]:
    return {
        "success": True,
        "result": {
            "messages": [{
                "id": "message-1",
                "attempts": attempts,
                "lease_id": lease_id,
                "body": body,
                "metadata": {"CF-Content-Type": content_type},
                "timestamp_ms": 1_800_000_000_000,
            }],
        },
    }


class QueueClientTests(unittest.TestCase):
    def make_client(self, opener: QueueOpener) -> QueueClient:
        return QueueClient(
            "secret", "account", "queue",
            visibility_timeout_ms=300_000,
            timeout_seconds=30,
            max_attempts=1,
            opener=opener,
        )

    def test_pulls_strict_text_json_envelope(self) -> None:
        analysis_id = str(uuid.uuid4())
        opener = QueueOpener([queue_payload(json.dumps({"schemaVersion": 1, "analysisId": analysis_id}))])
        message = self.make_client(opener).pull()
        self.assertIsNotNone(message)
        self.assertEqual(message.analysis_id, analysis_id)
        self.assertEqual(message.attempts, 2)
        self.assertEqual(opener.requests[0]["body"], {"batch_size": 1, "visibility_timeout_ms": 300_000})

    def test_accepts_cloudflare_zero_based_first_delivery_attempt(self) -> None:
        analysis_id = str(uuid.uuid4())
        payload = queue_payload(json.dumps({"schemaVersion": 1, "analysisId": analysis_id}), attempts=0)
        message = self.make_client(QueueOpener([payload])).pull()
        self.assertEqual(message.attempts, 0)

    def test_rejects_invalid_delivery_attempts(self) -> None:
        analysis_id = str(uuid.uuid4())
        body = json.dumps({"schemaVersion": 1, "analysisId": analysis_id})
        for attempts in (-1, True, "0", None):
            with self.subTest(attempts=attempts):
                with self.assertRaisesRegex(LeasedQueueProtocolError, "queue_attempts_invalid") as raised:
                    self.make_client(QueueOpener([queue_payload(body, attempts=attempts)])).pull()
                self.assertEqual(raised.exception.lease_id, "opaque-lease")

    def test_safely_decodes_json_and_bytes_base64(self) -> None:
        analysis_id = str(uuid.uuid4())
        encoded = base64.b64encode(json.dumps({"schemaVersion": 1, "analysisId": analysis_id}).encode()).decode()
        for content_type in ("json", "bytes"):
            with self.subTest(content_type=content_type):
                message = self.make_client(QueueOpener([queue_payload(encoded, content_type)])).pull()
                self.assertEqual(message.analysis_id, analysis_id)

    def test_rejects_v8_invalid_base64_and_extra_fields(self) -> None:
        analysis_id = str(uuid.uuid4())
        cases = [
            queue_payload("ignored", "v8"),
            queue_payload("not-base64!", "json"),
            queue_payload(json.dumps({"schemaVersion": 1, "analysisId": analysis_id, "extra": True})),
            queue_payload(json.dumps({"schemaVersion": 2, "analysisId": analysis_id})),
            queue_payload(json.dumps({"schemaVersion": 1, "analysisId": 123})),
        ]
        for payload in cases:
            with self.subTest(payload=payload):
                with self.assertRaises(QueueProtocolError):
                    self.make_client(QueueOpener([payload])).pull()

    def test_malformed_poison_without_usable_lease_is_rejected_without_settlement(self) -> None:
        payload = queue_payload(
            "not-json",
            lease_id=None,
        )
        with self.assertRaisesRegex(QueueProtocolError, "queue_lease_invalid") as raised:
            self.make_client(QueueOpener([payload])).pull()
        self.assertNotIsInstance(raised.exception, LeasedQueueProtocolError)

    def test_ack_and_retry_use_lease_only(self) -> None:
        analysis_id = str(uuid.uuid4())
        opener = QueueOpener([
            queue_payload(json.dumps({"schemaVersion": 1, "analysisId": analysis_id})),
            {"success": True, "result": {}},
            {"success": True, "result": {}},
        ])
        client = self.make_client(opener)
        message = client.pull()
        client.ack(message)
        client.retry(message, 60)
        self.assertEqual(opener.requests[1]["body"], {"acks": [{"lease_id": "opaque-lease"}], "retries": []})
        self.assertEqual(
            opener.requests[2]["body"],
            {"acks": [], "retries": [{"lease_id": "opaque-lease", "delay_seconds": 60}]},
        )

    def test_empty_pull_is_none(self) -> None:
        client = self.make_client(QueueOpener([{"success": True, "result": {"messages": []}}]))
        self.assertIsNone(client.pull())

    def test_pull_uses_exactly_one_http_attempt(self) -> None:
        opener = QueueFailingOpener()
        client = QueueClient(
            "secret", "account", "queue",
            visibility_timeout_ms=300_000,
            timeout_seconds=30,
            max_attempts=3,  # a response lost after a server-side pull must not lease another message
            opener=opener,
        )
        with self.assertRaises(HttpError):
            client.pull()
        self.assertEqual(opener.attempts, 1)


if __name__ == "__main__":
    unittest.main()
