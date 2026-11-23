"""Unit tests for V6 API Auth, Safe Startup & 5-Stage Production Readiness Gate (Streams B & F)."""

from __future__ import annotations

import hashlib
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import v6_api_auth_and_readiness_gate as gate


SAMPLE_INPUT = "v6-unit-test-sample-value-20261123-abcdef"
SAMPLE_DIGEST = hashlib.sha256(SAMPLE_INPUT.encode("utf-8")).hexdigest()
ALLOWED_LOCAL_ORIGIN = "local-ui-5717"


class TestApiAuthAndSafeStartup(unittest.TestCase):
    def test_valid_token_and_allowlisted_origin_authorized_without_live(self) -> None:
        res = gate.evaluate_api_request_auth(
            provided_token=SAMPLE_INPUT,
            expected_token_sha256=SAMPLE_DIGEST,
            origin=ALLOWED_LOCAL_ORIGIN,
            allowed_origins=[ALLOWED_LOCAL_ORIGIN],
        )
        self.assertTrue(res["authorized"])
        self.assertFalse(res["liveAuthorized"])

    def test_missing_token_bypass_flags_and_wildcard_cors_rejected(self) -> None:
        r_bypass = gate.evaluate_api_request_auth(
            provided_token=SAMPLE_INPUT,
            expected_token_sha256=SAMPLE_DIGEST,
            origin=ALLOWED_LOCAL_ORIGIN,
            allowed_origins=[ALLOWED_LOCAL_ORIGIN],
            allow_localhost_bypass_flag=True,
        )
        self.assertFalse(r_bypass["authorized"])
        self.assertEqual(r_bypass["reason"], "INSECURE_LOCALHOST_OR_LAN_BYPASS_FORBIDDEN")

        r_wild = gate.evaluate_api_request_auth(
            provided_token=SAMPLE_INPUT,
            expected_token_sha256=SAMPLE_DIGEST,
            origin=ALLOWED_LOCAL_ORIGIN,
            allowed_origins=["*"],
        )
        self.assertFalse(r_wild["authorized"])
        self.assertEqual(r_wild["reason"], "WILDCARD_CORS_ORIGIN_FORBIDDEN")

        r_short = gate.evaluate_api_request_auth(
            provided_token="",
            expected_token_sha256=SAMPLE_DIGEST,
            origin=ALLOWED_LOCAL_ORIGIN,
            allowed_origins=[ALLOWED_LOCAL_ORIGIN],
        )
        self.assertFalse(r_short["authorized"])
        self.assertEqual(r_short["reason"], "MISSING_OR_SHORT_CONTROL_TOKEN")

    def test_safe_startup_never_restores_live_auto_dca_from_persisted_state(self) -> None:
        st = gate.build_safe_startup_state(
            {"liveArmed": True, "autoEnabled": True, "dcaEnabled": True, "liveAuthorized": True}
        )
        self.assertEqual(st["botMode"], "DISARMED")
        self.assertFalse(st["liveArmed"])
        self.assertFalse(st["autoEnabled"])
        self.assertFalse(st["dcaEnabled"])
        self.assertFalse(st["liveAuthorized"])
        self.assertEqual(
            st["suppressedPersistedFlags"],
            ["autoEnabled", "dcaEnabled", "liveArmed", "liveAuthorized"],
        )


class TestFiveStageReadinessSeparation(unittest.TestCase):
    def test_ci_green_alone_stays_live_blocked(self) -> None:
        rep = gate.evaluate_final_production_acceptance(
            ci_all_required_green=True,
            branch_protection_enforced=True,
            emergency_stop_and_clear_verified=True,
            cross_process_stop_send_verified=True,
            broker_ack_reconciliation_verified=True,
            windows_runtime_process_verified=False,
            windows_acl_dpapi_service_verified=False,
            api_auth_hardened_verified=True,
            mt5_readonly_contract_verified=True,
            autolot_and_daily_loss_verified=True,
            trading_sl_be_trailing_verified=True,
            release_manifest_and_rollback_verified=True,
            owner_explicit_live_approval=False,
        )
        self.assertFalse(rep["CODE_READY"])
        self.assertFalse(rep["HOST_VERIFIED"])
        self.assertFalse(rep["BROKER_VERIFIED"])
        self.assertFalse(rep["RISK_VERIFIED"])
        self.assertFalse(rep["LIVE_AUTHORIZED"])
        self.assertTrue(rep["claimOnlyStages"]["CODE_READY"])
        self.assertFalse(rep["claimOnlyStages"]["HOST_VERIFIED"])
        self.assertTrue(rep["claimOnlyStages"]["BROKER_VERIFIED"])
        self.assertEqual(rep["classification"], "LIVE_BLOCKED")
        self.assertIn("windows_runtime_process_verified", rep["unverifiedItems"])

    def test_all_prelive_verified_without_owner_approval_is_ready_for_approval_not_live(self) -> None:
        rep = gate.evaluate_final_production_acceptance(
            ci_all_required_green=True,
            branch_protection_enforced=True,
            emergency_stop_and_clear_verified=True,
            cross_process_stop_send_verified=True,
            broker_ack_reconciliation_verified=True,
            windows_runtime_process_verified=True,
            windows_acl_dpapi_service_verified=True,
            api_auth_hardened_verified=True,
            mt5_readonly_contract_verified=True,
            autolot_and_daily_loss_verified=True,
            trading_sl_be_trailing_verified=True,
            release_manifest_and_rollback_verified=True,
            owner_explicit_live_approval=False,
        )
        self.assertFalse(rep["CODE_READY"])
        self.assertFalse(rep["HOST_VERIFIED"])
        self.assertFalse(rep["BROKER_VERIFIED"])
        self.assertFalse(rep["RISK_VERIFIED"])
        self.assertFalse(rep["LIVE_AUTHORIZED"])
        self.assertTrue(rep["claimedPreLiveChecklistComplete"])
        self.assertTrue(rep["claimOnlyStages"]["HOST_VERIFIED"])
        self.assertFalse(rep["runtimeIntegrationVerified"])
        self.assertEqual(rep["classification"], "LIVE_BLOCKED")
        self.assertEqual(rep["unverifiedItems"], [])
        self.assertEqual(
            rep["reason"], "CALLER_BOOLEAN_CLAIMS_NOT_VERIFIED_HOST_BROKER_EVIDENCE"
        )


    def test_spoofed_all_true_claims_including_owner_approval_cannot_grant_live(self) -> None:
        rep = gate.evaluate_final_production_acceptance(
            ci_all_required_green=True,
            branch_protection_enforced=True,
            emergency_stop_and_clear_verified=True,
            cross_process_stop_send_verified=True,
            broker_ack_reconciliation_verified=True,
            windows_runtime_process_verified=True,
            windows_acl_dpapi_service_verified=True,
            api_auth_hardened_verified=True,
            mt5_readonly_contract_verified=True,
            autolot_and_daily_loss_verified=True,
            trading_sl_be_trailing_verified=True,
            release_manifest_and_rollback_verified=True,
            owner_explicit_live_approval=True,
        )
        self.assertTrue(rep["claimedOwnerApproval"])
        self.assertTrue(rep["claimedPreLiveChecklistComplete"])
        self.assertEqual(rep["classification"], "LIVE_BLOCKED")
        self.assertFalse(rep["LIVE_AUTHORIZED"])
        self.assertFalse(rep["CODE_READY"])
        self.assertFalse(rep["HOST_VERIFIED"])

if __name__ == "__main__":
    unittest.main()
