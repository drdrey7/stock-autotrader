"""Regression proof for PR #3 blockers B1 (EARNINGS upsert) and B2 (SIGNAL reasons)."""
import json
import sys
import urllib.request

sys.path.insert(0, "/tmp/stock-at-review/apps/publisher")
from publisher import client

ENDPOINT = "http://127.0.0.1:8792/ingest/events"
SECRET = "test-secret-12345"

def post(events):
    body = json.dumps({"events": events}).encode()
    req = urllib.request.Request(ENDPOINT, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    timestamp = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()
    req.add_header("X-Ingest-Signature", client.sign(SECRET, body, timestamp))
    req.add_header("X-Ingest-Timestamp", timestamp)
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())

# B1: EARNINGS_UPDATED twice for same (symbol, date) -> must upsert, not duplicate.
earn = lambda eid: client.make_event("EARNINGS_UPDATED", {"items": [{
    "symbol": "AAPL", "company": "Apple Inc.", "date": "2026-08-12", "timing": "AMC",
    "eventSignal": "Confirmed", "engineRelevant": True, "signal": "Rejected",
    "strategy": "Trend Breakout", "hasPosition": False, "tracked": True,
    "updatedAt": "2026-08-10T23:00:00Z",
}]}, event_id=eid)
print("B1 run 1:", post([earn("earn-b1-1")]))
print("B1 run 2 (dup symbol+date):", post([earn("earn-b1-2")]))

# B2: SIGNAL with reasons -> reasons must land in decision_reasons.
sig = client.make_event("SIGNAL_SURFACED", {
    "symbol": "CRM", "company": "Salesforce, Inc.", "sector": "Technology", "marketCap": 300_000_000_000,
    "price": 310.5, "quantScore": 81, "strategyId": "trend_breakout_v1", "strategyVersion": "1.0.0",
    "strategy": "Trend Breakout", "trend": "Strong", "momentum": 9.5, "relativeStrength": 1.3,
    "relativeVolume": 1.2, "breakout": "20D breakout", "status": "Strong Setup", "direction": "Long",
    "riskFlags": [], "updatedAt": "2026-08-10T23:05:00Z",
    "reasons": [
        {"code": "trend_alignment", "label": "Price above all EMAs", "outcome": "pass"},
        {"code": "volume_confirmation", "label": "Volume confirms breakout", "outcome": "pass"},
    ],
}, event_id="sig-b2-1")
print("B2 run:", post([sig]))
