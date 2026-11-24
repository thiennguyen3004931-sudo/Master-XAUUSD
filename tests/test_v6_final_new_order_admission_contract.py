"""Offline crash/stop-latch/ACL/reset admission tests for V6 G1/G4 (#7)."""
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
    persist_operator_emergency_stop,
    authorize_emergency_stop_release,
)
from scripts.v6_final_new_order_admission_contract import (
    ADMISSION_SCOPE_NOTE,
    compute_operator_reset_hmac,
    evaluate_final_new_order_admission,
    verify_operator_reset_token_offline,
    assess_caller_supplied_acl_claims,
)

VALID_ACL = {
    "aclVerified": True,
    "ownerPrincipal": "BUILTIN\\Administrators",
    "nonAdminWriteDenied": True,
    "worldReadable": False,
    "storageDirExists": True,
}
VALID_DAILY = {"ok": True, "dailyLimitBreached": False, "wouldExceedWithNewOrder": False}
VALID_MARGIN = {"ok": True, "freeMarginOk": True}
OPERATOR_SECRET = "offline-test-operator-secret-32b"


class FinalNewOrderAdmissionContractTests(unittest.TestCase):
    def test_protective_sl_tp_remains_unaffected_under_stop_latch_and_unverified_acl(self):
        with robust_tempdir() as folder:
            path = Path(folder) / "latch.json"
            persist_operator_emergency_stop(
                path, account_login=123456, server="DBGMarkets-Live", operator_id="owner-op", now_utc=1700000000
            )
            res = evaluate_final_new_order_admission(
                action_kind=ACTION_PROTECTIVE_SL_TP,
                latch_path=path,
                account_login=123456,
                server="DBGMarkets-Live",
                acl_attestation=None,
                uncertain_entry_state=None,
                daily_loss_check=None,
                last_moment_margin_check=None,
                live_armed=False,
            )
            self.assertFalse(res["admitted"])
            self.assertTrue(res["latchDoesNotBlockProtectiveManagement"])
            self.assertFalse(res["blockedByStopLatch"])
            self.assertFalse(res["liveExecutionWired"])
            self.assertFalse(res["liveAuthorized"])

    def test_authenticated_hmac_reset_and_full_admission_contract(self):
        with robust_tempdir() as folder:
            path = Path(folder) / "latch.json"
            stop = persist_operator_emergency_stop(
                path, account_login=123456, server="DBGMarkets-Live", operator_id="owner-op", now_utc=1700000000
            )
            before_bytes = path.read_text(encoding="utf-8")

            valid_sig = compute_operator_reset_hmac(
                operator_secret=OPERATOR_SECRET,
                account_login=123456,
                server="DBGMarkets-Live",
                stop_revision=stop["stopRevision"],
                operator_id="owner-op",
                approval_reason="Verified clean broker flat state",
                issued_at_utc=1700000000,
                expires_at_utc=1700000300,
            )
            bad_sig = verify_operator_reset_token_offline(
                latch_path=path,
                account_login=123456,
                server="DBGMarkets-Live",
                operator_id="owner-op",
                approval_reason="Reset",
                expected_stop_revision=stop["stopRevision"],
                issued_at_utc=1700000000,
                expires_at_utc=1700000300,
                provided_hmac="0" * 64,
                operator_secret=OPERATOR_SECRET,
                uncertain_entry_state={},
                now_utc=1700000050,
            )
            self.assertFalse(bad_sig["ok"])
            self.assertEqual(bad_sig["releaseDeniedReason"], "RESET_TOKEN_HMAC_MISMATCH")
            self.assertEqual(path.read_text(encoding="utf-8"), before_bytes)

            expired = verify_operator_reset_token_offline(
                latch_path=path,
                account_login=123456,
                server="DBGMarkets-Live",
                operator_id="owner-op",
                approval_reason="Reset",
                expected_stop_revision=stop["stopRevision"],
                issued_at_utc=1700000000,
                expires_at_utc=1700000300,
                provided_hmac=valid_sig,
                operator_secret=OPERATOR_SECRET,
                uncertain_entry_state={},
                now_utc=1700000301,
            )
            self.assertFalse(expired["ok"])
            self.assertEqual(expired["releaseDeniedReason"], "RESET_TOKEN_EXPIRED")

            released = verify_operator_reset_token_offline(
                latch_path=path,
                account_login=123456,
                server="DBGMarkets-Live",
                operator_id="owner-op",
                approval_reason="Verified clean broker flat state",
                expected_stop_revision=stop["stopRevision"],
                issued_at_utc=1700000000,
                expires_at_utc=1700000300,
                provided_hmac=valid_sig,
                operator_secret=OPERATOR_SECRET,
                uncertain_entry_state={},
                now_utc=1700000100,
            )
            self.assertFalse(released["ok"])
            self.assertTrue(released["tokenValidOffline"])
            self.assertTrue(released["releaseDenied"])
            self.assertFalse(released["releaseApplied"])
            self.assertFalse(released["operatorIdentityVerifiedByHost"])
            self.assertFalse(released["liveAuthorized"])
            self.assertEqual(path.read_text(encoding="utf-8"), before_bytes)

            tampered_reason = verify_operator_reset_token_offline(
                latch_path=path, account_login=123456, server="DBGMarkets-Live",
                operator_id="owner-op", approval_reason="Different approval reason",
                expected_stop_revision=stop["stopRevision"],
                issued_at_utc=1700000000, expires_at_utc=1700000300,
                provided_hmac=valid_sig, operator_secret=OPERATOR_SECRET,
                uncertain_entry_state={}, now_utc=1700000100,
            )
            self.assertFalse(tampered_reason["ok"])
            self.assertEqual(tampered_reason["releaseDeniedReason"], "RESET_TOKEN_HMAC_MISMATCH")
            self.assertEqual(path.read_text(encoding="utf-8"), before_bytes)

            # Isolated older offline latch fixture: actual runtime reset remains unavailable.
            manual_offline_clear = authorize_emergency_stop_release(
                path, account_login=123456, server="DBGMarkets-Live",
                operator_authenticated=True, operator_id="owner-op",
                approval_reason="Offline fixture only", uncertain_entry_state={},
                expected_stop_revision=stop["stopRevision"], now_utc=1700000101,
            )
            self.assertFalse(manual_offline_clear["releaseDenied"])

            no_acl = evaluate_final_new_order_admission(
                action_kind=ACTION_NEW_ORDER,
                latch_path=path,
                account_login=123456,
                server="DBGMarkets-Live",
                acl_attestation={**VALID_ACL, "nonAdminWriteDenied": False},
                uncertain_entry_state={},
                daily_loss_check=VALID_DAILY,
                last_moment_margin_check=VALID_MARGIN,
                live_armed=True,
            )
            self.assertFalse(no_acl["admitted"])
            self.assertEqual(no_acl["reason"], "WINDOWS_HOST_ACL_UNVERIFIED")

            bad_daily = evaluate_final_new_order_admission(
                action_kind=ACTION_NEW_ORDER,
                latch_path=path,
                account_login=123456,
                server="DBGMarkets-Live",
                acl_attestation=VALID_ACL,
                uncertain_entry_state={},
                daily_loss_check={**VALID_DAILY, "dailyLimitBreached": True},
                last_moment_margin_check=VALID_MARGIN,
                live_armed=True,
            )
            self.assertFalse(bad_daily["admitted"])
            self.assertEqual(bad_daily["reason"], "BLOCKED_DAILY_LOSS_OR_HISTORY_UNVERIFIED")

            admitted = evaluate_final_new_order_admission(
                action_kind=ACTION_NEW_ORDER,
                latch_path=path,
                account_login=123456,
                server="DBGMarkets-Live",
                acl_attestation=VALID_ACL,
                uncertain_entry_state={},
                daily_loss_check=VALID_DAILY,
                last_moment_margin_check=VALID_MARGIN,
                live_armed=True,
            )
            self.assertFalse(admitted["admitted"])
            self.assertTrue(admitted["offlineChecksPassed"])
            self.assertFalse(assess_caller_supplied_acl_claims(VALID_ACL)["hostAclIndependentlyVerified"])
            self.assertEqual(admitted["scope"], ADMISSION_SCOPE_NOTE)
            self.assertFalse(admitted["liveExecutionWired"])
            self.assertFalse(admitted["liveAuthorized"])


    def test_hmac_rejects_unbounded_ttl_and_future_issued_token_without_mutation(self):
        with robust_tempdir() as folder:
            path = Path(folder) / "latch.json"
            stop = persist_operator_emergency_stop(
                path, account_login=123456, server="DBGMarkets-Live",
                operator_id="owner-op", now_utc=1700000000,
            )
            original = path.read_bytes()
            for issued, expires, now, expected in (
                (1700000000, 1700001000, 1700000100, "RESET_TOKEN_WINDOW_INVALID"),
                (1700000200, 1700000300, 1700000100, "RESET_TOKEN_NOT_YET_VALID"),
            ):
                token = compute_operator_reset_hmac(
                    operator_secret=OPERATOR_SECRET, account_login=123456,
                    server="DBGMarkets-Live", stop_revision=stop["stopRevision"],
                    operator_id="owner-op", approval_reason="Offline review",
                    issued_at_utc=issued, expires_at_utc=expires,
                )
                res = verify_operator_reset_token_offline(
                    latch_path=path, account_login=123456, server="DBGMarkets-Live",
                    operator_id="owner-op", approval_reason="Offline review",
                    expected_stop_revision=stop["stopRevision"],
                    issued_at_utc=issued, expires_at_utc=expires, provided_hmac=token,
                    operator_secret=OPERATOR_SECRET, uncertain_entry_state={},
                    now_utc=now,
                )
                self.assertFalse(res["ok"])
                self.assertEqual(res["releaseDeniedReason"], expected)
                self.assertEqual(path.read_bytes(), original)

    def test_claimed_acl_does_not_grant_host_verified_status(self):
        result = assess_caller_supplied_acl_claims(VALID_ACL)
        self.assertFalse(result["ok"])
        self.assertTrue(result["claimsMatch"])
        self.assertFalse(result["hostAclIndependentlyVerified"])
        self.assertEqual(result["evidenceSource"], "CALLER_SUPPLIED_NOT_WINDOWS_HOST_ATTESTED")


if __name__ == "__main__":
    unittest.main()
