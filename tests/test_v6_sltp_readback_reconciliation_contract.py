"""Unit tests for V6 Standalone Protective SL/TP Broker Readback & Reconciliation Contract."""

from __future__ import annotations

from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import v6_sltp_readback_reconciliation_contract as rec


def _expected(**overrides):
    base = {
        "ticket": 123456,
        "magic": 600001,
        "symbol": "XAUUSD.G",
        "direction": "BUY",
        "previousSl": 2643.0,
        "expectedTargetSl": 2650.2,
        "expectedTp": 2665.0,
        "previousVolume": 0.10,
    }
    base.update(overrides)
    return base


def _readback(**overrides):
    base = {
        "positionExists": True,
        "ticket": 123456,
        "magic": 600001,
        "symbol": "XAUUSD.G",
        "direction": "BUY",
        "sl": 2650.2,
        "tp": 2665.0,
        "volume": 0.10,
        "snapshotTimestampUtc": 1795420000,
    }
    base.update(overrides)
    return base


class TestSltpReadbackReconciliationContract(unittest.TestCase):
    def test_confirmed_target_sltp_and_partial_volume_reduction(self) -> None:
        ok = rec.reconcile_sltp_broker_readback(
            expected_state=_expected(),
            broker_readback=_readback(),
            now_utc=1795420003,
        )
        self.assertTrue(ok["reconciled"])
        self.assertEqual(ok["status"], "RECONCILED_TARGET_CONFIRMED")
        self.assertFalse(ok["retryRequired"])
        self.assertFalse(ok["liveAuthorized"])

        partial = rec.reconcile_sltp_broker_readback(
            expected_state=_expected(),
            broker_readback=_readback(volume=0.05),
            now_utc=1795420003,
        )
        self.assertTrue(partial["reconciled"])
        self.assertEqual(partial["status"], "RECONCILED_PARTIAL_VOLUME_AND_TARGET_SL_CONFIRMED")
        self.assertEqual(partial["observedVolume"], 0.05)

    def test_sl_not_applied_triggers_retry_without_closing_position(self) -> None:
        drift = rec.reconcile_sltp_broker_readback(
            expected_state=_expected(),
            broker_readback=_readback(sl=2643.0),
            now_utc=1795420003,
        )
        self.assertFalse(drift["reconciled"])
        self.assertEqual(drift["status"], "DRIFT_SL_NOT_APPLIED_RETRY_REQUIRED")
        self.assertTrue(drift["retryRequired"])
        self.assertFalse(drift["positionAutoClosed"])

    def test_sl_widened_or_tp_wiped_escalates_and_blocks_new_orders(self) -> None:
        widened = rec.reconcile_sltp_broker_readback(
            expected_state=_expected(),
            broker_readback=_readback(sl=2640.0),
            now_utc=1795420003,
        )
        self.assertFalse(widened["reconciled"])
        self.assertEqual(widened["status"], "UNSAFE_SL_WIDENED_OR_TP_WIPED_ESCALATE")
        self.assertTrue(widened["escalationRequired"])
        self.assertTrue(widened["blockNewOrders"])

        wiped_tp = rec.reconcile_sltp_broker_readback(
            expected_state=_expected(),
            broker_readback=_readback(tp=None),
            now_utc=1795420003,
        )
        self.assertEqual(wiped_tp["status"], "UNSAFE_SL_WIDENED_OR_TP_WIPED_ESCALATE")
        self.assertTrue(wiped_tp["escalationRequired"])

    def test_closed_position_requires_closing_deal_evidence_and_stale_snapshot_fails_closed(self) -> None:
        closed_ok = rec.reconcile_sltp_broker_readback(
            expected_state=_expected(),
            broker_readback=_readback(positionExists=False),
            now_utc=1795420003,
            closing_deal_observed=True,
        )
        self.assertTrue(closed_ok["reconciled"])
        self.assertEqual(closed_ok["status"], "RECONCILED_POSITION_CLOSED_AT_BROKER")

        closed_missing = rec.reconcile_sltp_broker_readback(
            expected_state=_expected(),
            broker_readback=_readback(positionExists=False),
            now_utc=1795420003,
            closing_deal_observed=False,
        )
        self.assertFalse(closed_missing["reconciled"])
        self.assertEqual(closed_missing["status"], "MISSING_POSITION_WITHOUT_CLOSING_DEAL")
        self.assertTrue(closed_missing["escalationRequired"])

        stale = rec.reconcile_sltp_broker_readback(
            expected_state=_expected(),
            broker_readback=_readback(snapshotTimestampUtc=1795419900),
            now_utc=1795420003,
        )
        self.assertFalse(stale["reconciled"])
        self.assertEqual(stale["status"], "SNAPSHOT_STALE_OR_UNVERIFIED_FAIL_CLOSED")


if __name__ == "__main__":
    unittest.main()
