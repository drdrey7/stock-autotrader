"""Daily Finnhub + EdgarTools -> D1 snapshot job."""

from __future__ import annotations

import argparse
import json
import logging
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

from .config import Settings, from_env
from .d1 import SNAPSHOT_COLUMNS, D1Client, snapshot_values
from .edgar import (
    FilingLookupError,
    FilingMetadata,
    fetch_accounting_inputs,
    fetch_annual_fundamentals,
    fetch_latest_filing_metadata,
)
from .finnhub import FinnhubClient, MarketData
from .metrics import accounting_inputs_from_snapshot

logger = logging.getLogger("fundamentals_ingestor")


def load_universe(path: Path) -> list[str]:
    with path.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    symbols = payload.get("symbols") if isinstance(payload, dict) else None
    if not isinstance(symbols, list) or not symbols or any(not isinstance(symbol, str) for symbol in symbols):
        raise RuntimeError("invalid_core_universe")
    normalized = [symbol.strip().upper() for symbol in symbols]
    if len(normalized) != len(set(normalized)) or normalized != sorted(normalized):
        raise RuntimeError("invalid_core_universe")
    return normalized


def _stored_number(row: dict[str, object], name: str) -> float | None:
    value = row.get(name)
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _accounting_snapshot_complete(row: dict[str, object]) -> bool:
    # EdgarTools may successfully process a filing while a fact is genuinely
    # inapplicable or unavailable. Reuse the recorded extraction result rather
    # than treating every nullable source field as a daily retry signal.
    return row.get("accounting_refresh_status") == "ok"


def _market_from_snapshot(row: dict[str, object] | None) -> MarketData | None:
    if not row:
        return None
    return MarketData(
        _stored_number(row, "market_cap"),
        _stored_number(row, "pe_ttm"),
        _stored_number(row, "beta"),
        _stored_number(row, "eps_ttm"),
        _stored_number(row, "dividend_yield"),
        row.get("market_checked_at") if isinstance(row.get("market_checked_at"), str) else None,
    )


def _annual_rows_have_statement_coverage(rows: list[object]) -> bool:
    """Require evidence from each required annual statement for every year.

    Individual metrics remain nullable because they can be legitimately absent.
    A whole statement group being NULL for one fiscal year, however, indicates
    that EdgarTools returned a shorter/partial statement window. Reject that
    window before any D1 upsert/pruning so existing history is preserved.
    """
    groups = (
        (
            "revenue",
            "operating_income",
            "pretax_income",
            "income_tax",
            "net_income",
            "diluted_eps",
        ),
        (
            "operating_cash_flow",
            "capex",
            "free_cash_flow",
            "depreciation_amortization",
        ),
        (
            "cash",
            "total_debt",
            "shareholders_equity",
            "current_assets",
            "current_liabilities",
        ),
    )
    return all(
        any(getattr(row, field, None) is not None for field in group)
        for row in rows
        for group in groups
    )


def _annual_window_is_safe(
    existing_years: set[int],
    rows: list[object],
    annual_periods_available: int | None = None,
) -> bool:
    """Reject a short/truncated provider window before D1 pruning."""
    if not rows or len(rows) > 5 or not _annual_rows_have_statement_coverage(rows):
        return False
    returned_years = {getattr(row, "fiscal_year", None) for row in rows}
    if not all(isinstance(year, int) for year in returned_years):
        return False
    if not existing_years:
        if annual_periods_available is not None:
            if annual_periods_available < len(returned_years):
                return False
            return len(returned_years) == annual_periods_available if annual_periods_available < 5 else len(returned_years) >= 5
        return len(returned_years) >= 5
    if annual_periods_available is not None and annual_periods_available < len(returned_years):
        return False
    confirmed_minimum = min(5, annual_periods_available) if annual_periods_available is not None else 0
    minimum = min(5, max(len(existing_years), confirmed_minimum))
    if len(returned_years) < minimum:
        return False
    overlap = len(existing_years & returned_years)
    return (
        max(returned_years) >= max(existing_years)
        and overlap >= max(0, min(len(existing_years), len(returned_years)) - 1)
    )


def _snapshot_changed(existing: dict[str, object] | None, values: list[object]) -> bool:
    if existing is None:
        return True
    candidate = dict(zip(SNAPSHOT_COLUMNS, values))
    # updated_at is the successful provider-check timestamp. Persist it even
    # when Finnhub and EdgarTools return the same financial values, so market
    # freshness reflects successful daily checks rather than value churn.
    return any(existing.get(column) != candidate.get(column) for column in SNAPSHOT_COLUMNS)


def run(settings: Settings, dry_run: bool = False) -> dict[str, int]:
    symbols = load_universe(settings.universe_path)
    finnhub = FinnhubClient(
        settings.finnhub_api_key,
        settings.request_timeout_seconds,
        min_interval_seconds=settings.finnhub_min_interval_seconds,
    )
    d1 = D1Client(
        settings.cloudflare_api_token,
        settings.cloudflare_account_id,
        settings.cloudflare_d1_database_id,
        settings.request_timeout_seconds,
    )
    updated_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    counts = {"processed": 0, "failed": 0, "written": 0, "reused": 0, "refreshed": 0}
    for symbol in symbols:
        try:
            existing = d1.get_snapshot(symbol) if not dry_run else None
            market = None
            try:
                market = finnhub.fetch(symbol)
            except Exception as exc:
                logger.warning("Finnhub reference check failed symbol=%s reason=%s", symbol, type(exc).__name__)
            if market is None:
                market = _market_from_snapshot(existing)
            filing_lookup_failed = False
            try:
                filing = fetch_latest_filing_metadata(symbol, settings.edgar_identity)
            except FilingLookupError:
                filing_lookup_failed = True
                filing = FilingMetadata(
                    existing.get("accounting_filing_accession") if existing and isinstance(existing.get("accounting_filing_accession"), str) else None,
                    existing.get("accounting_as_of") if existing and isinstance(existing.get("accounting_as_of"), str) else None,
                    existing.get("accounting_filing_form") if existing and isinstance(existing.get("accounting_filing_form"), str) else None,
                )
            annual_years = set()
            if not dry_run and hasattr(d1, "get_annual_years"):
                annual_years = d1.get_annual_years(symbol)
            can_reuse = bool(
                existing
                and filing
                and filing.accession
                and existing.get("accounting_filing_accession") == filing.accession
                and _accounting_snapshot_complete(existing)
                and (dry_run or not hasattr(d1, "get_annual_years") or bool(annual_years))
            )
            if can_reuse:
                accounting = accounting_inputs_from_snapshot(existing)
                counts["reused"] += 1
            else:
                try:
                    accounting = fetch_accounting_inputs(symbol, settings.edgar_identity, filing)
                    counts["refreshed"] += 1
                    if not dry_run and hasattr(d1, "upsert_annual"):
                        try:
                            annual = fetch_annual_fundamentals(symbol, settings.edgar_identity, filing)
                            existing_years = annual_years
                            if not _annual_window_is_safe(
                                existing_years,
                                annual,
                                filing.annual_periods_available if filing else None,
                            ):
                                raise RuntimeError("annual_history_truncated")
                            d1.upsert_annual([(symbol, row) for row in annual])
                        except Exception:
                            accounting = replace(accounting, extraction_status="incomplete")
                            counts["failed"] += 1
                            logger.exception("annual history refresh failed symbol=%s", symbol)
                except Exception:
                    if not existing:
                        raise
                    # A successful Finnhub refresh must not be lost because a
                    # new SEC filing is temporarily unavailable or incomplete.
                    # Keep the last processed accession until accounting is
                    # successfully refreshed.
                    accounting = accounting_inputs_from_snapshot(existing)
                    filing = FilingMetadata(
                        existing.get("accounting_filing_accession") if isinstance(existing.get("accounting_filing_accession"), str) else None,
                        existing.get("accounting_as_of") if isinstance(existing.get("accounting_as_of"), str) else None,
                        existing.get("accounting_filing_form") if isinstance(existing.get("accounting_filing_form"), str) else None,
                    )
                    counts["failed"] += 1
                    logger.error("accounting refresh failed symbol=%s; valid data preserved", symbol)
            if (not filing or not filing.accession) and existing:
                # A no-filing/lookup response is not permission to erase the
                # last processed accession or form used for recovery.
                filing = FilingMetadata(
                    existing.get("accounting_filing_accession") if isinstance(existing.get("accounting_filing_accession"), str) else None,
                    existing.get("accounting_as_of") if isinstance(existing.get("accounting_as_of"), str) else None,
                    existing.get("accounting_filing_form") if isinstance(existing.get("accounting_filing_form"), str) else None,
                )
            values = snapshot_values(
                symbol,
                market,
                accounting,
                updated_at,
                filing.accession if filing else None,
                filing.form if filing else None,
            )
            if not dry_run and _snapshot_changed(existing, values):
                d1.upsert(values)
                counts["written"] += 1
            counts["processed"] += 1
            logger.info("snapshot symbol=%s reused=%s filing_lookup_failed=%s dry_run=%s", symbol, can_reuse, filing_lookup_failed, dry_run)
        except Exception as exc:
            counts["failed"] += 1
            logger.error("snapshot failed symbol=%s reason=%s", symbol, type(exc).__name__)
    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="fetch and calculate without D1 writes")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        settings = from_env()
        counts = run(settings, dry_run=args.dry_run)
        logger.info("run complete processed=%d failed=%d written=%d reused=%d refreshed=%d", *(counts[key] for key in ("processed", "failed", "written", "reused", "refreshed")))
        return 1 if counts["failed"] else 0
    except Exception as exc:
        logger.error("run failed reason=%s", type(exc).__name__)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())