"""Tests for the isolated stop latch; never interacts with MT5."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "v6_emergency_stop_latch.py"


def load():
    spec = importlib.util.spec_from_file_location("v6_stop_latch_offline", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class StopLatchOfflineTests(unittest.TestCase):
    def test_missing_corrupt_and_unapproved_false_are_all_blocking(self):
        m = load()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "stop.json"
            for state in (None, "{bad-json", '{"emergencyStopActive": false}', "[]"):
                if state is not None:
                    path.write_text(state, encoding="utf-8")
                result = m.read_emergency_stop_latch(path)
                self.assertTrue(result["emergencyStopActive"])
                self.assertTrue(result["blockNewOrders"])
                self.assertTrue(result["allowProtectivePositionManagement"])

    def test_latch_persists_across_module_reload_and_never_unlocks_itself(self):
        m = load()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "stop.json"
            state = m.persist_emergency_stop_latch(path, reason="TEST_OPERATOR_STOP", now_utc=1000)
            self.assertEqual(state["reason"], "TEST_OPERATOR_STOP")
            self.assertEqual(state["triggeredAtUtc"], 1000)
            after_restart = load().read_emergency_stop_latch(path)
            self.assertTrue(after_restart["blockNewOrders"])
            self.assertTrue(after_restart["allowProtectivePositionManagement"])
            self.assertFalse(hasattr(m, "clear_emergency_stop_latch_explicit"))
            self.assertFalse(hasattr(m, "order_send"))

    def test_failed_serialization_cannot_replace_existing_active_latch(self):
        m = load()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "stop.json"
            m.persist_emergency_stop_latch(path, reason="MUST_REMAIN_LATCHED")
            with self.assertRaises(TypeError):
                m._atomic_write_json(path, {"not_json": object()})
            state = m.read_emergency_stop_latch(path)
            self.assertEqual(state["reason"], "MUST_REMAIN_LATCHED")
            self.assertTrue(state["blockNewOrders"])
            self.assertEqual(list(Path(folder).glob("*.tmp")), [])

    def test_latch_only_carries_status_not_broker_capabilities(self):
        m = load()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "stop.json"
            record = m.persist_emergency_stop_latch(path)
            self.assertNotIn("liveArmed", record)
            self.assertNotIn("liveAuthorized", record)
            self.assertNotIn("brokerConnected", record)


if __name__ == "__main__":
    unittest.main()
