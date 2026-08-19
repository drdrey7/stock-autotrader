"""History ingestor — Alpha Vantage weekly history + split-only adjustment.

Bootstrap/resume tooling for the Stock Autotrader Screener SMA200W basis.
Companion to apps/quote-ingestor (live quotes); this app owns the HISTORICAL
weekly layer only. Zero runtime dependencies (stdlib + zoneinfo).
"""

__version__ = "1.0.0"
