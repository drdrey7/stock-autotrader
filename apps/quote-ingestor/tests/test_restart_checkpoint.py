"""End-to-end restart regression for a failed close-window D1 write."""

from __future__ import annotations

import datetime as dt
import json
import tempfile
import unittest
from pathlib import Path

from quote_ingestor.app import Ingestor
from quote_ingestor.config import Settings
from quote_ingestor.d1 import D1WriteResult
from quote_ingestor.durable_state import CloseCandidateCheckpoint

SYMBOLS = ["AAPL", "MSFT"]
CLOSE_GRACE = dt.datetime(2026, 8, 18, 20, 3, tzinfo=dt.UTC)
NEXT_OPEN = dt.datetime(2026, 8, 19, 14, 0, tzinfo=dt.UTC)
CLOSE_TICK_MS = int(dt.datetime(2026, 8, 18, 19, 59, 59, tzinfo=dt.UTC).timestamp() * 1000)
NEXT_TICK_MS = int(dt.datetime(2026, 8, 19, 13, 59, 30, tzinfo=dt.UTC).timestamp() * 1000)


def settings() -> Settings:
    return Settings(
        finnhub_api_key="k",
        cloudflare_api_token="t",
        cloudflare_account_id="a",
        cloudflare_d1_database_id="d",
    )


def trade_raw(symbol: str, price: float, timestamp_ms: int) -> str:
    return json.dumps({"type": "trade", "data": [{"s": symbol, "p": price, "t": timestamp_ms, "v": 1}]})


class FakeD1:
    def __init__(self, fail: bool) -> None:
        self.fail = fail
        self.calls: list[list[tuple[str, float, int]]] = []
        self.health_writes: list[dict] = []

    def upsert_quotes(self, rows):
        rows = list(rows)
        self.calls.append(rows)
        symbols = list(dict.fromkeys(symbol for symbol, _, _ in rows))
        if self.fail:
            return D1WriteResult(written=[], failed=symbols, http_status=503, error="HTTP 503")
        return D1WriteResult(written=symbols, failed=[], http_status=200, total_changes=len(symbols))

    def write_health(self, record: dict) -> bool:
        self.health_writes.append(record)
        return True

    def read_latest_quotes_count(self) -> dict:
        return {"total": 0, "rows": []}


class RestartCheckpointTest(unittest.TestCase):
    def test_failed_close_candidate_survives_process_restart_and_is_replayed_first(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            path = Path(tempdir) / "pending-close-candidates.json"

            # Process A observes a valid final-window tick. Intake itself makes
            # the first candidate durable locally before the 60-second D1 flush.
            first_checkpoint = CloseCandidateCheckpoint(path, SYMBOLS)
            failing_d1 = FakeD1(fail=True)
            first = Ingestor(
                settings(),
                SYMBOLS,
                failing_d1,  # type: ignore[arg-type]
                clock=lambda: CLOSE_GRACE,
                close_checkpoint=first_checkpoint,
            )
            first.on_message(trade_raw("AAPL", 100.0, CLOSE_TICK_MS))
            self.assertEqual(len(first_checkpoint.restore()), 1)

            first.flush_once(CLOSE_GRACE)
            self.assertEqual(len(failing_d1.calls), 1)
            self.assertEqual(first_checkpoint.restore()[0].timestamp_ms, CLOSE_TICK_MS)

            # Simulate crash/redeploy: all RAM state is discarded. Process B
            # reconstructs QuoteStateStore solely from the systemd checkpoint.
            restarted_checkpoint = CloseCandidateCheckpoint(path, SYMBOLS)
            healthy_d1 = FakeD1(fail=False)
            second = Ingestor(
                settings(),
                SYMBOLS,
                healthy_d1,  # type: ignore[arg-type]
                clock=lambda: NEXT_OPEN,
                close_checkpoint=restarted_checkpoint,
            )
            restored = second.store.pending_changed()
            self.assertEqual([(tick.symbol, tick.timestamp_ms) for tick in restored], [("AAPL", CLOSE_TICK_MS)])

            # The first current-session tick must not overwrite the recovered
            # close evidence: both rows are submitted, candidate first.
            second.on_message(trade_raw("AAPL", 102.0, NEXT_TICK_MS))
            second.flush_once(NEXT_OPEN)
            self.assertEqual(len(healthy_d1.calls), 1)
            self.assertEqual(
                [(symbol, timestamp_ms) for symbol, _, timestamp_ms in healthy_d1.calls[0]],
                [("AAPL", CLOSE_TICK_MS), ("AAPL", NEXT_TICK_MS)],
            )

            # Only after D1 confirms the latest submitted AAPL row do both the
            # in-memory pending state and local crash checkpoint clear.
            self.assertEqual(second.store.pending_changed(), [])
            self.assertEqual(restarted_checkpoint.restore(), [])


if __name__ == "__main__":
    unittest.main()
