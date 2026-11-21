"""V6 G1 static audit negatives: source inspection MUST NOT imply LIVE approval."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.v6_final_order_send_static_audit import (
    SCOPE, audit_final_new_order_source,
)


MINIMAL_SOURCE = """
def partial_close_position(mt5):
    return mt5.order_send({"action": "close"})

def modify_position_sl_tp(mt5):
    return mt5.order_send({"action": "SLTP"})

def close_position_by_ticket(mt5):
    return mt5.order_send({"action": "close-ticket"})

def execute_order(mt5):
    with _strict_new_order_lock():
        state = _read_uncertain_entry_state()
        _write_uncertain_entry_state(state)
        return _execute_order_serialized(mt5)

def _execute_order_serialized(mt5):
    final_margin = verify_last_moment_entry_margin(mt5)
    if not final_margin.get("ok"):
        return final_margin
    return mt5.order_send({"action": "new"})
"""


class FinalOrderSendStaticAuditTests(unittest.TestCase):
    def assert_never_approves(self, report):
        self.assertEqual(report["scope"], SCOPE)
        self.assertFalse(report["runtimeFinalStopVerified"])
        self.assertFalse(report["interprocessLockIndependentlyVerified"])
        self.assertFalse(report["durableMarkerIndependentlyVerified"])
        self.assertFalse(report["brokerFillIndependentlyVerified"])
        self.assertFalse(report["hostAclIndependentlyVerified"])
        self.assertFalse(report["liveAuthorized"])
        self.assertFalse(report["admitted"])
        self.assertFalse(report["orderSendInvoked"])
        self.assertFalse(report["readyForLive"])

    def test_actual_probe_path_reports_missing_final_runtime_emergency_stop(self):
        # Parse the REAL checked-out source; never import/execute it.
        path = ROOT / "scripts" / "mt5-direct-probe.py"
        self.assertTrue(path.is_file(), "Required real runtime script unavailable")
        report = audit_final_new_order_source(path.read_text(encoding="utf-8"))
        self.assert_never_approves(report)
        self.assertTrue(report["staticEvidenceCollected"])
        self.assertEqual(report["directOrderSendSiteCount"], 4)
        self.assertTrue(report["directCallSiteStructureObserved"])
        self.assertEqual(len(report["newEntryDirectSites"]), 1)
        self.assertEqual(len(report["protectiveOrExitDirectSites"]), 3)
        self.assertTrue(report["newEntryLockCallObserved"])
        self.assertTrue(report["pendingMarkerWriteBeforeSerializerCallObserved"])
        self.assertTrue(report["lastMomentMarginGuardBeforeSendObserved"])
        self.assertFalse(report["potentialFinalEmergencyStopHookCallObserved"])
        self.assertIn(
            "FINAL_NEW_ENTRY_EMERGENCY_STOP_CALL_NOT_OBSERVED",
            report["missingOrUnverifiedGates"],
        )

    def test_minimal_structural_evidence_still_never_authorizes_trade(self):
        report = audit_final_new_order_source(MINIMAL_SOURCE)
        self.assert_never_approves(report)
        self.assertTrue(report["directCallSiteStructureObserved"])
        self.assertTrue(report["newEntryLockCallObserved"])
        self.assertTrue(report["pendingMarkerWriteBeforeSerializerCallObserved"])
        self.assertTrue(report["lastMomentMarginGuardBeforeSendObserved"])
        self.assertFalse(report["potentialFinalEmergencyStopHookCallObserved"])

    def test_alternative_alias_and_getattr_dispatch_are_unverified(self):
        mutations = (
            "\ndef alias(mt5):\n    submit = mt5.order_send\n    return submit({})\n",
            "\ndef dynamic(mt5):\n    return getattr(mt5, 'order_send')({})\n",
            "\ndef foreign(client):\n    return client.order_send({})\n",
        )
        for mutated in mutations:
            with self.subTest(mutated=mutated):
                report = audit_final_new_order_source(MINIMAL_SOURCE + mutated)
                self.assert_never_approves(report)
                self.assertFalse(report["directCallSiteStructureObserved"])
                self.assertTrue(report["unmappedOrAliasedOrderSendLines"])
                self.assertIn("ORDER_SEND_CALL_SITE_COVERAGE_UNVERIFIED", report["missingOrUnverifiedGates"])

    def test_missing_lock_marker_or_final_margin_is_reported_as_incomplete(self):
        mutations = (
            (
                MINIMAL_SOURCE.replace(
                    "    with _strict_new_order_lock():\n",
                    "    if True:\n",
                ), "NEW_ENTRY_LOCK_CALL_NOT_OBSERVED",
            ),
            (
                MINIMAL_SOURCE.replace(
                    "        _write_uncertain_entry_state(state)\n", "",
                ), "PENDING_MARKER_PRECEDENCE_UNVERIFIED",
            ),
            (
                MINIMAL_SOURCE.replace(
                    "    if not final_margin.get(\"ok\"):\n        return final_margin\n",
                    "",
                ), "LAST_MOMENT_MARGIN_GUARD_UNVERIFIED",
            ),
        )
        for source, missing in mutations:
            with self.subTest(missing=missing):
                report = audit_final_new_order_source(source)
                self.assert_never_approves(report)
                self.assertIn(missing, report["missingOrUnverifiedGates"])

    def test_faked_named_stop_call_does_not_prove_real_latch_protection(self):
        mutated = MINIMAL_SOURCE.replace(
            "    return mt5.order_send({\"action\": \"new\"})",
            "    read_bound_emergency_stop_latch(None)\n"
            "    return mt5.order_send({\"action\": \"new\"})",
        )
        report = audit_final_new_order_source(mutated)
        self.assert_never_approves(report)
        self.assertTrue(report["potentialFinalEmergencyStopHookCallObserved"])
        self.assertIn(
            "DURABLE_RUNTIME_STOP_AND_ACCOUNT_BINDING_NOT_ATTESTED",
            report["missingOrUnverifiedGates"],
        )

    def test_syntax_errors_and_missing_source_fail_closed_without_side_effects(self):
        for source in ("", None, "def broken(:"):
            with self.subTest(source=source):
                report = audit_final_new_order_source(source)
                self.assert_never_approves(report)
                self.assertFalse(report["staticEvidenceCollected"])


if __name__ == "__main__":
    unittest.main()
