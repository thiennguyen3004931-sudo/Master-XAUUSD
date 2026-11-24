"""Offline broker mock & negative tests for V6 G1 Emergency Stop gate (#7)."""
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
    "status": "ENTRY_IN_FLIGHT",
    "createdAtUtc": 1700000000,
}
OTHER_ACCOUNT_INTENT = {
    "symbol": "XAUUSD.G",
    "side": "SELL",
    "brokerComment": "XAUUSD_AI_MASTER_V6:xyz98765432",
    "accountLogin": 999999,
    "server": "DBGMarkets-Live",
    "requestedVolume": 0.05,
    "status": "ENTRY_IN_FLIGHT",
    "createdAtUtc": 1700000001,
}
DEAL = {
    "ticket": 501,
    "position_id": 601,
    "volume": 0.10,
    "magic": 270715,
    "symbol": "XAUUSD.G",
    "type": 0,
    "entry": 0,
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
    def test_freeze_state_shape_verification_fails_closed_on_malformed_and_allows_valid_other_account(self):
        with robust_tempdir() as folder:
            path = Path(folder) / "latch.json"
            stop = persist_operator_emergency_stop(
                path, account_login=123456, server="DBGMarkets-Live", operator_id="owner-op", now_utc=1700000000
            )
            before_bytes = path.read_text(encoding="utf-8")

            invalid_states = [
                (None, "UNCERTAIN_ENTRY_STATE_UNVERIFIED"),
                ("not-a-dict", "UNCERTAIN_ENTRY_STATE_UNVERIFIED"),
                (["123456|DBGMarkets-Live"], "UNCERTAIN_ENTRY_STATE_UNVERIFIED"),
                ({"123456|DBGMarkets-Live": INTENT}, "UNCERTAIN_ENTRY_FREEZE_ACTIVE"),
                ({"bad-key": {}}, "UNCERTAIN_ENTRY_STATE_MALFORMED"),
                ({"   ": INTENT}, "UNCERTAIN_ENTRY_STATE_MALFORMED"),
                ({"": INTENT}, "UNCERTAIN_ENTRY_STATE_MALFORMED"),
                ({" 123456|DBGMarkets-Live ": INTENT}, "UNCERTAIN_ENTRY_STATE_MALFORMED"),
                ({"999999|DBGMarkets-Live": "corrupt"}, "UNCERTAIN_ENTRY_STATE_MALFORMED"),
                ({"999999|DBGMarkets-Live": {"accountLogin": 999999}}, "UNCERTAIN_ENTRY_STATE_MALFORMED"),
            ]
            for state_arg, expected_reason in invalid_states:
                with self.subTest(expected_reason=expected_reason):
                    res = authorize_emergency_stop_release(
                        path,
                        account_login=123456,
                        server="DBGMarkets-Live",
                        operator_authenticated=True,
                        operator_id="owner-op",
                        approval_reason="Check freeze validation",
                        uncertain_entry_state=state_arg,
                        expected_stop_revision=stop["stopRevision"],
                        now_utc=1700000010,
                    )
                    self.assertTrue(res["releaseDenied"])
                    self.assertEqual(res["releaseDeniedReason"], expected_reason)
                    self.assertEqual(path.read_text(encoding="utf-8"), before_bytes)

            valid_other = {"999999|DBGMarkets-Live": OTHER_ACCOUNT_INTENT}
            released = authorize_emergency_stop_release(
                path,
                account_login=123456,
                server="DBGMarkets-Live",
                operator_authenticated=True,
                operator_id="owner-op",
                approval_reason="Other account only",
                uncertain_entry_state=valid_other,
                expected_stop_revision=stop["stopRevision"],
                now_utc=1700000020,
            )
            self.assertFalse(released["releaseDenied"])
            self.assertFalse(released["emergencyStopActive"])

            gate_malformed = evaluate_new_order_gate(
                action_kind=ACTION_NEW_ORDER,
                latch_path=path,
                account_login=123456,
                server="DBGMarkets-Live",
                uncertain_entry_state={"bad": 1},
                live_armed=True,
            )
            self.assertFalse(gate_malformed["allowed"])
            self.assertEqual(gate_malformed["reason"], "BLOCKED_ENTRY_STATE_UNAVAILABLE")

            gate_other = evaluate_new_order_gate(
                action_kind=ACTION_NEW_ORDER,
                latch_path=path,
                account_login=123456,
                server="DBGMarkets-Live",
                uncertain_entry_state=valid_other,
                live_armed=True,
            )
            self.assertTrue(gate_other["allowedByStopLatchOnly"])

    def test_same_second_stops_have_distinct_revisions_and_block_aba_release(self):
        with robust_tempdir() as folder:
            path = Path(folder) / "latch.json"
            same_ts = 1700000000
            stop_a = persist_operator_emergency_stop(
                path,
                account_login=123456,
                server="DBGMarkets-Live",
                operator_id="owner-op",
                reason="STOP_A",
                now_utc=same_ts,
            )
            stop_b = persist_operator_emergency_stop(
                path,
                account_login=123456,
                server="DBGMarkets-Live",
                operator_id="owner-op",
                reason="STOP_B",
                now_utc=same_ts,
            )
            self.assertEqual(stop_a["triggeredAtUtc"], stop_b["triggeredAtUtc"])
            self.assertNotEqual(stop_a["stopRevision"], stop_b["stopRevision"])
            before_bytes = path.read_text(encoding="utf-8")

            stale_a = authorize_emergency_stop_release(
                path,
                account_login=123456,
                server="DBGMarkets-Live",
                operator_authenticated=True,
                operator_id="owner-op",
                approval_reason="Delayed release for STOP-A",
                uncertain_entry_state={},
                expected_stop_revision=stop_a["stopRevision"],
                now_utc=same_ts + 1,
            )
            self.assertTrue(stale_a["releaseDenied"])
            self.assertEqual(stale_a["releaseDeniedReason"], "STALE_LATCH_REVISION_MISMATCH")
            self.assertEqual(path.read_text(encoding="utf-8"), before_bytes)

            ok_b = authorize_emergency_stop_release(
                path,
                account_login=123456,
                server="DBGMarkets-Live",
                operator_authenticated=True,
                operator_id="owner-op",
                approval_reason="Verified flat after STOP-B",
                uncertain_entry_state={},
                expected_stop_revision=stop_b["stopRevision"],
                now_utc=same_ts + 2,
            )
            self.assertFalse(ok_b["releaseDenied"])
            self.assertFalse(ok_b["emergencyStopActive"])
            self.assertEqual(ok_b["releasedStopRevision"], stop_b["stopRevision"])
            self.assertFalse(ok_b["liveAuthorized"])

    def test_forged_or_missing_revision_on_active_record_or_release_is_denied(self):
        with robust_tempdir() as folder:
            path = Path(folder) / "latch.json"
            missing_rev_record = json.dumps({
                "schemaVersion": 1,
                "emergencyStopActive": True,
                "accountLogin": 123456,
                "server": "DBGMarkets-Live",
                "stopCategory": "OPERATOR_EMERGENCY_STOP",
                "triggeredBy": "owner-op",
                "triggeredAtUtc": 1700000000,
                "reason": "NO_REVISION",
            })
            path.write_text(missing_rev_record, encoding="utf-8")
            read_res = read_bound_emergency_stop_latch(path, account_login=123456, server="DBGMarkets-Live")
            self.assertEqual(read_res["stopCategory"], "FAIL_CLOSED_UNVERIFIED")
            self.assertTrue(read_res["blockNewOrders"])

            stop = persist_operator_emergency_stop(
                path, account_login=123456, server="DBGMarkets-Live", operator_id="owner-op", now_utc=1700000000
            )
            before_bytes = path.read_text(encoding="utf-8")

            for bad_rev, expected_code in (
                ("", "EXPECTED_REVISION_REQUIRED"),
                ("short", "EXPECTED_REVISION_REQUIRED"),
                ("0" * 32, "STALE_LATCH_REVISION_MISMATCH"),
            ):
                res = authorize_emergency_stop_release(
                    path,
                    account_login=123456,
                    server="DBGMarkets-Live",
                    operator_authenticated=True,
                    operator_id="owner-op",
                    approval_reason="Bad revision",
                    uncertain_entry_state={},
                    expected_stop_revision=bad_rev,
                )
                self.assertTrue(res["releaseDenied"])
                self.assertEqual(res["releaseDeniedReason"], expected_code)
                self.assertEqual(path.read_text(encoding="utf-8"), before_bytes)
            self.assertTrue(stop["stopRevision"])

    def test_recovery_restores_active_stop_with_fresh_revision_and_never_unlocks_directly(self):
        with robust_tempdir() as folder:
            path = Path(folder) / "latch.json"
            recovered = initialize_or_recover_emergency_stop_latch(
                path,
                account_login=123456,
                server="DBGMarkets-Live",
                operator_authenticated=True,
                operator_id="owner-op",
                recovery_reason="Rebuilt after missing file",
                recovery_evidence_verified=True,
                now_utc=1700000050,
            )
            self.assertFalse(recovered["recoveryDenied"])
            self.assertTrue(recovered["emergencyStopActive"])
            self.assertTrue(recovered["blockNewOrders"])
            self.assertEqual(recovered["stopCategory"], "OPERATOR_EMERGENCY_STOP")
            self.assertTrue(recovered["stopRevision"])

            released = authorize_emergency_stop_release(
                path,
                account_login=123456,
                server="DBGMarkets-Live",
                operator_authenticated=True,
                operator_id="owner-op",
                approval_reason="Verified clean broker flat state",
                uncertain_entry_state={},
                expected_stop_revision=recovered["stopRevision"],
                now_utc=1700000060,
            )
            self.assertFalse(released["releaseDenied"])
            self.assertFalse(released["emergencyStopActive"])

    def test_protective_semantics_and_enriched_fill_evidence_mocks_never_clear_freeze(self):
        with robust_tempdir() as folder:
            path = Path(folder) / "latch.json"
            persist_operator_emergency_stop(
                path, account_login=123456, server="DBGMarkets-Live", operator_id="owner-op", now_utc=1700000000
            )
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
