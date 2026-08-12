"""Daily Briefing publisher pipeline.

Orchestrates: X ingestion -> membership gate -> market snapshot -> Potential
Entry gate -> composition -> local validation -> (dry-run | publish).

Fail policy (data/brief-spec.v1.md):
- invalid benchmark snapshot -> do not publish (fail closed);
- no X posts -> publish a valid brief with market context only (partial);
- publish failures -> keep the local report, never retry blindly.

The pipeline is deliberately deterministic and offline-testable: all external
data (X posts, quotes) arrives as JSON input; only the signed publication step
touches the network.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .accounts import load_accounts
from .briefing import IdeaDraft, build_briefing, validate_briefing
from .market import load_benchmarks, load_candidate_quotes
from .universe import load_universe
from .x_feed import ingest_posts


@dataclass(frozen=True)
class PipelineReport:
    ok: bool
    publishable: bool
    published: bool
    counts: dict[str, int]
    rejected: dict[str, list[str]]
    briefing: dict[str, Any] | None
    errors: list[str]
    message: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "publishable": self.publishable,
            "published": self.published,
            "counts": self.counts,
            "rejected": self.rejected,
            "briefing": self.briefing,
            "errors": self.errors,
            "message": self.message,
        }


def _default_prepared_at(edition_type: str, now: datetime | None = None) -> datetime:
    """Anchor: the actual run time in America/New_York.

    ``preparedAt`` must never be in the future (false provenance) and must
    never claim an earlier time than the run; the honest anchor is now.
    """
    return (now or datetime.now(timezone.utc)).astimezone(ZoneInfoNY())


def ZoneInfoNY():
    from zoneinfo import ZoneInfo

    return ZoneInfo("America/New_York")


def run_pipeline(
    *,
    edition_type: str,
    x_posts: list[dict[str, Any]],
    quotes: list[dict[str, Any]],
    data_dir: str | Path,
    prepared_at: datetime | None = None,
    dry_run: bool = True,
    publish: bool = False,
    endpoint: str | None = None,
    secret: str | None = None,
) -> PipelineReport:
    """Run the full pipeline for one edition."""
    counts: dict[str, Any] = {}
    rejected: dict[str, list[str]] = {}
    errors: list[str] = []

    if edition_type not in ("pre_market", "post_close"):
        return PipelineReport(
            ok=False, publishable=False, published=False,
            counts=counts, rejected=rejected, briefing=None,
            errors=[f"unknown edition_type: {edition_type!r}"],
            message="invalid edition_type",
        )

    data_path = Path(data_dir)
    try:
        accounts = load_accounts(data_path / "accounts.v1.json")
        universe = load_universe(
            data_path / "sp500.v1.json",
            data_path / "nasdaq100.v1.json",
        )
    except (FileNotFoundError, ValueError) as exc:
        return PipelineReport(
            ok=False, publishable=False, published=False,
            counts=counts, rejected=rejected, briefing=None,
            errors=[f"data load failed: {exc}"],
            message="data unavailable",
        )

    if prepared_at is not None and prepared_at.tzinfo is None:
        raise ValueError(
            "prepared_at must include an explicit timezone offset (naive timestamps are rejected)"
        )
    anchor = prepared_at or _default_prepared_at(edition_type)
    if anchor.tzinfo is None:
        anchor = anchor.replace(tzinfo=timezone.utc)
    if publish and not dry_run and anchor.astimezone(timezone.utc) > datetime.now(timezone.utc):
        return PipelineReport(
            ok=False, publishable=False, published=False,
            counts=counts, rejected=rejected, briefing=None,
            errors=["prepared_at cannot be in the future when publishing"],
            message="future prepared_at rejected",
        )

    counts["active_accounts"] = len(accounts.active_handles)
    counts["universe_version"] = universe.version
    combined = set()
    for members in universe.indexes.values():
        combined |= set(members)
    counts["universe_total"] = len(combined)

    # 1. X ingestion (cheap gates first)
    ingest = ingest_posts(
        x_posts,
        universe,
        prepared_at=anchor,
        allowed_handles=accounts.active_handles,
    )
    counts.update(ingest.counts)
    rejected.update(ingest.rejected)

    # 2. Market snapshot (required to publish a new edition)
    # Normalize input shapes: allow a single object {"benchmarks": [...],
    # "candidates": [...]}, a list containing such an object, or a flat list
    # of candidate quotes (no benchmark snapshot -> fail closed).
    benchmark_items: list[dict[str, Any]] = []
    candidate_items: list[dict[str, Any]] = []
    if isinstance(quotes, dict):
        benchmark_items = quotes.get("benchmarks") or []
        candidate_items = quotes.get("candidates") or []
    elif isinstance(quotes, list):
        for entry in quotes:
            if isinstance(entry, dict) and "benchmarks" in entry:
                benchmark_items = entry.get("benchmarks") or []
                candidate_items = entry.get("candidates") or []
                break
        if not benchmark_items and not candidate_items:
            candidate_items = quotes
    benchmarks = load_benchmarks(benchmark_items)

    if benchmarks is None:
        return PipelineReport(
            ok=False, publishable=False, published=False,
            counts=counts, rejected=rejected, briefing=None,
            errors=["market benchmark snapshot invalid or incomplete"],
            message="market snapshot unavailable — refusing to publish",
        )

    # 3. Candidate quotes + Potential Entry gate
    quotes_by_symbol = load_candidate_quotes(candidate_items)
    ideas: list[IdeaDraft] = []
    for candidate in ingest.candidates:
        quote = quotes_by_symbol.get(candidate.symbol)
        if quote is None:
            counts.setdefault("ideas_missing_data", 0)
            counts["ideas_missing_data"] += 1
            rejected.setdefault("missing_quote", []).append(candidate.post.post_id)
            continue
        if not quote.is_complete():
            counts.setdefault("ideas_missing_data", 0)
            counts["ideas_missing_data"] += 1
            rejected.setdefault("incomplete_quote", []).append(candidate.post.post_id)
            continue
        ideas.append(IdeaDraft(candidate=candidate, quote=quote, collected_at=anchor))

    # Composition guarantee: one idea per canonical symbol (first wins) and at
    # most three, so a duplicate-symbol follow-up post or a fourth candidate
    # can never kill the edition.
    seen_symbols: set[str] = set()
    unique_ideas: list[IdeaDraft] = []
    duplicate_symbol_skipped = 0
    capped_candidates = 0
    for idea in ideas:
        if idea.candidate.symbol in seen_symbols:
            duplicate_symbol_skipped += 1
            rejected.setdefault("duplicate_symbol", []).append(idea.candidate.post.post_id)
            continue
        if len(unique_ideas) == 3:
            capped_candidates += 1
            rejected.setdefault("capped", []).append(idea.candidate.post.post_id)
            continue
        seen_symbols.add(idea.candidate.symbol)
        unique_ideas.append(idea)
    counts["duplicate_symbol_skipped"] = duplicate_symbol_skipped
    counts["ideas_capped"] = capped_candidates
    ideas = unique_ideas

    # 4. Composition + local validation
    try:
        briefing = build_briefing(
            edition_type=edition_type,
            prepared_at=anchor,
            benchmarks=benchmarks,
            ideas=ideas,
            universe=universe,
        )
    except ValueError as exc:
        return PipelineReport(
            ok=False, publishable=False, published=False,
            counts=counts, rejected=rejected, briefing=None,
            errors=[f"composition failed: {exc}"],
            message="composition failed",
        )

    validation_errors = validate_briefing(briefing, universe)
    if validation_errors:
        return PipelineReport(
            ok=False, publishable=False, published=False,
            counts=counts, rejected=rejected, briefing=briefing,
            errors=validation_errors,
            message="briefing failed local validation",
        )

    counts["potential_entries"] = len(ideas)
    counts["briefing_ideas"] = len(briefing["ideas"])

    # 5. Publish (only when explicitly requested and never in dry-run)
    published = False
    if publish and not dry_run:
        from .client import make_event, publish as publish_events

        if not endpoint or not secret:
            return PipelineReport(
                ok=False, publishable=True, published=False,
                counts=counts, rejected=rejected, briefing=briefing,
                errors=["publish requires endpoint and secret"],
                message="publish configuration missing",
            )
        event = make_event("DAILY_BRIEFING_PUBLISHED", briefing)
        try:
            result = publish_events(endpoint, secret, [event])
        except Exception as exc:  # network / HTTP errors
            return PipelineReport(
                ok=False, publishable=True, published=False,
                counts=counts, rejected=rejected, briefing=briefing,
                errors=[f"publication failed: {exc}"],
                message="publication failed — brief kept locally",
            )
        applied = result.get("applied", [])
        skipped = result.get("skipped", [])
        # An idempotent replay of an identical edition is acknowledged by
        # ingest with `skipped`; both arrays count as successful publication.
        if event["event_id"] not in applied and event["event_id"] not in skipped:
            return PipelineReport(
                ok=False, publishable=True, published=False,
                counts=counts, rejected=rejected, briefing=briefing,
                errors=[f"publication not acknowledged: {result}"],
                message="publication not acknowledged",
            )
        published = True

    message = "dry-run complete (not published)" if dry_run else (
        "published" if published else "ready to publish"
    )
    return PipelineReport(
        ok=True,
        publishable=True,
        published=published,
        counts=counts,
        rejected=rejected,
        briefing=briefing,
        errors=errors,
        message=message,
    )
