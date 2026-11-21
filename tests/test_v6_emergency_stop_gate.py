"""Offline broker mock & negative tests for V6 G1 Emergency Stop gate (#7)."""
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.v6_emergency_stop_gate import (
    ACTION_NEW_ORDER,
    ACTION_PROTECTIVE_SL_TP,
    authorize_emergency_stop_release,
    enrich_uncertain_entry_fill_evidence,
    evaluate_new_order_gate,
    persist_operator_emergency_stop,
    read_bound_emergency_stop_latch,
)

INTENT = {
    "symbol": "XAUUSD.G",
    "side": "BUY",
    "brokerComment": "XAUUSD_AI_MASTER_V6:abc12345678",
    "accountLogin": 123456,
    "server": "DBGMarkets-Live",
    "requestedVolume": 0.10,
}
DEAL = {
    "ticket": 501,
    "position_id": 601,
    "volume": 0.10,
    "magic": 270715,
    "symbol": "XAUUSD.G",
    "type": 0,
    "comment": INTENT["brokerComment"],
}
POSITION = {
    "ticket": 602,
    "identifier": 601,
    "magic": 270715,
    "symbol": "XAUUSD.G",
    "type": 0,
    "volume": 0.10,
}


class EmergencyStopGateTests(unittest.TestCase):
    def test_missing_corrupt_and_unverified_latch_fail_closed_and_distinguish_startup(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "latch.json"
            missing = read_bound_emergency_stop_latch(path, account_login=123456, server="DBGMarkets-Live")
            self.assertTrue(missing["emergencyStopActive"])
            self.assertEqual(missing["stopCategory"], "FAIL_CLOSED_STARTUP")
            self.assertEqual(missing["reason"], "STOP_LATCH_MISSING_UNVERIFIED")

            for bad in ("{corrupt", "[]", '{"emergencyStopActive": false, "accountLogin": 123456, "server": "DBGMarkets-Live"}'):
                path.write_text(bad, encoding="utf-8")
                res = read_bound_emergency_stop_latch(path, account_login=123456, server="DBGMarkets-Live")
                self.assertTrue(res["blockNewOrders"])
                self.assertTrue(res["allowProtectivePositionManagement"])

    def test_operator_stop_persists_across_restart_and_distinguishes_from_startup(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "latch.json"
            state = persist_operator_emergency_stop(
                path,
                account_login=123456,
                server="DBGMarkets-Live",
                operator_id="owner-op",
                reason="MANUAL_KILL_SWITCH",
                now_utc=1700000000,
            )
            self.assertTrue(state["emergencyStopActive"])
            self.assertEqual(state["stopCategory"], "OPERATOR_EMERGENCY_STOP")
            self.assertEqual(state["reason"], "MANUAL_KILL_SWITCH")
            self.assertEqual(state["triggeredBy"], "owner-op")
            self.assertFalse(state["liveArmed"])

            reloaded = read_bound_emergency_stop_latch(path, account_login=123456, server="DBGMarkets-Live")
            self.assertEqual(reloaded["stopCategory"], "OPERATOR_EMERGENCY_STOP")
            self.assertTrue(reloaded["blockNewOrders"])

    def test_account_or_server_switch_blocks_even_after_release(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "latch.json"
            release = authorize_emergency_stop_release(
                path,
                account_login=123456,
                server="DBGMarkets-Live",
                operator_authenticated=True,
                operator_id="owner-op",
                approval_reason="Verified flat",
                now_utc=1700000100,
            )
            self.assertFalse(release["emergencyStopActive"])
            self.assertFalse(release["liveArmed"])
            self.assertFalse(release["liveAuthorized"])

            wrong_login = evaluate_new_order_gate(
                action_kind=ACTION_NEW_ORDER,
                latch_path=path,
                account_login=999999,
                server="DBGMarkets-Live",
                uncertain_entry_state={},
                live_armed=True,
            )
            self.assertFalse(wrong_login["allowed"])
            self.assertEqual(wrong_login["reason"], "STOP_LATCH_ACCOUNT_SERVER_MISMATCH")

            wrong_server = evaluate_new_order_gate(
                action_kind=ACTION_NEW_ORDER,
                latch_path=path,
                account_login=123456,
                server="Other-Server",
                uncertain_entry_state={},
                live_armed=True,
            )
            self.assertFalse(wrong_server["allowed"])
            self.assertEqual(wrong_server["reason"], "STOP_LATCH_ACCOUNT_SERVER_MISMATCH")

    def test_unauthenticated_reset_and_uncertain_freeze_reset_are_denied(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "latch.json"
            persist_operator_emergency_stop(
                path, account_login=123456, server="DBGMarkets-Live", operator_id="owner-op"
            )
            unauth = authorize_emergency_stop_release(
                path,
                account_login=123456,
                server="DBGMarkets-Live",
                operator_authenticated=False,
                operator_id="owner-op",
                approval_reason="Try bypass",
            )
            self.assertTrue(unauth["releaseDenied"])
            self.assertTrue(unauth["emergencyStopActive"])
            self.assertEqual(unauth["releaseDeniedReason"], "OPERATOR_AUTH_REQUIRED")

            frozen = authorize_emergency_stop_release(
                path,
                account_login=123456,
                server="DBGMarkets-Live",
                operator_authenticated=True,
                operator_id="owner-op",
                approval_reason="Try clear while uncertain",
                uncertain_entry_frozen=True,
            )
            self.assertTrue(frozen["releaseDenied"])
            self.assertTrue(frozen["emergencyStopActive"])
            self.assertEqual(frozen["releaseDeniedReason"], "UNCERTAIN_ENTRY_FREEZE_ACTIVE")

    def test_protective_sl_tp_allowed_while_new_order_blocked(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "latch.json"
            persist_operator_emergency_stop(
                path, account_login=123456, server="DBGMarkets-Live", operator_id="owner-op"
            )
            new_order = evaluate_new_order_gate(
                action_kind=ACTION_NEW_ORDER,
                latch_path=path,
                account_login=123456,
                server="DBGMarkets-Live",
                uncertain_entry_state={},
                live_armed=True,
            )
            self.assertFalse(new_order["allowed"])

            protective = evaluate_new_order_gate(
                action_kind=ACTION_PROTECTIVE_SL_TP,
                latch_path=path,
                account_login=123456,
                server="DBGMarkets-Live",
                uncertain_entry_state={"123456|DBGMarkets-Live": INTENT},
                live_armed=False,
            )
            self.assertTrue(protective["allowed"])
            self.assertTrue(protective["allowProtectivePositionManagement"])

    def test_uncertain_entry_gate_and_enriched_fill_evidence_mocks(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "latch.json"
            authorize_emergency_stop_release(
                path,
                account_login=123456,
                server="DBGMarkets-Live",
                operator_authenticated=True,
                operator_id="owner-op",
                approval_reason="Ready for test",
            )
            blocked_by_uncertain = evaluate_new_order_gate(
                action_kind=ACTION_NEW_ORDER,
                latch_path=path,
                account_login=123456,
                server="DBGMarkets-Live",
                uncertain_entry_state={"123456|DBGMarkets-Live": INTENT},
                live_armed=True,
            )
            self.assertFalse(blocked_by_uncertain["allowed"])
            self.assertEqual(blocked_by_uncertain["reason"], "BLOCKED_UNCERTAIN_PREVIOUS_ENTRY")

            not_armed = evaluate_new_order_gate(
                action_kind=ACTION_NEW_ORDER,
                latch_path=path,
                account_login=123456,
                server="DBGMarkets-Live",
                uncertain_entry_state={},
                live_armed=False,
            )
            self.assertFalse(not_armed["allowed"])
            self.assertEqual(not_armed["reason"], "BLOCKED_LIVE_NOT_ARMED")

            scenarios = [
                ("NO_MATCH_NOT_PROOF_OF_NO_FILL", dict(broker_positions=[], broker_pending_orders=[], broker_deals=[])),
                ("BROKER_PENDING_ORDER_REVIEW", dict(broker_positions=[], broker_pending_orders=[dict(DEAL, ticket=701)], broker_deals=[])),
                ("BROKER_PARTIAL_FILL_REVIEW", dict(broker_positions=[], broker_pending_orders=[], broker_deals=[dict(DEAL, volume=0.05)])),
                ("DUPLICATE_BROKER_RECORDS", dict(broker_positions=[], broker_pending_orders=[], broker_deals=[DEAL, DEAL])),
                ("BROKER_FULL_FILL_POSITION_OBSERVED_REVIEW", dict(broker_positions=[POSITION], broker_pending_orders=[], broker_deals=[DEAL])),
            ]
            for expected_status, mock_data in scenarios:
                ev = enrich_uncertain_entry_fill_evidence(
                    intent=INTENT,
                    snapshot_login=123456,
                    snapshot_server="DBGMarkets-Live",
                    **mock_data,
                )
                self.assertEqual(ev["status"], expected_status)
                self.assertTrue(ev["freezeNewOrders"])
                self.assertFalse(ev["allowDuplicateSend"])
                self.assertFalse(ev["allowAutomaticFreezeClear"])
                self.assertTrue(ev["allowProtectivePositionManagement"])


if __name__ == "__main__":
    unittest.main()
