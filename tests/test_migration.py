import sqlite3
from pathlib import Path

import pytest


def test_d1_migration_is_valid_sql() -> None:
    migration = Path("database/migrations/0001_initial.sql").read_text()
    connection = sqlite3.connect(":memory:")
    connection.executescript(migration)
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {
        "stocks",
        "strategies",
        "scans",
        "scan_candidates",
        "signals",
        "analyses",
        "decision_reasons",
        "earnings",
        "news_events",
        "shadow_portfolios",
        "shadow_positions",
        "shadow_trades",
        "backtests",
        "bot_events",
    }.issubset(tables)

    connection.execute(
        "INSERT INTO stocks(symbol,company,exchange,data_source) VALUES ('NVDA','NVIDIA','NASDAQ','fixture')"
    )
    earnings = (
        "event-1",
        "NVDA",
        "2026-08-20",
        "fixture",
    )
    connection.execute("INSERT INTO earnings(id,symbol,event_date,data_source) VALUES (?,?,?,?)", earnings)
    with pytest.raises(sqlite3.IntegrityError):
        connection.execute(
            "INSERT INTO earnings(id,symbol,event_date,data_source) VALUES (?,?,?,?)",
            ("event-2", "NVDA", "2026-08-20", "fixture"),
        )
