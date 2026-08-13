"""Real market-context provider: index quotes + benchmark bars via yfinance.

Fetches the four public index cards (S&P 500, Nasdaq-100, Dow Jones, VIX)
plus the SPY/QQQ benchmark bars required by the healthy snapshot contract.
Network access is isolated here; the job layer decides *when* to run and the
worker schema decides *what* is accepted.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timezone
from math import isfinite
from typing import Any, Callable

from .models import IndexBar, MarketDataSnapshot, PriceBar, UniverseResult
from .provider import DataValidationError

# Public symbols (worker marketIndexSchema) -> Yahoo tickers.
INDEX_DEFINITIONS: tuple[tuple[str, str, str], ...] = (
    ("SPX", "S&P 500", "^GSPC"),
    ("NDX", "Nasdaq", "^NDX"),
    ("DJI", "Dow Jones", "^DJI"),
    ("VIX", "VIX", "^VIX"),
)

BENCHMARK_SYMBOLS: tuple[str, ...] = ("SPY", "QQQ")


@dataclass(frozen=True)
class IndexQuote:
    symbol: str
    name: str
    value: float
    change: float
    bar_date: date
    updated_at: str


class YfinanceMarketContextProvider:
    """Fetch index quotes and daily benchmark bars from Yahoo Finance.

    ``fetch_ohlcv`` is injectable so tests never touch the network.
    """

    name = "yfinance"

    def __init__(
        self,
        indices: tuple[tuple[str, str, str], ...] = INDEX_DEFINITIONS,
        benchmarks: tuple[str, ...] = BENCHMARK_SYMBOLS,
        fetch_ohlcv: Callable[[str], dict[str, Any]] | None = None,
    ) -> None:
        self.indices = indices
        self.benchmarks = benchmarks
        self._fetch_ohlcv = fetch_ohlcv or self._yfinance_ohlcv

    @staticmethod
    def _yfinance_ohlcv(ticker: str) -> dict[str, Any]:
        """Return the last two daily closes plus the latest OHLCV bar."""
        try:
            import yfinance as yf
        except ImportError as exc:  # pragma: no cover - environment guard
            raise DataValidationError("yfinance is not installed") from exc
        history = yf.Ticker(ticker).history(period="2d", interval="1d")
        if history is None or history.empty:
            raise DataValidationError(f"no price history for {ticker}")
        close = history["Close"].dropna()
        if close.empty:
            raise DataValidationError(f"no closing prices for {ticker}")
        last = float(close.iloc[-1])
        previous = float(close.iloc[-2]) if len(close) > 1 else last
        if not isfinite(last) or last <= 0 or not isfinite(previous) or previous <= 0:
            raise DataValidationError(f"invalid closing price for {ticker}")
        row = history.iloc[-1]
        bar_date = history.index[-1]
        if hasattr(bar_date, "date"):
            bar_date = bar_date.date()
        return {
            "date": bar_date.isoformat(),
            "open": float(row["Open"]),
            "high": float(row["High"]),
            "low": float(row["Low"]),
            "close": last,
            "adjusted_close": float(row["Adj Close"]) if "Adj Close" in history.columns else last,
            "volume": int(row["Volume"]),
            "change_pct": (last / previous - 1.0) * 100.0,
        }

    def _quote(self, symbol: str, name: str, ticker: str, collected_at: str) -> IndexQuote:
        data = self._fetch_ohlcv(ticker)
        value = float(data["close"])
        change = float(data["change_pct"])
        if not isfinite(change):
            raise DataValidationError(f"invalid change for {ticker}")
        bar_date = date.fromisoformat(str(data["date"]))
        return IndexQuote(
            symbol=symbol,
            name=name,
            value=value,
            change=change,
            bar_date=bar_date,
            updated_at=collected_at,
        )

    def build_snapshot(self, now: datetime | None = None) -> MarketDataSnapshot:
        """Build the MARKET_DATA_UPDATED snapshot; degraded if anything fails."""
        now = now or datetime.now(timezone.utc)
        collected_at = now.isoformat()
        warnings: list[str] = []
        indices: list[IndexBar] = []
        bars: list[PriceBar] = []

        for symbol, name, ticker in self.indices:
            try:
                quote = self._quote(symbol, name, ticker, collected_at)
                indices.append(IndexBar(
                    symbol=quote.symbol,
                    name=quote.name,
                    value=quote.value,
                    change=quote.change,
                    updated_at=quote.updated_at,
                ))
            except (DataValidationError, KeyError, TypeError, ValueError) as exc:
                warnings.append(f"{ticker}: {exc}")

        for symbol in self.benchmarks:
            try:
                data = self._fetch_ohlcv(symbol)
                bars.append(PriceBar(
                    symbol=symbol,
                    date=str(data["date"]),
                    open=float(data["open"]),
                    high=float(data["high"]),
                    low=float(data["low"]),
                    close=float(data["close"]),
                    adjusted_close=float(data["adjusted_close"]),
                    volume=int(data["volume"]),
                ))
            except (DataValidationError, KeyError, TypeError, ValueError) as exc:
                warnings.append(f"{symbol}: {exc}")

        all_ok = len(indices) == len(self.indices) and len(bars) == len(self.benchmarks) and not warnings
        status = "healthy" if all_ok else "degraded"
        if not all_ok and len(warnings) == 0:
            warnings.append("Market data is unavailable.")
        market_date = indices[0].updated_at[:10] if indices else now.date().isoformat()
        return MarketDataSnapshot(
            provider=self.name,
            status=status,
            as_of=market_date,
            last_successful_update=now.isoformat() if status == "healthy" else None,
            universe=UniverseResult(total=0, eligible=(), excluded_symbols=(), exclusions={}),
            benchmarks=tuple(bars),
            indices=tuple(indices),
            warnings=tuple(warnings),
            updated_at=now.isoformat(),
        )
