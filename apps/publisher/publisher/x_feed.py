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
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timedelta
from ipaddress import ip_address
from typing import Any
from urllib.parse import urlsplit

from .universe import UniverseSnapshot, canonical_symbol

TICKER_RE = re.compile(r"\$([A-Z]{1,5}(?:\.[A-Z]{1,3})?(?:-[A-Z])?)\b", re.IGNORECASE)
AUTHOR_RE = re.compile(r"^@[A-Za-z0-9_]{1,30}$")
WINDOW_HOURS = 24
WHATWG_FORBIDDEN_HOST_CHARS = frozenset(
    '\x00\t\n\r "#%/:<>?@[]\\^|\x7f'
)
X_POST_HOSTS = frozenset({"x.com", "www.x.com"})


def _raw_path_segments_are_whatwg_safe(path: str) -> bool:
    """Reject raw path segments that WHATWG normalizes or rejects."""
    from urllib.parse import unquote

    for segment in path.split("/"):
        if any(ord(char) > 0x7E or char.isspace() or ord(char) < 0x20 or ord(char) == 0x7F for char in segment):
            return False
        if any(char == "%" and (index + 2 >= len(segment) or not all(digit in "0123456789abcdefABCDEF" for digit in segment[index + 1:index + 3])) for index, char in enumerate(segment)):
            return False
        try:
            decoded = unquote(segment, encoding="utf-8", errors="strict")
        except UnicodeDecodeError:
            return False
        if any(ord(char) > 0x7E or char.isspace() or ord(char) < 0x20 or ord(char) == 0x7F for char in decoded):
            return False
        if decoded in {".", ".."} or any(separator in decoded for separator in ("/", "\\")):
            return False
    return True


def _is_expected_x_post_url(parsed_url: Any, *, post_id: str, author: str) -> bool:
    """Require a canonical X host and a status path for the declared author."""
    if parsed_url.hostname.casefold() not in X_POST_HOSTS:
        return False
    authority = parsed_url.netloc.rsplit("@", 1)[-1]
    if authority.endswith(":"):
        return False
    if parsed_url.username is not None or parsed_url.password is not None:
        return False
    try:
        port = parsed_url.port
    except ValueError:
        return False
    if port not in (None, 443):
        return False
    if not _raw_path_segments_are_whatwg_safe(parsed_url.path):
        return False
    segments = parsed_url.path.split("/")
    return (
        len(segments) == 4
        and segments[0] == ""
        and segments[1].casefold() == author.removeprefix("@").casefold()
        and segments[2].casefold() == "status"
        and segments[3] == post_id
    )


def _idna_variants(hostname: str) -> tuple[str, ...] | None:
    """Return raw and per-label IDNA forms, or ``None`` for invalid IDNA."""
    ascii_labels: list[str] = []
    for label in hostname.split("."):
        if not label:
            # WHATWG accepts empty DNS labels in inputs such as ``example..com``.
            ascii_labels.append("")
            continue
        try:
            ascii_labels.append(label.encode("idna").decode("ascii"))
        except UnicodeError:
            return None
    return (hostname, ".".join(ascii_labels))


def _has_forbidden_hostname_chars(hostname: str) -> bool:
    """Reject raw or IDNA-mapped host characters forbidden by WHATWG URL."""
    variants = _idna_variants(hostname)
    if variants is None:
        return True
    return any(
        ord(char) <= 0x1F
        or char in WHATWG_FORBIDDEN_HOST_CHARS
        or unicodedata.category(char) in {"Cc", "Cf", "Cn", "Co", "Cs"}
        for value in variants
        for char in value
    )


def _parse_whatwg_ipv4_number(value: str) -> int | None:
    """Parse one WHATWG IPv4 number, or return ``None`` on parse failure."""
    if not value:
        return None
    if value[:2].lower() == "0x":
        digits = value[2:]
        base = 16
        if not digits:
            return None
    elif len(value) > 1 and value.startswith("0"):
        digits = value
        base = 8
    else:
        digits = value
        base = 10
    if not digits:
        return None
    valid_digits = "0123456789abcdefABCDEF" if base == 16 else "01234567" if base == 8 else "0123456789"
    if any(char not in valid_digits for char in digits):
        return None
    return int(digits, base)


def _has_malformed_whatwg_ipv4(hostname: str) -> bool:
    """Reject numeric-looking hosts that WHATWG treats as IPv4 but cannot parse."""
    variants = _idna_variants(hostname)
    if variants is None:
        return True
    for value in variants:
        candidate = value[:-1] if value.endswith(".") else value
        if not candidate:
            continue
        parts = candidate.split(".")
        last = parts[-1]
        is_decimal = last.isascii() and last.isdigit()
        is_hex = (
            last.lower() == "0x"
            or (
                len(last) > 2
                and last[:2].lower() == "0x"
                and all(char in "0123456789abcdefABCDEF" for char in last[2:])
            )
        )
        if not is_decimal and not is_hex:
            continue
        if len(parts) > 4:
            return True
        numbers: list[int] = []
        for part in parts:
            number = _parse_whatwg_ipv4_number(part)
            if number is None:
                return True
            numbers.append(number)
        if any(number > 255 for number in numbers[:-1]):
            return True
        max_last = (256 ** (5 - len(parts))) - 1
        if numbers[-1] > max_last:
            return True
    return False


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
    def from_dict(cls, raw: dict[str, Any]) -> XPost:
        post_id = raw.get("id")
        text = raw.get("text")
        url = raw.get("url")
        created_at_raw = raw.get("created_at")
        author = raw.get("author")
        if not isinstance(post_id, str) or not 4 <= len(post_id) <= 120:
            raise ValueError("X post requires an 'id' between 4 and 120 characters")
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"X post {post_id!r} requires non-empty 'text'")
        if not isinstance(url, str):
            raise ValueError(f"X post {post_id!r} requires a 'url'")
        # Keep raw source URLs strict: do not silently normalize external
        # whitespace or userinfo before the shared ingest contract sees them.
        if not url.startswith("https://"):
            raise ValueError(f"X post {post_id!r} requires an absolute HTTPS 'url'")
        # Reject raw backslashes before urlsplit() so producer and WHATWG
        # consumer cannot disagree after URL parser normalization.
        if "\\" in url:
            raise ValueError(f"X post {post_id!r} has backslashes in 'url'")
        # urlsplit() silently removes ASCII tab/LF/CR characters. Reject them
        # on the raw source URL so validation cannot accept a normalized value.
        if any(ord(char) <= 0x1F or ord(char) == 0x7F for char in url):
            raise ValueError(f"X post {post_id!r} has control characters in 'url'")
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
        hostname = parsed_url.hostname
        if not hostname or "%" in hostname:
            raise ValueError(f"X post {post_id!r} has a malformed host in 'url'")
        authority = parsed_url.netloc.rsplit("@", 1)[-1]
        if authority.startswith("["):
            # WHATWG URL (used by the TypeScript contract) rejects IPvFuture
            # literals such as [v1.foo], while urlsplit accepts them as hostnames.
            # Keep bracketed authorities only for genuine IPv6 literals.
            try:
                address = ip_address(hostname)
            except ValueError as exc:
                raise ValueError(f"X post {post_id!r} has a malformed host in 'url'") from exc
            if address.version != 6:
                raise ValueError(f"X post {post_id!r} has a malformed host in 'url'")
        elif _has_forbidden_hostname_chars(hostname) or _has_malformed_whatwg_ipv4(hostname):
            raise ValueError(f"X post {post_id!r} has a malformed host in 'url'")
        if not isinstance(created_at_raw, str) or not created_at_raw:
            raise ValueError(f"X post {post_id!r} requires 'created_at'")
        if not isinstance(author, str) or not AUTHOR_RE.fullmatch(author):
            raise ValueError(f"X post {post_id!r} requires an 'author' handle starting with '@'")
        if not _is_expected_x_post_url(parsed_url, post_id=post_id, author=author):
            raise ValueError(f"X post {post_id!r} URL does not match its declared X author")
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
