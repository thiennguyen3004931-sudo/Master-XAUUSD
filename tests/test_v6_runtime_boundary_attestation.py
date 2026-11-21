"""Offline contract & mock tests for G1 runtime boundary attestation (#7)."""
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.v6_runtime_boundary_attestation import (
    evaluate_action_boundary,
    map_mt5_order_send_call_sites,
    simulate_locked_new_order_with_pending_marker,
)

SAMPLE_PROBE_SNIPPET = """
def partial_close_position(mt5):
    return mt5.order_send({"action": "DEAL"})

def modify_position_sl_tp(mt5):
    return mt5.order_send({"action": "SLTP"})

def _execute_order_serialized(mt5):
    return mt5.order_send({"action": "NEW_ENTRY"})

def close_position_by_ticket(mt5):
    return mt5.order_send({"action": "CLOSE_WEB_V6"})
"""


class RuntimeBoundaryAttestationTests(unittest.TestCase):
    def test_ast_mapper_classifies_all_four_known_sites_and_rejects_unknown_site(self):
        mapped = map_mt5_order_send_call_sites(SAMPLE_PROBE_SNIPPET)
        self.assertTrue(mapped["allCallSitesClassified"])
        self.assertFalse(mapped["allPossibleOrderSendPathsVerified"])
        self.assertEqual(mapped["totalCallSites"], 4)
        self.assertEqual(len(mapped["newEntrySites"]), 1)
        self.assertEqual(mapped["newEntrySites"][0]["function"], "_execute_order_serialized")
        self.assertEqual(len(mapped["protectiveOrExitSites"]), 3)

        rogue_source = SAMPLE_PROBE_SNIPPET + "\ndef rogue_helper(mt5):\n    return mt5.order_send({})\n"
        rogue = map_mt5_order_send_call_sites(rogue_source)
        self.assertFalse(rogue["allCallSitesClassified"])
        self.assertEqual(len(rogue["unknownSites"]), 1)
        self.assertEqual(rogue["unknownSites"][0]["function"], "rogue_helper")

        # Also validate against real scripts/mt5-direct-probe.py if present in repo checkout
        real_probe = ROOT / "scripts" / "mt5-direct-probe.py"
        if real_probe.exists():
            real_mapped = map_mt5_order_send_call_sites(real_probe.read_text(encoding="utf-8"))
            self.assertTrue(real_mapped["allCallSitesClassified"])
            self.assertEqual(len(real_mapped["newEntrySites"]), 1)
            self.assertEqual(len(real_mapped["protectiveOrExitSites"]), 3)

    def test_protective_actions_remain_unblocked_while_new_entry_enforces_account_server_and_lock(self):
        prot = evaluate_action_boundary(
            action_category="PROTECTIVE_OR_EXIT",
            emergency_stop_active=True,
            uncertain_entry_latched=True,
            expected_account_login=1001,
            expected_server="Broker-Live",
            observed_account_login=9999,
            observed_server="Wrong-Server",
            entry_lock_held=False,
            pending_marker_persisted=False,
        )
        self.assertFalse(prot["allowed"])
        self.assertTrue(prot["protectiveUnaffectedByNewEntryLatch"])
        self.assertFalse(prot["liveAuthorized"])

        mismatch_acct = evaluate_action_boundary(
            action_category="NEW_ORDER_ENTRY",
            emergency_stop_active=False,
            uncertain_entry_latched=False,
            expected_account_login=1001,
            expected_server="Broker-Demo",
            observed_account_login=2002,
            observed_server="Broker-Demo",
            entry_lock_held=True,
            pending_marker_persisted=True,
        )
        self.assertFalse(mismatch_acct["allowed"])
        self.assertEqual(mismatch_acct["reason"], "ACCOUNT_BINDING_MISMATCH")

        no_lock = evaluate_action_boundary(
            action_category="NEW_ORDER_ENTRY",
            emergency_stop_active=False,
            uncertain_entry_latched=False,
            expected_account_login=1001,
            expected_server="Broker-Demo",
            observed_account_login=1001,
            observed_server="Broker-Demo",
            entry_lock_held=False,
            pending_marker_persisted=True,
        )
        self.assertFalse(no_lock["allowed"])
        self.assertEqual(no_lock["reason"], "ENTRY_LOCK_NOT_HELD")

    def test_pending_marker_and_unknown_ack_or_crash_latch_blocks_subsequent_retry(self):
        with tempfile.TemporaryDirectory() as folder:
            marker = Path(folder) / "v6-uncertain-entry-state.json"
            lock = threading.Lock()

            # Unknown ACK (e.g. None return) must latch and block next call even after restart
            res1 = simulate_locked_new_order_with_pending_marker(
                entry_lock=lock,
                pending_marker_path=marker,
                request_id="req-1",
                expected_account_login=1001,
                expected_server="Broker-Demo",
                observed_account_login=1001,
                observed_server="Broker-Demo",
                emergency_stop_active=False,
                mock_order_send=lambda _req: None,
                now_utc=1700000000,
            )
            self.assertTrue(res1["latchedUncertain"])
            self.assertEqual(res1["reason"], "MOCK_ACK_NOT_BROKER_CONFIRMED")

            # Simulated restart with a fresh lock must still fail closed due to marker on disk
            fresh_lock = threading.Lock()
            called = []
            res2 = simulate_locked_new_order_with_pending_marker(
                entry_lock=fresh_lock,
                pending_marker_path=marker,
                request_id="req-2",
                expected_account_login=1001,
                expected_server="Broker-Demo",
                observed_account_login=1001,
                observed_server="Broker-Demo",
                emergency_stop_active=False,
                mock_order_send=lambda req: called.append(req) or {"retcode": 10009, "order": 1},
                now_utc=1700000005,
            )
            self.assertFalse(res2["sent"])
            self.assertTrue(res2["latchedUncertain"])
            self.assertEqual(res2["reason"], "PRIOR_UNVERIFIED_ENTRY_MARKER_BLOCKS_NEW_ORDER")
            self.assertEqual(called, [])

    def test_exception_during_order_send_latches_and_mock_success_is_still_unverified(self):
        with tempfile.TemporaryDirectory() as folder:
            marker_crash = Path(folder) / "crash.json"
            lock = threading.Lock()

            def boom(_req):
                raise TimeoutError("MT5 IPC timeout")

            res_crash = simulate_locked_new_order_with_pending_marker(
                entry_lock=lock,
                pending_marker_path=marker_crash,
                request_id="req-crash",
                expected_account_login=1001,
                expected_server="Broker-Demo",
                observed_account_login=1001,
                observed_server="Broker-Demo",
                emergency_stop_active=False,
                mock_order_send=boom,
                now_utc=1700000010,
            )
            self.assertTrue(res_crash["latchedUncertain"])
            self.assertEqual(res_crash["reason"], "ORDER_SEND_EXCEPTION_TimeoutError")
            self.assertEqual(json.loads(marker_crash.read_text(encoding="utf-8"))["status"], "CRASH_OR_EXCEPTION")

            marker_ok = Path(folder) / "ok.json"
            res_ok = simulate_locked_new_order_with_pending_marker(
                entry_lock=lock,
                pending_marker_path=marker_ok,
                request_id="req-ok",
                expected_account_login=1001,
                expected_server="Broker-Demo",
                observed_account_login=1001,
                observed_server="Broker-Demo",
                emergency_stop_active=False,
                mock_order_send=lambda _req: {"retcode": 10009, "order": 555777},
                now_utc=1700000020,
            )
            self.assertTrue(res_ok["sent"])
            self.assertTrue(res_ok["latchedUncertain"])
            self.assertEqual(res_ok["reason"], "MOCK_ACK_NOT_BROKER_CONFIRMED")
            self.assertTrue(res_ok["marker"]["mockAckLooksSuccessful"])
            self.assertEqual(json.loads(marker_ok.read_text(encoding="utf-8"))["status"], "UNKNOWN_ACK")
            self.assertFalse(res_ok["liveAuthorized"])


    def test_existing_unrecognized_or_nondict_marker_blocks_mock_send(self):
        with tempfile.TemporaryDirectory() as folder:
            marker = Path(folder) / "latch.json"
            for text in (
                '{"status": "UNRECOGNIZED_LEGACY_STATUS"}',
                '{"status": "CONFIRMED_DONE", "order": 7}',
                '[]',
                '{"status": "ABORTED_BEFORE_SEND"}',
                'not valid json',
            ):
                with self.subTest(contents=text):
                    marker.write_text(text, encoding="utf-8")
                    before = marker.read_bytes()
                    submitted = []
                    result = simulate_locked_new_order_with_pending_marker(
                        entry_lock=threading.Lock(), pending_marker_path=marker,
                        request_id="no-retry", expected_account_login=1001,
                        expected_server="Broker-Demo", observed_account_login=1001,
                        observed_server="Broker-Demo", emergency_stop_active=False,
                        mock_order_send=lambda info: submitted.append(info),
                        now_utc=1700000040,
                    )
                    self.assertFalse(result["sent"])
                    self.assertTrue(result["latchedUncertain"])
                    self.assertEqual(result["reason"], "PRIOR_UNVERIFIED_ENTRY_MARKER_BLOCKS_NEW_ORDER")
                    self.assertEqual(submitted, [])
                    self.assertEqual(marker.read_bytes(), before)

    def test_pure_boundary_checklist_never_grants_runtime_trade(self):
        result = evaluate_action_boundary(
            action_category="NEW_ORDER_ENTRY",
            emergency_stop_active=False, uncertain_entry_latched=False,
            expected_account_login=1001, expected_server="Broker-Demo",
            observed_account_login=1001, observed_server="Broker-Demo",
            entry_lock_held=True, pending_marker_persisted=True,
        )
        self.assertFalse(result["allowed"])
        self.assertTrue(result["offlineChecksPassed"])
        self.assertFalse(result["liveAuthorized"])

        invalid_login = evaluate_action_boundary(
            action_category="NEW_ORDER_ENTRY",
            emergency_stop_active=False, uncertain_entry_latched=False,
            expected_account_login=None, expected_server="Broker-Demo",
            observed_account_login=1001, observed_server="Broker-Demo",
            entry_lock_held=True, pending_marker_persisted=True,
        )
        self.assertFalse(invalid_login["allowed"])
        self.assertEqual(invalid_login["reason"], "ACCOUNT_BINDING_MISMATCH")


if __name__ == "__main__":
    unittest.main()
