"""D1 HTTP API client tests (fake transport — no network, no secrets printed)."""

from __future__ import annotations

import datetime as dt
import io
import json
import sqlite3
import unittest
import urllib.error

from quote_ingestor.d1 import (
    D1Client,
    D1TransportError,
    build_upsert_sql,
    iso_from_ms,
)
from quote_ingestor.market_hours import session_close_utc

TOKEN = "test-token-value"
ACCOUNT = "account-1"
DATABASE = "db-1"
TRADE_MS = 1_787_073_678_242  # 2026-08-18, a regular Tuesday session.
PRIOR_CLOSE_MS = int(dt.datetime(2026, 8, 17, 19, 59, tzinfo=dt.UTC).timestamp() * 1000)
CURRENT_OPEN_MS = int(dt.datetime(2026, 8, 18, 14, 0, tzinfo=dt.UTC).timestamp() * 1000)

SESSION_SCHEMA = """
CREATE TABLE latest_quotes (
  symbol TEXT PRIMARY KEY,
  price REAL NOT NULL,
  change_abs REAL NOT NULL,
  change_pct REAL NOT NULL,
  day_high REAL,
  day_low REAL,
  day_open REAL,
  previous_close REAL,
  provider TEXT NOT NULL,
  provider_timestamp TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  quote_session_date TEXT,
  previous_close_session_date TEXT,
  daily_change_valid INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE split_events (
  symbol TEXT NOT NULL,
  effective_date TEXT NOT NULL,
  split_factor REAL NOT NULL,
  PRIMARY KEY(symbol, effective_date)
);
"""


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


def _bad_response(message: str = "bad sql") -> _Resp:
    return _Resp(json.dumps({
        "success": False,
        "errors": [{"message": message}],
    }).encode(), status=400)


class D1ClientTest(unittest.TestCase):
    def test_multi_values_sql_has_session_rollover_split_guard_and_newer_wins(self) -> None:
        sql = build_upsert_sql(2).upper()
        self.assertIn(
            "WITH SESSION_CTX(CURRENT_SESSION_DATE, PREVIOUS_SESSION_DATE, PREVIOUS_CLOSE_NOT_BEFORE, PREVIOUS_SESSION_CLOSE)",
            sql,
        )
        self.assertIn("EXCLUDED.PROVIDER_TIMESTAMP >= LATEST_QUOTES.PROVIDER_TIMESTAMP", sql)
        self.assertIn("LATEST_QUOTES.PREVIOUS_CLOSE", sql)
        self.assertIn("LATEST_QUOTES.QUOTE_SESSION_DATE", sql)
        self.assertIn("PREVIOUS_CLOSE_SESSION_DATE", sql)
        self.assertIn("DAILY_CHANGE_VALID", sql)
        self.assertIn("PREVIOUS_CLOSE_NOT_BEFORE", sql)
        self.assertIn("PREVIOUS_SESSION_CLOSE", sql)
        self.assertIn("SPLIT_EVENTS", sql)
        self.assertIn("ON CONFLICT(SYMBOL)", sql)
        self.assertEqual(sql.count("'FINNHUB-WEBSOCKET'"), 2)

    def test_write_ok_success(self) -> None:
        transport = FakeTransport()
        transport.queue.append(_Resp(_ok_response(2).encode()))
        client = _client(transport)
        rows = [("AAPL", 310.63, TRADE_MS), ("NVDA", 900.0, TRADE_MS)]
        result = client.upsert_quotes(rows)
        self.assertEqual(result.written, ["AAPL", "NVDA"])
        self.assertEqual(result.failed, [])
        self.assertEqual(result.total_changes, 2)
        self.assertEqual(len(transport.requests), 1)
        body = transport.requests[0]["body"]
        self.assertIsInstance(body, dict)
        self.assertEqual(body["sql"], build_upsert_sql(2))
        params = body["params"]
        self.assertEqual(params[0], "2026-08-18")
        self.assertEqual(params[1], "2026-08-17")
        self.assertEqual(params[2], "2026-08-17T19:55:00.000Z")
        self.assertEqual(params[3], "2026-08-17T20:00:00.000Z")
        self.assertEqual(params[4], "AAPL")
        self.assertEqual(params[5], 310.63)
        # provider_timestamp is ISO 8601 UTC and follows the four session params.
        self.assertRegex(params[6], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
        # 4 session params + 2 rows x 4 params each.
        self.assertEqual(len(params), 12)

    def test_chunking_splits_beyond_batch_max_rows(self) -> None:
        transport = FakeTransport()
        transport.queue.append(_Resp(_ok_response(2).encode()))
        transport.queue.append(_Resp(_ok_response(1).encode()))
        client = _client(transport)  # batch_max_rows=2
        rows = [("A", 1.0, TRADE_MS), ("B", 2.0, TRADE_MS), ("C", 3.0, TRADE_MS)]
        result = client.upsert_quotes(rows)
        self.assertEqual(result.written, ["A", "B", "C"])
        self.assertEqual(len(transport.requests), 2)
        # Each chunk repeats the four session-context params, then four per row.
        self.assertEqual(len(transport.requests[0]["body"]["params"]), 12)
        self.assertEqual(len(transport.requests[1]["body"]["params"]), 8)

    def test_rollover_candidate_is_written_before_current_tick(self) -> None:
        transport = FakeTransport()
        transport.queue.extend([
            _Resp(_ok_response(1).encode()),
            _Resp(_ok_response(1).encode()),
        ])
        client = _client(transport)

        result = client.upsert_quotes([
            ("AAPL", 100.0, PRIOR_CLOSE_MS),
            ("AAPL", 102.0, CURRENT_OPEN_MS),
        ])

        self.assertEqual(result.written, ["AAPL"])
        self.assertEqual(result.failed, [])
        self.assertEqual(len(transport.requests), 2)
        first_params = transport.requests[0]["body"]["params"]
        second_params = transport.requests[1]["body"]["params"]
        self.assertEqual(first_params[0], "2026-08-17")
        self.assertEqual(first_params[4:6], ["AAPL", 100.0])
        self.assertEqual(second_params[0], "2026-08-18")
        self.assertEqual(second_params[4:6], ["AAPL", 102.0])

    def test_failed_rollover_candidate_blocks_current_tick_for_same_symbol(self) -> None:
        transport = FakeTransport()
        transport.queue.append(_bad_response("candidate failed"))
        client = _client(transport)

        result = client.upsert_quotes([
            ("AAPL", 100.0, PRIOR_CLOSE_MS),
            ("AAPL", 102.0, CURRENT_OPEN_MS),
        ])

        self.assertEqual(result.written, [])
        self.assertEqual(result.failed, ["AAPL"])
        self.assertEqual(len(transport.requests), 1)
        self.assertIn("candidate failed", result.error or "")

    def test_failed_candidate_does_not_block_unrelated_current_symbol(self) -> None:
        transport = FakeTransport()
        transport.queue.extend([
            _bad_response("AAPL candidate failed"),
            _Resp(_ok_response(1).encode()),
        ])
        client = _client(transport)

        result = client.upsert_quotes([
            ("AAPL", 100.0, PRIOR_CLOSE_MS),
            ("AAPL", 102.0, CURRENT_OPEN_MS),
            ("MSFT", 50.0, CURRENT_OPEN_MS),
        ])

        self.assertEqual(result.written, ["MSFT"])
        self.assertEqual(result.failed, ["AAPL"])
        self.assertEqual(len(transport.requests), 2)
        second_params = transport.requests[1]["body"]["params"]
        self.assertEqual(second_params[0], "2026-08-18")
        self.assertEqual(second_params[4:6], ["MSFT", 50.0])

    def test_current_failure_after_candidate_success_keeps_symbol_failed(self) -> None:
        transport = FakeTransport()
        transport.queue.extend([
            _Resp(_ok_response(1).encode()),
            _bad_response("current failed"),
        ])
        client = _client(transport)

        result = client.upsert_quotes([
            ("AAPL", 100.0, PRIOR_CLOSE_MS),
            ("AAPL", 102.0, CURRENT_OPEN_MS),
        ])

        self.assertEqual(result.written, [])
        self.assertEqual(result.failed, ["AAPL"])
        self.assertEqual(len(transport.requests), 2)
        self.assertIn("current failed", result.error or "")

    def test_rejected_statement_marks_chunk_failed(self) -> None:
        transport = FakeTransport()
        transport.queue.append(_Resp(json.dumps({
            "success": False, "errors": [{"code": 7400, "message": "Invalid input"}],
        }).encode(), status=400))
        client = _client(transport)
        result = client.upsert_quotes([("AAPL", 1.0, TRADE_MS), ("NVDA", 2.0, TRADE_MS)])
        self.assertEqual(result.written, [])
        self.assertEqual(result.failed, ["AAPL", "NVDA"])

    def test_retry_on_transport_error_then_success(self) -> None:
        transport = FakeTransport()
        transport.queue.append(urllib.error.URLError("boom"))
        transport.queue.append(_Resp(_ok_response(1).encode()))
        client = _client(transport)
        result = client.upsert_quotes([("AAPL", 1.0, TRADE_MS)])
        self.assertEqual(result.written, ["AAPL"])
        self.assertEqual(client.error_count, 1)
        self.assertGreaterEqual(len(transport.requests), 2)

    def test_retry_on_http500_then_success(self) -> None:
        transport = FakeTransport()
        transport.queue.append(_Resp(b"", status=500))
        transport.queue.append(_Resp(_ok_response(1).encode()))
        client = _client(transport)
        result = client.upsert_quotes([("AAPL", 1.0, TRADE_MS)])
        self.assertEqual(result.written, ["AAPL"])
        self.assertGreaterEqual(len(transport.requests), 2)

    def test_http400_is_not_retried(self) -> None:
        transport = FakeTransport()
        transport.queue.append(_bad_response())
        client = _client(transport)
        result = client.upsert_quotes([("AAPL", 1.0, TRADE_MS)])
        self.assertEqual(len(transport.requests), 1)
        self.assertEqual(result.failed, ["AAPL"])
        self.assertIsNotNone(result.error)
        self.assertIn("HTTP 400", result.error or "")

    def test_bounded_retries_stops_after_http429(self) -> None:
        transport = FakeTransport()
        for _ in range(5):
            transport.queue.append(_Resp(b"", status=429))
        client = _client(transport)
        result = client.upsert_quotes([("AAPL", 1.0, TRADE_MS)])
        # max_retries=2 => 3 attempts total, then failure result
        self.assertEqual(len(transport.requests), 3)
        self.assertEqual(result.failed, ["AAPL"])

    def test_request_authorization_header_uses_bearer(self) -> None:
        transport = FakeTransport()
        transport.queue.append(_Resp(_ok_response(1).encode()))
        client = _client(transport)
        client.upsert_quotes([("AAPL", 1.0, TRADE_MS)])
        auth = transport.requests[0]["headers"].get("Authorization")
        self.assertEqual(auth, "Bearer test-token-value")

    def test_transport_error_class_is_retry_layer_marker(self) -> None:
        self.assertTrue(issubclass(D1TransportError, RuntimeError))

    def test_health_mirror_upsert(self) -> None:
        transport = FakeTransport()
        transport.queue.append(_Resp(_ok_response(1).encode()))
        client = _client(transport)
        self.assertTrue(client.write_health({"provider": "finnhub-websocket", "ok": True}))
        body = transport.requests[0]["body"]
        self.assertEqual(body["params"][0], "quoteIngestorHealth")

    def test_iso_from_ms(self) -> None:
        self.assertEqual(
            iso_from_ms(TRADE_MS),
            "2026-08-18T17:21:18.242Z",
        )


class SessionBaselineSqlTest(unittest.TestCase):
    def setUp(self) -> None:
        self.db = sqlite3.connect(":memory:")
        self.db.executescript(SESSION_SCHEMA)

    def tearDown(self) -> None:
        self.db.close()

    def _seed(
        self,
        *,
        price: float,
        session: str,
        previous_close: float | None = None,
        previous_session: str | None = None,
        valid: int = 0,
        provider_time: str = "19:59:00.000Z",
    ) -> None:
        self.db.execute(
            """INSERT INTO latest_quotes
            (symbol, price, change_abs, change_pct, previous_close, provider,
             provider_timestamp, updated_at, quote_session_date,
             previous_close_session_date, daily_change_valid)
            VALUES ('AAPL', ?, 999, 999, ?, 'finnhub-websocket',
                    ? || 'T' || ?, ? || 'T' || ?, ?, ?, ?)""",
            (
                price,
                previous_close,
                session,
                provider_time,
                session,
                provider_time,
                session,
                previous_session,
                valid,
            ),
        )
        self.db.commit()

    def _write(self, *, price: float, current: str, previous: str, timestamp: str) -> sqlite3.Row:
        previous_close = session_close_utc(dt.date.fromisoformat(previous))
        previous_close_not_before = previous_close - dt.timedelta(minutes=5)
        self.db.execute(
            build_upsert_sql(1),
            [
                current,
                previous,
                iso_from_ms(int(previous_close_not_before.timestamp() * 1000)),
                iso_from_ms(int(previous_close.timestamp() * 1000)),
                "AAPL",
                price,
                timestamp,
                timestamp,
            ],
        )
        self.db.row_factory = sqlite3.Row
        row = self.db.execute("SELECT * FROM latest_quotes WHERE symbol='AAPL'").fetchone()
        assert row is not None
        return row

    def test_first_tick_of_next_session_promotes_prior_close(self) -> None:
        self._seed(price=100.0, session="2026-08-26")
        row = self._write(
            price=102.0,
            current="2026-08-27",
            previous="2026-08-26",
            timestamp="2026-08-27T14:00:00.000Z",
        )
        self.assertEqual(row["previous_close"], 100.0)
        self.assertEqual(row["previous_close_session_date"], "2026-08-26")
        self.assertEqual(row["daily_change_valid"], 1)
        self.assertAlmostEqual(row["change_abs"], 2.0)
        self.assertAlmostEqual(row["change_pct"], 2.0)

    def test_intraday_prior_session_price_is_not_promoted_as_close(self) -> None:
        self._seed(price=100.0, session="2026-08-26", provider_time="16:00:00.000Z")
        row = self._write(
            price=102.0,
            current="2026-08-27",
            previous="2026-08-26",
            timestamp="2026-08-27T14:00:00.000Z",
        )
        self.assertIsNone(row["previous_close"])
        self.assertIsNone(row["previous_close_session_date"])
        self.assertEqual(row["daily_change_valid"], 0)

    def test_restart_same_session_preserves_baseline_and_recomputes(self) -> None:
        self._seed(
            price=102.0,
            session="2026-08-27",
            previous_close=100.0,
            previous_session="2026-08-26",
            valid=1,
            provider_time="14:00:00.000Z",
        )
        row = self._write(
            price=103.0,
            current="2026-08-27",
            previous="2026-08-26",
            timestamp="2026-08-27T15:00:00.000Z",
        )
        self.assertEqual(row["previous_close"], 100.0)
        self.assertEqual(row["daily_change_valid"], 1)
        self.assertAlmostEqual(row["change_abs"], 3.0)
        self.assertAlmostEqual(row["change_pct"], 3.0)

    def test_gap_never_reuses_older_baseline(self) -> None:
        self._seed(price=100.0, session="2026-08-25", previous_close=99.0, previous_session="2026-08-24", valid=1)
        row = self._write(
            price=105.0,
            current="2026-08-27",
            previous="2026-08-26",
            timestamp="2026-08-27T14:00:00.000Z",
        )
        self.assertIsNone(row["previous_close"])
        self.assertIsNone(row["previous_close_session_date"])
        self.assertEqual(row["daily_change_valid"], 0)
        self.assertEqual(row["change_abs"], 0)
        self.assertEqual(row["change_pct"], 0)

    def test_effective_split_invalidates_rollover(self) -> None:
        self._seed(price=500.0, session="2026-08-26")
        self.db.execute("INSERT INTO split_events VALUES ('AAPL', '2026-08-27', 5.0)")
        row = self._write(
            price=101.0,
            current="2026-08-27",
            previous="2026-08-26",
            timestamp="2026-08-27T14:00:00.000Z",
        )
        self.assertIsNone(row["previous_close"])
        self.assertEqual(row["daily_change_valid"], 0)

    def test_split_discovered_mid_session_clears_existing_baseline(self) -> None:
        self._seed(
            price=102.0,
            session="2026-08-27",
            previous_close=100.0,
            previous_session="2026-08-26",
            valid=1,
            provider_time="14:00:00.000Z",
        )
        self.db.execute("INSERT INTO split_events VALUES ('AAPL', '2026-08-27', 2.0)")
        row = self._write(
            price=103.0,
            current="2026-08-27",
            previous="2026-08-26",
            timestamp="2026-08-27T15:00:00.000Z",
        )
        self.assertIsNone(row["previous_close"])
        self.assertEqual(row["daily_change_valid"], 0)


if __name__ == "__main__":
    unittest.main()
