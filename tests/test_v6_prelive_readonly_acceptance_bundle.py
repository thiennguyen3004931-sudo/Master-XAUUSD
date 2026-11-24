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
        self.assertFalse(rep["liveAuthorized"])
        self.assertFalse(rep["orderSendCalled"])
        self.assertFalse(rep["secretsExposed"])

    def test_all_windows_probes_pass_produces_ready_for_approval_never_live_authorized(self) -> None:
        rep = mod.assemble_prelive_evidence_bundle(
            release_commit_sha="b5a1ba6",
            platform_name="Windows",
            generated_at_utc=1795460000,
            process_entrypoint_report={"activeRuntimeReleaseVerified": True, "liveAuthorized": False, "reportSha256": "a" * 64},
            effective_acl_dpapi_report={"effectiveAclVerified": True, "dpapiReady": True, "liveAuthorized": False, "reportSha256": "b" * 64},
            mt5_readonly_ledger_report={"brokerProvenanceVerified": True, "orderSendCalled": False, "liveAuthorized": False, "reportSha256": "c" * 64},
            ci_required_all_green_sha="b5a1ba6",
        )
        self.assertEqual(rep["classification"], "READY_FOR_OWNER_LIVE_APPROVAL")
        self.assertEqual(rep["blockingReasons"], [])
        self.assertFalse(rep["liveAuthorized"])
        self.assertEqual(len(rep["bundleSha256"]), 64)


if __name__ == "__main__":
    unittest.main()
