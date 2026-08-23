"""D1 writer for the direct Finnhub Stock Detail snapshot."""

from __future__ import annotations

from .d1 import D1Client
from .finnhub import MarketData


class MarketD1Client(D1Client):
    """Update only Finnhub-owned snapshot columns, preserving legacy accounting data."""

    def upsert_market(self, symbol: str, market: MarketData, updated_at: str) -> None:
        values = [
            symbol,
            market.market_cap,
            market.pe_ttm,
            market.beta,
            market.eps_ttm,
            market.dividend_yield,
            market.roic_pct,
            market.fcf_margin_pct,
            market.debt_to_equity,
            market.fcf_per_share_ttm,
            market.checked_at,
            "finnhub",
            "none",
            updated_at,
        ]
        sql = """
        INSERT INTO stock_fundamentals_snapshot (
          symbol, market_cap, pe_ttm, beta, eps_ttm, dividend_yield,
          roic_pct, fcf_margin_pct, debt_to_equity, fcf_per_share_ttm,
          market_checked_at, market_source, accounting_source, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol) DO UPDATE SET
          market_cap=excluded.market_cap,
          pe_ttm=excluded.pe_ttm,
          beta=excluded.beta,
          eps_ttm=excluded.eps_ttm,
          dividend_yield=excluded.dividend_yield,
          roic_pct=excluded.roic_pct,
          fcf_margin_pct=excluded.fcf_margin_pct,
          debt_to_equity=excluded.debt_to_equity,
          fcf_per_share_ttm=excluded.fcf_per_share_ttm,
          market_checked_at=excluded.market_checked_at,
          market_source=excluded.market_source,
          updated_at=excluded.updated_at
        """.strip()
        try:
            self._query(sql, values)
        except RuntimeError as exc:
            if str(exc) == "d1_query_failed":
                raise RuntimeError("d1_write_failed") from exc
            raise
