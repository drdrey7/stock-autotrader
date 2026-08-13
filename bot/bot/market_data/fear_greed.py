"""CNN Fear & Greed Index provider (market sentiment, daily).

Uses the same dataviz endpoint the CNN website itself calls. The endpoint is
unofficial, so failures degrade honestly (the worker surfaces Unavailable);
it is never a reason to fabricate a reading.
"""
from __future__ import annotations

import json
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable

from .provider import DataValidationError

FEAR_GREED_URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata"

_BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
        "(KHTML, like Gecko) Version/17.4 Safari/605.1.15"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://www.cnn.com",
    "Referer": "https://www.cnn.com/",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "cross-site",
}

RATING_ALIASES = {
    "extreme fear": "extreme_fear",
    "fear": "fear",
    "neutral": "neutral",
    "greed": "greed",
    "extreme greed": "extreme_greed",
}


@dataclass(frozen=True)
class SentimentReading:
    provider: str
    score: int
    rating: str
    as_of: str


class CnnFearGreedProvider:
    """Fetch the CNN Fear & Greed reading (score 0-100 + rating)."""

    name = "cnn-fear-greed"

    def __init__(self, fetch_json: Callable[[], dict] | None = None) -> None:
        self._fetch_json = fetch_json or self._http_fetch

    @staticmethod
    def _http_fetch() -> dict:
        request = urllib.request.Request(FEAR_GREED_URL, headers=_BROWSER_HEADERS)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return json.loads(response.read().decode("utf-8"))
        except (OSError, ValueError) as exc:
            raise DataValidationError(f"CNN Fear & Greed fetch failed: {exc}") from exc

    def fetch(self, now: datetime | None = None) -> SentimentReading:
        now = now or datetime.now(timezone.utc)
        payload = self._fetch_json()
        block = payload.get("fear_and_greed")
        if not isinstance(block, dict):
            raise DataValidationError("CNN Fear & Greed response has no fear_and_greed block")
        raw_score = block.get("score")
        if not isinstance(raw_score, (int, float)):
            raise DataValidationError("CNN Fear & Greed score is missing or not numeric")
        if isinstance(raw_score, float) and not raw_score.is_integer():
            raise DataValidationError(f"CNN Fear & Greed score is not an integer: {raw_score}")
        score = int(raw_score)
        if score < 0 or score > 100:
            raise DataValidationError(f"CNN Fear & Greed score out of range: {score}")
        raw_rating = str(block.get("rating") or "").strip().lower()
        rating = RATING_ALIASES.get(raw_rating)
        if rating is None:
            raise DataValidationError(f"CNN Fear & Greed rating not recognized: {raw_rating!r}")
        raw_ts = block.get("timestamp")
        as_of = raw_ts if isinstance(raw_ts, str) and raw_ts else now.isoformat()
        return SentimentReading(
            provider=self.name,
            score=score,
            rating=rating,
            as_of=as_of,
        )
