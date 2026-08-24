from __future__ import annotations

import unittest
import urllib.error

from ai_analysis_runner.http import post_json

from tests.helpers import FakeResponse


class RetryAfterOpener:
    def __init__(self) -> None:
        self.calls = 0

    def __call__(self, request: object, timeout: float) -> FakeResponse:
        del request, timeout
        self.calls += 1
        if self.calls == 1:
            raise urllib.error.HTTPError(
                "https://api.cloudflare.com/test",
                429,
                "rate limited",
                {"Retry-After": "12"},
                None,
            )
        return FakeResponse({"success": True})


class HttpTests(unittest.TestCase):
    def test_429_retry_after_is_a_lower_bound_for_backoff(self) -> None:
        sleeps: list[float] = []
        opener = RetryAfterOpener()
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


if __name__ == "__main__":
    unittest.main()
