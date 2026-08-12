"""X post ingestion for the Daily Briefing publisher.

The pipeline never talks to X itself. Posts are collected externally (Hermes
``x_search`` at execution time) and passed as JSON input:

    [
      {"id": "123", "text": "$NVDA setup ...", "created_at": "...", "url": "https://x.com/..."},
      ...
    ]

Rules (see data/brief-spec.v1.md):
- exact 24h window anchored on ``preparedAt``;
- dedupe by post id;
- ticker extraction from ``$TICKER`` mentions only;
- membership gate against the versioned universe;
- posts without id/url/timestamp are dropped.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit
from typing import Any

from .universe import UniverseSnapshot, canonical_symbol

TICKER_RE = re.compile(r"\$([A-Z]{1,5}(?:\.[A-Z]{1,3})?(?:-[A-Z])?)\b", re.IGNORECASE)
WINDOW_HOURS = 24


def parse_iso_timestamp(value: str) -> datetime:
    """Parse an ISO-8601 timestamp; require explicit timezone info."""
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError(f"timestamp must include timezone offset: {value!r}")
    return parsed


@dataclass(frozen=True)
class XPost:
    post_id: str
    text: str
    created_at: datetime
    url: str
    author: str

    @classmethod
    def from_dict(cls, raw: dict[str, Any]) -> "XPost":
        post_id = raw.get("id")
        text = raw.get("text")
        url = raw.get("url")
        created_at_raw = raw.get("created_at")
        author = raw.get("author")
        if not isinstance(post_id, str) or not post_id:
            raise ValueError("X post requires a non-empty string 'id'")
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"X post {post_id!r} requires non-empty 'text'")
        if not isinstance(url, str):
            raise ValueError(f"X post {post_id!r} requires a 'url'")
        try:
            parsed_url = urlsplit(url)
        except ValueError:
            raise ValueError(f"X post {post_id!r} has an invalid 'url'")
        if parsed_url.scheme != "https" or not parsed_url.netloc:
            raise ValueError(f"X post {post_id!r} requires an absolute HTTPS 'url'")
        if any(char.isspace() for char in parsed_url.netloc):
            raise ValueError(f"X post {post_id!r} has a malformed host in 'url'")
        try:
            parsed_url.port
        except ValueError as exc:
            raise ValueError(f"X post {post_id!r} has an invalid port in 'url'") from exc
        if not parsed_url.hostname or "%" in parsed_url.hostname:
            raise ValueError(f"X post {post_id!r} has a malformed host in 'url'")
        if not isinstance(created_at_raw, str) or not created_at_raw:
            raise ValueError(f"X post {post_id!r} requires 'created_at'")
        if not isinstance(author, str) or not author.startswith("@") or len(author) < 2:
            raise ValueError(f"X post {post_id!r} requires an 'author' handle starting with '@'")
        return cls(
            post_id=post_id,
            text=text,
            created_at=parse_iso_timestamp(created_at_raw),
            url=url,
            author=author,
        )


def extract_tickers(text: str) -> list[str]:
    """Extract canonical tickers from ``$TICKER`` mentions, deduped, in order."""
    seen: list[str] = []
    for match in TICKER_RE.finditer(text):
        canonical = canonical_symbol(match.group(1))
        if canonical not in seen:
            seen.append(canonical)
    return seen


@dataclass(frozen=True)
class CandidateIdea:
    """A post that survived the cheap gates, with a resolved universe ticker."""

    post: XPost
    symbol: str
    universe: str  # "S&P 500" | "Nasdaq-100" | "Both"


@dataclass(frozen=True)
class XIngestResult:
    candidates: tuple[CandidateIdea, ...]
    counts: dict[str, int]
    rejected: dict[str, list[str]]  # reason -> post ids


def _is_within_window(post: XPost, prepared_at: datetime, window_hours: int) -> bool:
    cutoff = prepared_at - timedelta(hours=window_hours)
    return cutoff <= post.created_at <= prepared_at


def ingest_posts(
    raw_posts: list[dict[str, Any]],
    universe: UniverseSnapshot,
    *,
    prepared_at: datetime,
    window_hours: int = WINDOW_HOURS,
    allowed_handles: tuple[str, ...] = ("@nolimitgains",),
) -> XIngestResult:
    """Run all X ingestion gates; return surviving candidates and counts."""
    counts = {
        "posts_seen": 0,
        "posts_outside_window": 0,
        "posts_deduped": 0,
        "posts_malformed": 0,
        "posts_without_ticker": 0,
        "posts_unauthorized": 0,
        "tickers_outside_universe": 0,
        "candidates": 0,
    }
    rejected: dict[str, list[str]] = {
        "outside_window": [],
        "duplicate": [],
        "malformed": [],
        "unauthorized": [],
        "without_ticker": [],
        "outside_universe": [],
    }

    if prepared_at.tzinfo is None:
        raise ValueError("prepared_at must be timezone-aware")

    posts: list[XPost] = []
    for raw in raw_posts:
        counts["posts_seen"] += 1
        if not isinstance(raw, dict):
            counts["posts_malformed"] += 1
            rejected["malformed"].append("<no-id>")
            continue
        try:
            posts.append(XPost.from_dict(raw))
        except ValueError:
            counts["posts_malformed"] += 1
            raw_id = raw.get("id")
            rejected["malformed"].append(str(raw_id) if raw_id is not None else "<no-id>")

    # dedupe by post id (first occurrence wins)
    seen_ids: set[str] = set()
    unique_posts: list[XPost] = []
    for post in posts:
        if post.post_id in seen_ids:
            counts["posts_deduped"] += 1
            rejected["duplicate"].append(post.post_id)
            continue
        seen_ids.add(post.post_id)
        unique_posts.append(post)

    # handle allowlist gate (fail closed on unknown authors)
    authorized_posts: list[XPost] = []
    for post in unique_posts:
        if post.author not in allowed_handles:
            counts["posts_unauthorized"] += 1
            rejected["unauthorized"].append(post.post_id)
            continue
        authorized_posts.append(post)

    # 24h window anchored on preparedAt
    windowed: list[XPost] = []
    for post in authorized_posts:
        if _is_within_window(post, prepared_at, window_hours):
            windowed.append(post)
        else:
            counts["posts_outside_window"] += 1
            rejected["outside_window"].append(post.post_id)

    candidates: list[CandidateIdea] = []
    for post in windowed:
        tickers = extract_tickers(post.text)
        if not tickers:
            counts["posts_without_ticker"] += 1
            rejected["without_ticker"].append(post.post_id)
            continue
        resolved = next(
            (symbol for symbol in tickers if universe.contains(symbol)),
            None,
        )
        if resolved is None:
            counts["tickers_outside_universe"] += 1
            rejected["outside_universe"].append(post.post_id)
            continue
        labels = universe.index_labels(resolved)
        universe_label = "Both" if len(labels) == 2 else labels[0]
        counts["candidates"] += 1
        candidates.append(
            CandidateIdea(post=post, symbol=resolved, universe=universe_label)
        )

    return XIngestResult(
        candidates=tuple(candidates),
        counts=counts,
        rejected=rejected,
    )
