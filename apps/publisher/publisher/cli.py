"""CLI for the Stock Autotrader publisher.

Legacy event publishing (PR #3):
    python -m publisher.cli --endpoint https://<host>/ingest/events \
        --secret-file /run/secrets/ingest.key --file events.json
    python -m publisher.cli --endpoint ... --secret-file ... --type SYSTEM_STATUS \
        --payload '{"engine":"online","apiHealth":"healthy"}'

Daily Briefing pipeline (PR #8):
    python -m publisher.cli brief --edition pre_market \
        --x-posts x_posts.json --quotes quotes.json --data-dir data --dry-run
    python -m publisher.cli brief --edition post_close \
        --x-posts x_posts.json --quotes quotes.json --data-dir data \
        --publish --endpoint https://<host>/ingest/events --secret-file /run/secrets/ingest.key
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

from .client import make_event, publish
from .pipeline import run_pipeline


def _load_secret(args: argparse.Namespace) -> str:
    if args.secret_file and args.secret:
        print("error: pass only one of --secret / --secret-file", file=sys.stderr)
        raise SystemExit(2)
    secret = args.secret
    if args.secret_file:
        secret = Path(args.secret_file).read_text().strip()
    if not secret:
        print("error: secret required (--secret or --secret-file)", file=sys.stderr)
        raise SystemExit(2)
    return secret


def _cmd_events(args: argparse.Namespace) -> int:
    if args.file:
        events = json.loads(Path(args.file).read_text())
        if not isinstance(events, list):
            print("error: --file must contain a JSON array of events", file=sys.stderr)
            return 2
    elif args.type:
        payload = json.loads(args.payload) if args.payload else {}
        events = [make_event(args.type, payload)]
    else:
        argparse.ArgumentParser().print_usage(file=sys.stderr)
        return 2
    secret = _load_secret(args)
    result = publish(args.endpoint, secret, events, timeout=args.timeout)
    print(json.dumps(result))
    return 0


def _cmd_brief(args: argparse.Namespace) -> int:
    x_posts = json.loads(Path(args.x_posts).read_text())
    quotes = json.loads(Path(args.quotes).read_text())
    if not isinstance(x_posts, list):
        print("error: --x-posts must contain a JSON array", file=sys.stderr)
        return 2

    prepared_at: datetime | None = None
    if args.prepared_at:
        prepared_at = datetime.fromisoformat(args.prepared_at.replace("Z", "+00:00"))

    report = run_pipeline(
        edition_type=args.edition,
        x_posts=x_posts,
        quotes=quotes,
        data_dir=args.data_dir,
        prepared_at=prepared_at,
        dry_run=args.dry_run or not args.publish,
        publish=args.publish,
        endpoint=args.endpoint if args.publish else None,
        secret=_load_secret(args) if args.publish else None,
    )
    print(json.dumps(report.to_dict(), indent=2))
    return 0 if report.ok else 1


def _cmd_x_posts(args: argparse.Namespace) -> int:
    """Publish collected X posts as an X_POSTS_COLLECTED event (read model)."""
    payload = json.loads(Path(args.posts).read_text())
    posts = payload.get("posts") if isinstance(payload, dict) else payload
    if not isinstance(posts, list) or not posts:
        print("error: --posts must contain a JSON array (or {posts: [...]})", file=sys.stderr)
        return 2
    secret = _load_secret(args)
    event = make_event("X_POSTS_COLLECTED", {"posts": posts})
    result = publish(args.endpoint, secret, [event], timeout=args.timeout)
    print(json.dumps(result))
    # Fail unless the event was applied or acknowledged as an idempotent skip;
    # an HTTP-200 `rejected` means the batch was discarded (feed stays stale).
    acknowledged = event["event_id"] in result.get("applied", []) or event["event_id"] in result.get("skipped", [])
    return 0 if acknowledged else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Stock Autotrader publisher.")
    # Root options keep the legacy PR #3 no-subcommand invocation working.
    parser.add_argument("--endpoint")
    parser.add_argument("--secret")
    parser.add_argument("--secret-file", type=Path)
    parser.add_argument("--file", type=Path)
    parser.add_argument("--type")
    parser.add_argument("--payload")
    parser.add_argument("--timeout", type=int, default=30)
    subparsers = parser.add_subparsers(dest="command")

    events = subparsers.add_parser("events", help="Publish normalized events (PR #3).")
    events.add_argument("--endpoint", required=True)
    events.add_argument("--secret")
    events.add_argument("--secret-file", type=Path)
    events.add_argument("--file", type=Path)
    events.add_argument("--type")
    events.add_argument("--payload")
    events.add_argument("--timeout", type=int, default=30)
    events.set_defaults(handler=_cmd_events)

    brief = subparsers.add_parser("brief", help="Compose and (optionally) publish a Daily Briefing (PR #8).")
    brief.add_argument("--edition", required=True, choices=("pre_market", "post_close"))
    brief.add_argument("--x-posts", required=True, type=Path, help="JSON array of X posts.")
    brief.add_argument("--quotes", required=True, type=Path, help="JSON market quotes/snapshot.")
    brief.add_argument("--data-dir", default="data", type=Path, help="Publisher data directory (versioned snapshots).")
    brief.add_argument("--prepared-at", help="ISO-8601 preparedAt with explicit timezone offset (default: next scheduled NY anchor).")
    brief.add_argument("--dry-run", action="store_true", help="Explicit dry-run (default; no publication).")
    brief.add_argument("--publish", action="store_true", help="Publish via signed ingest (overrides --dry-run).")
    brief.add_argument("--endpoint")
    brief.add_argument("--secret")
    brief.add_argument("--secret-file", type=Path)
    brief.set_defaults(handler=_cmd_brief)

    x_posts = subparsers.add_parser("x-posts", help="Publish collected X posts to the read model (X Search feed).")
    x_posts.add_argument("--posts", required=True, type=Path, help="JSON array of X posts (or {posts: [...]}).")
    x_posts.add_argument("--endpoint", required=True)
    x_posts.add_argument("--secret")
    x_posts.add_argument("--secret-file", type=Path)
    x_posts.add_argument("--timeout", type=int, default=30)
    x_posts.set_defaults(handler=_cmd_x_posts)

    args = parser.parse_args()
    if args.command is None:
        # Legacy PR #3 invocation without a subcommand.
        if getattr(args, "endpoint", None):
            return _cmd_events(args)
        parser.print_usage(file=sys.stderr)
        return 2
    if not hasattr(args, "handler"):
        parser.print_usage(file=sys.stderr)
        return 2
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
