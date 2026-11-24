"""Unit tests for V6 One-Shot Read-Only Pre-LIVE Evidence Bundle Collector."""

from __future__ import annotations

from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import v6_prelive_readonly_acceptance_bundle as mod


class TestPreliveReadonlyAcceptanceBundle(unittest.TestCase):
    def test_missing_or_linux_evidence_stays_live_blocked(self) -> None:
        rep = mod.assemble_prelive_evidence_bundle(
            release_commit_sha="b5a1ba6",
            platform_name="Linux",
            generated_at_utc=1795460000,
            process_entrypoint_report={"activeRuntimeReleaseVerified": True, "liveAuthorized": False, "reportSha256": "a" * 64},
            effective_acl_dpapi_report={"effectiveAclVerified": True, "dpapiReady": True, "liveAuthorized": False, "reportSha256": "b" * 64},
            mt5_readonly_ledger_report={"brokerProvenanceVerified": True, "orderSendCalled": False, "liveAuthorized": False, "reportSha256": "c" * 64},
            ci_required_all_green_sha="b5a1ba6",
        )
        self.assertEqual(rep["classification"], "LIVE_BLOCKED")
        self.assertIn("WINDOWS_HOST_REQUIRED", rep["blockingReasons"])
        self.assertIn("FULL_RELEASE_SHA_REQUIRED", rep["blockingReasons"])
        self.assertFalse(rep["liveAuthorized"])
        self.assertFalse(rep["orderSendCalled"])
        self.assertFalse(rep["secretsExposed"])

    def test_unattested_windows_claims_cannot_promote_any_verdict(self) -> None:
        rep = mod.assemble_prelive_evidence_bundle(
            release_commit_sha="b" * 40,
            platform_name="Windows",
            generated_at_utc=1795460000,
            process_entrypoint_report={"activeRuntimeReleaseVerified": True, "liveAuthorized": False, "reportSha256": "a" * 64},
            effective_acl_dpapi_report={"effectiveAclVerified": True, "dpapiReady": True, "liveAuthorized": False, "reportSha256": "b" * 64},
            mt5_readonly_ledger_report={"brokerProvenanceVerified": True, "orderSendCalled": False, "liveAuthorized": False, "reportSha256": "c" * 64},
            ci_required_all_green_sha="b" * 40,
        )
        self.assertEqual(rep["classification"], "LIVE_BLOCKED")
        self.assertEqual(set(rep["verdicts"].values()), {"UNVERIFIED"})
        self.assertIn("CI_EXACT_HEAD_UNVERIFIED", rep["blockingReasons"])
        self.assertIn("MT5_READONLY_BROKER_LEDGER_UNVERIFIED", rep["blockingReasons"])
        self.assertNotEqual(rep["evidenceHashes"]["mt5ReadonlyLedgerSha256"], "c" * 64)
        self.assertFalse(rep["liveAuthorized"])
        self.assertEqual(len(rep["bundleSha256"]), 64)

    def test_main_wires_process_attestation_into_bundle(self) -> None:
        source = (ROOT / "scripts" / "v6_prelive_readonly_acceptance_bundle.py").read_text(encoding="utf-8")
        self.assertIn("v6_runtime_process_attestation", source)
        self.assertIn("collect_runtime_process_attestation", source)
        self.assertIn("expected_release_sha=args.release_commit_sha", source)

    def test_digest_tracks_observed_content_not_declared_hash(self) -> None:
        def digest(timestamp, claimed):
            result = mod.assemble_prelive_evidence_bundle(
                release_commit_sha="a" * 40, platform_name="Windows", generated_at_utc=123,
                process_entrypoint_report=None, effective_acl_dpapi_report=None,
                mt5_readonly_ledger_report={"time": timestamp, "reportSha256": claimed},
            )
            self.assertEqual(result["classification"], "LIVE_BLOCKED")
            return result["evidenceHashes"]["mt5ReadonlyLedgerSha256"]

        self.assertEqual(digest(1, "first"), digest(1, "second"))
        self.assertNotEqual(digest(1, "first"), digest(2, "first"))


if __name__ == "__main__":
    unittest.main()
