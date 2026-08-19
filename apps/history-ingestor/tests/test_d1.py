"""Tests for the D1 HTTP client (history ingestor)."""

from __future__ import annotations

import json
import unittest

from history_ingestor.d1 import (
    D1Client,
    D1QueryError,
    D1TransportError,
    build_split_upsert_sql,
    build_weekly_upsert_sql,
)


class FakeResponse:
    def __init__(self, status, payload):
        self.status = status
        self._payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return json.dumps(self._payload).encode("utf-8")


class FakeURL:
    def __init__(self, responses=None, raise_errors=None):
        self._responses = responses or []  # list of (status, payload) or callable
        self._raise = raise_errors or []
        self.calls: list[tuple[str, dict]] = []
        self.i = 0

    def __call__(self, request, timeout):
        body = json.loads(request.data.decode("utf-8")) if request.data else {}
        self.calls.append((request.full_url, body))
        if self.i < len(self._raise):
            err = self._raise[self.i]
            self.i += 1
            raise err
        if self.i < len(self._responses):
            status, payload = self._responses[self.i]
            self.i += 1
            return FakeResponse(status, payload)
        return FakeResponse(200, {"success": True, "result": [{"meta": {"changes": 0}}]})


def client(url, **kwargs):
    return D1Client("token", "acct", "db", max_retries=2, retry_base_seconds=0.01,
                    request_timeout_seconds=5, urlopen=url, **kwargs)


def row(symbol="NVDA", date="2026-08-14", close=100.0, factor=1.0, adj=100.0) -> tuple:
    return (symbol, date, 99.0, 101.0, 98.0, close, 1000, factor, adj, "2026-08-19T00:00:00Z")


class SqlTests(unittest.TestCase):
    def test_build_weekly_upsert_sql(self):
        sql = build_weekly_upsert_sql(2)
        self.assertIn("INSERT INTO weekly_prices", sql)
        self.assertIn("ON CONFLICT(symbol, week_end_date) DO UPDATE SET", sql)
        self.assertIn("'alpha-vantage'", sql)
        self.assertEqual(sql.count("(?, ?, ?, ?, ?, ?, ?, ?, ?, 'alpha-vantage', ?)"), 2)

    def test_build_requires_positive_count(self):
        with self.assertRaises(ValueError):
            build_weekly_upsert_sql(0)

    def test_default_batch_stays_under_d1_100_split_variable_limit(self):
        # D1 HTTP API caps a single statement at 100 bound variables (verified
        # live: 20 rows -> HTTP 400 "too many SQL variables"). Each weekly row
        # binds 10 variables, so the default batch must be <= 10.
        from history_ingestor.config import from_env
        settings = from_env({"ALPHA_VANTAGE_API_KEYS": "K", "CLOUDFLARE_API_TOKEN": "t",
                             "CLOUDFLARE_ACCOUNT_ID": "a", "CLOUDFLARE_D1_DATABASE_ID": "d"})
        self.assertLessEqual(settings.d1_batch_max_rows, 10)
        bounds_per_row = build_weekly_upsert_sql(settings.d1_batch_max_rows).count("?")
        self.assertLessEqual(bounds_per_row, 100)

    def test_build_split_upsert_sql_shape(self):
        sql = build_split_upsert_sql(2)
        self.assertIn("INSERT INTO split_events", sql)
        self.assertIn("ON CONFLICT(symbol, effective_date) DO UPDATE SET", sql)
        self.assertEqual(sql.count("'alpha-vantage'"), 2)
        self.assertEqual(sql.count("(?, ?, ?, 'alpha-vantage', ?)"), 2)

    def test_split_upsert_batch_stays_under_100_binds(self):
        from history_ingestor.config import from_env
        settings = from_env({"ALPHA_VANTAGE_API_KEYS": "K", "CLOUDFLARE_API_TOKEN": "t",
                             "CLOUDFLARE_ACCOUNT_ID": "a", "CLOUDFLARE_D1_DATABASE_ID": "d"})
        bounds = build_split_upsert_sql(settings.d1_batch_max_rows).count("?")
        self.assertLessEqual(bounds, 100)

    def test_build_split_upsert_requires_positive_count(self):
        with self.assertRaises(ValueError):
            build_split_upsert_sql(0)


class D1ClientTests(unittest.TestCase):
    def test_upsert_weekly_rows_success(self):
        url = FakeURL()
        c = client(url)
        result = c.upsert_weekly_rows([row()])
        self.assertEqual(result.written, ["NVDA"])
        self.assertEqual(result.failed, [])
        # The request carried the SQL + params (one statement object).
        _, body = url.calls[0]
        self.assertIn("INSERT INTO weekly_prices", body["sql"])
        self.assertEqual(body["params"][0], "NVDA")

    def test_empty_rows_no_request(self):
        url = FakeURL()
        c = client(url)
        result = c.upsert_weekly_rows([])
        self.assertEqual(result.written, [])
        self.assertEqual(url.calls, [])

    def test_chunking_at_batch_max(self):
        url = FakeURL()
        c = client(url, batch_max_rows=2)
        rows = [row(symbol=f"S{i}") for i in range(5)]
        result = c.upsert_weekly_rows(rows)
        self.assertEqual(len(result.written), 5)
        self.assertEqual(len(url.calls), 3)  # 2 + 2 + 1

    def test_http_400_not_retried(self):
        url = FakeURL([(400, {"errors": [{"message": "bad sql"}]})])
        c = client(url)
        result = c.upsert_weekly_rows([row()])
        self.assertEqual(result.failed, ["NVDA"])
        self.assertIn("HTTP 400", result.error)
        self.assertEqual(len(url.calls), 1)

    def test_429_retried_then_succeeds(self):
        url = FakeURL([(429, {"errors": [{"message": "slow down"}]}), (200, {"success": True, "result": [{"meta": {"changes": 1}}]})])
        c = client(url)
        result = c.upsert_weekly_rows([row()])
        self.assertEqual(result.written, ["NVDA"])
        self.assertEqual(len(url.calls), 2)

    def test_transport_error_retried_then_fails(self):
        import urllib.error
        url = FakeURL(raise_errors=[urllib.error.URLError("net")] * 3)
        c = client(url)
        result = c.upsert_weekly_rows([row()])
        self.assertEqual(result.failed, ["NVDA"])
        self.assertEqual(len(url.calls), 3)

    def test_write_app_meta(self):
        url = FakeURL()
        c = client(url)
        self.assertTrue(c.write_app_meta("k", {"a": 1}))
        _, body = url.calls[0]
        self.assertEqual(body["params"][0], "k")

    def test_read_app_meta(self):
        url = FakeURL([(200, {"success": True, "result": [{"results": [{"value": '{"a": 1}'}]}]})])
        c = client(url)
        self.assertEqual(c.read_app_meta("k"), {"a": 1})

    def test_read_app_meta_missing(self):
        url = FakeURL([(200, {"success": True, "result": [{"results": []}]})])
        c = client(url)
        self.assertIsNone(c.read_app_meta("k"))

    def test_read_app_meta_bad_json_raises(self):
        url = FakeURL([(200, {"success": True, "result": [{"results": [{"value": "not json"}]}]})])
        c = client(url)
        with self.assertRaises(D1QueryError):
            c.read_app_meta("k")

    def test_read_failure_raises(self):
        url = FakeURL([(500, {"success": False, "errors": []})])
        c = client(url)
        with self.assertRaises(D1QueryError):
            c.read_weekly_summary()


if __name__ == "__main__":
    unittest.main()
