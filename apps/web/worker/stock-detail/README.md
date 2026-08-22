# Stock Detail read model

Stock Detail is a serving path, not a collection path:

```text
existing providers / manual inputs
        ↓
existing ingestors
        ↓
D1
        ↓
Worker stock-detail read model
        ↓
GET /api/stocks/:symbol/detail
        ↓
ApiStockDetailDataSource
        ↓
Stock Detail UI
```

Canonical persisted sources in v1:

- current quote: `latest_quotes` (Finnhub data persisted by the existing quote collector);
- company name/logo: active Core rows in `earnings_universe`;
- completed weekly OHLC/history: `weekly_prices` (Alpha Vantage data persisted by the history ingestor);
- current/live 200W SMA basis: `technical_metrics` plus the persisted current quote;
- manual supports: `stock_support_levels`;
- manual intrinsic value: `stock_intrinsic_values`;
- split safety/price scale: `split_events` and `weekly_prices.split_adjustment_factor`.

A page request never calls Finnhub, Alpha Vantage or another provider and never
uses the VPS. The VPS history ingestor remains asynchronous data collection
only. The browser never reads D1 directly.

Missing optional rows are represented as `null`/`[]`; storage failures are not
silently converted into missing data and produce the public 503 error contract.
No historical intrinsic-value series or fundamentals are fabricated in v1.
