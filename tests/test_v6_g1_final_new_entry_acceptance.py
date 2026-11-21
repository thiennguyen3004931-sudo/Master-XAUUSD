"""G1 P0 regression: trusted-sounding caller claims never authorize MT5."""
import copy
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.v6_g1_final_new_entry_acceptance import (
    compute_release_hmac,
    evaluate_g1_final_new_entry_acceptance,
    verify_atomic_durable_stop_persistence,
    verify_host_trusted_stop_release,
    verify_readonly_broker_readback,
)

SECRET = b"offline-test-secret-key-do-not-use-in-prod"


def _valid_inputs():
    now, rev, issued, expires = 1700000100, 7, 1700000090, 1700000200
    sig = compute_release_hmac(
        secret_key=SECRET, account_login=1001, server="Broker-Demo",
        stop_revision=rev, operator_id="offline-owner",
        approval_reason="Read-only release checklist scenario",
        issued_at_utc=issued, expires_at_utc=expires,
    )
    return {
        "call_site_function": "_execute_order_serialized",
        "strict_new_order_lock_held": True,
        "expected_account_login": 1001,
        "expected_server": "Broker-Demo",
        "now_utc": now,
        "host_acl_evidence": {
            "platform": "Windows",
            "windowsHostAclVerified": True,
            "reparseOrSymlinkDetected": False,
            "icacls": {"nonAdminWriteDenied": True, "broadWriteGrants": []},
        },
        "service_identity": {
            "serviceAccount": "NT SERVICE\\MasterXAUUSD",
            "isInteractiveUser": False,
        },
        "key_custody": {
            "secretValuesExposed": False,
            "dpapiProtected": True,
        },
        "release_auth": {
            "accountLogin": 1001,
            "server": "Broker-Demo",
            "stopRevision": rev,
            "operatorId": "offline-owner",
            "approvalReason": "Read-only release checklist scenario",
            "issuedAtUtc": issued,
            "expiresAtUtc": expires,
            "hmacSha256": sig,
        },
        "signing_secret": SECRET,
        "persistence_state": {
            "atomicTempRenameUsed": True,
            "fsyncCompleted": True,
            "lockFileHeld": True,
            "lockOwnerPid": 4321,
            "stopRevision": rev,
            "emergencyStopActive": False,
            "uncertainEntryLatched": False,
        },
        "broker_readback": {
            "accountInfo": {"login": 1001, "server": "Broker-Demo"},
            "positions": [], "orders": [],
            "snapshotEpochUtc": now - 1,
            "reconciliationClean": True,
        },
    }


class G1FinalNewEntryAcceptanceTests(unittest.TestCase):
    def assert_never_authorizes(self, res):
        self.assertFalse(res["admitted"])
        self.assertFalse(res["ok"])
        self.assertFalse(res["liveAuthorized"])
        self.assertFalse(res["executionEnabled"])
        self.assertFalse(res["runtimePreSendAccepted"])
        self.assertFalse(res["orderSendExecuted"])
        self.assertFalse(res["hostIndependentlyVerified"])
        self.assertFalse(res["brokerReadbackIndependentlyVerified"])

    def test_perfectly_forged_caller_claims_and_valid_hmac_remain_non_authorizing(self):
        kwargs = _valid_inputs()
        before = copy.deepcopy(kwargs)
        result = evaluate_g1_final_new_entry_acceptance(**kwargs)
        self.assert_never_authorizes(result)
        self.assertTrue(result["offlineChecksPassed"])
        self.assertEqual(result["reason"], "OFFLINE_CLAIMS_MATCH_BUT_RUNTIME_ADMISSION_UNAVAILABLE")
        self.assertEqual(kwargs, before)

    def test_signed_reason_operator_and_expiry_are_bound_and_tamper_denied(self):
        base = _valid_inputs()
        for key, value in (
            ("approvalReason", "Different reason"),
            ("operatorId", "different-owner"),
            ("expiresAtUtc", 1700000199),
            ("hmacSha256", "0" * 64),
        ):
            with self.subTest(key=key):
                data = copy.deepcopy(base)
                data["release_auth"][key] = value
                result = evaluate_g1_final_new_entry_acceptance(**data)
                self.assert_never_authorizes(result)
                self.assertFalse(result["offlineChecksPassed"])
                self.assertEqual(result["reason"], "RELEASE_AUTH_HMAC_INVALID")

    def test_stop_emergency_or_unknown_entry_and_release_revision_are_blocked(self):
        data = _valid_inputs()
        for k, value, expected in (
            ("emergencyStopActive", True, "EMERGENCY_STOP_ACTIVE_FAIL_CLOSED"),
            ("uncertainEntryLatched", True, "UNCERTAIN_ENTRY_LATCHED_FAIL_CLOSED"),
            ("fsyncCompleted", False, "ATOMIC_FSYNC_PERSISTENCE_UNVERIFIED"),
            ("lockFileHeld", False, "DURABLE_LOCK_FILE_NOT_HELD"),
            ("lockOwnerPid", True, "DURABLE_LOCK_FILE_NOT_HELD"),
            ("stopRevision", None, "INVALID_STOP_REVISION"),
        ):
            with self.subTest(key=k):
                kwargs = copy.deepcopy(data)
                kwargs["persistence_state"][k] = value
                res = evaluate_g1_final_new_entry_acceptance(**kwargs)
                self.assert_never_authorizes(res)
                self.assertEqual(res["reason"], expected)
        kw = copy.deepcopy(data)
        kw["persistence_state"]["stopRevision"] = 10
        r = evaluate_g1_final_new_entry_acceptance(**kw)
        self.assert_never_authorizes(r)
        self.assertEqual(r["reason"], "RELEASE_STOP_REVISION_MISMATCH")

    def test_nonwindows_acl_broad_write_reparse_or_interactive_are_refused(self):
        for source, field, replacement, expected in (
            ("host_acl_evidence", "platform", "Linux", "WINDOWS_HOST_ACL_NOT_VERIFIED"),
            ("host_acl_evidence", "reparseOrSymlinkDetected", True, "REPARSE_OR_SYMLINK_DETECTED"),
            ("service_identity", "isInteractiveUser", True, "INTERACTIVE_USER_SESSION_REJECTED"),
            ("key_custody", "dpapiProtected", False, "DPAPI_CUSTODY_NOT_VERIFIED"),
        ):
            with self.subTest(source=source, field=field):
                kw = _valid_inputs()
                kw[source][field] = replacement
                x = evaluate_g1_final_new_entry_acceptance(**kw)
                self.assert_never_authorizes(x)
                self.assertEqual(x["reason"], expected)
        kw = _valid_inputs()
        kw["host_acl_evidence"]["icacls"]["broadWriteGrants"] = ["Everyone:(F)"]
        x = evaluate_g1_final_new_entry_acceptance(**kw)
        self.assert_never_authorizes(x)
        self.assertEqual(x["reason"], "HOST_ICACLS_BROAD_WRITE_OR_MISSING")

    def test_broker_inventory_unavailable_corrupt_duplicate_or_clock_skew_fails(self):
        cases = (
            (None, "BROKER_READBACK_INCOMPLETE_OR_NONE"),
            ("invalid", "BROKER_READBACK_INVALID_INVENTORY_TYPE"),
            ([None], "INVALID_POSITION_RECORD"),
            ([{"ticket": 1}, {"ticket": 1}], "INVALID_OR_DUPLICATE_POSITION_TICKET"),
            ([{"ticket": True}], "INVALID_OR_DUPLICATE_POSITION_TICKET"),
        )
        for positions, expected in cases:
            with self.subTest(positions=positions):
                kw = _valid_inputs()
                kw["broker_readback"]["positions"] = positions
                x = evaluate_g1_final_new_entry_acceptance(**kw)
                self.assert_never_authorizes(x)
                self.assertEqual(x["reason"], expected)
        kw = _valid_inputs()
        kw["broker_readback"]["snapshotEpochUtc"] = 1700000030
        self.assertEqual(
            evaluate_g1_final_new_entry_acceptance(**kw)["reason"],
            "BROKER_READBACK_STALE_OR_FUTURE",
        )

    def test_wrong_function_or_lock_cannot_be_accepted(self):
        for change, expected in (
            ({"call_site_function": "modify_position_sl_tp"}, "INVALID_CALL_SITE_FUNCTION"),
            ({"strict_new_order_lock_held": False}, "STRICT_NEW_ORDER_LOCK_NOT_HELD"),
            ({"expected_account_login": False}, "INVALID_EXPECTED_ACCOUNT_SERVER_OR_CLOCK"),
            ({"now_utc": None}, "INVALID_EXPECTED_ACCOUNT_SERVER_OR_CLOCK"),
        ):
            with self.subTest(change=change):
                kw = _valid_inputs()
                kw.update(change)
                x = evaluate_g1_final_new_entry_acceptance(**kw)
                self.assert_never_authorizes(x)
                self.assertEqual(x["reason"], expected)

    def test_direct_claim_check_helpers_also_never_return_ok_or_permission(self):
        kw = _valid_inputs()
        r = verify_atomic_durable_stop_persistence(kw["persistence_state"])
        self.assertTrue(r["claimsMatch"])
        self.assertFalse(r["ok"])
        r = verify_host_trusted_stop_release(
            host_acl_evidence=kw["host_acl_evidence"],
            service_identity=kw["service_identity"],
            key_custody=kw["key_custody"],
            release_auth=kw["release_auth"],
            expected_account_login=kw["expected_account_login"],
            expected_server=kw["expected_server"],
            expected_stop_revision=kw["persistence_state"]["stopRevision"],
            now_utc=kw["now_utc"],
            signing_secret=kw["signing_secret"],
        )
        self.assertTrue(r["claimsMatch"])
        self.assertFalse(r["ok"])
        r = verify_readonly_broker_readback(
            readback=kw["broker_readback"],
            expected_account_login=kw["expected_account_login"],
            expected_server=kw["expected_server"],
            now_utc=kw["now_utc"],
        )
        self.assertTrue(r["claimsMatch"])
        self.assertFalse(r["ok"])

    def test_hmac_has_short_explicit_window_and_requires_reason(self):
        kw = _valid_inputs()
        for expires, reason in (
            (1700000500, "RELEASE_AUTH_STALE_FUTURE_OR_WINDOW_INVALID"),
            (1700000080, "RELEASE_AUTH_STALE_FUTURE_OR_WINDOW_INVALID"),
        ):
            with self.subTest(expires=expires):
                data = copy.deepcopy(kw)
                data["release_auth"]["expiresAtUtc"] = expires
                x = evaluate_g1_final_new_entry_acceptance(**data)
                self.assert_never_authorizes(x)
                self.assertEqual(x["reason"], reason)
        with self.assertRaises(ValueError):
            compute_release_hmac(
                secret_key=SECRET, account_login=1001, server="Broker-Demo",
                stop_revision=7, operator_id="owner", approval_reason="",
                issued_at_utc=1700000090, expires_at_utc=1700000200,
            )


if __name__ == "__main__":
    unittest.main()
