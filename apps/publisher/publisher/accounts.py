"""Versioned account registry for X sources.

The registry lives in ``data/accounts.v1.json`` and is the only place that
decides which X accounts are allowed as briefing sources. Unknown handles fail
closed at ingestion time.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

HANDLE_RE_PREFIX = "@"


@dataclass(frozen=True)
class Account:
    handle: str
    active: bool

    def __post_init__(self) -> None:
        if not self.handle.startswith(HANDLE_RE_PREFIX) or len(self.handle) < 2:
            raise ValueError(f"account handle must start with '@': {self.handle!r}")


@dataclass(frozen=True)
class AccountRegistry:
    version: int
    accounts: tuple[Account, ...]

    @property
    def active_handles(self) -> tuple[str, ...]:
        return tuple(account.handle for account in self.accounts if account.active)

    def is_active(self, handle: str) -> bool:
        return handle in self.active_handles


def load_accounts(path: str | Path) -> AccountRegistry:
    """Load and validate the versioned account registry."""
    registry_path = Path(path)
    if not registry_path.is_file():
        raise FileNotFoundError(f"account registry not found: {registry_path}")
    with registry_path.open(encoding="utf-8") as handle:
        payload = json.load(handle)

    version = payload.get("version")
    if not isinstance(version, int) or version < 1:
        raise ValueError("account registry must declare a positive integer version")

    raw_accounts = payload.get("accounts")
    if not isinstance(raw_accounts, list):
        raise ValueError("account registry 'accounts' must be a list")

    accounts: list[Account] = []
    for raw in raw_accounts:
        if not isinstance(raw, dict):
            raise ValueError("each account entry must be an object")
        handle = raw.get("handle")
        active = raw.get("active")
        if not isinstance(handle, str) or not isinstance(active, bool):
            raise ValueError("account entry requires string 'handle' and boolean 'active'")
        accounts.append(Account(handle=handle, active=active))

    if not accounts:
        raise ValueError("account registry must contain at least one account")

    handles = [account.handle for account in accounts]
    if len(set(handles)) != len(handles):
        raise ValueError("account registry contains duplicate handles")

    return AccountRegistry(version=version, accounts=tuple(accounts))
