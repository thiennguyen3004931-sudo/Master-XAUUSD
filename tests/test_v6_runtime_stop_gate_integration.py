"""Offline integration tests for runtime Emergency Stop latch enforcement in mt5-direct-probe.py (#7)."""
import importlib.util
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _load_probe_module():
    probe_path = ROOT / "scripts" / "mt5-direct-probe.py"
    spec = importlib.util.spec_from_file_location("mt5_direct_probe_under_test", probe_path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(mod)
    return mod


class RuntimeEmergencyStopGateIntegrationTests(unittest.TestCase):
    def test_runtime_latch_helper_blocks_active_corrupt_mismatched_and_required_missing_latch(self):
        probe = _load_probe_module()
        with tempfile.TemporaryDirectory() as folder:
            latch_file = Path(folder) / "v6-emergency-stop-latch.json"
            with patch.object(probe, "EMERGENCY_STOP_LATCH_FILE", latch_file):
                latch_file.write_text(
                    json.dumps({
                        "schemaVersion": 1,
                        "accountLogin": 1001,
                        "server": "Broker-Demo",
                        "emergencyStopActive": True,
                        "blockNewOrders": True,
                        "stopCategory": "OPERATOR_STOP",
                        "reason": "OPERATOR_EMERGENCY_STOP",
                        "stopRevision": "rev-1",
                    }),
                    encoding="utf-8",
                )
                blocked = probe._check_runtime_emergency_stop_latch(1001, "Broker-Demo")
                self.assertIsNotNone(blocked)
                self.assertTrue(blocked["blockNewOrders"])

                latch_file.write_text("{corrupt-json", encoding="utf-8")
                blocked_corrupt = probe._check_runtime_emergency_stop_latch(1001, "Broker-Demo")
                self.assertIsNotNone(blocked_corrupt)
                self.assertTrue(blocked_corrupt["blockNewOrders"])

                latch_file.unlink()
                with patch.dict(os.environ, {"ZIQ_V6_REQUIRE_EMERGENCY_STOP_LATCH": "1"}):
                    blocked_missing = probe._check_runtime_emergency_stop_latch(1001, "Broker-Demo")
                    self.assertIsNotNone(blocked_missing)
                    self.assertTrue(blocked_missing["blockNewOrders"])

                latch_file.write_text(
                    json.dumps({
                        "schemaVersion": 1,
                        "accountLogin": 1001,
                        "server": "Broker-Demo",
                        "emergencyStopActive": False,
                        "blockNewOrders": False,
                        "stopCategory": "NONE",
                        "reason": "RELEASED",
                        "stopRevision": "rev-2",
                    }),
                    encoding="utf-8",
                )
                allowed = probe._check_runtime_emergency_stop_latch(1001, "Broker-Demo")
                self.assertIsNone(allowed)

    def test_protective_actions_in_probe_do_not_require_new_order_latch(self):
        probe = _load_probe_module()
        called = []

        class _MockMt5:
            TRADE_ACTION_SLTP = 6
            TRADE_ACTION_DEAL = 1

            @staticmethod
            def positions_get(ticket=None):
                return [SimpleNamespace(
                    ticket=ticket or 99,
                    symbol="XAUUSD",
                    type=0,
                    volume=0.01,
                    price_open=2600.0,
                    sl=2590.0,
                    tp=2620.0,
                    magic=270715,
                )]

            @staticmethod
            def symbol_info_tick(_sym):
                return SimpleNamespace(bid=2605.0, ask=2605.5)

            @staticmethod
            def symbol_info(_sym):
                return SimpleNamespace(digits=2, point=0.01, trade_stops_level=0, filling_mode=2)

            @staticmethod
            def order_send(req):
                called.append(req)
                return SimpleNamespace(retcode=10009, comment="Done")

        with tempfile.TemporaryDirectory() as folder:
            latch_file = Path(folder) / "v6-emergency-stop-latch.json"
            latch_file.write_text(
                json.dumps({
                    "schemaVersion": 1,
                    "accountLogin": 1001,
                    "server": "Broker-Demo",
                    "emergencyStopActive": True,
                    "blockNewOrders": True,
                    "stopCategory": "OPERATOR_STOP",
                    "reason": "OPERATOR_EMERGENCY_STOP",
                    "stopRevision": "rev-1",
                }),
                encoding="utf-8",
            )
            with patch.object(probe, "EMERGENCY_STOP_LATCH_FILE", latch_file):
                res = probe.modify_position_sl_tp(_MockMt5(), 99, sl=2595.0, tp=2625.0)
                self.assertTrue(res.get("ok"))
                self.assertEqual(len(called), 1)


if __name__ == "__main__":
    unittest.main()
