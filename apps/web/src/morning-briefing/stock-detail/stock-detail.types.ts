export type StockMarketState = "open" | "closed";

export interface StockPricePoint {
  time: string;
  close: number;
  open?: number;
  high?: number;
  low?: number;
}

export interface StockLinePoint {
  time: string;
  value: number;
}

export interface StockSupportLevel {
  level: 1 | 2 | 3 | 4;
  price: number;
}

export interface StockDetail {
  /** Data provenance; visual components never branch on this field. */
  source: "mock" | "api";
  symbol: string;
  companyName: string;
  exchange: string | null;
  sector: string | null;
  logoUrl: string | null;
  quote: {
    price: number;
    change: number;
    changePct: number;
    marketState: StockMarketState;
    asOf: string;
  };
  valuation: {
    intrinsicValue: number | null;
    upsidePct: number | null;
    scenarios: {
      bear: number | null;
      base: number | null;
      bull: number | null;
    };
    methods: {
      dcf: number | null;
      multiples: number | null;
      manual: number | null;
      selected: number | null;
      selectedMethod: string | null;
    };
  };
  technical: {
    sma200w: number | null;
    smaDistancePct: number | null;
    sma200wHistory: StockLinePoint[];
    supports: StockSupportLevel[];
  };
  metrics: {
    marketCap: string | null;
    peTtm: number | null;
    roicPct: number | null;
    fcfMarginPct: number | null;
    debtToEquity: number | null;
  };
  chart: {
    priceHistory: StockPricePoint[];
    intrinsicValueHistory?: StockLinePoint[];
  };
}

export interface StockDetailDataSource {
  getStockDetail(symbol: string): Promise<StockDetail | null>;
}
