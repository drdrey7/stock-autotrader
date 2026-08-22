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
from .metrics import CalculatedMetrics, accounting_inputs_from_snapshot, calculate_metrics

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


def _stored_metrics(row: dict[str, object]) -> CalculatedMetrics:
    return CalculatedMetrics(
        free_cash_flow_ttm=_stored_number(row, "free_cash_flow_ttm"),
        roic_pct=_stored_number(row, "roic_pct"),
        fcf_margin_pct=_stored_number(row, "fcf_margin_pct"),
        debt_to_equity=_stored_number(row, "debt_to_equity"),
    )


def _accounting_snapshot_complete(row: dict[str, object]) -> bool:
    # EdgarTools may successfully process a filing while a fact is genuinely
    # inapplicable or unavailable. Reuse the recorded extraction result rather
    # than treating every nullable source field as a daily retry signal.
    return row.get("accounting_refresh_status") == "ok"


def _derived_market(accounting, quote: tuple[float, str] | None, fallback):
    """Use the quote pipeline for freshness; never timestamp Finnhub metrics."""
    if quote is None:
        return fallback
    price, timestamp = quote
    market_cap = price * accounting.shares_outstanding if accounting.shares_outstanding and accounting.shares_outstanding > 0 else None
    pe_ttm = price / accounting.diluted_eps_ttm if accounting.diluted_eps_ttm and accounting.diluted_eps_ttm > 0 else None
    return MarketData(market_cap, pe_ttm, timestamp)


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
    counts = {"complete": 0, "partial": 0, "missing": 0, "failed": 0, "written": 0}
    for symbol in symbols:
        try:
            # One Finnhub metric=all request remains the provider health/reference
            # check. Market cards use the current quote already stored in D1.
            finnhub.fetch(symbol)
            existing = d1.get_snapshot(symbol) if not dry_run else None
            quote = None
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
            can_reuse = bool(
                existing
                and filing
                and filing.accession
                and existing.get("accounting_filing_accession") == filing.accession
                and _accounting_snapshot_complete(existing)
            )
            market_fallback_allowed = can_reuse
            if can_reuse:
                accounting = accounting_inputs_from_snapshot(existing)
                calculated = _stored_metrics(existing)
            else:
                try:
                    accounting = fetch_accounting_inputs(symbol, settings.edgar_identity, filing)
                    calculated = calculate_metrics(accounting)
                    if not dry_run and hasattr(d1, "upsert_annual"):
                        try:
                            annual = fetch_annual_fundamentals(symbol, settings.edgar_identity, filing)
                            if not annual:
                                raise RuntimeError("annual_history_unavailable")
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
                    calculated = _stored_metrics(existing)
                    filing = FilingMetadata(
                        existing.get("accounting_filing_accession") if isinstance(existing.get("accounting_filing_accession"), str) else None,
                        existing.get("accounting_as_of") if isinstance(existing.get("accounting_as_of"), str) else None,
                        existing.get("accounting_filing_form") if isinstance(existing.get("accounting_filing_form"), str) else None,
                    )
                    market_fallback_allowed = True
                    counts["failed"] += 1
                    logger.error("accounting refresh failed symbol=%s; market refresh preserved", symbol)
            fallback_market = MarketData(
                _stored_number(existing, "market_cap") if market_fallback_allowed and existing else None,
                _stored_number(existing, "pe_ttm") if market_fallback_allowed and existing else None,
                existing.get("market_as_of") if market_fallback_allowed and existing and isinstance(existing.get("market_as_of"), str) else None,
            )
            if not dry_run and hasattr(d1, "get_latest_quote"):
                quote_data = d1.get_latest_quote(symbol, accounting.accounting_as_of)
                if quote_data is not None and quote_data.basis_compatible:
                    quote = (quote_data.price, quote_data.timestamp)
                elif quote_data is not None:
                    fallback_market = MarketData(None, None, None)
            market = _derived_market(accounting, quote, fallback_market)
            card_values = [market.market_cap, market.pe_ttm, calculated.roic_pct, calculated.fcf_margin_pct, calculated.debt_to_equity]
            available = sum(value is not None for value in card_values)
            if available == 5:
                counts["complete"] += 1
            elif available == 0:
                counts["missing"] += 1
            else:
                counts["partial"] += 1
            values = snapshot_values(
                symbol,
                market,
                accounting,
                calculated,
                updated_at,
                filing.accession if filing else None,
            )
            if not dry_run and _snapshot_changed(existing, values):
                d1.upsert(values)
                counts["written"] += 1
            logger.info("snapshot symbol=%s cards=%d reused=%s filing_lookup_failed=%s dry_run=%s", symbol, available, can_reuse, filing_lookup_failed, dry_run)
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
        logger.info("run complete complete=%d partial=%d missing=%d failed=%d written=%d", *(counts[key] for key in ("complete", "partial", "missing", "failed", "written")))
        return 1 if counts["failed"] else 0
    except Exception as exc:
        logger.error("run failed reason=%s", type(exc).__name__)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
