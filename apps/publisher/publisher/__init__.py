"""Stock Autotrader publisher (VPS -> Cloudflare ingest).

``client`` — signed HMAC publication (PR #3).
``pipeline`` — Daily Briefing composition (PR #8): X ingestion, membership
gate, market snapshot, Potential Entry gate, dry-run and publication.
"""
from __future__ import annotations

__version__ = "5.1.0"
