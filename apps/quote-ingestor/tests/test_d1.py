"""D1 HTTP API client tests (fake transport — no network, no secrets printed)."""

from __future__ import annotations

import io
import json
import unittest
import urllib.error

from quote_ingestor.d1 import (
    D1Client,
    D1TransportError,
    build_upsert_sql,
    iso_from_ms,
)

TOKEN = "test-token-value"
ACCOUNT = "account-1"
DATABASE = "db-1"


class _Resp(io.BytesIO):
    def __init__(self, payload: bytes, status: int = 200) -> None:
        super().__init__(payload)
        self.status = status

    def __enter__(self) -> _Resp:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


class FakeTransport:
    """Scripted urlopen: each entry is (response | exception | callable)."""

    def __init__(self) -> None:
        self.queue: list[object] = []
        self.requests: list[dict] = []

    def __call__(self, request: object, timeout: float) -> object:
        req = request  # urllib.Request
        body = getattr(req, "data", None) or b""
        self.requests.append({
            "headers": dict(getattr(req, "headers", {})),
            "body": json.loads(body.decode("utf-8")) if body else None,
            "timeout": timeout,
        })
        item = self.queue.pop(0)
        if callable(item):
            return item(self.requests[-1])
        if isinstance(item, Exception):
            raise item
        return item  # must be a _Resp


def _client(transport: FakeTransport) -> D1Client:
    return D1Client(
        TOKEN,
        ACCOUNT,
        DATABASE,
        max_retries=2,
        retry_base_seconds=0.01,
        batch_max_rows=2,
        random_source=__import__("random").Random(1),
        urlopen=transport,
    )


def _ok_response(changes: int) -> str:
    return json.dumps({
        "success": True, "errors": [], "messages": [],
        "result": [{"success": True, "meta": {"changes": changes, "changes_total": changes}, "results": [], "duration": 1}],
    })


class D1ClientTest(unittest.TestCase):
    def test_multi_values_sql_has_newer_wins_guard_and_preserves_fields(self) -> None:
        sql = build_upsert_sql(2).upper()
        self.assertIn("EXCLUDED.PROVIDER_TIMESTAMP >= LATEST_QUOTES.PROVIDER_TIMESTAMP", sql)
        self.assertIn("LATEST_QUOTES.PREVIOUS_CLOSE", sql)
        self.assertIn("LATEST_QUOTES.DAY_HIGH", sql)
        self.assertIn("LATEST_QUOTES.DAY_LOW", sql)
        self.assertIn("LATEST_QUOTES.DAY_OPEN", sql)
        self.assertIn("ON CONFLICT(SYMBOL)", sql)
        # two VALUES rows
        self.assertEqual(sql.count("FINNHUB-WEBSOCKET"), 2)
        self.assertEqual(sql.count("(?, ?, 0, 0, NULL, NULL, NULL, NULL, 'FINNHUB-WEBSOCKET', ?, ?)"), 2)

    def test_write_ok_success(self) -> None:
        transport = FakeTransport()
        transport.queue.append(_Resp(_ok_response(2).encode()))
        client = _client(transport)
        rows = [("AAPL", 310.63, 1_787_073_678_242), ("NVDA", 900.0, 1_787_073_678_242)]
        result = client.upsert_quotes(rows)
        self.assertEqual(result.written, ["AAPL", "NVDA"])
        self.assertEqual(result.failed, [])
        self.assertEqual(result.total_changes, 2)
        self.assertEqual(len(transport.requests), 1)
        body = transport.requests[0]["body"]
        self.assertIsInstance(body, dict)
        self.assertEqual(body["sql"], build_upsert_sql(2))
        params = body["params"]
        self.assertEqual(params[0], "AAPL")
        self.assertEqual(params[1], 310.63)
        # provider_timestamp is ISO 8601 UTC (comparable with the REST writer)
        self.assertRegex(params[2], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
        # 2 rows x 4 params each
        self.assertEqual(len(params), 8)

    def test_chunking_splits_beyond_batch_max_rows(self) -> None:
        transport = FakeTransport()
        transport.queue.append(_Resp(_ok_response(2).encode()))
        transport.queue.append(_Resp(_ok_response(1).encode()))
        client = _client(transport)  # batch_max_rows=2
        rows = [("A", 1.0, 1000), ("B", 2.0, 1000), ("C", 3.0, 1000)]
        result = client.upsert_quotes(rows)
        self.assertEqual(result.written, ["A", "B", "C"])
        self.assertEqual(len(transport.requests), 2)
        self.assertEqual(len(transport.requests[0]["body"]["params"]), 8)  # rows 1-2
        self.assertEqual(len(transport.requests[1]["body"]["params"]), 4)  # row 3

    def test_rejected_statement_marks_chunk_failed(self) -> None:
        transport = FakeTransport()
        transport.queue.append(_Resp(json.dumps({
            "success": False, "errors": [{"code": 7400, "message": "Invalid input"}],
        }).encode(), status=400))
        client = _client(transport)
        result = client.upsert_quotes([("AAPL", 1.0, 1000), ("NVDA", 2.0, 1000)])
        self.assertEqual(result.written, [])
        self.assertEqual(result.failed, ["AAPL", "NVDA"])

    def test_retry_on_transport_error_then_success(self) -> None:
        transport = FakeTransport()
        transport.queue.append(urllib.error.URLError("boom"))
        transport.queue.append(_Resp(_ok_response(1).encode()))
        client = _client(transport)
        result = client.upsert_quotes([("AAPL", 1.0, 1000)])
        self.assertEqual(result.written, ["AAPL"])
        self.assertEqual(client.error_count, 1)
        self.assertGreaterEqual(len(transport.requests), 2)

    def test_retry_on_http500_then_success(self) -> None:
        transport = FakeTransport()
        transport.queue.append(_Resp(b"", status=500))
        transport.queue.append(_Resp(_ok_response(1).encode()))
        client = _client(transport)
        result = client.upsert_quotes([("AAPL", 1.0, 1000)])
        self.assertEqual(result.written, ["AAPL"])
        self.assertGreaterEqual(len(transport.requests), 2)

    def test_http400_is_not_retried(self) -> None:
        transport = FakeTransport()
        transport.queue.append(_Resp(json.dumps({
            "success": False, "errors": [{"message": "bad sql"}],
        }).encode(), status=400))
        client = _client(transport)
        result = client.upsert_quotes([("AAPL", 1.0, 1000)])
        self.assertEqual(len(transport.requests), 1)
        self.assertEqual(result.failed, ["AAPL"])
        self.assertIsNotNone(result.error)
        self.assertIn("HTTP 400", result.error or "")

    def test_bounded_retries_stops_after_http429(self) -> None:
        transport = FakeTransport()
        for _ in range(5):
            transport.queue.append(_Resp(b"", status=429))
        client = _client(transport)
        result = client.upsert_quotes([("AAPL", 1.0, 1000)])
        # max_retries=2 => 3 attempts total, then failure result
        self.assertEqual(len(transport.requests), 3)
        self.assertEqual(result.failed, ["AAPL"])

    def test_request_authorization_header_uses_bearer(self) -> None:
        transport = FakeTransport()
        transport.queue.append(_Resp(_ok_response(1).encode()))
        client = _client(transport)
        client.upsert_quotes([("AAPL", 1.0, 1000)])
        auth = transport.requests[0]["headers"].get("Authorization")
        self.assertEqual(auth, "Bearer test-token-value")

    def test_health_mirror_upsert(self) -> None:
        transport = FakeTransport()
        transport.queue.append(_Resp(_ok_response(1).encode()))
        client = _client(transport)
        self.assertTrue(client.write_health({"provider": "finnhub-websocket", "ok": True}))
        body = transport.requests[0]["body"]
        self.assertEqual(body["params"][0], "quoteIngestorHealth")

    def test_iso_from_ms(self) -> None:
        self.assertEqual(
            iso_from_ms(1_787_073_678_242),
            "2026-08-18T17:21:18.242Z",
        )


if __name__ == "__main__":
    unittest.main()
