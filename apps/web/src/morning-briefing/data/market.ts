import type { DataSource } from "./source";

export type MarketIndex = {
  name: string; symbol: string; value: number; decimals: number; change: number; source?: DataSource;
};

export const marketIndexes: MarketIndex[] = [
  { name: "S&P 500", symbol: "SPX", value: 6427.18, decimals: 2, change: 0.62 },
  { name: "Nasdaq", symbol: "NDX", value: 23724.31, decimals: 2, change: 0.78 },
  { name: "Dow Jones", symbol: "DJI", value: 45118.26, decimals: 2, change: 0.48 },
  { name: "VIX", symbol: "VIX", value: 15.41, decimals: 2, change: -1.26 },
];

export const quickStats = [
  { label: "10Y Treasury Yield", short: "10Y Yield", value: "4.28%", change: -0.03 },
  { label: "WTI Crude Oil", short: "WTI Oil", value: "$80.21", change: 0.44 },
  { label: "Gold (Spot)", short: "Gold", value: "$2,347.60", change: 0.28 },
  { label: "Bitcoin (BTC)", short: "BTC", value: "$63,842", change: 1.86 },
];

export const chartPoints = "0,83 22,81 44,78 66,79 88,72 110,74 132,64 154,66 176,58 198,60 220,52 242,55 264,43 286,47 308,35 330,40 352,30 374,34 396,18 418,24 440,13 462,18 484,12 506,17 528,9 550,13 572,4 600,7";
