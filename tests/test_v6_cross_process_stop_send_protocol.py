"""Deterministic two-process interleaved tests for STOP/send linearization (#7)."""
import hashlib
import hmac
import json
import subprocess
import sys
import threading
import tempfile

try:
    from tests.v6_test_tempdir import robust_tempdir
except ImportError:  # discover -s tests imports modules top-level
    from v6_test_tempdir import robust_tempdir
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.v6_cross_process_stop_send_protocol import (
    _atomic_write_json,
    execute_linearized_new_order,
    persist_nonblocking_stop_intent_and_latch,
)

KEY = b"test-dpapi-custody-key-32-bytes!"


def _write_trusted_clear_latch(runtime_dir: Path, login: int = 1001, server: str = "Broker-Demo", now_utc: int = 1700000100):
    stop_rev = "abcdef1234567890"
    operator_id = "op-1"
    approval_reason = "VERIFIED_FLAT_BROKER_READBACK"
    msg = f"{login}|{server}|{stop_rev}|{now_utc}|{operator_id}|{approval_reason}".encode("utf-8")
    sig = hmac.new(KEY, msg, hashlib.sha256).hexdigest()
    _atomic_write_json(
        runtime_dir / "v6-emergency-stop-latch.json",
        {
            "schemaVersion": 1,
            "accountLogin": login,
            "server": server,
            "emergencyStopActive": False,
            "blockNewOrders": False,
            "stopRevision": stop_rev,
            "releaseProof": {
                "operatorId": operator_id,
                "approvalReason": approval_reason,
                "releasedAtUtc": now_utc,
                "stopRevision": stop_rev,
                "hmacSha256": sig,
            },
        },
    )


_CHILD_STOP_BEFORE_SEND = """
import json, sys, time
from pathlib import Path
root, rt_str, ready_str, go_str, out_str, key_str = sys.argv[1:7]
sys.path.insert(0, root)
from scripts.v6_cross_process_stop_send_protocol import execute_linearized_new_order

calls = []
def hook():
    Path(ready_str).write_text("ready")
    deadline = time.time() + 5.0
    while not Path(go_str).exists() and time.time() < deadline:
        time.sleep(0.01)

res = execute_linearized_new_order(
    runtime_dir=Path(rt_str),
    account_login=1001,
    server="Broker-Demo",
    request_id="req-child-1",
    mock_order_send=lambda r: calls.append(r) or {"retcode": 10009, "order": 1},
    host_dpapi_verifier=lambda _l: True,
    release_hmac_key=key_str.encode("utf-8"),
    now_utc=1700000105,
    pre_send_hook=hook,
)
Path(out_str).write_text(json.dumps({"res": res, "calls": len(calls)}))
"""

_CHILD_SLOW_SEND = """
import json, sys, time
from pathlib import Path
root, rt_str, in_send_str, rel_str, out_str, key_str = sys.argv[1:7]
sys.path.insert(0, root)
from scripts.v6_cross_process_stop_send_protocol import execute_linearized_new_order

def slow_send(_req):
    Path(in_send_str).write_text("in_send")
    deadline = time.time() + 5.0
    while not Path(rel_str).exists() and time.time() < deadline:
        time.sleep(0.01)
    return None

res = execute_linearized_new_order(
    runtime_dir=Path(rt_str),
    account_login=1001,
    server="Broker-Demo",
    request_id="req-slow-1",
    mock_order_send=slow_send,
    host_dpapi_verifier=lambda _l: True,
    release_hmac_key=key_str.encode("utf-8"),
    now_utc=1700000105,
)
Path(out_str).write_text(json.dumps(res))
"""


_CHILD_EXACT_INTERLEAVE = """
import json, sys, time
from pathlib import Path
root, rt_text, mode, ready_text, go_text, out_text, key_text = sys.argv[1:8]
sys.path.insert(0, root)
from scripts.v6_cross_process_stop_send_protocol import execute_linearized_new_order
calls = []
def rendezvous():
    Path(ready_text).write_text("ready")
    deadline = time.time() + 8.0
    while not Path(go_text).exists() and time.time() < deadline:
        time.sleep(0.01)
    if not Path(go_text).exists():
        raise TimeoutError("parent did not release barrier")
def mock_send(req):
    calls.append(req)
    return {"retcode": 10009, "order": 73}
kwargs = {
    "before_admission_reservation_hook": rendezvous if mode == "before" else None,
    "after_final_stop_check_hook": rendezvous if mode == "after" else None,
}
result = execute_linearized_new_order(
    runtime_dir=Path(rt_text),
    account_login=1001,
    server="Broker-Demo",
    request_id="req-interleave",
    mock_order_send=mock_send,
    host_dpapi_verifier=lambda _l: True,
    release_hmac_key=key_text.encode("utf-8"),
    now_utc=1700000105,
    **kwargs
)
Path(out_text).write_text(json.dumps({"result": result, "calls": calls}))
"""


class CrossProcessStopSendProtocolTests(unittest.TestCase):
    def test_two_process_stop_before_send_blocks_child_sender_with_zero_orders(self):
        with robust_tempdir() as folder:
            rt = Path(folder) / "runtime"
            rt.mkdir()
            _write_trusted_clear_latch(rt, now_utc=1700000100)
            ready_flag = rt / "sender_ready.flag"
            go_flag = rt / "go.flag"
            result_file = rt / "sender_result.json"

            proc = subprocess.Popen([
                sys.executable,
                "-c",
                _CHILD_STOP_BEFORE_SEND,
                str(ROOT),
                str(rt),
                str(ready_flag),
                str(go_flag),
                str(result_file),
                KEY.decode("utf-8"),
            ])
            deadline = time.time() + 5.0
            while not ready_flag.exists() and time.time() < deadline:
                time.sleep(0.01)
            self.assertTrue(ready_flag.exists())

            persist_nonblocking_stop_intent_and_latch(
                runtime_dir=rt, account_login=1001, server="Broker-Demo", operator_id="op-stop", now_utc=1700000104
            )
            go_flag.write_text("go")
            self.assertEqual(proc.wait(timeout=5.0), 0)

            out = json.loads(result_file.read_text(encoding="utf-8"))
            self.assertFalse(out["res"]["submitted"])
            self.assertEqual(out["res"]["status"], "BLOCKED_STOP_INTENT_ACTIVE")
            self.assertEqual(out["calls"], 0)

    def test_nonblocking_stop_completes_immediately_while_broker_send_is_blocked_and_restart_stays_latched(self):
        with robust_tempdir() as folder:
            rt = Path(folder) / "runtime"
            rt.mkdir()
            _write_trusted_clear_latch(rt, now_utc=1700000100)
            in_send_flag = rt / "in_send.flag"
            release_send_flag = rt / "release_send.flag"
            result_file = rt / "slow_sender_result.json"

            proc = subprocess.Popen([
                sys.executable,
                "-c",
                _CHILD_SLOW_SEND,
                str(ROOT),
                str(rt),
                str(in_send_flag),
                str(release_send_flag),
                str(result_file),
                KEY.decode("utf-8"),
            ])
            deadline = time.time() + 5.0
            while not in_send_flag.exists() and time.time() < deadline:
                time.sleep(0.01)
            self.assertTrue(in_send_flag.exists())

            t0 = time.monotonic()
            persist_nonblocking_stop_intent_and_latch(
                runtime_dir=rt, account_login=1001, server="Broker-Demo", operator_id="op-stop", now_utc=1700000106
            )
            elapsed = time.monotonic() - t0
            self.assertLess(elapsed, 2.0)

            release_send_flag.write_text("release")
            self.assertEqual(proc.wait(timeout=5.0), 0)
            out = json.loads(result_file.read_text(encoding="utf-8"))
            self.assertTrue(out["uncertain"])
            self.assertEqual(out["status"], "UNCERTAIN_BROKER_ACK")

            (rt / "v6-stop-intent.flag").unlink()
            _write_trusted_clear_latch(rt, now_utc=1700000110)
            retry = execute_linearized_new_order(
                runtime_dir=rt,
                account_login=1001,
                server="Broker-Demo",
                request_id="req-restart-2",
                mock_order_send=lambda _r: {"retcode": 10009, "order": 2},
                host_dpapi_verifier=lambda _l: True,
                release_hmac_key=KEY,
                now_utc=1700000115,
            )
            self.assertFalse(retry["submitted"])
            self.assertEqual(retry["status"], "BLOCKED_UNCERTAIN_PREVIOUS_ENTRY")


    def _interleave_stop_with_child(self, mode: str):
        with robust_tempdir() as folder:
            rt = Path(folder) / "runtime"
            rt.mkdir()
            _write_trusted_clear_latch(rt, now_utc=1700000100)
            ready = rt / "ready.flag"
            go = rt / "go.flag"
            out = rt / "child.json"
            proc = subprocess.Popen([
                sys.executable, "-c", _CHILD_EXACT_INTERLEAVE,
                str(ROOT), str(rt), mode, str(ready), str(go), str(out),
                KEY.decode("utf-8"),
            ])
            try:
                deadline = time.monotonic() + 7.0
                while not ready.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(ready.exists(), "child did not reach interleave barrier")
                written = []
                errors = []

                def issue_stop():
                    try:
                        written.append(persist_nonblocking_stop_intent_and_latch(
                            runtime_dir=rt,
                            account_login=1001, server="Broker-Demo",
                            operator_id="op-deterministic-stop",
                            now_utc=1700000106,
                        ))
                    except Exception as exc:
                        errors.append(type(exc).__name__)

                writer = threading.Thread(target=issue_stop, daemon=True)
                writer.start()
                stop_flag = rt / "v6-stop-intent.flag"
                deadline = time.monotonic() + 7.0
                while not stop_flag.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(stop_flag.exists(), "STOP intent was not published")
                go.write_text("release")
                self.assertEqual(proc.wait(timeout=7.0), 0)
                writer.join(timeout=7.0)
                self.assertFalse(writer.is_alive(), "STOP latch writer hung")
                self.assertFalse(errors)
                self.assertEqual(len(written), 1)
                self.assertTrue(written[0]["blockNewOrders"])
                data = json.loads(out.read_text(encoding="utf-8"))
                return data, rt
            finally:
                if proc.poll() is None:
                    proc.kill()
                    proc.wait(timeout=3.0)

    def test_two_process_stop_after_latch_read_but_before_admission_blocks(self):
        result, _rt = self._interleave_stop_with_child("before")
        self.assertFalse(result["result"]["submitted"])
        self.assertEqual(result["result"]["status"], "BLOCKED_STOP_INTENT_DURING_ADMISSION")
        self.assertEqual(result["calls"], [])

    def test_two_process_stop_after_admission_can_precede_mock_broker_callback(self):
        # This is deliberately a NEGATIVE guarantee demonstration: broker IO
        # may occur after STOP even when the request was reserved BEFORE STOP.
        # Never claim on-wire STOP priority from an admission protocol.
        result, _rt = self._interleave_stop_with_child("after")
        self.assertTrue(result["result"]["submitted"])
        self.assertTrue(result["result"]["uncertain"])
        self.assertEqual(result["result"]["status"], "MOCK_ACK_NOT_BROKER_ATTESTED")
        self.assertFalse(result["result"]["ok"])
        self.assertFalse(result["result"]["brokerFillIndependentlyVerified"])
        self.assertEqual(len(result["calls"]), 1)

    def test_mock_done_ack_does_not_clear_pending_or_prove_real_fill(self):
        with robust_tempdir() as folder:
            rt = Path(folder) / "runtime"
            rt.mkdir()
            _write_trusted_clear_latch(rt)
            calls = []
            res = execute_linearized_new_order(
                runtime_dir=rt,
                account_login=1001,
                server="Broker-Demo",
                request_id="mock-success",
                mock_order_send=lambda req: calls.append(req) or {"retcode": 10009, "order": 73},
                host_dpapi_verifier=lambda _l: True,
                release_hmac_key=KEY,
                now_utc=1700000105,
            )
            self.assertTrue(res["submitted"])
            self.assertFalse(res["ok"])
            self.assertTrue(res["uncertain"])
            self.assertEqual(res["status"], "MOCK_ACK_NOT_BROKER_ATTESTED")
            self.assertFalse(res["brokerFillIndependentlyVerified"])
            self.assertEqual(len(calls), 1)
            pending = json.loads((rt / "v6-uncertain-entry-state.json").read_text(encoding="utf-8"))
            self.assertEqual(pending["1001|Broker-Demo"]["status"], "PENDING_SEND")
            retry = execute_linearized_new_order(
                runtime_dir=rt,
                account_login=1001,
                server="Broker-Demo",
                request_id="same-unknown-retry",
                mock_order_send=lambda req: calls.append(req),
                host_dpapi_verifier=lambda _l: True,
                release_hmac_key=KEY,
                now_utc=1700000106,
            )
            self.assertFalse(retry["submitted"])
            self.assertEqual(retry["status"], "BLOCKED_UNCERTAIN_PREVIOUS_ENTRY")
            self.assertEqual(len(calls), 1)

    def test_mock_host_verifier_exception_and_invalid_latch_shape_fail_closed(self):
        with robust_tempdir() as folder:
            rt = Path(folder) / "runtime"
            rt.mkdir()
            _write_trusted_clear_latch(rt)
            calls = []

            def failing_verifier(_latch):
                raise PermissionError("DPAPI unavailable")

            result = execute_linearized_new_order(
                runtime_dir=rt, account_login=1001,
                server="Broker-Demo", request_id="host-verifier-error",
                mock_order_send=lambda req: calls.append(req),
                host_dpapi_verifier=failing_verifier,
                release_hmac_key=KEY, now_utc=1700000105,
            )
            self.assertFalse(result["submitted"])
            self.assertEqual(result["status"], "BLOCKED_EMERGENCY_STOP_LATCH")
            self.assertEqual(result["reason"], "HOST_DPAPI_VERIFIER_EXCEPTION")
            self.assertEqual(calls, [])

            result = execute_linearized_new_order(
                runtime_dir=rt, account_login=1001,
                server="Broker-Demo", request_id="bad-key",
                mock_order_send=lambda req: calls.append(req),
                host_dpapi_verifier=lambda _l: True,
                release_hmac_key="mock-key-string", now_utc=1700000105,
            )
            self.assertFalse(result["submitted"])
            self.assertEqual(result["reason"], "WINDOWS_DPAPI_AND_KEY_CUSTODY_UNVERIFIED")
            self.assertEqual(calls, [])

            (rt / "v6-emergency-stop-latch.json").write_text("[]", encoding="utf-8")
            result = execute_linearized_new_order(
                runtime_dir=rt, account_login=1001,
                server="Broker-Demo", request_id="bad-latch-list",
                mock_order_send=lambda req: calls.append(req),
                host_dpapi_verifier=lambda _l: True,
                release_hmac_key=KEY, now_utc=1700000105,
            )
            self.assertFalse(result["submitted"])
            self.assertEqual(result["status"], "BLOCKED_STOP_LATCH_INVALID_SHAPE")
            self.assertEqual(calls, [])

    def test_account_switch_and_invalid_binding_do_not_create_new_send(self):
        with robust_tempdir() as folder:
            rt = Path(folder) / "runtime"
            rt.mkdir()
            _write_trusted_clear_latch(rt)
            calls = []

            for login, server, req_id in (
                (True, "Broker-Demo", "bool-login"),
                (0, "Broker-Demo", "zero-login"),
                (1001, "", "no-server"),
                (1001, "Broker-Demo", ""),
            ):
                with self.subTest(login=login, server=server, req_id=req_id):
                    blocked = execute_linearized_new_order(
                        runtime_dir=rt,
                        account_login=login, server=server, request_id=req_id,
                        mock_order_send=lambda req: calls.append(req),
                        host_dpapi_verifier=lambda _l: True,
                        release_hmac_key=KEY, now_utc=1700000105,
                    )
                    self.assertFalse(blocked["submitted"])
                    self.assertEqual(
                        blocked["status"], "BLOCKED_INVALID_ACCOUNT_SERVER_OR_REQUEST_ID"
                    )
            self.assertEqual(calls, [])

            # An unreconciled order tied to another broker account must
            # quarantine the entire shared runtime until independently read back.
            _atomic_write_json(rt / "v6-uncertain-entry-state.json", {
                "2002|Broker-Demo": {"requestId": "unknown-elsewhere", "status": "PENDING_SEND"}
            })
            blocked = execute_linearized_new_order(
                runtime_dir=rt, account_login=1001, server="Broker-Demo",
                request_id="after-account-switch",
                mock_order_send=lambda req: calls.append(req),
                host_dpapi_verifier=lambda _l: True,
                release_hmac_key=KEY, now_utc=1700000105,
            )
            self.assertFalse(blocked["submitted"])
            self.assertEqual(blocked["status"], "BLOCKED_UNCERTAIN_OTHER_ACCOUNT_ENTRY")
            self.assertEqual(calls, [])

    def test_invalid_uncertain_inventory_shape_blocks_without_dispatch(self):
        with robust_tempdir() as folder:
            rt = Path(folder) / "runtime"
            rt.mkdir()
            _write_trusted_clear_latch(rt)
            (rt / "v6-uncertain-entry-state.json").write_text("[]", encoding="utf-8")
            calls = []
            res = execute_linearized_new_order(
                runtime_dir=rt, account_login=1001, server="Broker-Demo",
                request_id="unknown-inventory", mock_order_send=lambda req: calls.append(req),
                host_dpapi_verifier=lambda _l: True,
                release_hmac_key=KEY, now_utc=1700000105,
            )
            self.assertFalse(res["submitted"])
            self.assertEqual(res["status"], "BLOCKED_ENTRY_STATE_INVALID_SHAPE")
            self.assertEqual(calls, [])

    def test_fails_closed_without_host_dpapi_verifier(self):
        with robust_tempdir() as folder:
            rt = Path(folder) / "runtime"
            rt.mkdir()
            _write_trusted_clear_latch(rt, now_utc=1700000100)
            calls = []
            res = execute_linearized_new_order(
                runtime_dir=rt,
                account_login=1001,
                server="Broker-Demo",
                request_id="req-no-dpapi",
                mock_order_send=lambda r: calls.append(r) or {"retcode": 10009, "order": 3},
                host_dpapi_verifier=None,
                release_hmac_key=None,
                now_utc=1700000105,
            )
            self.assertFalse(res["submitted"])
            self.assertEqual(res["reason"], "WINDOWS_DPAPI_AND_KEY_CUSTODY_UNVERIFIED")
            self.assertEqual(calls, [])

    def test_safe_pre_send_abort_clears_only_matching_request_reservation(self):
        from unittest.mock import patch
        with robust_tempdir() as folder:
            rt = Path(folder) / "runtime"
            rt.mkdir()
            _write_trusted_clear_latch(rt, now_utc=1700000100)
            calls = []
            exists_calls = {"n": 0}
            orig_exists = Path.exists

            def _fake_exists(p: Path) -> bool:
                if p.name == "v6-stop-intent.flag":
                    exists_calls["n"] += 1
                    if exists_calls["n"] >= 3:
                        return True
                return orig_exists(p)

            with patch.object(Path, "exists", _fake_exists):
                res = execute_linearized_new_order(
                    runtime_dir=rt,
                    account_login=1001,
                    server="Broker-Demo",
                    request_id="req-abort-pre",
                    mock_order_send=lambda r: calls.append(r) or {"retcode": 10009, "order": 1},
                    host_dpapi_verifier=lambda _l: True,
                    release_hmac_key=KEY,
                    now_utc=1700000105,
                )
            self.assertFalse(res["submitted"])
            self.assertEqual(res["status"], "BLOCKED_STOP_INTENT_BEFORE_SEND")
            self.assertEqual(calls, [])
            self.assertEqual(json.loads((rt / "v6-uncertain-entry-state.json").read_text(encoding="utf-8")), {})
            
if __name__ == "__main__":
    unittest.main()
