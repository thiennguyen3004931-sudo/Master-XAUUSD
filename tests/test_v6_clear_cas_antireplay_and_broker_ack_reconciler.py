"""Unit tests for V6 G1 (#7) CLEAR CAS/anti-replay audit contract and broker ACK reconciler."""

from __future__ import annotations

import copy
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import v6_clear_cas_antireplay_and_broker_ack_reconciler as mod


OPERATOR_SID_HASH = "a" * 64
RELEASE_SHA = "a5c0fbf3a2ed4fb5434ca6f85b2a315a096b2b4d"


def _base_state() -> dict:
    return {
        "generation": 3,
        "emergencyStopActive": True,
        "blockNewOrders": True,
        "accountLogin": 100362,
        "server": "DBGMarkets-Live",
        "releaseCommitSha": RELEASE_SHA,
        "consumedNonces": ["already-used-nonce-0001"],
        "auditChain": [],
        "liveAuthorized": False,
    }


def _valid_clear_request() -> dict:
    return {
        "expectedGeneration": 3,
        "nonce": "fresh-operator-nonce-20261123-001",
        "issuedAtUtc": 1795413000,
        "expiresAtUtc": 1795413200,
        "accountLogin": 100362,
        "server": "DBGMarkets-Live",
        "releaseCommitSha": RELEASE_SHA,
        "hostAclVerified": True,
        "dpapiServiceIdentityVerified": True,
        "brokerReconciliationClean": True,
        "signatureVerified": True,
        "operatorSidSha256": OPERATOR_SID_HASH,
    }


def _base_intent(*, stop_active: bool = False) -> dict:
    return {
        "clientOrderId": "v6-ord-20261123-001",
        "accountLogin": 100362,
        "server": "DBGMarkets-Live",
        "symbol": "XAUUSD.G",
        "direction": "BUY",
        "requestedVolume": 0.10,
        "stopActiveDuringSend": stop_active,
    }


class TestClearCasAntiReplay(unittest.TestCase):
    def test_valid_clear_increments_generation_and_appends_verified_audit_chain(self) -> None:
        res = mod.validate_and_apply_clear_cas(
            current_state=_base_state(),
            clear_request=_valid_clear_request(),
            now_utc=1795413100,
        )
        self.assertTrue(res["accepted"])
        self.assertFalse(res["liveAuthorized"])
        self.assertFalse(res["state"]["liveAuthorized"])
        self.assertEqual(res["state"]["generation"], 4)
        self.assertIn("fresh-operator-nonce-20261123-001", res["state"]["consumedNonces"])
        self.assertEqual(len(res["state"]["auditChain"]), 1)
        self.assertTrue(mod.verify_audit_chain(res["state"]["auditChain"])["valid"])

    def test_replay_nonce_is_rejected(self) -> None:
        req = _valid_clear_request()
        req["nonce"] = "already-used-nonce-0001"
        res = mod.validate_and_apply_clear_cas(
            current_state=_base_state(),
            clear_request=req,
            now_utc=1795413100,
        )
        self.assertFalse(res["accepted"])
        self.assertEqual(res["reason"], "CLEAR_NONCE_REPLAY_DETECTED")
        self.assertFalse(res["liveAuthorized"])

    def test_cas_generation_mismatch_is_rejected(self) -> None:
        req = _valid_clear_request()
        req["expectedGeneration"] = 2
        res = mod.validate_and_apply_clear_cas(
            current_state=_base_state(),
            clear_request=req,
            now_utc=1795413100,
        )
        self.assertFalse(res["accepted"])
        self.assertEqual(res["reason"], "CAS_GENERATION_MISMATCH")

    def test_expired_or_excessive_ttl_window_is_rejected(self) -> None:
        req = _valid_clear_request()
        res_expired = mod.validate_and_apply_clear_cas(
            current_state=_base_state(),
            clear_request=req,
            now_utc=1795413201,
        )
        self.assertFalse(res_expired["accepted"])
        self.assertEqual(res_expired["reason"], "CLEAR_EXPIRED_OR_INVALID_WINDOW")

        req_long = _valid_clear_request()
        req_long["expiresAtUtc"] = req_long["issuedAtUtc"] + 301
        res_long = mod.validate_and_apply_clear_cas(
            current_state=_base_state(),
            clear_request=req_long,
            now_utc=1795413100,
        )
        self.assertFalse(res_long["accepted"])
        self.assertEqual(res_long["reason"], "CLEAR_EXPIRED_OR_INVALID_WINDOW")

    def test_binding_mismatch_and_missing_trust_preconditions_fail_closed(self) -> None:
        req_srv = _valid_clear_request()
        req_srv["server"] = "OtherBroker-Demo"
        res_srv = mod.validate_and_apply_clear_cas(
            current_state=_base_state(),
            clear_request=req_srv,
            now_utc=1795413100,
        )
        self.assertFalse(res_srv["accepted"])
        self.assertEqual(res_srv["reason"], "CLEAR_BINDING_MISMATCH:server")

        req_trust = _valid_clear_request()
        req_trust["dpapiServiceIdentityVerified"] = False
        res_trust = mod.validate_and_apply_clear_cas(
            current_state=_base_state(),
            clear_request=req_trust,
            now_utc=1795413100,
        )
        self.assertFalse(res_trust["accepted"])
        self.assertIn("dpapiServiceIdentityVerified", res_trust["reason"])

    def test_tampered_audit_chain_is_detected(self) -> None:
        first = mod.validate_and_apply_clear_cas(
            current_state=_base_state(),
            clear_request=_valid_clear_request(),
            now_utc=1795413100,
        )
        tampered_state = copy.deepcopy(first["state"])
        tampered_state["auditChain"][0]["operatorSidSha256"] = "b" * 64
        self.assertFalse(mod.verify_audit_chain(tampered_state["auditChain"])["valid"])

        req2 = _valid_clear_request()
        req2["expectedGeneration"] = 4
        req2["nonce"] = "fresh-operator-nonce-20261123-002"
        res2 = mod.validate_and_apply_clear_cas(
            current_state=tampered_state,
            clear_request=req2,
            now_utc=1795413150,
        )
        self.assertFalse(res2["accepted"])
        self.assertTrue(res2["reason"].startswith("AUDIT_CHAIN_CORRUPTED:"))


class TestBrokerAckAndPartialFillReconciler(unittest.TestCase):
    def test_confirmed_full_fill_counts_only_deal_entry_in(self) -> None:
        deals = [
            {
                "entry": 0,
                "clientOrderId": "v6-ord-20261123-001",
                "accountLogin": 100362,
                "server": "DBGMarkets-Live",
                "symbol": "XAUUSD.G",
                "direction": "BUY",
                "volume": 0.10,
            },
            {
                "entry": 1,
                "clientOrderId": "v6-ord-20261123-001",
                "accountLogin": 100362,
                "server": "DBGMarkets-Live",
                "symbol": "XAUUSD.G",
                "direction": "BUY",
                "volume": 0.10,
            },
        ]
        res = mod.reconcile_broker_ack_and_fills(
            intent=_base_intent(),
            broker_ack={"retcode": 10009, "timedOut": False, "disconnected": False},
            observed_deals=deals,
        )
        self.assertEqual(res["outcome"], "CONFIRMED_FULL_FILL")
        self.assertEqual(res["filledVolume"], 0.10)
        self.assertEqual(res["matchingOpeningDealCount"], 1)
        self.assertEqual(res["ignoredDealCount"], 1)
        self.assertFalse(res["uncertainExposure"])
        self.assertFalse(res["blockNewOrders"])
        self.assertFalse(res["liveAuthorized"])

    def test_partial_fill_blocks_new_orders_and_tracks_remaining_volume(self) -> None:
        deals = [
            {
                "entry": 0,
                "clientOrderId": "v6-ord-20261123-001",
                "accountLogin": 100362,
                "server": "DBGMarkets-Live",
                "symbol": "XAUUSD.G",
                "direction": "BUY",
                "volume": 0.04,
            }
        ]
        res = mod.reconcile_broker_ack_and_fills(
            intent=_base_intent(stop_active=True),
            broker_ack={"retcode": 10010, "timedOut": False, "disconnected": False},
            observed_deals=deals,
            observed_pending_orders=[
                {
                    "clientOrderId": "v6-ord-20261123-001",
                    "accountLogin": 100362,
                    "server": "DBGMarkets-Live",
                    "symbol": "XAUUSD.G",
                }
            ],
        )
        self.assertEqual(res["outcome"], "CONFIRMED_PARTIAL_FILL")
        self.assertEqual(res["filledVolume"], 0.04)
        self.assertEqual(res["remainingVolume"], 0.06)
        self.assertTrue(res["blockNewOrders"])
        self.assertTrue(res["requiresPartialFillReconciliation"])
        self.assertTrue(res["requiresPostStopFlattenOrReview"])
        self.assertFalse(res["liveAuthorized"])

    def test_timeout_or_ambiguous_ack_without_fills_fails_closed_uncertain(self) -> None:
        res = mod.reconcile_broker_ack_and_fills(
            intent=_base_intent(),
            broker_ack={"retcode": None, "timedOut": True, "disconnected": False},
            observed_deals=[],
        )
        self.assertEqual(res["outcome"], "AMBIGUOUS_EXPOSURE_UNKNOWN")
        self.assertTrue(res["uncertainExposure"])
        self.assertTrue(res["emergencyStopActive"])
        self.assertTrue(res["blockNewOrders"])
        self.assertFalse(res["liveAuthorized"])

    def test_confirmed_rejection_clears_uncertain_but_preserves_stop_block(self) -> None:
        res = mod.reconcile_broker_ack_and_fills(
            intent=_base_intent(stop_active=True),
            broker_ack={"retcode": 10019, "timedOut": False, "disconnected": False},
            observed_deals=[],
        )
        self.assertEqual(res["outcome"], "CONFIRMED_NO_FILL_REJECTED")
        self.assertFalse(res["uncertainExposure"])
        self.assertTrue(res["emergencyStopActive"])
        self.assertTrue(res["blockNewOrders"])
        self.assertFalse(res["liveAuthorized"])

    def test_overfill_triggers_emergency_stop_fail_closed(self) -> None:
        deals = [
            {
                "entry": 0,
                "clientOrderId": "v6-ord-20261123-001",
                "accountLogin": 100362,
                "server": "DBGMarkets-Live",
                "symbol": "XAUUSD.G",
                "direction": "BUY",
                "volume": 0.15,
            }
        ]
        res = mod.reconcile_broker_ack_and_fills(
            intent=_base_intent(),
            broker_ack={"retcode": 10009, "timedOut": False, "disconnected": False},
            observed_deals=deals,
        )
        self.assertEqual(res["outcome"], "UNSAFE_OVERFILL_DETECTED")
        self.assertTrue(res["uncertainExposure"])
        self.assertTrue(res["emergencyStopActive"])
        self.assertTrue(res["blockNewOrders"])
        self.assertFalse(res["liveAuthorized"])


if __name__ == "__main__":
    unittest.main()
