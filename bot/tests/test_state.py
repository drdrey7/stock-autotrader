import tempfile
import unittest
from pathlib import Path

from bot.state import StateStore


class StateStoreTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.store = StateStore(Path(self._tmp.name) / "state.db")

    def tearDown(self):
        self.store.close()
        self._tmp.cleanup()

    def test_record_and_recent_events(self):
        self.store.record_event("INFO", "test", "hello")
        events = self.store.recent_events(10)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["source"], "test")
        self.assertEqual(events[0]["message"], "hello")

    def test_job_lifecycle(self):
        run_id = self.store.start_job("health_check")
        self.store.finish_job(run_id, "ok")
        last = self.store.last_job_status("health_check")
        self.assertIsNotNone(last)
        assert last is not None
        self.assertEqual(last["status"], "ok")
        self.assertIsNotNone(last["finished_at"])

    def test_schema_created(self):
        tables = self.store._conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('runtime_events','job_runs')"
        ).fetchall()
        self.assertEqual(len(tables), 2)


if __name__ == "__main__":
    unittest.main()
