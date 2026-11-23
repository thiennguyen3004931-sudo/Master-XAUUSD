"""Unit tests for read-only Windows SID-based Effective ACL & DPAPI probe (#7)."""

from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import v6_windows_effective_acl_dpapi_probe as probe


OPERATOR_SID = "S-1-5-21-1001-2002-3003-1001"
OTHER_USER_SID = "S-1-5-21-1001-2002-3003-1009"


def _strict_rules() -> list[dict]:
    return [
        {
            "sid": OPERATOR_SID,
            "accessControlType": "Allow",
            "rightsMask": 0x001F01FF,
            "rightsText": "FullControl",
            "isInherited": False,
        },
        {
            "sid": "S-1-5-18",
            "accessControlType": "Allow",
            "rightsMask": 0x001F01FF,
            "rightsText": "FullControl",
            "isInherited": False,
        },
        {
            "sid": "S-1-5-32-544",
            "accessControlType": "Allow",
            "rightsMask": 0x001F01FF,
            "rightsText": "FullControl",
            "isInherited": False,
        },
    ]


class TestV6WindowsEffectiveAclDpapiProbe(unittest.TestCase):
    def test_strict_operator_system_admin_sid_ace_screen_only(self) -> None:
        res = probe.evaluate_sid_acl_rules(
            path_label="latch_file",
            exists=True,
            owner_sid=OPERATOR_SID,
            current_user_sid=OPERATOR_SID,
            rules=_strict_rules(),
            reparse_detected=False,
        )
        self.assertFalse(res["verified"])
        self.assertTrue(res["acePolicyScreened"])
        self.assertEqual(res["status"], "ACE_POLICY_SCREENED_ONLY")
        self.assertEqual(res["reason"], "SID_ACE_RULES_SCREENED_NOT_EFFECTIVE_ACCESS")
        self.assertEqual(res["broadWriteGrants"], [])
        self.assertEqual(res["unexpectedWriteSids"], [])

    def test_broad_everyone_or_users_write_grant_blocks(self) -> None:
        rules = _strict_rules() + [
            {
                "sid": "S-1-1-0",
                "accessControlType": "Allow",
                "rightsMask": 0x40000000,
                "rightsText": "GenericWrite",
                "isInherited": True,
            },
            {
                "sid": "S-1-5-32-545",
                "accessControlType": "Allow",
                "rightsMask": 0x000301BF,
                "rightsText": "Modify",
                "isInherited": True,
            },
        ]
        res = probe.evaluate_sid_acl_rules(
            path_label="runtime_dir",
            exists=True,
            owner_sid=OPERATOR_SID,
            current_user_sid=OPERATOR_SID,
            rules=rules,
        )
        self.assertFalse(res["verified"])
        self.assertEqual(res["status"], "UNSAFE")
        self.assertEqual(res["reason"], "BROAD_PRINCIPAL_WRITE_GRANT_DETECTED")
        self.assertIn("S-1-1-0:Everyone", res["broadWriteGrants"])
        self.assertIn("S-1-5-32-545:BUILTIN_Users", res["broadWriteGrants"])

    def test_broad_readonly_grant_allowed_on_dir_but_blocked_on_dpapi_blob(self) -> None:
        rules = _strict_rules() + [
            {
                "sid": "S-1-5-11",
                "accessControlType": "Allow",
                "rightsMask": 0x00020089,
                "rightsText": "Read",
                "isInherited": True,
            }
        ]
        dir_res = probe.evaluate_sid_acl_rules(
            path_label="runtime_dir",
            exists=True,
            owner_sid=OPERATOR_SID,
            current_user_sid=OPERATOR_SID,
            rules=rules,
            forbid_any_broad_allow=False,
        )
        self.assertFalse(dir_res["verified"])
        self.assertTrue(dir_res["acePolicyScreened"])

        blob_res = probe.evaluate_sid_acl_rules(
            path_label="dpapi_operator_key_blob",
            exists=True,
            owner_sid=OPERATOR_SID,
            current_user_sid=OPERATOR_SID,
            rules=rules,
            forbid_any_broad_allow=True,
        )
        self.assertFalse(blob_res["verified"])
        self.assertIn("S-1-5-11:AuthenticatedUsers", blob_res["broadWriteGrants"])

    def test_unexpected_other_user_write_sid_blocks_with_hashed_sid_only(self) -> None:
        rules = _strict_rules() + [
            {
                "sid": OTHER_USER_SID,
                "accessControlType": "Allow",
                "rightsMask": 0x000301BF,
                "rightsText": "Modify",
                "isInherited": False,
            }
        ]
        res = probe.evaluate_sid_acl_rules(
            path_label="latch_file",
            exists=True,
            owner_sid=OPERATOR_SID,
            current_user_sid=OPERATOR_SID,
            rules=rules,
        )
        self.assertFalse(res["verified"])
        self.assertEqual(res["reason"], "UNEXPECTED_PRINCIPAL_WRITE_GRANT_DETECTED")
        self.assertEqual(len(res["unexpectedWriteSids"]), 1)
        self.assertTrue(res["unexpectedWriteSids"][0].startswith("sid_sha256:"))
        self.assertNotIn(OTHER_USER_SID, json.dumps(res))

    def test_reparse_point_and_untrusted_owner_fail_closed(self) -> None:
        reparse_res = probe.evaluate_sid_acl_rules(
            path_label="runtime_dir",
            exists=True,
            owner_sid=OPERATOR_SID,
            current_user_sid=OPERATOR_SID,
            rules=_strict_rules(),
            reparse_detected=True,
        )
        self.assertFalse(reparse_res["verified"])
        self.assertEqual(reparse_res["reason"], "REPARSE_POINT_OR_SYMLINK_DETECTED")

        owner_res = probe.evaluate_sid_acl_rules(
            path_label="runtime_dir",
            exists=True,
            owner_sid=OTHER_USER_SID,
            current_user_sid=OPERATOR_SID,
            rules=_strict_rules(),
        )
        self.assertFalse(owner_res["verified"])
        self.assertEqual(owner_res["reason"], "UNTRUSTED_OWNER_SID")

    def test_classify_effective_acl_and_dpapi_all_states_never_authorize_live(self) -> None:
        ok_target = {
            "pathLabel": "runtime_dir",
            "verified": False,
            "acePolicyScreened": True,
            "reason": "SID_ACE_RULES_SCREENED_NOT_EFFECTIVE_ACCESS",
        }
        bad_target = {
            "pathLabel": "latch_file",
            "verified": False,
            "reason": "BROAD_PRINCIPAL_WRITE_GRANT_DETECTED",
        }
        dpapi_ok = {
            "supported": True,
            "roundTripPassed": True,
            "reason": "DPAPI_CURRENT_USER_ROUNDTRIP_OK",
        }
        dpapi_bad = {
            "supported": True,
            "roundTripPassed": False,
            "reason": "CRYPT_PROTECT_DATA_FAILED",
        }

        non_win = probe.classify_effective_acl_and_dpapi(
            platform_name="Linux",
            target_results=[ok_target],
            dpapi_status=dpapi_ok,
            dpapi_key_blob_present=True,
            dpapi_key_blob_acl=ok_target,
        )
        self.assertEqual(non_win["status"], "UNSUPPORTED_PLATFORM")
        self.assertFalse(non_win["liveAuthorized"])

        acl_bad = probe.classify_effective_acl_and_dpapi(
            platform_name="Windows",
            target_results=[ok_target, bad_target],
            dpapi_status=dpapi_ok,
            dpapi_key_blob_present=True,
            dpapi_key_blob_acl=ok_target,
        )
        self.assertEqual(acl_bad["status"], "BLOCKED")
        self.assertIn("latch_file:BROAD_PRINCIPAL_WRITE_GRANT_DETECTED", acl_bad["reason"])
        self.assertFalse(acl_bad["liveAuthorized"])

        dpapi_fail = probe.classify_effective_acl_and_dpapi(
            platform_name="Windows",
            target_results=[ok_target],
            dpapi_status=dpapi_bad,
            dpapi_key_blob_present=True,
            dpapi_key_blob_acl=ok_target,
        )
        self.assertEqual(dpapi_fail["status"], "BLOCKED")
        self.assertEqual(dpapi_fail["reason"], "CRYPT_PROTECT_DATA_FAILED")
        self.assertFalse(dpapi_fail["liveAuthorized"])

        missing_blob = probe.classify_effective_acl_and_dpapi(
            platform_name="Windows",
            target_results=[ok_target],
            dpapi_status=dpapi_ok,
            dpapi_key_blob_present=False,
            dpapi_key_blob_acl=None,
        )
        self.assertEqual(missing_blob["status"], "PARTIAL_ACE_SCREEN_ONLY_KEY_BLOB_MISSING")
        self.assertFalse(missing_blob["effectiveAclVerified"])
        self.assertFalse(missing_blob["dpapiReady"])
        self.assertTrue(missing_blob["acePolicyScreened"])
        self.assertTrue(missing_blob["dpapiProbeCurrentUserRoundTripObserved"])
        self.assertFalse(missing_blob["dpapiKeyBlobVerified"])
        self.assertFalse(missing_blob["liveAuthorized"])

        full_ok = probe.classify_effective_acl_and_dpapi(
            platform_name="Windows",
            target_results=[ok_target],
            dpapi_status=dpapi_ok,
            dpapi_key_blob_present=True,
            dpapi_key_blob_acl=ok_target,
        )
        self.assertEqual(full_ok["status"], "UNVERIFIED_SERVICE_EFFECTIVE_ACCESS_AND_DPAPI_IDENTITY")
        self.assertFalse(full_ok["effectiveAclVerified"])
        self.assertFalse(full_ok["dpapiReady"])
        self.assertFalse(full_ok["dpapiKeyBlobVerified"])
        self.assertTrue(full_ok["acePolicyScreened"])
        self.assertTrue(full_ok["dpapiProbeCurrentUserRoundTripObserved"])
        self.assertTrue(full_ok["dpapiKeyBlobAcePolicyScreened"])
        self.assertFalse(full_ok["liveAuthorized"])

    def test_spoofed_verified_flags_cannot_prove_windows_service_identity(self) -> None:
        """Even all legacy 'verified' booleans cannot replace service AccessCheck."""
        operator_probe = {
            "pathLabel": "runtime_dir",
            "verified": True,
            "reason": "FAKE_VERIFIED_FLAG",
        }
        fake_blob = {"verified": True, "reason": "FAKE_BLOB"}
        dpapi_ok = {"supported": True, "roundTripPassed": True}
        result = probe.classify_effective_acl_and_dpapi(
            platform_name="Windows",
            target_results=[operator_probe],
            dpapi_status=dpapi_ok,
            dpapi_key_blob_present=True,
            dpapi_key_blob_acl=fake_blob,
        )
        self.assertEqual(result["status"], "BLOCKED")
        self.assertFalse(result["acePolicyScreened"])
        self.assertFalse(result["effectiveAclVerified"])
        self.assertFalse(result["dpapiReady"])
        self.assertFalse(result["dpapiKeyBlobVerified"])
        self.assertFalse(result["liveAuthorized"])

    def test_all_preliminary_checks_even_when_screened_are_unverified(self) -> None:
        screened = {"pathLabel": "runtime_dir", "acePolicyScreened": True, "verified": False}
        dpapi = {"supported": True, "roundTripPassed": True}
        result = probe.classify_effective_acl_and_dpapi(
            platform_name="Windows",
            target_results=[screened],
            dpapi_status=dpapi,
            dpapi_key_blob_present=True,
            dpapi_key_blob_acl=screened,
        )
        self.assertEqual(
            result["status"], "UNVERIFIED_SERVICE_EFFECTIVE_ACCESS_AND_DPAPI_IDENTITY"
        )
        self.assertTrue(result["acePolicyScreened"])
        self.assertTrue(result["dpapiProbeCurrentUserRoundTripObserved"])
        self.assertTrue(result["dpapiKeyBlobAcePolicyScreened"])
        self.assertFalse(result["effectiveAclVerified"])
        self.assertFalse(result["dpapiReady"])
        self.assertFalse(result["dpapiKeyBlobVerified"])
        self.assertFalse(result["liveAuthorized"])

    def test_build_probe_report_fail_closed_and_deterministic_sha256(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            rt = root / ".runtime"
            rt.mkdir()
            report = probe.build_probe_report(root, runtime_dir=rt, now_utc=1795409999)
            self.assertEqual(report["schemaVersion"], 1)
            self.assertFalse(report["liveAuthorized"])
            self.assertFalse(report["secretsExposed"])
            self.assertEqual(len(report["reportSha256"]), 64)
            self.assertEqual(report["reportSha256"], probe._canonical_report_sha256(report))


if __name__ == "__main__":
    unittest.main()
