import type { TradingViewWidgetSettings } from "./TradingViewWidget";

/**
 * TradingView widget configurations for the public homepage.
 *
 * Every symbol was verified against TradingView's symbol pages before being
 * committed. TradingView owns the market-data display layer — these configs
 * are the only market data the homepage requests, and none of it travels
 * through our backend.
 */

/** Compact strip under the shell header: headline indices + the futures/crypto the products key on. */
export const TICKER_TAPE_WIDGET: TradingViewWidgetSettings = {
  symbols: [
    { proName: "SP:SPX", title: "S&P 500" },
    { proName: "NASDAQ:NDX", title: "Nasdaq-100" },
    { proName: "TVC:DJI", title: "Dow Jones" },
    { proName: "CBOE:VIX", title: "VIX" },
    { proName: "CME_MINI:ES1!", title: "S&P 500 Futures" },
    { proName: "CME_MINI:NQ1!", title: "Nasdaq 100 Futures" },
    { proName: "COMEX:GC1!", title: "Gold" },
    { proName: "NYMEX:CL1!", title: "WTI Crude Oil" },
    { proName: "BITSTAMP:BTCUSD", title: "Bitcoin" },
  ],
  showSymbolLogo: true,
  isTransparent: false,
  displayMode: "adaptive",
  locale: "en",
};

/** Tabbed market overview: restrained symbol lists per asset class. */
export const MARKET_OVERVIEW_WIDGET: TradingViewWidgetSettings = {
  tabs: [
    {
      title: "Indices",
      originalTitle: "Indices",
      symbols: [{ s: "SP:SPX" }, { s: "NASDAQ:NDX" }, { s: "TVC:DJI" }, { s: "CBOE:VIX" }],
    },
    {
      title: "Futures",
      originalTitle: "Futures",
      symbols: [
        { s: "CME_MINI:ES1!" },
        { s: "CME_MINI:NQ1!" },
        { s: "COMEX:GC1!" },
        { s: "NYMEX:CL1!" },
        { s: "NYMEX:NG1!" },
      ],
    },
    {
      title: "Bonds",
      originalTitle: "Bonds",
      symbols: [{ s: "CBOT:ZN1!" }, { s: "CBOT:ZB1!" }, { s: "CBOT:ZF1!" }, { s: "CBOT:ZT1!" }, { s: "EUREX:FGBL1!" }],
    },
    {
      title: "Crypto",
      originalTitle: "Crypto",
      symbols: [
        { s: "BITSTAMP:BTCUSD" },
        { s: "BITSTAMP:ETHUSD" },
        { s: "BITSTAMP:XRPUSD" },
        { s: "COINBASE:SOLUSD" },
      ],
    },
  ],
  showSymbolLogo: true,
  isTransparent: false,
  locale: "en",
  width: "100%",
  height: 520,
  dateRange: "12M",
};

/** Macro economic calendar (replaces economic-event information; not the earnings calendar). */
export const ECONOMIC_CALENDAR_WIDGET: TradingViewWidgetSettings = {
  width: "100%",
  height: 600,
  locale: "en",
  importanceFilter: "0,1,2",
  countryFilter: "US,EU,GB",
  currencyFilter: "USD,EUR,GBP",
  isTransparent: false,
};

/** Market news feed. */
export const TOP_STORIES_WIDGET: TradingViewWidgetSettings = {
  width: "100%",
  height: 600,
  market: "stock",
  displayMode: "regular",
  locale: "en",
  isTransparent: false,
};
