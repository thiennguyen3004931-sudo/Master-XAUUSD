"""Offline integration tests for runtime Emergency Stop latch enforcement in mt5-direct-probe.py (#7)."""
import hashlib
import hmac
import importlib.util
import json
import sys
import tempfile
import threading
import time
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


def _sign_release(key_bytes: bytes, login: int, server: str, stop_rev: str, released_at: int, operator_id: str) -> str:
    msg = f"{int(login)}|{server.strip()}|{stop_rev.strip()}|{int(released_at)}|{operator_id.strip()}".encode("utf-8")
    return hmac.new(key_bytes, msg, hashlib.sha256).hexdigest()


class RuntimeEmergencyStopGateIntegrationTests(unittest.TestCase):
    def test_direct_execute_order_serialized_without_strict_lock_fails_closed(self):
        probe = _load_probe_module()
        called = []

        class _MockMt5:
            @staticmethod
            def order_send(req):
                called.append(req)
                return SimpleNamespace(retcode=10009, order=1)

        res = probe._execute_order_serialized(_MockMt5(), "XAUUSD", {"side": "BUY"}, "TEST")
        self.assertFalse(res.get("ok"))
        self.assertFalse(res.get("submitted"))
        self.assertEqual(res.get("status"), "BLOCKED_ENTRY_LOCK_NOT_HELD")
        self.assertEqual(called, [])

    def test_runtime_latch_blocks_active_corrupt_missing_and_unverified_clear(self):
        probe = _load_probe_module()
        with tempfile.TemporaryDirectory() as folder:
            latch_file = Path(folder) / "v6-emergency-stop-latch.json"
            key_file = Path(folder) / "v6-stop-release.key"
            with patch.object(probe, "EMERGENCY_STOP_LATCH_FILE", latch_file):
                blocked_missing = probe._check_runtime_emergency_stop_latch(1001, "Broker-Demo")
                self.assertTrue(blocked_missing["blockNewOrders"])

                stop_state = persist_operator_emergency_stop(
                    latch_file,
                    account_login=1001,
                    server="Broker-Demo",
                    operator_id="op-1",
                    reason="OPERATOR_EMERGENCY_STOP",
                    now_utc=1700000000,
                )
                blocked_active = probe._check_runtime_emergency_stop_latch(1001, "Broker-Demo")
                self.assertTrue(blocked_active["blockNewOrders"])

                latch_file.write_text("{corrupt-json", encoding="utf-8")
                blocked_corrupt = probe._check_runtime_emergency_stop_latch(1001, "Broker-Demo")
                self.assertTrue(blocked_corrupt["blockNewOrders"])

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
                blocked_clear = probe._check_runtime_emergency_stop_latch(1001, "Broker-Demo")
                self.assertTrue(blocked_clear["blockNewOrders"])
                self.assertEqual(blocked_clear["reason"], "STOP_RELEASE_HOST_AUTH_UNVERIFIED")

    def test_spoofed_windows_acl_and_valid_hmac_never_authorize_runtime_entry(self):
        probe = _load_probe_module()
        with tempfile.TemporaryDirectory() as folder:
            latch_file = Path(folder) / "v6-emergency-stop-latch.json"
            key_file = Path(folder) / "v6-stop-release.key"
            secret = b"dpapi-sealed-test-key-32-bytes!!"
            key_file.write_bytes(secret)

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
            raw = json.loads(latch_file.read_text(encoding="utf-8"))
            released_at = 1700000020
            raw["stopRevision"] = stop_state["stopRevision"]
            raw["releaseProof"] = {
                "operatorId": "op-1",
                "releasedAtUtc": released_at,
                "stopRevision": stop_state["stopRevision"],
                "hmacSha256": _sign_release(secret, 1001, "Broker-Demo", stop_state["stopRevision"], released_at, "op-1"),
            }
            latch_file.write_text(json.dumps(raw), encoding="utf-8")

            acl_ok = lambda _p: {"windowsHostAclVerified": True, "reparseOrSymlinkDetected": False}
            acl_bad = lambda _p: {"windowsHostAclVerified": False, "reparseOrSymlinkDetected": False}

            with patch.object(probe, "EMERGENCY_STOP_LATCH_FILE", latch_file):
                self.assertIsNotNone(
                    probe._check_runtime_emergency_stop_latch(
                        1001, "Broker-Demo", now_utc=released_at + 5, host_acl_checker=acl_bad
                    )
                )
                forged = probe._check_runtime_emergency_stop_latch(
                    1001, "Broker-Demo", now_utc=released_at + 5, host_acl_checker=acl_ok
                )
                self.assertIsNotNone(forged)
                self.assertTrue(forged["blockNewOrders"])
                self.assertFalse(forged["liveAuthorized"])
                self.assertEqual(forged["reason"], "STOP_RELEASE_HOST_AUTH_UNVERIFIED")
                self.assertIsNotNone(
                    probe._check_runtime_emergency_stop_latch(
                        1001, "Broker-Demo", now_utc=released_at + 999, host_acl_checker=acl_ok
                    )
                )

    def test_missing_corrupt_and_reader_failure_always_denied_without_order(self):
        probe = _load_probe_module()
        with tempfile.TemporaryDirectory() as folder:
            latch_file = Path(folder) / "unavailable-stop.json"
            with patch.object(probe, "EMERGENCY_STOP_LATCH_FILE", latch_file):
                missing = probe._check_runtime_emergency_stop_latch(1001, "Broker-Demo")
                self.assertTrue(missing["blockNewOrders"])
                self.assertEqual(missing["reason"], "STOP_LATCH_MISSING_UNVERIFIED")
                latch_file.write_text("bad-json", encoding="utf-8")
                bad = probe._check_runtime_emergency_stop_latch(1001, "Broker-Demo")
                self.assertTrue(bad["blockNewOrders"])
                for exc in (PermissionError("no ACL"), RuntimeError("I/O failed")):
                    with self.subTest(exc=type(exc).__name__), patch.object(
                        probe, "_read_bound_emergency_stop_latch", side_effect=exc
                    ):
                        blocked = probe._check_runtime_emergency_stop_latch(
                            1001, "Broker-Demo"
                        )
                        self.assertTrue(blocked["blockNewOrders"])
                        self.assertEqual(
                            blocked["reason"], "STOP_LATCH_READ_EXCEPTION_FAIL_CLOSED"
                        )

    def test_concurrent_emergency_stop_write_does_not_deadlock_and_protective_sltp_unblocked(self):
        probe = _load_probe_module()
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

            writer_done = threading.Event()

            def _write_stop():
                persist_operator_emergency_stop(
                    latch_file,
                    account_login=1001,
                    server="Broker-Demo",
                    operator_id="op-2",
                    reason="CONCURRENT_STOP",
                    now_utc=int(time.time()),
                )
                writer_done.set()

            with patch.object(probe, "EMERGENCY_STOP_LATCH_FILE", latch_file):
                t = threading.Thread(target=_write_stop, daemon=True)
                t.start()
                self.assertTrue(writer_done.wait(timeout=2.0))
                blocked = probe._check_runtime_emergency_stop_latch(1001, "Broker-Demo")
                self.assertIsNotNone(blocked)
                self.assertTrue(blocked["blockNewOrders"])

                called = []
                pos = SimpleNamespace(
                    ticket=99, symbol="XAUUSD", type=0, volume=0.01,
                    price_open=2600.0, sl=2590.0, tp=2620.0, magic=270715,
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

                res = probe.modify_position_sl_tp(_MockMt5(), pos, 2595.0, 2625.0, "TEST_SLTP")
                self.assertEqual(len(called), 1)
                self.assertNotEqual(res.get("status"), "BLOCKED_EMERGENCY_STOP_LATCH")

    def test_stop_intent_flag_blocks_runtime_latch_and_close_position_stays_unblocked(self):
        probe = _load_probe_module()
        with tempfile.TemporaryDirectory() as folder:
            latch_file = Path(folder) / "v6-emergency-stop-latch.json"
            intent_file = Path(folder) / "v6-stop-intent.flag"
            intent_file.write_text('{"stopIntentActive": true}', encoding="utf-8")

            with patch.object(probe, "EMERGENCY_STOP_LATCH_FILE", latch_file), patch.object(
                probe, "STOP_INTENT_FILE", intent_file
            ):
                blocked = probe._check_runtime_emergency_stop_latch(1001, "Broker-Demo")
                self.assertIsNotNone(blocked)
                self.assertTrue(blocked["blockNewOrders"])
                self.assertFalse(blocked["liveAuthorized"])
                self.assertEqual(blocked["reason"], "STOP_INTENT_ACTIVE_FAIL_CLOSED")

                called = []
                pos = SimpleNamespace(
                    ticket=105, symbol="XAUUSD", type=0, volume=0.01,
                    price_open=2600.0, sl=2590.0, tp=2620.0, magic=270715,
                )

                class _MockMt5Close:
                    TRADE_ACTION_DEAL = 1
                    ORDER_TYPE_BUY = 0
                    ORDER_TYPE_SELL = 1
                    ORDER_TIME_GTC = 0
                    ORDER_FILLING_IOC = 1
                    TRADE_RETCODE_DONE = 10009

                    @staticmethod
                    def positions_get(ticket=None):
                        return [pos] if not called else []

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

                close_res = probe.close_position_by_ticket(_MockMt5Close(), 105)
                self.assertEqual(len(called), 1)
                self.assertNotEqual(close_res.get("status"), "BLOCKED_EMERGENCY_STOP_LATCH")


if __name__ == "__main__":
    unittest.main()
