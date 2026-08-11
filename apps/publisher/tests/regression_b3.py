"""Regression proof for B3 (reasons cross-contamination) and EARNINGS full update."""
import json
import sys
import urllib.request

sys.path.insert(0, "/tmp/stock-at-review/apps/publisher")
from publisher import client

ENDPOINT = "http://127.0.0.1:8794/ingest/events"
SECRET = "test-secret-12345"

def post(events):
    body = json.dumps({"events": events}).encode()
    req = urllib.request.Request(ENDPOINT, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Ingest-Signature", client.sign(SECRET, body))
    req.add_header("X-Ingest-Timestamp", __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat())
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())

def cand(symbol, strategy_id, strategy, status, reasons):
    return {
        "symbol": symbol, "company": f"{symbol} Corp", "sector": "Technology", "marketCap": 100_000_000_000,
        "price": 100.0, "quantScore": 80, "strategyId": strategy_id, "strategyVersion": "1.0.0",
        "strategy": strategy, "trend": "Strong", "momentum": 5.0, "relativeStrength": 1.1,
        "relativeVolume": 1.0, "breakout": None, "status": status, "direction": "Long",
        "riskFlags": [], "updatedAt": "2026-08-11T00:00:00Z", "reasons": reasons,
    }

# B3: same symbol in TWO strategies within one scan -> reasons must NOT leak.
scan = client.make_event("SCAN_COMPLETED", {
    "scannedAt": "2026-08-11T00:00:00Z", "universe": 1600, "passedFilters": 900,
    "candidates": 2, "setups": 2, "watch": 0,
    "results": [
        cand("DUPSYM", "strat_a", "Strategy A", "Strong Setup", [{"code": "ra", "label": "Reason A", "outcome": "pass"}]),
        cand("DUPSYM", "strat_b", "Strategy B", "Watch", [{"code": "rb", "label": "Reason B", "outcome": "info"}]),
    ],
}, event_id="scan-b3-0001")
print("B3 scan:", post([scan]))

# EARNINGS full update: NFLX timing TBD -> AMC must land.
earn = client.make_event("EARNINGS_UPDATED", {"items": [{
    "symbol": "NFLX", "company": "Netflix, Inc.", "date": "2026-08-13", "timing": "AMC",
    "eventSignal": "Confirmed", "engineRelevant": True, "signal": "Strong Setup",
    "strategy": "Trend Breakout", "hasPosition": True, "tracked": True,
    "updatedAt": "2026-08-11T00:00:00Z",
}]}, event_id="earn-b3-0001")
print("B3 earnings:", post([earn]))
