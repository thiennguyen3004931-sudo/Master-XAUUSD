"""Tests: caller-provided SLTP readback claims NEVER become broker proof."""

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
        "accountLogin": 5201362,
        "server": "DBGMarkets-Live",
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
        "accountLogin": 5201362,
        "server": "DBGMarkets-Live",
        "symbol": "XAUUSD.G",
        "direction": "BUY",
        "sl": 2650.2,
        "tp": 2665.0,
        "volume": 0.10,
        "snapshotTimestampUtc": 1795420000,
    }
    base.update(overrides)
    return base


def _check(expected=None, readback=None, **kwargs):
    return rec.reconcile_sltp_broker_readback(
        expected_state=_expected() if expected is None else expected,
        broker_readback=_readback() if readback is None else readback,
        now_utc=1795420003,
        **kwargs,
    )


class TestSltpReadbackReconciliationContract(unittest.TestCase):
    def test_exact_caller_match_and_partial_volume_are_not_broker_verified(self):
        exact = _check()
        self.assertEqual(exact["status"], "CALLER_TARGET_FIELDS_MATCH_UNVERIFIED")
        self.assertTrue(exact["candidateFieldsMatch"])
        self.assertFalse(exact["reconciled"])
        self.assertFalse(exact["retryRequired"])
        self.assertTrue(exact["reconciliationRequired"])
        self.assertTrue(exact["blockNewOrders"])
        self.assertFalse(exact["brokerReadbackProvenanceVerified"])
        self.assertFalse(exact["brokerAcknowledgementVerified"])
        self.assertFalse(exact["liveAuthorized"])

        partial = _check(readback=_readback(volume=0.05))
        self.assertEqual(partial["status"], "CALLER_PARTIAL_VOLUME_TARGET_MATCH_UNVERIFIED")
        self.assertTrue(partial["candidateFieldsMatch"])
        self.assertFalse(partial["reconciled"])
        self.assertEqual(partial["observedVolume"], 0.05)
        self.assertTrue(partial["blockNewOrders"])
        self.assertFalse(partial["liveAuthorized"])

    def test_no_sl_change_is_not_automatic_retry_permission(self):
        drift = _check(readback=_readback(sl=2643.0))
        self.assertEqual(drift["status"], "SL_DRIFT_UNVERIFIED_RECONCILE_BEFORE_RETRY")
        self.assertFalse(drift["reconciled"])
        self.assertFalse(drift["retryRequired"])
        self.assertTrue(drift["reconciliationRequired"])
        self.assertTrue(drift["blockNewOrders"])
        self.assertFalse(drift["positionAutoClosed"])
        self.assertFalse(drift["newOrderSubmitted"])

    def test_widened_stop_and_wiped_tp_escalate(self):
        wide = _check(readback=_readback(sl=2640.0))
        self.assertFalse(wide["reconciled"])
        self.assertEqual(wide["status"], "UNSAFE_SL_WIDENED_OR_TP_WIPED_ESCALATE")
        self.assertTrue(wide["escalationRequired"])
        self.assertTrue(wide["blockNewOrders"])
        self.assertFalse(wide["retryRequired"])

        wiped = _check(readback=_readback(tp=None))
        self.assertEqual(wiped["status"], "UNSAFE_SL_WIDENED_OR_TP_WIPED_ESCALATE")
        self.assertTrue(wiped["escalationRequired"])
        self.assertTrue(wiped["blockNewOrders"])

    def test_spoofed_closing_deal_boolean_never_reconciles_position(self):
        claimed = _check(
            readback=_readback(positionExists=False),
            closing_deal_observed=True,
        )
        self.assertEqual(claimed["status"], "CALLER_CLOSING_DEAL_CLAIM_UNVERIFIED")
        self.assertFalse(claimed["reconciled"])
        self.assertFalse(claimed["candidateFieldsMatch"])
        self.assertFalse(claimed["closingDealProvenanceVerified"])
        self.assertFalse(claimed["retryRequired"])
        self.assertTrue(claimed["blockNewOrders"])
        self.assertFalse(claimed["liveAuthorized"])

        absent = _check(readback=_readback(positionExists=False))
        self.assertFalse(absent["reconciled"])
        self.assertEqual(absent["status"], "MISSING_POSITION_WITHOUT_CLOSING_DEAL")
        self.assertTrue(absent["escalationRequired"])
        self.assertTrue(absent["blockNewOrders"])

        stale = _check(readback=_readback(snapshotTimestampUtc=1795419900))
        self.assertFalse(stale["reconciled"])
        self.assertEqual(stale["status"], "SNAPSHOT_STALE_OR_UNVERIFIED_FAIL_CLOSED")
        self.assertFalse(stale["retryRequired"])
        self.assertTrue(stale["blockNewOrders"])

    def test_account_server_ticket_and_volume_increase_block(self):
        for snap in (
            _readback(accountLogin=1),
            _readback(server="Other"),
            _readback(ticket=234567),
            _readback(symbol="GOLD"),
            _readback(direction="SELL"),
            _readback(magic=999),
        ):
            with self.subTest(snap=snap):
                report = _check(readback=snap)
                self.assertEqual(report["status"], "IDENTITY_MISMATCH_FAIL_CLOSED")
                self.assertFalse(report["reconciled"])
                self.assertTrue(report["blockNewOrders"])

        for expected in (_expected(accountLogin=None), _expected(server="")):
            result = _check(expected=expected)
            self.assertEqual(result["status"], "INVALID_EXPECTED_STATE_FAIL_CLOSED")
            self.assertTrue(result["blockNewOrders"])

        larger = _check(readback=_readback(volume=0.12))
        self.assertEqual(larger["status"], "POSITION_VOLUME_INCREASED_UNVERIFIED_ESCALATE")
        self.assertTrue(larger["escalationRequired"])
        self.assertTrue(larger["blockNewOrders"])
        self.assertFalse(larger["retryRequired"])


if __name__ == "__main__":
    unittest.main()
