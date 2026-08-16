/**
 * TradingView widget configuration for the public homepage (PR #48).
 *
 * Every symbol below was verified to render real values against the official
 * TradingView web-component datafeed on 2026-08-16 (see `scripts/tv-probe.mjs`
 * and its output in `scripts/.tv-probe/`). TradingView owns the market-data
 * display layer — these configs are the only market data the homepage
 * requests, and none of it travels through our backend.
 *
 * Symbol provenance (the WC datafeed does not serve every exchange feed):
 *  - FOREXCOM:SPXUSD / FOREXCOM:NSXUSD / FOREXCOM:DJI are the official widget
 *    example feeds (S&P 500, Nasdaq-100, Dow) and render on the shared feed.
 *  - US-listed futures (CME_MINI:ES1!, CME_MINI:NQ1!, COMEX:GC1!,
 *    NYMEX:CL1!) and the CBOE:/TVC: VIX feeds are NOT served — they render
 *    blank rows / "No data here yet" — so the homepage uses the feeds that
 *    demonstrably render instead:
 *      VIX          → bare "VIX" (Volatility Index)
 *      WTI crude    → "USOIL" (WTI Crude Oil)
 *      Gold         → "CMCMARKETS:GOLD"
 *      Silver       → "XAGUSD"
 *      US Treasuries → "US10Y" (US 10-year Government Bond)
 *      European bond → "EUREX:FGBL1!" (Euro-Bund Futures)
 */

/** Global ticker tape: headline indices + the commodities/crypto the products key on. */
export const TICKER_SYMBOLS: readonly string[] = [
  "FOREXCOM:SPXUSD", // S&P 500 (official example)
  "FOREXCOM:NSXUSD", // Nasdaq-100 (official example)
  "FOREXCOM:DJI", // Dow Jones (official example)
  "VIX", // Volatility Index (bare — CBOE:/TVC: feeds are not served)
  "CMCMARKETS:GOLD", // Gold (official example)
  "BITSTAMP:BTCUSD", // Bitcoin (official example)
  "BITSTAMP:ETHUSD", // Ether (official example)
  "COINBASE:SOLUSD", // Solana
  "FX:EURUSD", // EUR/USD (official example)
];

export interface TradingViewMarketSection {
  sectionName: string;
  symbols: string[];
}

/**
 * Market Overview sections. The widget renders one section's rows at a time
 * behind its own tab selector. Section names are kept deliberately short so
 * the tab strip fits at mobile widths.
 */
export const MARKET_OVERVIEW_SECTIONS: readonly TradingViewMarketSection[] = [
  { sectionName: "Indices", symbols: ["FOREXCOM:SPXUSD", "FOREXCOM:NSXUSD", "FOREXCOM:DJI", "VIX"] },
  // "Commodities" carries the proxies for the futures block the spec asked
  // for: S&P/Nasdaq futures are not served by the WC feed, so this section
  // shows Gold, WTI and Silver on feeds that render real values.
  { sectionName: "Commodities", symbols: ["CMCMARKETS:GOLD", "USOIL", "XAGUSD"] },
  { sectionName: "Bonds", symbols: ["US10Y", "EUREX:FGBL1!"] },
  { sectionName: "Crypto", symbols: ["BITSTAMP:BTCUSD", "BITSTAMP:ETHUSD", "COINBASE:SOLUSD"] },
];

export const MARKET_OVERVIEW_PROPS = {
  mode: "custom",
  timeFrame: "12M",
} as const;

/** Official embed scripts for the two iframe widgets (s3.tradingview.com). */
export interface TradingViewIframeConfig {
  /** Embed script filename under https://s3.tradingview.com/external-embedding/. */
  script: string;
  /** Widget height in px (the widget's iframe height). */
  height: number;
  /**
   * Non-theme config. `colorTheme`, `width`, `height` and `container_id` are
   * applied by the component so the widget always matches the app theme.
   */
  config: Record<string, unknown>;
}

/** Macro economic calendar (unrelated to the product's earnings calendar). */
export const ECONOMIC_CALENDAR_CONFIG: TradingViewIframeConfig = {
  script: "embed-widget-events.js",
  height: 600,
  config: {
    locale: "en",
    // The official widget expects lowercase country ids and the -1..1
    // importance scale; `currencyFilter` is not supported by this widget.
    countryFilter: "us,eu,gb",
    importanceFilter: "-1,0,1",
    isTransparent: false,
  },
};

/** Market news feed covering all tracked symbols (no market-scoped filter). */
export const TOP_STORIES_CONFIG: TradingViewIframeConfig = {
  script: "embed-widget-timeline.js",
  height: 600,
  config: {
    locale: "en",
    feedMode: "all_symbols",
    displayMode: "regular",
    isTransparent: false,
  },
};
