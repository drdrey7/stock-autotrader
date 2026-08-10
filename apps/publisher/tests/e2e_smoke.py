"""End-to-end ingest smoke: publish events via the real publisher client against wrangler dev."""
import json
import sys
import urllib.error
import urllib.request

sys.path.insert(0, "/tmp/stock-at-review/apps/publisher")
from publisher import client

ENDPOINT = "http://127.0.0.1:8791/ingest/events"
SECRET = "test-secret-12345"

def post(body: bytes, secret: str | None = SECRET, ts: str | None = None) -> tuple[int, dict]:
    req = urllib.request.Request(ENDPOINT, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    if secret:
        req.add_header("X-Ingest-Signature", client.sign(secret, body))
    if ts:
        req.add_header("X-Ingest-Timestamp", ts)
    else:
        req.add_header("X-Ingest-Timestamp", __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat())
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def main():
    # 1) No signature -> 401
    status, body = post(json.dumps({"events": []}).encode(), secret=None)
    print(f"1. no auth: {status} (esperado 401)")

    # 2) Bad secret -> 401
    status, body = post(json.dumps({"events": []}).encode(), secret="wrong-secret")
    print(f"2. bad secret: {status} (esperado 401)")

    # 3) Invalid schema -> rejected in batch response (design: partial batch)
    status, body = post(json.dumps({"events": [{"type": "SCAN_COMPLETED", "event_id": "e-bad", "timestamp": "2026-08-10T00:00:00Z", "payload": {"nope": 1}}]}).encode())
    print(f"3. bad schema: {status} (esperado 200), body={body}")

    # 4) Valid SCAN_COMPLETED -> applied
    scan = client.make_event("SCAN_COMPLETED", {
        "scannedAt": "2026-08-10T21:00:00Z",
        "universe": 1600,
        "passedFilters": 900,
        "candidates": 2,
        "setups": 1,
        "watch": 1,
        "results": [
            {
                "symbol": "AAPL", "company": "Apple Inc.", "sector": "Technology", "marketCap": 3_200_000_000_000,
                "price": 245.1, "quantScore": 88, "strategyId": "trend_breakout_v1", "strategyVersion": "1.0.0",
                "strategy": "Trend Breakout", "trend": "Strong", "momentum": 12.3, "relativeStrength": 1.4,
                "relativeVolume": 1.8, "breakout": "50D breakout", "earningsDate": None, "earningsProximityDays": None,
                "status": "Strong Setup", "direction": "Long", "riskFlags": ["Earnings in window"], "updatedAt": "2026-08-10T21:00:00Z",
                "reasons": [{"code": "trend_alignment", "label": "Price above all EMAs", "outcome": "pass"}],
            },
            {
                "symbol": "MSFT", "company": "Microsoft Corp.", "sector": "Technology", "marketCap": 3_100_000_000_000,
                "price": 510.2, "quantScore": 72, "strategyId": "trend_breakout_v1", "strategyVersion": "1.0.0",
                "strategy": "Trend Breakout", "trend": "Positive", "momentum": 8.1, "relativeStrength": 1.1,
                "relativeVolume": 0.9, "breakout": None, "earningsDate": None, "earningsProximityDays": None,
                "status": "Watch", "direction": "Long", "riskFlags": [], "updatedAt": "2026-08-10T21:00:00Z",
                "reasons": [{"code": "volume_confirmation", "label": "Volume below confirmation threshold", "outcome": "info"}],
            },
        ],
    }, event_id="scan-e2e-0001")
    status, body = post(json.dumps({"events": [scan]}).encode())
    print(f"4. valid scan: {status} (esperado 200), body={body}")

    # 5) Same event_id again -> skipped (idempotent)
    status, body = post(json.dumps({"events": [scan]}).encode())
    print(f"5. duplicate: {status} (esperado 200), body={body}")

    # 6) SYSTEM_STATUS
    st = client.make_event("SYSTEM_STATUS", {"engine": "online", "nextScan": "2026-08-11T13:00:00Z", "lastDataUpdate": "2026-08-10T21:00:00Z", "apiHealth": "healthy"}, event_id="status-e2e-0001")
    status, body = post(json.dumps({"events": [st]}).encode())
    print(f"6. status: {status} (esperado 200), body={body}")


if __name__ == "__main__":
    main()
