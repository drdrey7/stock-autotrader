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
        dry_run=not args.publish,
        publish=args.publish,
        endpoint=args.endpoint if args.publish else None,
        secret=_load_secret(args) if args.publish else None,
    )
    print(json.dumps(report.to_dict(), indent=2))
    return 0 if report.ok else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Stock Autotrader publisher.")
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
    brief.add_argument("--prepared-at", help="ISO-8601 preparedAt (default: next scheduled NY anchor).")
    brief.add_argument("--publish", action="store_true", help="Publish via signed ingest (default: dry-run).")
    brief.add_argument("--endpoint")
    brief.add_argument("--secret")
    brief.add_argument("--secret-file", type=Path)
    brief.set_defaults(handler=_cmd_brief)

    args = parser.parse_args()
    if not hasattr(args, "handler"):
        parser.print_usage(file=sys.stderr)
        return 2
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
