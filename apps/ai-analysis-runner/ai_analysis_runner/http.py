"""Shared bounded HTTP JSON transport."""

from __future__ import annotations

import json
import random
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class HttpError(RuntimeError):
    code: str
    status: int | None = None
    retryable: bool = False
    # Internal upstream diagnostic detail (e.g. D1 errors[].code/message).
    # These are never surfaced to end users; __str__ only returns the app code.
    upstream_code: int | str | None = None
    upstream_message: str | None = None

    def __str__(self) -> str:
        return self.code


def post_json(
    url: str,
    token: str,
    body: dict[str, Any],
    *,
    timeout_seconds: float,
    max_attempts: int,
    opener: Callable[..., Any] = urllib.request.urlopen,
    sleeper: Callable[[float], None] = time.sleep,
    rand: Callable[[], float] = random.random,
) -> dict[str, Any]:
    encoded = json.dumps(body, separators=(",", ":"), allow_nan=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=encoded,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    for attempt in range(1, max_attempts + 1):
        try:
            with opener(request, timeout=timeout_seconds) as response:
                raw = response.read()
                payload = json.loads(raw.decode("utf-8"))
                if not isinstance(payload, dict):
                    raise HttpError("http_response_invalid")
                return payload
        except urllib.error.HTTPError as exc:
            retryable = exc.code == 429 or 500 <= exc.code <= 599
            error = HttpError("http_request_failed", exc.code, retryable)
        except (urllib.error.URLError, TimeoutError, OSError):
            error = HttpError("http_request_failed", None, True)
        except (UnicodeDecodeError, json.JSONDecodeError):
            error = HttpError("http_response_invalid", None, False)
        if not error.retryable or attempt >= max_attempts:
            raise error
        sleeper(min(8.0, 0.5 * (2 ** (attempt - 1))) * (0.75 + rand() * 0.5))
    raise HttpError("http_request_failed", None, True)

