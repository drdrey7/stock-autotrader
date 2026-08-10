# Research contract

This contract prevents the engine from quietly using future information to improve historical results.

## Fixed time partitions

| Stage | Period | Permitted use |
|---|---|---|
| Research | 2010-01-01 through 2024-12-31 | Baseline hypotheses and parameter selection |
| Validation | 2025-01-01 through 2025-12-31 | One-way validation; do not repeatedly tune against it |
| Final Out-of-Sample | 2026-01-01 through current date | Final evaluation only |
| Shadow | After a frozen version is registered | Forward simulated execution |
| Live | Not enabled in V5.1 | Future, separate approval |

2026 data **must not** be used to choose parameters. A strategy changed after seeing 2026 becomes a new version and returns to Research.

## Point-in-time rules

- A signal at the close can execute no earlier than the next tradable price. Daily baseline tests use the next session open.
- Universe membership must be known as of the tested date. Today's S&P 500/Nasdaq constituents cannot be applied backwards.
- Fundamentals, earnings, news and guidance use their actual public availability timestamp, not only the period or event date.
- Delisted and acquired securities remain in historical universes to reduce survivorship bias.
- Splits, dividends, symbol changes, mergers and spin-offs require point-in-time corporate-action handling.
- Adjusted series may be used for return continuity, but execution prices and volume must remain internally consistent.

## Execution model

Every result records one of three cost scenarios:

| Scenario | Commission/order | Spread | Slippage |
|---|---:|---:|---:|
| LOW_COST | $0 | 1 bp | 1 bp |
| NORMAL | $1 | 3 bp | 5 bp |
| STRESS | $2 | 8 bp | 15 bp |

These are explicit baseline assumptions, not claims about a future broker. If the next open gaps through a stop, execution uses the open plus the scenario's costs rather than the unavailable stop price.

## Required reporting

Report CAGR, total return, maximum drawdown, profit factor, expectancy, Sharpe, Sortino, Calmar, trades, win rate, average win/loss, exposure and average holding period. Compare Strategy, SPY and QQQ over identical dates and cost assumptions. Never combine Research, Validation, Out-of-Sample, Shadow or Live figures.

## Reproducibility

Persist strategy ID/version, immutable parameters, code version, data source, universe method, data-as-of timestamps, partition, cost scenario and benchmark series. A result without these fields is not publishable.

