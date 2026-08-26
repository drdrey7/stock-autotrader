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
            market.revenue_growth_ttm_yoy_pct,
            market.revenue_growth_3y_pct,
            market.revenue_growth_5y_pct,
            market.roe_ttm_pct,
            market.pe_5y_p25,
            market.pe_5y_median,
            market.pe_5y_p75,
            market.pe_5y_samples,
            market.pe_5y_as_of,
            market.pfcf_5y_p25,
            market.pfcf_5y_median,
            market.pfcf_5y_p75,
            market.pfcf_5y_samples,
            market.pfcf_5y_as_of,
            market.revenue_per_share_ttm,
            market.book_value_per_share,
            market.ps_5y_p25,
            market.ps_5y_median,
            market.ps_5y_p75,
            market.ps_5y_samples,
            market.ps_5y_as_of,
            market.pb_5y_p25,
            market.pb_5y_median,
            market.pb_5y_p75,
            market.pb_5y_samples,
            market.pb_5y_as_of,
            market.checked_at,
            "finnhub-basic-financials",
            "none",
            updated_at,
        ]
        sql = """
        INSERT INTO stock_fundamentals_snapshot (
          symbol, market_cap, pe_ttm, beta, eps_ttm, dividend_yield,
          roic_pct, fcf_margin_pct, debt_to_equity, fcf_per_share_ttm,
          revenue_growth_ttm_yoy_pct, revenue_growth_3y_pct, revenue_growth_5y_pct,
          roe_ttm_pct, pe_5y_p25, pe_5y_median, pe_5y_p75, pe_5y_samples,
          pe_5y_as_of, pfcf_5y_p25, pfcf_5y_median, pfcf_5y_p75,
          pfcf_5y_samples, pfcf_5y_as_of,
          revenue_per_share_ttm, book_value_per_share,
          ps_5y_p25, ps_5y_median, ps_5y_p75, ps_5y_samples, ps_5y_as_of,
          pb_5y_p25, pb_5y_median, pb_5y_p75, pb_5y_samples, pb_5y_as_of,
          market_checked_at, market_source, accounting_source, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          revenue_growth_ttm_yoy_pct=excluded.revenue_growth_ttm_yoy_pct,
          revenue_growth_3y_pct=excluded.revenue_growth_3y_pct,
          revenue_growth_5y_pct=excluded.revenue_growth_5y_pct,
          roe_ttm_pct=excluded.roe_ttm_pct,
          pe_5y_p25=excluded.pe_5y_p25,
          pe_5y_median=excluded.pe_5y_median,
          pe_5y_p75=excluded.pe_5y_p75,
          pe_5y_samples=excluded.pe_5y_samples,
          pe_5y_as_of=excluded.pe_5y_as_of,
          pfcf_5y_p25=excluded.pfcf_5y_p25,
          pfcf_5y_median=excluded.pfcf_5y_median,
          pfcf_5y_p75=excluded.pfcf_5y_p75,
          pfcf_5y_samples=excluded.pfcf_5y_samples,
          pfcf_5y_as_of=excluded.pfcf_5y_as_of,
          revenue_per_share_ttm=excluded.revenue_per_share_ttm,
          book_value_per_share=excluded.book_value_per_share,
          ps_5y_p25=excluded.ps_5y_p25,
          ps_5y_median=excluded.ps_5y_median,
          ps_5y_p75=excluded.ps_5y_p75,
          ps_5y_samples=excluded.ps_5y_samples,
          ps_5y_as_of=excluded.ps_5y_as_of,
          pb_5y_p25=excluded.pb_5y_p25,
          pb_5y_median=excluded.pb_5y_median,
          pb_5y_p75=excluded.pb_5y_p75,
          pb_5y_samples=excluded.pb_5y_samples,
          pb_5y_as_of=excluded.pb_5y_as_of,
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
