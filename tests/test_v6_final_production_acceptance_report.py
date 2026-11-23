"""Unit tests for V6 Final Production Acceptance Report Generator (#7/#91)."""

from __future__ import annotations

from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import v6_final_production_acceptance_report as fpa


def _all_pass_evidence() -> dict:
    return {
        cid: {"verdict": "PASS", "evidenceRef": f"sha256:verified-{cid}"}
        for cid, _dom in fpa.REQUIRED_CRITERIA
    }


class TestFinalProductionAcceptanceReport(unittest.TestCase):
    def test_missing_host_evidence_stays_live_blocked_even_with_owner_flag(self) -> None:
        ev = _all_pass_evidence()
        ev["windows_running_v6_process_attestation"] = {"verdict": "UNVERIFIED", "evidenceRef": "host-not-started"}
        rep = fpa.build_final_production_acceptance_report(
            release_commit_sha="29fab95",
            evidence_map=ev,
            owner_explicit_live_approval=True,
        )
        self.assertTrue(rep["CODE_READY"])
        self.assertFalse(rep["HOST_VERIFIED"])
        self.assertFalse(rep["LIVE_AUTHORIZED"])
        self.assertEqual(rep["classification"], "LIVE_BLOCKED")
        self.assertIn("windows_running_v6_process_attestation", rep["blockingCriteria"])

    def test_pass_without_evidence_ref_downgrades_to_unverified(self) -> None:
        ev = _all_pass_evidence()
        ev["mt5_readonly_account_and_contract"] = {"verdict": "PASS", "evidenceRef": ""}
        rep = fpa.build_final_production_acceptance_report(
            release_commit_sha="29fab95",
            evidence_map=ev,
            owner_explicit_live_approval=False,
        )
        self.assertFalse(rep["BROKER_VERIFIED"])
        self.assertEqual(rep["classification"], "LIVE_BLOCKED")

    def test_all_12_pass_without_owner_approval_is_ready_for_approval_not_live(self) -> None:
        rep = fpa.build_final_production_acceptance_report(
            release_commit_sha="29fab95",
            evidence_map=_all_pass_evidence(),
            owner_explicit_live_approval=False,
        )
        self.assertTrue(rep["CODE_READY"])
        self.assertTrue(rep["HOST_VERIFIED"])
        self.assertTrue(rep["BROKER_VERIFIED"])
        self.assertTrue(rep["RISK_VERIFIED"])
        self.assertFalse(rep["LIVE_AUTHORIZED"])
        self.assertEqual(rep["classification"], "READY_FOR_OWNER_LIVE_APPROVAL")
        self.assertEqual(rep["passCount"], 12)


if __name__ == "__main__":
    unittest.main()
