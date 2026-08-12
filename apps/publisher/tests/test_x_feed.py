"""X feed ingestion tests (unittest — CI-compatible)."""
from __future__ import annotations

import json
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from publisher.universe import load_universe
from publisher.x_feed import XPost, extract_tickers, ingest_posts

REPO_ROOT = Path(__file__).resolve().parents[1]
PREPARED_AT = datetime(2026, 8, 12, 12, 30, tzinfo=timezone.utc)  # 08:30 ET EDT


class XFeedTests(unittest.TestCase):
    def _universe(self):
        return load_universe(
            REPO_ROOT / "data" / "sp500.v1.json",
            REPO_ROOT / "data" / "nasdaq100.v1.json",
        )

    @staticmethod
    def _post(post_id: str, text: str, age_hours: float = 1.0, url: str | None = None) -> dict:
        created = PREPARED_AT - timedelta(hours=age_hours)
        return {
            "id": post_id,
            "text": text,
            "created_at": created.isoformat(),
            "url": url or f"https://x.com/nolimitgains/status/{post_id}",
            "author": "@nolimitgains",
        }

    def test_extract_tickers(self) -> None:
        self.assertEqual(extract_tickers("$NVDA setup"), ["NVDA"])
        self.assertEqual(extract_tickers("watching $NVDA and $NVDA again"), ["NVDA"])
        self.assertEqual(extract_tickers("$BRK-B special"), ["BRK-B"])
        self.assertEqual(extract_tickers("no ticker here"), [])
        self.assertEqual(extract_tickers("lowercase $nvda"), ["NVDA"])

    def test_window_and_dedupe(self) -> None:
        posts = [
            self._post("p1", "$NVDA fresh"),
            self._post("p1", "$NVDA duplicate id"),
            self._post("p2", "$AAPL old", age_hours=30),
        ]
        result = ingest_posts(posts, self._universe(), prepared_at=PREPARED_AT)
        self.assertEqual(result.counts["posts_seen"], 3)
        self.assertEqual(result.counts["posts_deduped"], 1)
        self.assertEqual(result.counts["posts_outside_window"], 1)
        self.assertEqual(result.counts["candidates"], 1)
        self.assertEqual([c.post.post_id for c in result.candidates], ["p1"])
        self.assertEqual(result.rejected["duplicate"], ["p1"])
        self.assertEqual(result.rejected["outside_window"], ["p2"])

    def test_without_ticker_and_outside_universe(self) -> None:
        posts = [
            self._post("p1", "market internals improving, no single name"),
            self._post("p2", "$DOGE momentum"),
            self._post("p3", "$NVDA valid"),
        ]
        result = ingest_posts(posts, self._universe(), prepared_at=PREPARED_AT)
        self.assertEqual(result.counts["posts_without_ticker"], 1)
        self.assertEqual(result.counts["tickers_outside_universe"], 1)
        self.assertEqual(result.counts["candidates"], 1)
        self.assertEqual(result.candidates[0].symbol, "NVDA")
        self.assertEqual(result.candidates[0].universe, "Both")
        self.assertEqual(result.rejected["without_ticker"], ["p1"])
        self.assertEqual(result.rejected["outside_universe"], ["p2"])

    def test_malformed_posts_dropped(self) -> None:
        posts = [
            {"id": "bad", "text": "", "created_at": PREPARED_AT.isoformat(), "url": "https://x.com/a"},
            self._post("ok", "$NVDA good"),
        ]
        result = ingest_posts(posts, self._universe(), prepared_at=PREPARED_AT)
        self.assertEqual(result.counts["posts_malformed"], 1)
        self.assertEqual(result.counts["candidates"], 1)

    def test_requires_timezone_aware_anchor(self) -> None:
        with self.assertRaises(ValueError):
            ingest_posts([], self._universe(), prepared_at=datetime(2026, 8, 12, 12, 30))

    def test_sample_fixture_counts(self) -> None:
        posts = json.loads((REPO_ROOT / "fixtures" / "x_feed.sample.json").read_text())
        result = ingest_posts(posts, self._universe(), prepared_at=PREPARED_AT)
        self.assertEqual(result.counts["posts_seen"], 7)
        self.assertEqual(result.counts["posts_deduped"], 1)
        self.assertEqual(result.counts["posts_outside_window"], 1)
        self.assertEqual(result.counts["posts_without_ticker"], 1)
        self.assertEqual(result.counts["tickers_outside_universe"], 1)
        self.assertEqual(result.counts["candidates"], 3)
        self.assertEqual({c.symbol for c in result.candidates}, {"NVDA", "AAPL", "TSLA"})

    def test_xpost_requires_https_url(self) -> None:
        with self.assertRaises(ValueError):
            XPost.from_dict(
                {"id": "x", "text": "$NVDA", "created_at": PREPARED_AT.isoformat(), "url": "http://x.com/a", "author": "@nolimitgains"}
            )

    def test_xpost_rejects_malformed_host(self) -> None:
        for bad_url in ("https:// not-a-url", "https://exa mple.com/x", "https://"):
            with self.subTest(url=bad_url):
                with self.assertRaises(ValueError):
                    XPost.from_dict(
                        {"id": "x", "text": "$NVDA", "created_at": PREPARED_AT.isoformat(), "url": bad_url, "author": "@nolimitgains"}
                    )

    def test_xpost_requires_author(self) -> None:
        with self.assertRaises(ValueError, msg="author required"):
            XPost.from_dict(
                {"id": "x", "text": "$NVDA", "created_at": PREPARED_AT.isoformat(), "url": "https://x.com/a"}
            )

    def test_non_dict_posts_dropped(self) -> None:
        posts = ["this is not a dict", 42, None, self._post("ok", "$NVDA good")]
        result = ingest_posts(posts, self._universe(), prepared_at=PREPARED_AT)
        self.assertEqual(result.counts["posts_malformed"], 3)
        self.assertEqual(result.counts["candidates"], 1)
        self.assertEqual(result.rejected["malformed"], ["<no-id>", "<no-id>", "<no-id>"])

    def test_unauthorized_handle_rejected(self) -> None:
        posts = [self._post("p1", "$NVDA from someone else")]
        posts[0]["author"] = "@unknown"
        result = ingest_posts(posts, self._universe(), prepared_at=PREPARED_AT)
        self.assertEqual(result.counts["posts_unauthorized"], 1)
        self.assertEqual(result.counts["candidates"], 0)
        self.assertEqual(result.rejected["unauthorized"], ["p1"])

    def test_naive_prepared_at_rejected(self) -> None:
        posts = [self._post("p1", "$NVDA setup")]
        naive = datetime(2026, 8, 12, 12, 30, 0)  # no tzinfo
        with self.assertRaises(ValueError):
            ingest_posts(posts, self._universe(), prepared_at=naive)

    def test_dot_ticker_resolves_to_hyphen_canonical(self) -> None:
        self.assertEqual(extract_tickers("$BRK.B earnings"), ["BRK-B"])


if __name__ == "__main__":
    unittest.main()
