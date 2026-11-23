"""Unit tests for Windows Service-Token Win32 AccessCheck & DPAPI Attestation (Issue #7)."""

from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import v6_windows_service_accesscheck_dpapi as mod


class TestWindowsServiceAccessCheckDpapi(unittest.TestCase):
    def test_accesscheck_requires_read_write_and_broad_principal_screen(self) -> None:
        ok = mod.evaluate_accesscheck_result(
            path_label="latch_file",
            exists=True,
            access_check_succeeded=True,
            read_granted=True,
            write_granted=True,
            require_write=True,
            broad_principal_screen_passed=True,
        )
        self.assertTrue(ok["verified"])
        self.assertEqual(ok["status"], "VERIFIED")

        no_broad_screen = mod.evaluate_accesscheck_result(
            path_label="latch_file",
            exists=True,
            access_check_succeeded=True,
            read_granted=True,
            write_granted=True,
            require_write=True,
            broad_principal_screen_passed=False,
        )
        self.assertFalse(no_broad_screen["verified"])
        self.assertEqual(no_broad_screen["reason"], "BROAD_PRINCIPAL_ACE_SCREEN_NOT_CONFIRMED")

        no_write = mod.evaluate_accesscheck_result(
            path_label="latch_file",
            exists=True,
            access_check_succeeded=True,
            read_granted=True,
            write_granted=False,
            require_write=True,
            broad_principal_screen_passed=True,
        )
        self.assertFalse(no_write["verified"])
        self.assertEqual(no_write["reason"], "SERVICE_TOKEN_LACKS_EFFECTIVE_WRITE")

    def test_classify_service_token_attestation_blocks_on_any_missing_gate_and_never_authorizes_live(self) -> None:
        verified_target = {"pathLabel": "runtime_dir", "verified": True, "reason": "WIN32_SERVICE_TOKEN_ACCESSCHECK_VERIFIED"}

        linux = mod.classify_service_token_attestation(
            platform_name="Linux",
            target_results=[verified_target],
            dpapi_roundtrip_ok=True,
            declared_release_sha="4baaa5b",
            observed_release_sha="4baaa5b",
        )
        self.assertEqual(linux["status"], "UNSUPPORTED_PLATFORM")
        self.assertFalse(linux["liveAuthorized"])

        sha_mismatch = mod.classify_service_token_attestation(
            platform_name="Windows",
            target_results=[verified_target],
            dpapi_roundtrip_ok=True,
            declared_release_sha="4baaa5b",
            observed_release_sha="deadbeef",
        )
        self.assertEqual(sha_mismatch["status"], "BLOCKED")
        self.assertEqual(sha_mismatch["reason"], "DECLARED_RELEASE_SHA_MISMATCH_OR_MISSING")
        self.assertFalse(sha_mismatch["liveAuthorized"])

        all_ok = mod.classify_service_token_attestation(
            platform_name="Windows",
            target_results=[verified_target],
            dpapi_roundtrip_ok=True,
            declared_release_sha="4baaa5b",
            observed_release_sha="4baaa5b",
        )
        self.assertEqual(all_ok["status"], "SERVICE_TOKEN_ACCESSCHECK_AND_DPAPI_VERIFIED")
        self.assertTrue(all_ok["serviceTokenAccessCheckVerified"])
        self.assertTrue(all_ok["dpapiServiceIdentityVerified"])
        self.assertTrue(all_ok["releaseShaMatched"])
        self.assertFalse(all_ok["liveAuthorized"])

    def test_build_service_token_report_fail_closed_with_deterministic_hash(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            rep = mod.build_service_token_report(
                runtime_dir=Path(tmp) / ".runtime",
                declared_release_sha="4baaa5b",
                observed_release_sha="4baaa5b",
                now_utc=1795419000,
            )
            self.assertFalse(rep["liveAuthorized"])
            self.assertFalse(rep["secretsExposed"])
            self.assertEqual(len(rep["reportSha256"]), 64)
            self.assertEqual(rep["reportSha256"], mod._sha256_canonical(rep))


if __name__ == "__main__":
    unittest.main()
