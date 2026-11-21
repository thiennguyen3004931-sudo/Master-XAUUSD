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
    initialize_or_recover_emergency_stop_latch,
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
    def test_missing_corrupt_and_mismatched_latch_deny_release_and_leave_file_unchanged(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "latch.json"
            missing_rel = authorize_emergency_stop_release(
                path,
                account_login=123456,
                server="DBGMarkets-Live",
                operator_authenticated=True,
                operator_id="owner-op",
                approval_reason="Try release missing",
                uncertain_entry_state={},
            )
            self.assertTrue(missing_rel["releaseDenied"])
            self.assertEqual(missing_rel["releaseDeniedReason"], "REQUIRES_ACTIVE_OPERATOR_STOP")
            self.assertFalse(path.exists())

            for raw in (
                "{corrupt",
                '{"emergencyStopActive": true, "accountLogin": 999999, "server": "DBGMarkets-Live", "stopCategory": "OPERATOR_EMERGENCY_STOP"}',
            ):
                path.write_text(raw, encoding="utf-8")
                res = authorize_emergency_stop_release(
                    path,
                    account_login=123456,
                    server="DBGMarkets-Live",
                    operator_authenticated=True,
                    operator_id="owner-op",
                    approval_reason="Try release bad/mismatch",
                    uncertain_entry_state={},
                )
                self.assertTrue(res["releaseDenied"])
                self.assertTrue(res["blockNewOrders"])
                self.assertEqual(path.read_text(encoding="utf-8"), raw)

    def test_recovery_flow_requires_evidence_and_clear_uncertain_state(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "latch.json"
            denied = initialize_or_recover_emergency_stop_latch(
                path,
                account_login=123456,
                server="DBGMarkets-Live",
                operator_authenticated=True,
                operator_id="owner-op",
                approval_reason="Bootstrap",
                uncertain_entry_state={},
                recovery_evidence_verified=False,
            )
            self.assertTrue(denied["recoveryDenied"])
            self.assertEqual(denied["recoveryDeniedReason"], "RECOVERY_EVIDENCE_REQUIRED")
            self.assertFalse(path.exists())

            ok = initialize_or_recover_emergency_stop_latch(
                path,
                account_login=123456,
                server="DBGMarkets-Live",
                operator_authenticated=True,
                operator_id="owner-op",
                approval_reason="Verified clean broker flat state",
                uncertain_entry_state={},
                recovery_evidence_verified=True,
                now_utc=1700000050,
            )
            self.assertFalse(ok["recoveryDenied"])
            self.assertFalse(ok["emergencyStopActive"])
            self.assertFalse(ok["liveArmed"])
            self.assertFalse(ok["liveAuthorized"])

    def test_operator_stop_persists_across_restart_and_rejects_stale_writer(self):
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
            before_bytes = path.read_text(encoding="utf-8")

            stale = authorize_emergency_stop_release(
                path,
                account_login=123456,
                server="DBGMarkets-Live",
                operator_authenticated=True,
                operator_id="owner-op",
                approval_reason="Stale clear",
                uncertain_entry_state={},
                expected_triggered_at_utc=1699999999,
            )
            self.assertTrue(stale["releaseDenied"])
            self.assertEqual(stale["releaseDeniedReason"], "STALE_LATCH_VERSION_MISMATCH")
            self.assertEqual(path.read_text(encoding="utf-8"), before_bytes)

    def test_omitted_null_invalid_and_active_uncertain_entry_all_deny_release(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "latch.json"
            persist_operator_emergency_stop(
                path, account_login=123456, server="DBGMarkets-Live", operator_id="owner-op", now_utc=1700000000
            )
            before_bytes = path.read_text(encoding="utf-8")

            omitted = authorize_emergency_stop_release(
                path,
                account_login=123456,
                server="DBGMarkets-Live",
                operator_authenticated=True,
                operator_id="owner-op",
                approval_reason="Omitted state",
            )
            self.assertTrue(omitted["releaseDenied"])
            self.assertEqual(omitted["releaseDeniedReason"], "UNCERTAIN_ENTRY_STATE_UNVERIFIED")
            self.assertEqual(path.read_text(encoding="utf-8"), before_bytes)

            for bad_state, expected_reason in (
                (None, "UNCERTAIN_ENTRY_STATE_UNVERIFIED"),
                ("not-a-dict", "UNCERTAIN_ENTRY_STATE_UNVERIFIED"),
                ({"123456|DBGMarkets-Live": INTENT}, "UNCERTAIN_ENTRY_FREEZE_ACTIVE"),
            ):
                res = authorize_emergency_stop_release(
                    path,
                    account_login=123456,
                    server="DBGMarkets-Live",
                    operator_authenticated=True,
                    operator_id="owner-op",
                    approval_reason="Bad/active entry state",
                    uncertain_entry_state=bad_state,
                )
                self.assertTrue(res["releaseDenied"])
                self.assertEqual(res["releaseDeniedReason"], expected_reason)
                self.assertEqual(path.read_text(encoding="utf-8"), before_bytes)

    def test_account_switch_and_protective_sl_tp_semantics(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "latch.json"
            persist_operator_emergency_stop(
                path, account_login=123456, server="DBGMarkets-Live", operator_id="owner-op", now_utc=1700000000
            )
            released = authorize_emergency_stop_release(
                path,
                account_login=123456,
                server="DBGMarkets-Live",
                operator_authenticated=True,
                operator_id="owner-op",
                approval_reason="Verified flat",
                uncertain_entry_state={},
                expected_triggered_at_utc=1700000000,
            )
            self.assertFalse(released["releaseDenied"])
            self.assertFalse(released["emergencyStopActive"])
            self.assertFalse(released["liveAuthorized"])

            gate_ok = evaluate_new_order_gate(
                action_kind=ACTION_NEW_ORDER,
                latch_path=path,
                account_login=123456,
                server="DBGMarkets-Live",
                uncertain_entry_state={},
                live_armed=True,
            )
            self.assertTrue(gate_ok["allowedByStopLatchOnly"])
            self.assertEqual(gate_ok["gateScope"], "LATCH_ONLY_OFFLINE_CANDIDATE_NOT_FINAL_AUTH")
            self.assertFalse(gate_ok["liveAuthorized"])

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

            protective = evaluate_new_order_gate(
                action_kind=ACTION_PROTECTIVE_SL_TP,
                latch_path=path,
                account_login=123456,
                server="DBGMarkets-Live",
                uncertain_entry_state={"123456|DBGMarkets-Live": INTENT},
                live_armed=False,
            )
            self.assertTrue(protective["allowed"])
            self.assertFalse(protective["blockedByStopLatch"])
            self.assertEqual(protective["reason"], "NOT_BLOCKED_BY_STOP_LATCH_REQUIRES_INDEPENDENT_SL_VERIFICATION")

    def test_enriched_fill_evidence_mocks_never_clear_freeze(self):
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
