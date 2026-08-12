"""End-to-end pipeline tests (unittest — deterministic, offline)."""
from __future__ import annotations

import json
import unittest
from datetime import datetime, timezone
from pathlib import Path

from publisher.pipeline import run_pipeline

REPO_ROOT = Path(__file__).resolve().parents[1]
PREPARED_AT = datetime(2026, 8, 12, 12, 30, tzinfo=timezone.utc)  # 08:30 ET EDT


def _load(name: str) -> dict | list:
    return json.loads((REPO_ROOT / "fixtures" / name).read_text())


class PipelineTests(unittest.TestCase):
    def _run(self, **overrides):
        kwargs = {
            "edition_type": "pre_market",
            "x_posts": _load("x_feed.sample.json"),
            "quotes": _load("quotes.sample.json"),
            "data_dir": REPO_ROOT / "data",
            "prepared_at": PREPARED_AT,
            "dry_run": True,
        }
        kwargs.update(overrides)
        return run_pipeline(**kwargs)

    def test_dry_run_sample_fixture(self) -> None:
        report = self._run()
        self.assertTrue(report.ok)
        self.assertTrue(report.publishable)
        self.assertFalse(report.published)
        self.assertIsNotNone(report.briefing)
        assert report.briefing is not None
        self.assertEqual(report.counts["posts_seen"], 7)
        self.assertEqual(report.counts["candidates"], 3)
        self.assertEqual(report.counts["ideas_missing_data"], 1)  # TSLA incomplete
        self.assertEqual(report.counts["potential_entries"], 2)
        self.assertEqual(report.counts["briefing_ideas"], 2)
        self.assertEqual([idea["symbol"] for idea in report.briefing["ideas"]], ["NVDA", "AAPL"])
        self.assertIs(report.briefing["example"], False)
        self.assertEqual(report.briefing["editionDate"], "2026-08-12")
        self.assertEqual(len(report.briefing["market"]), 3)
        self.assertEqual(report.errors, [])

    def test_briefing_contract_shape(self) -> None:
        report = self._run()
        self.assertIsNotNone(report.briefing)
        assert report.briefing is not None
        idea = report.briefing["ideas"][0]
        self.assertEqual(idea["verdict"], "Potential Entry")
        self.assertEqual(idea["source"]["handle"], "@nolimitgains")
        self.assertTrue(idea["source"]["reference"].startswith("https://x.com/"))
        self.assertEqual(idea["levels"]["rewardRiskRatio"], 2.6)
        self.assertEqual(idea["levels"]["rewardRisk"], "2.6R")
        self.assertEqual(report.briefing["schedule"][0]["time"], "08:30 ET")

    def test_zero_ideas_still_valid(self) -> None:
        report = self._run(x_posts=[])
        self.assertTrue(report.ok)
        self.assertIsNotNone(report.briefing)
        assert report.briefing is not None
        self.assertEqual(report.briefing["ideas"], [])
        self.assertEqual(report.counts["potential_entries"], 0)
        self.assertEqual(report.counts["posts_seen"], 0)

    def test_missing_benchmarks_fails_closed(self) -> None:
        quotes = _load("quotes.sample.json")
        assert isinstance(quotes, dict)
        quotes["benchmarks"] = [
            {"name": "S&P 500", "symbol": "SP:SPX", "value": "1", "change": "+0.1%", "state": "x", "note": "y"}
        ]
        report = self._run(quotes=quotes)
        self.assertFalse(report.ok)
        self.assertFalse(report.publishable)
        self.assertIsNone(report.briefing)
        self.assertIn("market benchmark snapshot invalid", " ".join(report.errors))

    def test_unknown_edition_rejected(self) -> None:
        report = self._run(edition_type="intraday")
        self.assertFalse(report.ok)
        self.assertIn("edition_type", " ".join(report.errors))

    def test_publish_without_endpoint_fails_gracefully(self) -> None:
        report = self._run(dry_run=False, publish=True)
        self.assertFalse(report.ok)
        self.assertTrue(report.publishable)  # brief was valid
        self.assertIsNotNone(report.briefing)
        self.assertTrue(any("endpoint and secret" in error for error in report.errors))

    def test_publish_network_failure_keeps_local_report(self) -> None:
        report = self._run(
            dry_run=False,
            publish=True,
            endpoint="http://127.0.0.1:1/ingest/events",
            secret="test-secret",
        )
        self.assertFalse(report.ok)
        self.assertTrue(report.publishable)
        self.assertIsNotNone(report.briefing)
        self.assertTrue(any("publication failed" in error for error in report.errors))

    def test_post_close_edition(self) -> None:
        report = self._run(edition_type="post_close")
        self.assertTrue(report.ok)
        self.assertIsNotNone(report.briefing)
        assert report.briefing is not None
        self.assertEqual(report.briefing["editionType"], "post_close")
        self.assertEqual(report.briefing["schedule"][0]["time"], "16:30 ET")

    def test_duplicate_symbol_keeps_edition(self) -> None:
        """Two posts for the same ticker must not kill the edition (P1-1)."""
        posts = _load("x_feed.sample.json")
        assert isinstance(posts, list)
        posts.append(
            {
                "id": "post-008",
                "text": "$NVDA follow-up confirmation post",
                "created_at": "2026-08-12T11:40:00Z",
                "url": "https://x.com/nolimitgains/status/post-008",
                "author": "@nolimitgains",
            }
        )
        report = self._run(x_posts=posts)
        self.assertTrue(report.ok)
        assert report.briefing is not None
        symbols = [idea["symbol"] for idea in report.briefing["ideas"]]
        self.assertEqual(len(symbols), len(set(symbols)))
        self.assertEqual(symbols.count("NVDA"), 1)
        self.assertEqual(report.counts["duplicate_symbol_skipped"], 1)

    def test_more_than_three_candidates_capped(self) -> None:
        """A fourth qualified candidate must be capped, not crash the edition."""
        posts = [
            {"id": f"p{i}", "text": f"${s} setup", "created_at": PREPARED_AT.isoformat(),
             "url": f"https://x.com/nolimitgains/status/p{i}", "author": "@nolimitgains"}
            for i, s in enumerate(["NVDA", "AAPL", "MSFT", "AMZN"], start=1)
        ]
        quotes = _load("quotes.sample.json")
        assert isinstance(quotes, dict)
        base = quotes["candidates"][0]
        for symbol in ("NVDA", "AAPL", "MSFT", "AMZN"):
            quote = dict(base)
            quote["symbol"] = symbol
            quote["company"] = symbol
            quotes["candidates"].append(quote)
        report = self._run(x_posts=posts, quotes=quotes)
        self.assertTrue(report.ok)
        assert report.briefing is not None
        self.assertEqual(len(report.briefing["ideas"]), 3)
        # the 4th distinct candidate is capped (not a duplicate symbol)
        self.assertEqual(report.counts["ideas_capped"], 1)
        self.assertEqual(report.counts["duplicate_symbol_skipped"], 0)

    def test_universe_version_is_string(self) -> None:
        report = self._run()
        self.assertEqual(report.counts["universe_version"], "2026-08-11")


if __name__ == "__main__":
    unittest.main()
