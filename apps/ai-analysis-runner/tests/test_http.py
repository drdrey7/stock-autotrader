from __future__ import annotations

import unittest
import urllib.error
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime

from ai_analysis_runner.http import post_json

from tests.helpers import FakeResponse


class RetryAfterOpener:
    def __init__(self, retry_after: str) -> None:
        self.calls = 0
        self.retry_after = retry_after

    def __call__(self, request: object, timeout: float) -> FakeResponse:
        del request, timeout
        self.calls += 1
        if self.calls == 1:
            raise urllib.error.HTTPError(
                "https://api.cloudflare.com/test",
                429,
                "rate limited",
                {"Retry-After": self.retry_after},
                None,
            )
        return FakeResponse({"success": True})


class HttpTests(unittest.TestCase):
    def test_429_retry_after_is_a_lower_bound_for_backoff(self) -> None:
        sleeps: list[float] = []
        opener = RetryAfterOpener("12")
        result = post_json(
            "https://api.cloudflare.com/test",
            "secret",
            {},
            timeout_seconds=30,
            max_attempts=2,
            opener=opener,
            sleeper=sleeps.append,
            rand=lambda: 0.5,
        )
        self.assertEqual(result, {"success": True})
        self.assertEqual(opener.calls, 2)
        self.assertEqual(sleeps, [12.0])

    def assert_retry_after_falls_back_to_bounded_backoff(self, value: str, expected: float) -> None:
        sleeps: list[float] = []
        opener = RetryAfterOpener(value)
        result = post_json(
            "https://api.cloudflare.com/test",
            "secret",
            {},
            timeout_seconds=30,
            max_attempts=2,
            opener=opener,
            sleeper=sleeps.append,
            rand=lambda: 0.5,
        )
        self.assertEqual(result, {"success": True})
        self.assertEqual(sleeps, [expected])

    def test_huge_numeric_retry_after_is_capped(self) -> None:
        self.assert_retry_after_falls_back_to_bounded_backoff("86400", 60.0)

    def test_nonfinite_retry_after_uses_exponential_backoff(self) -> None:
        self.assert_retry_after_falls_back_to_bounded_backoff("inf", 0.5)

    def test_future_http_date_retry_after_is_capped(self) -> None:
        future = datetime.now(UTC) + timedelta(hours=1)
        self.assert_retry_after_falls_back_to_bounded_backoff(format_datetime(future, usegmt=True), 60.0)

    def test_malformed_retry_after_uses_exponential_backoff(self) -> None:
        self.assert_retry_after_falls_back_to_bounded_backoff("not-a-retry-after", 0.5)


if __name__ == "__main__":
    unittest.main()
