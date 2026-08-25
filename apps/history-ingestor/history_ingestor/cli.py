"""CLI entry points for the history ingestor.

Subcommands:
  bootstrap        — resumable historical bootstrap (SPLITS+WEEKLY)
  maintenance      — priority WEEKLY refresh + metrics
  reconcile-splits — bounded provider SPLITS discovery with durable progress
  apply-due-splits — zero-provider application of stored due splits
  status           — checkpoint + D1 coverage summary
  validate         — local data-quality validation for one symbol (D1 read-only)

All commands log JSON lines; secrets never appear (config/state keys are
referenced by index only).
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from typing import Any

from .bootstrap import BootstrapRunner
from .config import ConfigError, Settings, from_env
from .d1 import D1Client
from .maintenance import MaintenanceRunner
from .maintenance_state import MaintenanceStore
from .provider import AlphaVantageClient
from .state import BootstrapBudgetLedger, KeyBudgetLedger, StateStore
from .universe import load_core_universe


def _settings() -> Settings:
    try:
        return from_env()
    except ConfigError as exc:
        print(json.dumps({"event": "config_error", "error": str(exc)}), file=sys.stderr)
        raise SystemExit(2)


def _build(
    settings: Settings,
    *,
    bootstrap: bool = False,
    bootstrap_run_limit: int | None = None,
    provider_run_limit: int | None = None,
) -> tuple[D1Client, AlphaVantageClient, StateStore]:
    d1 = D1Client(
        settings.cloudflare_api_token,
        settings.cloudflare_account_id,
        settings.cloudflare_d1_database_id,
        max_retries=settings.d1_max_retries,
        retry_base_seconds=settings.d1_retry_base_seconds,
        request_timeout_seconds=settings.d1_request_timeout_seconds,
        batch_max_rows=settings.d1_batch_max_rows,
    )
    store = StateStore(settings, d1)
    if bootstrap:
        ledger = BootstrapBudgetLedger(
            store,
            daily_limit=settings.bootstrap_max_requests_per_day,
            run_limit=bootstrap_run_limit,
        )
    else:
        ledger = KeyBudgetLedger(store, run_limit=provider_run_limit)
    provider = AlphaVantageClient(settings, ledger)
    return d1, provider, store


def _emit(event: str, **fields: Any) -> None:
    print(json.dumps({"event": event, **fields}, sort_keys=True))


def cmd_bootstrap(settings: Settings, args: argparse.Namespace) -> int:
    # Bootstrap gets a dedicated ledger wrapper so BOTH the persisted UTC-day
    # cap and a lower explicit --limit are enforced at the actual HTTP debit
    # boundary. Internal multi-key retry can therefore never overshoot the cap.
    d1, provider, store = _build(
        settings,
        bootstrap=True,
        bootstrap_run_limit=args.limit,
    )
    runner = BootstrapRunner(settings, d1, provider, store)
    report = runner.run(
        dry_run=args.dry_run,
        # The provider ledger owns --limit exactly. Passing it again to the
        # legacy runner-level logical-fetch counter would incorrectly compare a
        # per-invocation limit against prior same-day logical usage.
        limit=None,
        symbols_filter=args.symbols,
    )
    _emit("bootstrap_report", **report)
    # Quota exhaustion is NORMAL partial completion (free-tier), NOT a crash:
    # exit 0 so the systemd unit does not Restart=on-failure into a 120s loop.
    # throttled = provider-wide Information circuit breaker (normal partial day)
    return 0 if report["status"] in ("complete", "partial", "quota", "throttled") else 2


def cmd_maintenance(settings: Settings, args: argparse.Namespace) -> int:
    d1, provider, store = _build(settings)
    # The bootstrap StateStore doubles as the SHARED per-key daily budget
    # ledger (bootstrap + maintenance draw from the same provider day quota).
    # It MUST be loaded so the ledger has per-key entries (and day rollover
    # resets usage); its symbol statuses are never touched by maintenance.
    store.load()
    mstore = MaintenanceStore(settings, d1)
    runner = MaintenanceRunner(settings, d1, provider, mstore, key_store=store)
    report = runner.run(
        dry_run=args.dry_run,
        limit=args.limit,
        symbols_filter=args.symbols,
    )
    _emit("maintenance_report", **report)
    # Quota / waiting / partial are expected outcomes (free-tier pacing) and
    # exit 0 — no retry loop. Only genuine failures (config/corrupted state)
    # surface as non-zero, from _settings()/store.load() above.
    return 0


def cmd_apply_due_splits(settings: Settings, args: argparse.Namespace) -> int:
    d1, provider, store = _build(settings)
    store.load()
    mstore = MaintenanceStore(settings, d1)
    runner = MaintenanceRunner(settings, d1, provider, mstore, key_store=store)
    report = runner.apply_due_splits(symbols_filter=args.symbols)
    _emit("apply_due_splits_report", **report)
    return 0


def cmd_reconcile_splits(settings: Settings, args: argparse.Namespace) -> int:
    configured = settings.reconcile_splits_max_requests
    if configured is not None and args.limit is not None:
        effective_limit = min(configured, args.limit)
    elif configured is not None:
        effective_limit = configured
    else:
        effective_limit = args.limit

    # Enforce the reconciliation cap twice by design:
    # 1) provider ledger: hard boundary on every real HTTP debit, including
    #    internal multi-key retries / Information responses;
    # 2) runner: stops before starting another logical symbol fetch.
    d1, provider, store = _build(settings, provider_run_limit=effective_limit)
    store.load()
    mstore = MaintenanceStore(settings, d1)
    runner = MaintenanceRunner(settings, d1, provider, mstore, key_store=store)
    report = runner.reconcile_splits(
        symbols_filter=args.symbols,
        dry_run=args.dry_run,
        limit=effective_limit,
    )
    _emit("reconcile_splits_report", **report)
    # Quota / throttle / partial are expected outcomes (free-tier) — exit 0, no
    # retry loop. Only genuine failures surface as non-zero from _settings().
    return 0


def cmd_status(settings: Settings) -> int:
    d1, provider, store = _build(settings)
    state = store.load()
    universe = load_core_universe(settings.universe_path)
    done = [
        symbol for symbol in universe
        if store.symbol_status(symbol, "weekly") == "done"
        and store.symbol_status(symbol, "splits") == "done"
    ]
    coverage = d1.read_weekly_summary()
    metrics = d1.read_technical_metrics()
    try:
        mstore = MaintenanceStore(settings, d1)
        mstate = mstore.load()
        split_counts = {sym: len(rows) for sym, rows in d1.read_all_split_events().items()}
        maintenance = {
            "cycle_week": mstate.cycle_week,
            "phase": mstate.phase(),
            "symbols_tracked": len(mstate.symbols),
            "splits_done": sum(1 for s in mstate.symbols if mstate.symbol_status(s, "splits") == "done"),
            "weekly_done": sum(1 for s in mstate.symbols if mstate.symbol_status(s, "weekly") == "done"),
            "metrics_done": sum(1 for s in mstate.symbols if mstate.symbol_status(s, "metrics") == "done"),
        }
    except Exception:
        maintenance = {}
        split_counts = {}
    _emit("status", **{
        "day": state.day,
        "keys_used": [{"index": k.get("index"), "used": k.get("used", 0), "status": k.get("status")} for k in state.keys],
        "universe_total": len(universe),
        "bootstrap_done": len(done),
        "bootstrap_pending": len(universe) - len(done),
        "coverage_symbols": coverage["total_symbols"],
        "weekly_rows": sum(int(row.get("rows", 0)) for row in coverage["rows"]),
        "metrics_symbols": len(metrics),
        "metrics_status": {row.get("symbol"): row.get("status") for row in metrics},
        "split_events_symbols": len(split_counts),
        "maintenance": maintenance,
    })
    return 0


def cmd_validate(settings: Settings, args: argparse.Namespace) -> int:
    d1, provider, store = _build(settings)
    universe = load_core_universe(settings.universe_path)
    target = args.symbol or universe[0]
    rows = d1.read_weekly_rows(target)
    if not rows:
        _emit("validate", symbol=target, ok=False, error="no weekly rows in D1")
        return 2
    adjusted = []
    for row in rows:
        adjusted.append((
            float(row["raw_close"]),
            float(row["split_adjustment_factor"]),
            float(row["split_adjusted_close"]),
        ))
    ok = True
    issues: list[str] = []
    for raw, factor, adjusted_close in adjusted:
        if factor <= 0:
            ok = False
            issues.append("factor <= 0")
        if adjusted_close <= 0:
            ok = False
            issues.append("adjusted close <= 0")
        if abs((raw / factor) - adjusted_close) > 1e-6:
            ok = False
            issues.append("adjusted close != raw / factor")
    # uniqueness
    dates = [row["week_end_date"] for row in rows]
    if len(dates) != len(set(dates)):
        ok = False
        issues.append("duplicate week_end_date")
    if dates != sorted(dates):
        ok = False
        issues.append("not chronologically ordered")
    _emit("validate", symbol=target, ok=ok, rows=len(rows),
          oldest=dates[0] if dates else None, newest=dates[-1] if dates else None,
          issues=issues[:10])
    return 0 if ok else 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="history-ingestor", description=__doc__)
    parser.add_argument("--verbose", action="store_true", help="enable debug logging")
    sub = parser.add_subparsers(dest="command", required=True)

    p_bootstrap = sub.add_parser("bootstrap", help="resumable historical bootstrap")
    p_bootstrap.add_argument("--dry-run", action="store_true", help="plan only — no provider calls, no D1 writes")
    p_bootstrap.add_argument("--limit", type=int, default=None, help="cap total provider requests")
    p_bootstrap.add_argument("--symbols", nargs="*", default=None, help="restrict to these symbols")
    p_bootstrap.set_defaults(handler=cmd_bootstrap)

    p_maintenance = sub.add_parser("maintenance", help="priority WEEKLY refresh + metrics")
    p_maintenance.add_argument("--dry-run", action="store_true", help="plan only — no provider calls, no D1 writes")
    p_maintenance.add_argument("--limit", type=int, default=None, help="cap total provider requests")
    p_maintenance.add_argument("--symbols", nargs="*", default=None, help="restrict to these symbols")
    p_maintenance.set_defaults(handler=cmd_maintenance)

    p_due = sub.add_parser("apply-due-splits", help="daily ZERO-PROVIDER split application")
    p_due.add_argument("--symbols", nargs="*", default=None, help="restrict to these symbols")
    p_due.set_defaults(handler=cmd_apply_due_splits)

    p_recon = sub.add_parser("reconcile-splits", help="LOW-FREQUENCY provider SPLITS check (decoupled from weekly maintenance)")
    p_recon.add_argument("--dry-run", action="store_true", help="plan only — no provider calls, no D1 writes")
    p_recon.add_argument("--limit", type=int, default=None, help="cap total provider requests")
    p_recon.add_argument("--symbols", nargs="*", default=None, help="restrict to these symbols")
    p_recon.set_defaults(handler=cmd_reconcile_splits)

    p_status = sub.add_parser("status", help="checkpoint + D1 coverage summary")
    p_status.set_defaults(handler=lambda _s, _a: cmd_status(_s))

    p_validate = sub.add_parser("validate", help="local data-quality validation of one symbol in D1")
    p_validate.add_argument("--symbol", default=None, help="symbol to validate (default: first universe symbol)")
    p_validate.set_defaults(handler=cmd_validate)

    args = parser.parse_args(argv)
    if args.verbose:
        logging.basicConfig(level=logging.DEBUG)
    settings = _settings()
    return int(args.handler(settings, args))


if __name__ == "__main__":
    raise SystemExit(main())
