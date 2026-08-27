"""Instrument / listing metadata and canonical per-share normalization.

Automatic IV consumes per-share facts that must be expressed per *traded
security* (the exact instrument listed on the site) and in that instrument's
*quote currency*. Finnhub serves some foreign listings on a different basis:
TSM comes back in TWD per ordinary share (Taiwan 2330.TW), NVO in DKK, ASML in
EUR — while the Screener trades the USD ADR/ADS. This module records the
fixture-to-quote relationship for every Core symbol and provides the single
canonical conversion applied in the fundamentals-ingestor *before* a fact is
written to D1. The Worker and the Automatic IV engine never see currency or
ADR logic; they only ever read canonical facts.

Only symbols whose fundamentals basis differs from the quote basis need an
explicit override entry. Everything else defaults to USD/quoted-ordinary-share
(identity). Overrides below match the read-only audit and official sources.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

from .finnhub import MarketData

# Source-of-truth basis facts by Core symbol. quote_currency = currency of the
# security the Screener quotes; fundamentals_currency = currency Finnhub
# reports the per-share facts in; underlying_shares_per_listing = ordinary
# shares represented by one traded ADR/ADS (1 for non-ADR listings).
#   TSM: NYSE ADS, 1 ADS = 5 ordinary shares 2330.TW (SEC 20-F) — TWD
#   NVO: NYSE ADR, 1 ADR = 1 B-share (Copenhagen)           — DKK
#   ASML: Nasdaq ADS, 1 ADS = 1 ordinary share (Amsterdam)  — EUR
INSTRUMENT_OVERRIDES: dict[str, tuple[str, str, str, float]] = {
    "TSM": ("USD", "TWD", "ADR/ADS", 5.0),
    "NVO": ("USD", "DKK", "ADR", 1.0),
    "ASML": ("USD", "EUR", "ADS_nasdaq_foreign_listing", 1.0),
}

# Ordinary USD listings are the default; they need no conversion.
DEFAULT_QUOTE_CURRENCY = "USD"
DEFAULT_FUNDAMENTALS_CURRENCY = "USD"
DEFAULT_LISTING_TYPE = "domestic_ordinary"


@dataclass(frozen=True)
class InstrumentMetadata:
    symbol: str
    quote_currency: str
    fundamentals_currency: str
    listing_type: str
    # Ordinary underlying shares per traded security (used to scale per-share
    # facts to the quoted instrument). 5.0 for TSM's 1:5 ADS ratio, 1.0 otherwise.
    underlying_shares_per_listing: float


def get_instrument(symbol: str) -> InstrumentMetadata:
    normalized = symbol.strip().upper()
    override = INSTRUMENT_OVERRIDES.get(normalized)
    if override:
        quote, fundamentals, listing_type, ratio = override
        return InstrumentMetadata(
            symbol=normalized,
            quote_currency=quote,
            fundamentals_currency=fundamentals,
            listing_type=listing_type,
            underlying_shares_per_listing=float(ratio),
        )
    return InstrumentMetadata(
        symbol=normalized,
        quote_currency=DEFAULT_QUOTE_CURRENCY,
        fundamentals_currency=DEFAULT_FUNDAMENTALS_CURRENCY,
        listing_type=DEFAULT_LISTING_TYPE,
        underlying_shares_per_listing=1.0,
    )


def needs_normalization(meta: InstrumentMetadata) -> bool:
    """True when the raw Finnhub facts are not already per-traded-security in the
    quote currency.

    A listing needs normalization when either (a) Finnhub reports its per-share
    facts in a different currency than the quote, or (b) the quoted security is
    an ADR/ADS whose underlying-shares-per-listing ratio differs from 1 (e.g. a
    hypothetical USD quote, USD fundamentals, ratio 5.0 listing still needs the
    ADR scaling even though the currency is identical).  Only when the currency
    is identical AND the ratio is 1 is the basis already canonical (no-op).
    """
    return (
        meta.fundamentals_currency != meta.quote_currency
        or meta.underlying_shares_per_listing != 1.0
    )


# Per-share anchors consumed by Automatic IV. Multiples (P/E, P/S, P/B, P/FCF)
# and the trailing 5-year multiple history are dimensionless and scale/currency
# invariant, so they must NEVER be converted.
PER_SHARE_FIELDS = ("eps_ttm", "fcf_per_share_ttm", "revenue_per_share_ttm", "book_value_per_share")


def _fail_closed(market: MarketData) -> MarketData:
    """Null out every unit-dependent fact (per-share + market cap).

    Called when a conversion is required but no FX rate is available (no fresh
    fetch and no last-known-good). We must never emit a fact in the wrong
    currency/share basis, so the affected facts fail closed to NULL rather than
    producing an IV with invalid units.
    """
    return replace(
        market,
        eps_ttm=None,
        fcf_per_share_ttm=None,
        revenue_per_share_ttm=None,
        book_value_per_share=None,
        market_cap=None,
    )


def normalize_to_quote_currency(
    market: MarketData,
    meta: InstrumentMetadata,
    fx_rates: dict[tuple[str, str], float],
) -> MarketData:
    """Return a MarketData whose per-share facts are per traded security in the
    quote currency, and whose market cap is in the quote currency.

    canonical_per_share = raw_finnhub_per_share
                          * underlying_shares_per_listing / fx_rate_to_quote

    When the fundamentals currency equals the quote currency the FX factor is 1
    (no rate is required); only a ratio != 1 then needs scaling. market cap is
    converted by FX only (it is total company value, independent of the ADR
    ratio). Ratios and multiple histories are left untouched.

    When a currency conversion is required but the FX rate is missing, the
    affected unit-dependent facts fail closed to NULL (no wrong-unit IV); the
    caller (main.run) additionally skips the D1 write entirely for such symbols
    so a last-known-good canonical snapshot is never overwritten with NULLs.
    """
    if not needs_normalization(meta):
        return market

    ratio = meta.underlying_shares_per_listing
    if meta.fundamentals_currency == meta.quote_currency:
        # Identity currency: FX factor is 1. Only the ADR/ADS ratio applies.
        rate = 1.0
    else:
        rate = fx_rates.get((meta.quote_currency, meta.fundamentals_currency))
        if rate is None or rate <= 0:
            return _fail_closed(market)

    scale = ratio / rate

    def multiply(value: float | None) -> float | None:
        return value * scale if value is not None else None

    market_cap = market.market_cap / rate if market.market_cap is not None else None
    return replace(
        market,
        eps_ttm=multiply(market.eps_ttm),
        fcf_per_share_ttm=multiply(market.fcf_per_share_ttm),
        revenue_per_share_ttm=multiply(market.revenue_per_share_ttm),
        book_value_per_share=multiply(market.book_value_per_share),
        market_cap=market_cap,
    )