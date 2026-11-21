"""Offline integration tests for runtime Emergency Stop latch enforcement in mt5-direct-probe.py (#7)."""
import ast
import importlib.util
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

from scripts.v6_emergency_stop_gate import (
    authorize_emergency_stop_release,
    persist_operator_emergency_stop,
)


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
                stop_state = persist_operator_emergency_stop(
                    latch_file,
                    account_login=1001,
                    server="Broker-Demo",
                    operator_id="op-1",
                    reason="OPERATOR_EMERGENCY_STOP",
                    now_utc=1700000000,
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

                stop_state = persist_operator_emergency_stop(
                    latch_file,
                    account_login=1001,
                    server="Broker-Demo",
                    operator_id="op-1",
                    reason="OPERATOR_EMERGENCY_STOP",
                    now_utc=1700000000,
                )
                authorize_emergency_stop_release(
                    latch_file,
                    account_login=1001,
                    server="Broker-Demo",
                    operator_authenticated=True,
                    operator_id="op-1",
                    approval_reason="VERIFIED_RECONCILED",
                    uncertain_entry_state={},
                    expected_stop_revision=stop_state["stopRevision"],
                    now_utc=1700000010,
                )
                allowed = probe._check_runtime_emergency_stop_latch(1001, "Broker-Demo")
                self.assertIsNotNone(allowed)
                self.assertTrue(allowed["blockNewOrders"])
                self.assertEqual(allowed["reason"], "STOP_RELEASE_HOST_AUTH_UNVERIFIED")


    def test_missing_latch_always_blocks_even_when_environment_flag_is_disabled(self):
        probe = _load_probe_module()
        with tempfile.TemporaryDirectory() as folder:
            missing = Path(folder) / "missing-stop.json"
            with patch.object(probe, "EMERGENCY_STOP_LATCH_FILE", missing):
                for setting in ("", "0", "1"):
                    with self.subTest(flag=setting):
                        with patch.dict(os.environ, {"ZIQ_V6_REQUIRE_EMERGENCY_STOP_LATCH": setting}):
                            result = probe._check_runtime_emergency_stop_latch(1001, "Broker-Demo")
                            self.assertIsNotNone(result)
                            self.assertTrue(result["blockNewOrders"])
                            self.assertTrue(result["emergencyStopActive"])
                            self.assertEqual(result["reason"], "STOP_LATCH_MISSING_UNVERIFIED")

    def test_caller_asserted_clear_never_authorizes_new_order(self):
        probe = _load_probe_module()
        with tempfile.TemporaryDirectory() as folder:
            latch_file = Path(folder) / "stop.json"
            with patch.object(probe, "EMERGENCY_STOP_LATCH_FILE", latch_file):
                stop = persist_operator_emergency_stop(
                    latch_file, account_login=1001, server="Broker-Demo",
                    operator_id="unverified-claim", now_utc=1700000000,
                )
                # No trusted host operator identity, DPAPI custody or broker
                # reconciliation is established by this legacy source-only API.
                release = authorize_emergency_stop_release(
                    latch_file, account_login=1001, server="Broker-Demo",
                    operator_authenticated=True, operator_id="unverified-claim",
                    approval_reason="Fake caller assertion", uncertain_entry_state={},
                    expected_stop_revision=stop["stopRevision"], now_utc=1700000001,
                )
                self.assertFalse(release["releaseDenied"])
                result = probe._check_runtime_emergency_stop_latch(1001, "Broker-Demo")
                self.assertTrue(result["blockNewOrders"])
                self.assertFalse(result["liveAuthorized"])
                self.assertEqual(result["reason"], "STOP_RELEASE_HOST_AUTH_UNVERIFIED")

    def test_latch_reader_exception_nondict_and_account_mismatch_fail_closed(self):
        probe = _load_probe_module()
        for fake in (RuntimeError("I/O unavailable"), PermissionError("access denied")):
            with self.subTest(exception=type(fake).__name__):
                with patch.object(probe, "_read_bound_emergency_stop_latch", side_effect=fake):
                    result = probe._check_runtime_emergency_stop_latch(1001, "Broker-Demo")
                    self.assertTrue(result["blockNewOrders"])
                    self.assertEqual(result["reason"], "STOP_LATCH_READ_EXCEPTION_FAIL_CLOSED")
        with patch.object(probe, "_read_bound_emergency_stop_latch", return_value=None):
            result = probe._check_runtime_emergency_stop_latch(1001, "Broker-Demo")
            self.assertTrue(result["blockNewOrders"])
            self.assertEqual(result["reason"], "STOP_LATCH_RESULT_UNVERIFIED")

        with tempfile.TemporaryDirectory() as folder:
            latch_file = Path(folder) / "stop.json"
            persist_operator_emergency_stop(
                latch_file, account_login=1001, server="Broker-Demo",
                operator_id="owner", now_utc=1700000000,
            )
            with patch.object(probe, "EMERGENCY_STOP_LATCH_FILE", latch_file):
                mismatch = probe._check_runtime_emergency_stop_latch(1002, "Broker-Demo")
                self.assertTrue(mismatch["blockNewOrders"])
                self.assertEqual(mismatch["reason"], "STOP_LATCH_ACCOUNT_SERVER_MISMATCH")

    def test_actual_new_entry_source_has_blocking_guard_before_direct_send(self):
        # Parse the exact real source without executing MT5 and verify that the
        # guard return syntactically precedes the order_send call.
        path = ROOT / "scripts" / "mt5-direct-probe.py"
        parsed = ast.parse(path.read_text(encoding="utf-8"))
        fn = next(n for n in parsed.body if isinstance(n, ast.FunctionDef)
                  and n.name == "_execute_order_serialized")
        checks = [n for n in ast.walk(fn) if isinstance(n, ast.Call)
                  and isinstance(n.func, ast.Name)
                  and n.func.id == "_check_runtime_emergency_stop_latch"]
        sends = [n for n in ast.walk(fn) if isinstance(n, ast.Call)
                 and isinstance(n.func, ast.Attribute)
                 and n.func.attr == "order_send"
                 and isinstance(n.func.value, ast.Name)
                 and n.func.value.id == "mt5"]
        self.assertEqual(len(checks), 1)
        self.assertEqual(len(sends), 1)
        self.assertLess(checks[0].lineno, sends[0].lineno)
        self.assertTrue(any(
            isinstance(n, ast.If) and "estop_block" in ast.unparse(n.test)
            and any(isinstance(c, ast.Return) for c in n.body)
            and n.lineno < sends[0].lineno
            for n in ast.walk(fn)
        ))

    def test_protective_actions_in_probe_do_not_require_new_order_latch(self):
        probe = _load_probe_module()
        called = []
        pos = SimpleNamespace(
            ticket=99,
            symbol="XAUUSD",
            type=0,
            volume=0.01,
            price_open=2600.0,
            sl=2590.0,
            tp=2620.0,
            magic=270715,
        )

        class _MockMt5:
            TRADE_ACTION_SLTP = 6
            TRADE_ACTION_DEAL = 1

            @staticmethod
            def positions_get(ticket=None):
                return [pos]

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
            persist_operator_emergency_stop(
                latch_file,
                account_login=1001,
                server="Broker-Demo",
                operator_id="op-1",
                reason="OPERATOR_EMERGENCY_STOP",
                now_utc=1700000000,
            )
            with patch.object(probe, "EMERGENCY_STOP_LATCH_FILE", latch_file):
                res = probe.modify_position_sl_tp(_MockMt5(), pos, 2595.0, 2625.0, "TEST_SLTP")
                self.assertEqual(len(called), 1)
                self.assertNotEqual(res.get("status"), "BLOCKED_EMERGENCY_STOP_LATCH")


if __name__ == "__main__":
    unittest.main()
