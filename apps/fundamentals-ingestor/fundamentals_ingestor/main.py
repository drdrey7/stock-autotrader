"""Daily Finnhub metric=all -> D1 Stock Detail snapshot job."""

from __future__ import annotations

import argparse
import json
import logging
from datetime import UTC, datetime
from pathlib import Path

from .config import Settings, from_env
from .finnhub import FinnhubClient
from .fx import FxClient, FxError
from .instruments import get_instrument, normalize_to_quote_currency
from .market_d1 import MarketD1Client

logger = logging.getLogger("fundamentals_ingestor")

# Above this age a last-known-good FX rate is considered stale enough to warn.
FX_LKG_MAX_AGE_DAYS = 7


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


def _annual_rows_have_statement_coverage(rows: list[object]) -> bool:
    """Legacy Edgar annual-window guard retained for adapter/unit compatibility.

    The daily fundamentals runtime no longer calls Edgar. Keeping this small
    pure guard avoids coupling removal of the old adapter/tests to the Finnhub
    serving simplification.
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
    for row in rows:
        for group in groups:
            exposed = [field for field in group if hasattr(row, field)]
            if exposed and not any(getattr(row, field) is not None for field in exposed):
                return False
    return True


def _annual_window_is_safe(
    existing_years: set[int],
    rows: list[object],
    annual_periods_available: int | None = None,
) -> bool:
    """Legacy pure safety helper; not used by the Finnhub-only daily runtime."""
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


def _load_fx(fx: FxClient, d1, updated_at: str, dry_run: bool) -> tuple[dict[tuple[str, str], float], str]:
    """Fetch daily rates, persist them on a fresh read, else fall back to
    last-known-good stored in D1. Returns ``(rates, source)`` where source is
    ``fresh``, ``lkg`` or ``missing``. Logs the source and warns when the LKG
    is stale (observability only; staleness alone does not fail closed).
    """
    try:
        rates, as_of = fx.fetch_rates()
    except FxError as exc:
        lkg = d1.get_fx_rates()
        lkg_as_of: str | None = None
        getter = getattr(d1, "get_fx_last_as_of", None)
        if callable(getter):
            try:
                raw_as_of = getter()
                lkg_as_of = str(raw_as_of) if isinstance(raw_as_of, str) else None
            except RuntimeError:
                lkg_as_of = None
        if lkg_as_of:
            try:
                age_days = (datetime.now(UTC).date() - datetime.fromisoformat(lkg_as_of).date()).days
                if age_days > FX_LKG_MAX_AGE_DAYS:
                    logger.warning("fx lkg stale as_of=%s age_days=%d threshold_days=%d", lkg_as_of, age_days, FX_LKG_MAX_AGE_DAYS)
                else:
                    logger.warning("fx lkg as_of=%s age_days=%d", lkg_as_of, age_days)
            except ValueError:
                logger.warning("fx lkg as_of unparseable as_of=%r", lkg_as_of)
        else:
            logger.warning("fx lkg as_of unknown")
        logger.warning("fx fetch failed reason=%s using_lkg=%s", type(exc).__name__, bool(lkg))
        return lkg, ("lkg" if lkg else "missing")
    if not dry_run:
        try:
            d1.upsert_fx_rates(rates, as_of, updated_at)
        except RuntimeError:
            # FX persistence failure must not abort the whole fundamentals run;
            # the freshly fetched rates are still used in-memory for this run.
            logger.error("fx persist failed using_fetched=true")
    return rates, "fresh"


def run(settings: Settings, dry_run: bool = False) -> dict[str, int]:
    """Refresh direct Finnhub fundamentals for the Core Universe.

    A provider failure performs no D1 write for that symbol, preserving its
    last-known-good snapshot. Missing individual metrics inside an otherwise
    valid Finnhub response are legitimate NULLs and therefore become dashes in
    Stock Detail on the next successful snapshot.

    Instrument/currency normalization is applied here, before the canonical
    facts reach D1: per-share and market-cap values are converted to the quoted
    security and quote currency (see ``instruments``). When a foreign listing
    needs FX and no rate is available (no fresh fetch, no valid last-known-good)
    that symbol's refresh is **skipped entirely** — the previous last-known-good
    canonical snapshot is preserved rather than overwritten with NULLs. Domestic
    USD/computed listings (no FX required) continue to refresh normally.
    """
    symbols = load_universe(settings.universe_path)
    finnhub = FinnhubClient(
        settings.finnhub_api_key,
        settings.request_timeout_seconds,
        min_interval_seconds=settings.finnhub_min_interval_seconds,
    )
    d1 = MarketD1Client(
        settings.cloudflare_api_token,
        settings.cloudflare_account_id,
        settings.cloudflare_d1_database_id,
        settings.request_timeout_seconds,
    )
    updated_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    fx = FxClient(settings.request_timeout_seconds, settings.fx_url)
    fx_rates, fx_source = _load_fx(fx, d1, updated_at, dry_run)
    logger.info("fx source=%s pairs=%d updated_at=%s", fx_source, len(fx_rates), updated_at)
    counts = {"processed": 0, "failed": 0, "written": 0, "skipped": 0}

    for symbol in symbols:
        try:
            market = finnhub.fetch(symbol)
            meta = get_instrument(symbol)
            if meta.fundamentals_currency != meta.quote_currency and (meta.quote_currency, meta.fundamentals_currency) not in fx_rates:
                # A foreign listing needs FX but we have neither a fresh rate nor
                # a valid last-known-good one. Preserve the previous canonical
                # snapshot entirely instead of overwriting it with NULLs/erroneous
                # units; count and log the symbol as skipped rather than written.
                counts["skipped"] += 1
                logger.warning("instrument fx unavailable symbol=%s currency=%s quote_currency=%s skip_preserve_snapshot=true", symbol, meta.fundamentals_currency, meta.quote_currency)
                continue
            market = normalize_to_quote_currency(market, meta, fx_rates)
            if not dry_run:
                d1.upsert_market(symbol, market, updated_at)
                counts["written"] += 1
            counts["processed"] += 1
            # Brief valuation-feature summary. Never logs the API key, raw
            # JSON or the full provider payload.
            logger.info(
                "snapshot symbol=%s dry_run=%s growth_yoy=%s roe_pct=%s pe_samples=%s pe_median=%s pfcf_samples=%s pfcf_median=%s ps_samples=%s ps_median=%s pb_samples=%s pb_median=%s",
                symbol,
                dry_run,
                market.revenue_growth_ttm_yoy_pct,
                market.roe_ttm_pct,
                market.pe_5y_samples,
                market.pe_5y_median,
                market.pfcf_5y_samples,
                market.pfcf_5y_median,
                market.ps_5y_samples,
                market.ps_5y_median,
                market.pb_5y_samples,
                market.pb_5y_median,
            )
        except Exception as exc:
            counts["failed"] += 1
            logger.error("snapshot failed symbol=%s reason=%s", symbol, type(exc).__name__)
    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="fetch and normalize without D1 writes")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        settings = from_env()
        counts = run(settings, dry_run=args.dry_run)
        logger.info(
            "run complete processed=%d failed=%d written=%d",
            counts["processed"],
            counts["failed"],
            counts["written"],
        )
        return 1 if counts["failed"] else 0
    except Exception as exc:
        logger.error("run failed reason=%s", type(exc).__name__)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
