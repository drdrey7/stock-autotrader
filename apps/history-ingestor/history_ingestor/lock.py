"""Shared provider lock — bootstrap and maintenance must never run simultaneously.

Both services draw from the SAME per-key daily Alpha Vantage quota and share
the bootstrap checkpoint as the quota ledger. Without serialization, a
persistent-timer catch-up could activate both services after an outage and
they would race: each loads the remaining budget, each spends it, and the
quota is overspent.

The fix is a single exclusive file lock. It is:

* blocking — the second caller waits for the first (no non-blocking failure);
* auto-released by the OS when the holder exits or crashes (no stale lock);
* stored under the writable StateDirectory (so it works with ProtectHome=read-only);
* local only — no Redis / D1 / Cloudflare dependency.
"""

from __future__ import annotations

import fcntl
import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

PROVIDER_LOCK_PATH = Path(
    os.environ.get(
        "HISTORY_INGESTOR_LOCK_PATH",
        "/var/lib/history-ingestor/provider.lock",
    )
)


@contextmanager
def provider_lock() -> Iterator[None]:
    """Exclusive, blocking lock around provider work.

    Usage::

        with provider_lock():
            ...  # provider calls + quota ledger mutations

    The lock is held for the duration of the block. If the holder exits
    normally or crashes, the OS releases the lock automatically.
    """
    path = PROVIDER_LOCK_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(path), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)
