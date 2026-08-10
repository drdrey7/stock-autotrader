export const openApiDocument = {
  openapi: "3.1.0",
  info: { title: "Stock Autotrader Public API", version: "5.1.0", description: "Read-only public observability API. No trading or administration endpoints." },
  servers: [{ url: "/", description: "Current Worker" }],
  paths: Object.fromEntries([
    ["/api/status", "Safe public engine and API health"], ["/api/dashboard", "Aggregated dashboard snapshot"], ["/api/scans/latest", "Latest scan summary"], ["/api/scans/{id}", "Scan detail"], ["/api/candidates", "Latest candidates"], ["/api/stocks/{symbol}", "Public stock snapshot"], ["/api/stocks/{symbol}/analysis", "Structured stock analysis"], ["/api/strategies", "Strategy registry"], ["/api/strategies/{id}", "Strategy metadata"], ["/api/research", "Research results"], ["/api/backtests", "Backtest results"], ["/api/portfolio/shadow", "Simulated portfolio"], ["/api/trades/shadow", "Simulated trades"], ["/api/earnings", "Tracked earnings events"], ["/api/activity", "Public engine events"]
  ].map(([path, summary]) => [path, { get: { summary, responses: { "200": { description: "Successful read" }, "400": { description: "Invalid input" }, "404": { description: "Not found" }, "429": { description: "Rate limited" } } } }])),
  components: { securitySchemes: {} }
} as const;

