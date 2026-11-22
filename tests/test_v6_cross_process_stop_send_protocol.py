"""Deterministic two-process interleaved tests for STOP/send linearization (#7)."""
import hashlib
import hmac
import json
import subprocess
import sys
import tempfile
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


class CrossProcessStopSendProtocolTests(unittest.TestCase):
    def test_two_process_stop_before_send_blocks_child_sender_with_zero_orders(self):
        with tempfile.TemporaryDirectory() as folder:
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
        with tempfile.TemporaryDirectory() as folder:
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

    def test_fails_closed_without_host_dpapi_verifier(self):
        with tempfile.TemporaryDirectory() as folder:
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


if __name__ == "__main__":
    unittest.main()
