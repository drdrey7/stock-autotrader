"""Account registry tests (unittest — CI-compatible)."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from publisher.accounts import Account, AccountRegistry, load_accounts


class AccountRegistryTests(unittest.TestCase):
    def _write(self, payload: dict) -> Path:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "accounts.json"
        path.write_text(json.dumps(payload))
        return path

    def test_load_registry(self) -> None:
        registry = load_accounts(
            self._write(
                {
                    "version": 1,
                    "accounts": [{"handle": "@nolimitgains", "active": True}],
                }
            )
        )
        self.assertEqual(registry.version, 1)
        self.assertEqual(registry.active_handles, ("@nolimitgains",))
        self.assertTrue(registry.is_active("@nolimitgains"))
        self.assertFalse(registry.is_active("@someone-else"))

    def test_inactive_account_excluded(self) -> None:
        registry = load_accounts(
            self._write(
                {
                    "version": 1,
                    "accounts": [{"handle": "@nolimitgains", "active": False}],
                }
            )
        )
        self.assertEqual(registry.active_handles, ())

    def test_missing_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(FileNotFoundError):
                load_accounts(Path(tmp) / "missing.json")

    def test_handle_must_start_with_at(self) -> None:
        with self.assertRaises(ValueError):
            Account(handle="nolimitgains", active=True)

    def test_duplicate_handles_rejected(self) -> None:
        with self.assertRaises(ValueError):
            load_accounts(
                self._write(
                    {
                        "version": 1,
                        "accounts": [
                            {"handle": "@a", "active": True},
                            {"handle": "@a", "active": True},
                        ],
                    }
                )
            )

    def test_empty_registry_rejected(self) -> None:
        with self.assertRaises(ValueError):
            load_accounts(self._write({"version": 1, "accounts": []}))

    def test_registry_requires_bool_active(self) -> None:
        with self.assertRaises(ValueError):
            load_accounts(
                self._write({"version": 1, "accounts": [{"handle": "@a", "active": "yes"}]})
            )


if __name__ == "__main__":
    unittest.main()
