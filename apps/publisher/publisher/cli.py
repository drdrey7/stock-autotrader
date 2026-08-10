"""CLI for the Stock Autotrader publisher client.

Usage:
    python -m publisher.cli --endpoint https://<host>/ingest/events \
        --secret-file /run/secrets/ingest.key --file events.json
    python -m publisher.cli --endpoint ... --secret-file ... --type SYSTEM_STATUS \
        --payload '{"engine":"online","apiHealth":"healthy"}'
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .client import make_event, publish


def main() -> int:
    parser = argparse.ArgumentParser(description="Publish normalized events to Stock Autotrader ingest.")
    parser.add_argument("--endpoint", required=True, help="Full ingest URL (POST /ingest/events)")
    parser.add_argument("--secret", help="HMAC secret (prefer --secret-file)")
    parser.add_argument("--secret-file", type=Path, help="File containing the HMAC secret (no trailing newline)")
    parser.add_argument("--file", type=Path, help="JSON file with an array of events")
    parser.add_argument("--type", help="Event type when building a single event")
    parser.add_argument("--payload", help="JSON payload string when building a single event")
    parser.add_argument("--timeout", type=int, default=30)
    args = parser.parse_args()

    if args.secret_file and args.secret:
        print("error: pass only one of --secret / --secret-file", file=sys.stderr)
        return 2
    secret = args.secret
    if args.secret_file:
        secret = args.secret_file.read_text().strip()
    if not secret:
        print("error: secret required (--secret or --secret-file)", file=sys.stderr)
        return 2

    if args.file:
        events = json.loads(args.file.read_text())
        if not isinstance(events, list):
            print("error: --file must contain a JSON array of events", file=sys.stderr)
            return 2
    elif args.type:
        payload = json.loads(args.payload) if args.payload else {}
        events = [make_event(args.type, payload)]
    else:
        parser.print_usage(file=sys.stderr)
        return 2

    result = publish(args.endpoint, secret, events, timeout=args.timeout)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
