"""Tests for the provider lock — bootstrap and maintenance must never run simultaneously."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from history_ingestor.lock import PROVIDER_LOCK_PATH, provider_lock


class ProviderLockTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self._path = Path(self._tmp.name) / "provider.lock"
        self._patcher = patch(
            "history_ingestor.lock.PROVIDER_LOCK_PATH", self._path
        )
        self._patcher.start()
        self.addCleanup(self._patcher.stop)

    def test_lock_file_created(self):
        with provider_lock():
            self.assertTrue(self._path.exists())
        self.assertEqual(self._path.stat().st_mode & 0o777, 0o600)

    def test_lock_released_after_exit(self):
        with provider_lock():
            self.assertTrue(self._path.exists())
        # After the with-block closes, the lock must be free.
        fd = os.open(str(self._path), os.O_RDONLY)
        try:
            import fcntl

            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)

    def test_lock_released_after_exception(self):
        try:
            with provider_lock():
                raise RuntimeError("boom")
        except RuntimeError:
            pass
        fd = os.open(str(self._path), os.O_RDONLY)
        try:
            import fcntl

            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(fd, fcntl.LOCK_UN)
        finally:
            os.close(fd)

    def test_default_lock_path(self):
        # The default path must be the shared production lock path.
        self.assertEqual(str(PROVIDER_LOCK_PATH), "/var/lib/history-ingestor/provider.lock")

    def test_due_split_uses_same_lock(self):
        # due-split must use the same lock as bootstrap/maintenance.
        import inspect

        from history_ingestor.cli import cmd_apply_due_splits

        src = inspect.getsource(cmd_apply_due_splits)
        self.assertIn("provider_lock()", src)
