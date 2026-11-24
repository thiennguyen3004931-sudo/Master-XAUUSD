"""Round-trip read/write integration tests between v6_emergency_stop_gate and v6_cross_process_stop_send_protocol (#7)."""
import hashlib
import hmac
import json
import sys
import tempfile

try:
    from tests.v6_test_tempdir import robust_tempdir
except ImportError:  # discover -s tests imports modules top-level
    from v6_test_tempdir import robust_tempdir
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.v6_cross_process_stop_send_protocol import (
    execute_linearized_new_order,
)
from scripts.v6_emergency_stop_gate import (
    _has_active_uncertain_entry,
    authorize_emergency_stop_release,
    persist_operator_emergency_stop,
)

KEY = b"test-dpapi-custody-key-32-bytes!"


def _sign_release(login: int, server: str, stop_rev: str, released_at: int, operator_id: str, reason: str) -> str:
    msg = f"{login}|{server}|{stop_rev}|{released_at}|{operator_id}|{reason}".encode("utf-8")
    return hmac.new(KEY, msg, hashlib.sha256).hexdigest()


class GateProtocolRoundTripTests(unittest.TestCase):
    def test_offline_clear_without_windows_proof_remains_rejected_by_protocol(self):
        with robust_tempdir() as folder:
            rt = Path(folder)
            latch_path = rt / "v6-emergency-stop-latch.json"
            stop_state = persist_operator_emergency_stop(
                latch_path,
                account_login=1001,
                server="Broker-Demo",
                operator_id="op-1",
                reason="OPERATOR_EMERGENCY_STOP",
                now_utc=1700000000,
            )
            rel = authorize_emergency_stop_release(
                latch_path,
                account_login=1001,
                server="Broker-Demo",
                operator_authenticated=True,
                operator_id="op-1",
                approval_reason="VERIFIED_RECONCILED",
                uncertain_entry_state={},
                expected_stop_revision=stop_state["stopRevision"],
                now_utc=1700000010,
            )
            self.assertFalse(rel["releaseDenied"])

            calls = []
            res = execute_linearized_new_order(
                runtime_dir=rt,
                account_login=1001,
                server="Broker-Demo",
                request_id="req-roundtrip-1",
                mock_order_send=lambda r: calls.append(r) or {"retcode": 10009, "order": 1},
                now_utc=1700000020,
            )
            self.assertFalse(res["submitted"])
            self.assertEqual(res["reason"], "MISSING_TRUSTED_RELEASE_PROOF")
            self.assertEqual(calls, [])

    def test_pending_send_written_by_protocol_is_recognized_as_freeze_and_preserved_across_restart(self):
        with robust_tempdir() as folder:
            rt = Path(folder)
            latch_path = rt / "v6-emergency-stop-latch.json"
            stop_rev = "abcdef1234567890"
            released_at = 1700000100
            reason = "VERIFIED_FLAT_BROKER_READBACK"
            latch_path.write_text(
                json.dumps({
                    "schemaVersion": 1,
                    "accountLogin": 1001,
                    "server": "Broker-Demo",
                    "emergencyStopActive": False,
                    "blockNewOrders": False,
                    "stopRevision": stop_rev,
                    "releaseProof": {
                        "operatorId": "op-1",
                        "approvalReason": reason,
                        "releasedAtUtc": released_at,
                        "stopRevision": stop_rev,
                        "hmacSha256": _sign_release(1001, "Broker-Demo", stop_rev, released_at, "op-1", reason),
                    },
                }),
                encoding="utf-8",
            )

            res = execute_linearized_new_order(
                runtime_dir=rt,
                account_login=1001,
                server="Broker-Demo",
                request_id="req-roundtrip-pending-1",
                mock_order_send=lambda _r: {"retcode": 10009, "order": 42},
                host_dpapi_verifier=lambda _l: True,
                release_hmac_key=KEY,
                now_utc=released_at + 5,
            )
            self.assertEqual(res["status"], "MOCK_ACK_NOT_BROKER_ATTESTED")

            uncertain_state = json.loads((rt / "v6-uncertain-entry-state.json").read_text(encoding="utf-8"))
            self.assertEqual(uncertain_state["1001|Broker-Demo"]["status"], "PENDING_SEND")
            self.assertEqual(uncertain_state["1001|Broker-Demo"]["requestId"], "req-roundtrip-pending-1")

            frozen, freeze_reason = _has_active_uncertain_entry(uncertain_state, login=1001, server="Broker-Demo")
            self.assertTrue(frozen)
            self.assertEqual(freeze_reason, "UNCERTAIN_ENTRY_FREEZE_ACTIVE")

            stop_state = persist_operator_emergency_stop(
                latch_path,
                account_login=1001,
                server="Broker-Demo",
                operator_id="op-1",
                reason="POST_SEND_STOP",
                now_utc=released_at + 10,
            )
            rel_denied = authorize_emergency_stop_release(
                latch_path,
                account_login=1001,
                server="Broker-Demo",
                operator_authenticated=True,
                operator_id="op-1",
                approval_reason="TRY_CLEAR",
                uncertain_entry_state=uncertain_state,
                expected_stop_revision=stop_state["stopRevision"],
                now_utc=released_at + 15,
            )
            self.assertTrue(rel_denied["releaseDenied"])

    def test_foreign_pending_send_keeps_stop_active_after_account_or_server_switch(self):
        pending = {"accountLogin": 1001, "server": "Broker-A", "createdAtUtc": 1700000000,
                   "status": "PENDING_SEND", "requestId": "original-request"}
        other = dict(pending, accountLogin=1003, requestId="second-request")
        for login, server in ((1002, "Broker-A"), (1001, "Broker-B")):
            with self.subTest(login=login, server=server), robust_tempdir() as folder:
                rt = Path(folder)
                inventory = rt / "v6-uncertain-entry-state.json"
                inventory.write_text(json.dumps({"1003|Broker-A": other, "1001|Broker-A": pending}),
                                     encoding="utf-8")
                latch = rt / "v6-emergency-stop-latch.json"
                stop = persist_operator_emergency_stop(latch, account_login=login, server=server,
                                                       operator_id="offline")
                before = latch.read_bytes()
                state = json.loads(inventory.read_text(encoding="utf-8"))
                result = authorize_emergency_stop_release(
                    latch, account_login=login, server=server, operator_authenticated=True,
                    operator_id="offline", approval_reason="review",
                    expected_stop_revision=stop["stopRevision"], uncertain_entry_state=state,
                )
                self.assertTrue(result["releaseDenied"])
                self.assertEqual(result["releaseDeniedReason"], "UNCERTAIN_ENTRY_FREEZE_ACTIVE")
                self.assertEqual(latch.read_bytes(), before)
                self.assertEqual(state["1001|Broker-A"]["requestId"], "original-request")

    def test_distinguishes_entry_in_flight_and_blocks_missing_linkage_as_malformed(self):
        valid_flight = {
            "1001|Broker-Demo": {
                "accountLogin": 1001,
                "server": "Broker-Demo",
                "symbol": "XAUUSD",
                "side": "BUY",
                "brokerComment": "XAUUSD_AI:abc",
                "status": "ENTRY_IN_FLIGHT",
                "createdAtUtc": 1700000000,
            }
        }
        frozen_f, reason_f = _has_active_uncertain_entry(valid_flight, login=1001, server="Broker-Demo")
        self.assertTrue(frozen_f)
        self.assertEqual(reason_f, "UNCERTAIN_ENTRY_FREEZE_ACTIVE")

        missing_req_id = {
            "1001|Broker-Demo": {
                "accountLogin": 1001,
                "server": "Broker-Demo",
                "status": "PENDING_SEND",
                "createdAtUtc": 1700000000,
            }
        }
        frozen_m, reason_m = _has_active_uncertain_entry(missing_req_id, login=1001, server="Broker-Demo")
        self.assertTrue(frozen_m)
        self.assertEqual(reason_m, "UNCERTAIN_ENTRY_STATE_MALFORMED")


if __name__ == "__main__":
    unittest.main()
