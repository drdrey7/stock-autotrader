from __future__ import annotations

import json
import unittest
from typing import Any

from ai_analysis_runner.constants import ENGINE_DB_VERSION
from ai_analysis_runner.d1 import D1Client
from ai_analysis_runner.http import HttpError

from tests.helpers import FakeResponse


class D1Opener:
    def __init__(self, rows: list[dict[str, Any]] | None = None) -> None:
        self.rows = rows or []
        self.requests: list[dict[str, Any]] = []

    def __call__(self, request: Any, timeout: float) -> FakeResponse:
        body = json.loads(request.data)
        self.requests.append({"sql": body["sql"], "params": body["params"], "timeout": timeout})
        return FakeResponse({"success": True, "result": [{"success": True, "results": self.rows}]})


class D1ErrorOpener:
    def __init__(self, error: dict[str, Any]) -> None:
        self.error = error

    def __call__(self, request: Any, timeout: float) -> FakeResponse:
        return FakeResponse({"success": False, "errors": [self.error]})


def analysis_row(status: str = "running") -> dict[str, Any]:
    return {
        "id": "98ff9e47-6f16-43e4-9604-b68ad626ca33",
        "symbol": "AAPL",
        "status": status,
        "analysis_date": "2026-08-21",
        "attempt_count": 1,
        "execution_token": "token",
        "execution_message_id": "message",
        "heartbeat_at": "2026-08-23T12:00:00.000Z",
    }


class D1ClientTests(unittest.TestCase):
    def client(self, opener: D1Opener) -> D1Client:
        return D1Client("secret", "account", "database", timeout_seconds=30, max_attempts=1, opener=opener)

    def test_claim_is_atomic_for_queued_or_stale_running_and_increments_attempt(self) -> None:
        opener = D1Opener([analysis_row()])
        claimed = self.client(opener).claim(
            analysis_row()["id"], "message", "token", "2026-08-23T12:00:00.000Z", "2026-08-23T11:55:00.000Z",
        )
        self.assertEqual(claimed.attempt_count, 1)
        sql = opener.requests[0]["sql"]
        self.assertIn("attempt_count = attempt_count + 1", sql)
        self.assertIn("status = 'queued'", sql)
        self.assertIn("heartbeat_at <= ?5", sql)
        self.assertIn("execution_message_id = ?2", sql)

    def test_complete_uses_execution_token_and_exact_immutable_engine_version(self) -> None:
        opener = D1Opener([{"id": analysis_row()["id"]}])
        updated = self.client(opener).complete(
            analysis_row()["id"], "message", "token", "{}",
            "2026-08-23T12:00:00.000Z", "2026-08-28T12:00:00.000Z",
        )
        self.assertTrue(updated)
        request = opener.requests[0]
        self.assertIn("status = 'completed'", request["sql"])
        self.assertIn("execution_message_id = ?2 AND execution_token = ?3", request["sql"])
        self.assertEqual(request["params"][4], ENGINE_DB_VERSION)

    def test_definitive_failure_preserves_not_null_result_schema_for_refund_trigger(self) -> None:
        opener = D1Opener([{"id": analysis_row()["id"]}])
        updated = self.client(opener).fail(
            analysis_row()["id"], "message", "token", "2026-08-23T12:00:00.000Z",
            "engine_failed", "Analysis failed.",
        )
        self.assertTrue(updated)
        sql = opener.requests[0]["sql"]
        self.assertIn("status = 'failed'", sql)
        self.assertNotIn("result_schema_version = NULL", sql)
        self.assertIn("execution_message_id = ?2 AND execution_token = ?3", sql)
        self.assertNotIn("credit", sql.lower())

    def test_requeue_clears_lease_only_under_current_cas(self) -> None:
        opener = D1Opener([{"id": analysis_row()["id"]}])
        self.assertTrue(self.client(opener).requeue(
            analysis_row()["id"], "message", "token", "2026-08-23T12:00:00.000Z",
            "engine_failed", "Analysis failed.",
        ))
        sql = opener.requests[0]["sql"]
        self.assertIn("execution_token = NULL", sql)
        self.assertIn("execution_message_id = NULL", sql)
        self.assertIn("heartbeat_at = NULL", sql)
        self.assertEqual(
            opener.requests[0]["params"],
            [
                analysis_row()["id"], "message", "token",
                "engine_failed", "Analysis failed.", "2026-08-23T12:00:00.000Z",
            ],
        )

    def test_d1_classifies_transient_and_permanent_messages(self) -> None:
        identifier = analysis_row()["id"]
        transient = D1Client(
            "secret", "account", "database", timeout_seconds=30, max_attempts=1,
            opener=D1ErrorOpener({"code": 1000, "message": "Network connection lost"}),
        )
        with self.assertRaises(HttpError) as transient_error:
            transient.get_analysis(identifier)
        self.assertEqual(transient_error.exception.code, "d1_query_failed")
        self.assertTrue(transient_error.exception.retryable)
        self.assertEqual(transient_error.exception.upstream_code, 1000)
        self.assertEqual(transient_error.exception.upstream_message, "Network connection lost")
        self.assertNotIn("Network connection lost", str(transient_error.exception))

        permanent = D1Client(
            "secret", "account", "database", timeout_seconds=30, max_attempts=1,
            opener=D1ErrorOpener({"code": 1014, "message": "A permanent constraint was violated"}),
        )
        with self.assertRaises(HttpError) as permanent_error:
            permanent.get_analysis(identifier)
        self.assertFalse(permanent_error.exception.retryable)
        self.assertEqual(permanent_error.exception.upstream_code, 1014)
        self.assertNotIn("permanent constraint", str(permanent_error.exception))

    def test_d1_does_not_retry_on_numeric_code_based_classification(self) -> None:
        identifier = analysis_row()["id"]
        opener = D1ErrorOpener({"code": 7500, "message": "Unrecognized remote service query"})
        client = D1Client("secret", "account", "database", timeout_seconds=30, max_attempts=1, opener=opener)
        with self.assertRaises(HttpError) as error:
            client.get_analysis(identifier)
        self.assertFalse(error.exception.retryable)


if __name__ == "__main__":
    unittest.main()

