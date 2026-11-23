"""Regression: current-process Win32/DPAPI evidence is NOT service proof."""

from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import v6_windows_service_accesscheck_dpapi as mod


class TestWindowsServiceAccessCheckDpapi(unittest.TestCase):
    def test_even_full_current_process_accesscheck_remains_diagnostic(self) -> None:
        screened = mod.evaluate_accesscheck_result(
            path_label="latch_file", exists=True,
            access_check_succeeded=True, read_granted=True,
            write_granted=True, require_write=True,
            broad_principal_screen_passed=True,
        )
        self.assertFalse(screened["verified"])
        self.assertTrue(screened["currentProcessAccessCheckObserved"])
        self.assertEqual(screened["status"], "SCREENED_ONLY")
        self.assertEqual(screened["reason"], "CURRENT_PROCESS_RIGHTS_SCREENED_NOT_SERVICE_TOKEN")
        no_screen = mod.evaluate_accesscheck_result(
            path_label="latch_file", exists=True,
            access_check_succeeded=True, read_granted=True,
            write_granted=True, require_write=True,
            broad_principal_screen_passed=False,
        )
        self.assertFalse(no_screen["verified"])
        self.assertEqual(no_screen["reason"], "BROAD_PRINCIPAL_ACE_SCREEN_NOT_CONFIRMED")
        no_write = mod.evaluate_accesscheck_result(
            path_label="latch_file", exists=True,
            access_check_succeeded=True, read_granted=True,
            write_granted=False, require_write=True,
            broad_principal_screen_passed=True,
        )
        self.assertFalse(no_write["verified"])
        self.assertEqual(no_write["reason"], "SERVICE_TOKEN_LACKS_EFFECTIVE_WRITE")

    def test_fabricated_service_claims_and_matching_sha_cannot_authorize(self) -> None:
        # Entire argument set is caller-controlled. Old version returned
        # SERVICE_TOKEN_ACCESSCHECK_AND_DPAPI_VERIFIED from these values.
        fake_target = {
            "pathLabel": "runtime_dir", "verified": True,
            "accessCheckExecuted": True, "readGranted": True,
            "writeGranted": True,
        }
        sha = "a" * 40
        cls = mod.classify_service_token_attestation(
            platform_name="Windows", target_results=[fake_target],
            dpapi_roundtrip_ok=True,
            declared_release_sha=sha, observed_release_sha=sha,
        )
        self.assertEqual(cls["status"], "BLOCKED")
        self.assertEqual(cls["reason"], "WINDOWS_SERVICE_PROCESS_TOKEN_AND_DEPLOYED_RELEASE_NOT_ATTESTED")
        self.assertTrue(cls["currentProcessAccessCheckObserved"])
        self.assertTrue(cls["dpapiCurrentUserRoundTripObserved"])
        self.assertTrue(cls["releaseShaTextMatched"])
        self.assertFalse(cls["releaseShaMatched"])
        self.assertFalse(cls["serviceTokenAccessCheckVerified"])
        self.assertFalse(cls["dpapiServiceIdentityVerified"])
        self.assertFalse(cls["liveAuthorized"])

        short = mod.classify_service_token_attestation(
            platform_name="Windows", target_results=[fake_target],
            dpapi_roundtrip_ok=True,
            declared_release_sha="4baaa5b", observed_release_sha="4baaa5b",
        )
        self.assertFalse(short["releaseShaTextMatched"])
        self.assertFalse(short["releaseShaMatched"])
        linux = mod.classify_service_token_attestation(
            platform_name="Linux", target_results=[fake_target],
            dpapi_roundtrip_ok=True,
            declared_release_sha=sha, observed_release_sha=sha,
        )
        self.assertEqual(linux["status"], "UNSUPPORTED_PLATFORM")
        self.assertFalse(linux["serviceTokenAccessCheckVerified"])

    def test_simulated_windows_success_is_still_not_service_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            runtime = Path(temp) / ".runtime"
            runtime.mkdir()
            (runtime / "v6-emergency-stop-latch.json").write_text("{}", encoding="utf8")
            (runtime / "v6-uncertain-entry.json").write_text("{}", encoding="utf8")
            with (
                patch.object(mod.platform, "system", return_value="Windows"),
                patch.object(mod, "_win32_access_check_path", return_value=(True, True)),
                patch.object(mod, "_win32_dpapi_sentinel_roundtrip", return_value=True),
            ):
                rep = mod.build_service_token_report(
                    runtime_dir=runtime,
                    declared_release_sha="c" * 40,
                    observed_release_sha="c" * 40,
                    now_utc=1795419000,
                )
            self.assertEqual(rep["status"], "BLOCKED")
            self.assertFalse(rep["serviceTokenAccessCheckVerified"])
            self.assertFalse(rep["dpapiServiceIdentityVerified"])
            self.assertTrue(rep["dpapiCurrentUserRoundTripObserved"])
            self.assertTrue(rep["releaseShaTextMatched"])
            self.assertFalse(rep["releaseShaMatched"])
            self.assertFalse(rep["deployedProcessReleaseVerified"])
            self.assertTrue(rep["diagnosticOnly"])
            self.assertFalse(rep["liveAuthorized"])
            self.assertEqual(len(rep["targets"]), 3)
            self.assertTrue(all(t["accessCheckExecuted"] for t in rep["targets"]))
            self.assertTrue(all(not t["verified"] for t in rep["targets"]))

    def test_non_windows_report_fail_closed_and_self_digest_not_signature(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(mod.platform, "system", return_value="Linux"):
                report = mod.build_service_token_report(
                    runtime_dir=Path(temp) / ".runtime",
                    declared_release_sha="c" * 40,
                    observed_release_sha="c" * 40,
                    now_utc=1795419000,
                )
            self.assertEqual(report["status"], "UNSUPPORTED_PLATFORM")
            self.assertFalse(report["serviceTokenAccessCheckVerified"])
            self.assertFalse(report["dpapiServiceIdentityVerified"])
            self.assertFalse(report["releaseShaMatched"])
            self.assertFalse(report["liveAuthorized"])
            self.assertFalse(report["secretsExposed"])
            self.assertEqual(len(report["reportSha256"]), 64)
            self.assertEqual(report["reportSha256"], mod._sha256_canonical(report))


if __name__ == "__main__":
    unittest.main()
