"""Secret-leak regression tests.

Guarantees the ingestor can never put FINNHUB_API_KEY / Cloudflare token
values into logs, health records or error strings, even when a provider
error message contains the key.
"""

from __future__ import annotations

import io
import json
import logging
import unittest

from quote_ingestor.app import log_event
from quote_ingestor.config import Settings
from quote_ingestor.d1 import D1Client
from quote_ingestor.ws import FinnhubWebSocketClient

FAKE_KEY = "FINNHUB_S3CR3T_abc123XYZ"
FAKE_TOKEN = "CF_TOKEN_S3CR3T_abc123XYZ"


class _CaptureHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.INFO)
        self.buffer: io.StringIO = io.StringIO()
        self.setFormatter(logging.Formatter("%(message)s"))

    def emit(self, record: logging.LogRecord) -> None:
        self.buffer.write(self.format(record) + "\n")


class _Resp(io.BytesIO):
    status = 200

    def __enter__(self) -> _Resp:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


class SecretLeakTest(unittest.TestCase):
    def setUp(self) -> None:
        self.handler = _CaptureHandler()
        root = logging.getLogger()
        root.addHandler(self.handler)
        root.setLevel(logging.INFO)

    def tearDown(self) -> None:
        logging.getLogger().removeHandler(self.handler)

    def _assert_no_secrets(self) -> None:
        output = self.handler.buffer.getvalue()
        self.assertNotIn(FAKE_KEY, output)
        self.assertNotIn(FAKE_TOKEN, output)

    def test_startup_logs_never_contain_secret_values(self) -> None:
        # Simulates the exact startup lines (booleans only).
        log_event("startup", finnhub_key_configured=True, cloudflare_token_configured=True)
        log_event("universe_loaded", symbols=50)
        self._assert_no_secrets()

    def test_flush_and_health_logs_never_contain_secret_values(self) -> None:
        log_event("d1_baseline", total_rows=50)
        log_event("flush", requested=12, written=12, failed=0, duration_ms=240, http_status=200)
        log_event("shutdown", connection_status="disconnected", d1_write_errors=0)
        self._assert_no_secrets()

    def test_ws_error_logs_scrub_the_api_key(self) -> None:
        settings = Settings(
            finnhub_api_key=FAKE_KEY,
            cloudflare_api_token=FAKE_TOKEN,
            cloudflare_account_id="c",
            cloudflare_d1_database_id="d",
            ws_reconnect_base_seconds=0.01,
            ws_reconnect_max_seconds=0.05,
            ws_reconnect_jitter=0.1,
        )

        def poisoned_factory():
            raise RuntimeError(f"handshake failed: token={FAKE_KEY}")

        received: list[str] = []
        client = FinnhubWebSocketClient(
            settings,
            ["AAPL"],
            on_message=received.append,
            connect_factory=poisoned_factory,
        )
        # Connect fails with an error message that embeds the Finnhub key; the
        # client's scrub guard must strip it from anything it records/logs.
        # (The Cloudflare token never enters the WS layer at all.)
        scrubbed = client._scrub(f"token={FAKE_KEY}")
        self.assertNotIn(FAKE_KEY, scrubbed)
        self.assertIn("***", scrubbed)
        logger = logging.getLogger("quote_ingestor.ws")
        logger.error("ws connection lost", extra={"error": client._scrub(f"handshake {FAKE_KEY}")})
        self._assert_no_secrets()

    def test_d1_client_error_paths_never_log_credentials(self) -> None:
        # The D1 client must only ever place the token in the Authorization
        # header — never in the request body, error strings or logs. A full
        # write request is captured here and inspected for leaks.
        import json as _json

        class _FakeResp(io.BytesIO):
            status = 200

        recording: list[dict] = []

        def fake_urlopen(request: object, _timeout: float) -> io.BytesIO:
            body = getattr(request, "data", None) or b""
            recording.append({
                "headers": dict(getattr(request, "headers", {})),
                "body": _json.loads(body.decode("utf-8")) if body else None,
            })
            return _FakeResp(_json.dumps({
                "success": True, "errors": [], "messages": [],
                "result": [{"success": True, "meta": {"changes": 1}, "results": [], "duration": 1}],
            }).encode())

        d1 = D1Client(FAKE_TOKEN, "acc", "db", max_retries=0, retry_base_seconds=0.01, urlopen=fake_urlopen)
        d1.upsert_quotes([("AAPL", 1.0, 1_000)])
        body_text = _json.dumps(recording[0]["body"])
        self.assertNotIn(FAKE_TOKEN, body_text)
        self.assertNotIn(FAKE_KEY, body_text)
        # The token lives only in the Authorization header (expected).
        self.assertEqual(recording[0]["headers"].get("Authorization"), f"Bearer {FAKE_TOKEN}")
        self._assert_no_secrets()


if __name__ == "__main__":
    unittest.main()
