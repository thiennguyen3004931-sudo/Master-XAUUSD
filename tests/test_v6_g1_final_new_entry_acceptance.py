"""Offline fail-closed tests for G1 P0 final new-entry Emergency Stop source+host acceptance (#7)."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.v6_g1_final_new_entry_acceptance import (
    compute_release_hmac,
    evaluate_g1_final_new_entry_acceptance,
)

SECRET = b"offline-test-secret-key-do-not-use-in-prod"


def _valid_inputs() -> dict:
    now_utc = 1700000100
    stop_rev = 7
    sig = compute_release_hmac(
        secret_key=SECRET,
        account_login=1001,
        server="Broker-Demo",
        stop_revision=stop_rev,
        issued_at_utc=now_utc - 10,
    )
    return {
        "call_site_function": "_execute_order_serialized",
        "strict_new_order_lock_held": True,
        "expected_account_login": 1001,
        "expected_server": "Broker-Demo",
        "now_utc": now_utc,
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
            "stopRevision": stop_rev,
            "issuedAtUtc": now_utc - 10,
            "hmacSha256": sig,
        },
        "signing_secret": SECRET,
        "persistence_state": {
            "atomicTempRenameUsed": True,
            "fsyncCompleted": True,
            "lockFileHeld": True,
            "lockOwnerPid": 4321,
            "stopRevision": stop_rev,
            "emergencyStopActive": False,
            "uncertainEntryLatched": False,
        },
        "broker_readback": {
            "accountInfo": {"login": 1001, "server": "Broker-Demo"},
            "positions": [],
            "orders": [],
            "snapshotEpochUtc": now_utc - 1,
            "reconciliationClean": True,
        },
    }


class G1FinalNewEntryAcceptanceTests(unittest.TestCase):
    def test_admits_only_when_all_host_service_custody_persistence_and_readback_pass(self):
        res = evaluate_g1_final_new_entry_acceptance(**_valid_inputs())
        self.assertTrue(res["admitted"])
        self.assertFalse(res["orderSendExecuted"])
        self.assertFalse(res["liveAuthorized"])
        self.assertEqual(res["reason"], "G1_FINAL_NEW_ENTRY_SOURCE_AND_HOST_CONTRACT_SATISFIED")

    def test_fails_closed_on_non_windows_acl_symlink_or_interactive_service(self):
        kw_linux = _valid_inputs()
        kw_linux["host_acl_evidence"]["platform"] = "Linux"
        r1 = evaluate_g1_final_new_entry_acceptance(**kw_linux)
        self.assertFalse(r1["admitted"])
        self.assertEqual(r1["reason"], "WINDOWS_HOST_ACL_NOT_VERIFIED")

        kw_broad = _valid_inputs()
        kw_broad["host_acl_evidence"]["icacls"] = {"nonAdminWriteDenied": False, "broadWriteGrants": ["Everyone:(F)"]}
        r2 = evaluate_g1_final_new_entry_acceptance(**kw_broad)
        self.assertFalse(r2["admitted"])
        self.assertEqual(r2["reason"], "HOST_ICACLS_BROAD_WRITE_OR_MISSING")

        kw_interactive = _valid_inputs()
        kw_interactive["service_identity"]["isInteractiveUser"] = True
        r3 = evaluate_g1_final_new_entry_acceptance(**kw_interactive)
        self.assertFalse(r3["admitted"])
        self.assertEqual(r3["reason"], "INTERACTIVE_USER_SESSION_REJECTED")

    def test_fails_closed_on_missing_lock_emergency_latch_none_readback_or_bad_hmac(self):
        kw_nolock = _valid_inputs()
        kw_nolock["strict_new_order_lock_held"] = False
        self.assertEqual(
            evaluate_g1_final_new_entry_acceptance(**kw_nolock)["reason"],
            "STRICT_NEW_ORDER_LOCK_NOT_HELD",
        )

        kw_estop = _valid_inputs()
        kw_estop["persistence_state"]["emergencyStopActive"] = True
        self.assertEqual(
            evaluate_g1_final_new_entry_acceptance(**kw_estop)["reason"],
            "EMERGENCY_STOP_ACTIVE_FAIL_CLOSED",
        )

        kw_none_rb = _valid_inputs()
        kw_none_rb["broker_readback"]["positions"] = None
        self.assertEqual(
            evaluate_g1_final_new_entry_acceptance(**kw_none_rb)["reason"],
            "BROKER_READBACK_INCOMPLETE_OR_NONE",
        )

        kw_bad_hmac = _valid_inputs()
        kw_bad_hmac["release_auth"]["hmacSha256"] = "0" * 64
        self.assertEqual(
            evaluate_g1_final_new_entry_acceptance(**kw_bad_hmac)["reason"],
            "RELEASE_AUTH_HMAC_INVALID",
        )


if __name__ == "__main__":
    unittest.main()
