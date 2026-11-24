"""Broker rejection ACK reconciliation wired into the real execute_order path.

An explicit broker rejection may release the durable in-flight entry freeze
ONLY when broker history and pending orders prove no exposure for this exact
intent (CONFIRMED_NO_FILL_REJECTED). Everything else stays latched and must
never trigger an automatic re-send. All brokers here are offline mocks.
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
if str(ROOT / "tests") not in sys.path:
    sys.path.insert(0, str(ROOT / "tests"))

spec = importlib.util.spec_from_file_location("xauusd_mt5_direct_probe_ackwire", SCRIPTS / "mt5-direct-probe.py")
engine = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = engine
spec.loader.exec_module(engine)

from test_v6_mt5_execution import MockBroker  # noqa: E402

CFG = {"side": "BUY", "volume": 0.02, "slDistance": 6.8, "tpDistance": 16}


class RejectingBroker(MockBroker):
    """Mock broker that rejects new-entry DEAL requests with a fixed retcode."""

    def __init__(self, retcode, *, deals=None, pending=None, history_ok=True, orders_ok=True):
        super().__init__()
        self._retcode = retcode
        self._deals = deals
        self._pending = pending
        self._history_ok = history_ok
        self._orders_ok = orders_ok

    def order_send(self, request):
        if request.get("action") == self.TRADE_ACTION_DEAL and "position" not in request:
            self.sent.append(request)
            return SimpleNamespace(retcode=self._retcode, order=0, comment="rejected-by-mock")
        return super().order_send(request)

    def history_deals_get(self, *args):
        # Pre-send risk reads must succeed (they fail closed before send);
        # simulate the read outage only during post-rejection reconciliation.
        if not self._history_ok and _entry_sends(self):
            return None
        deals = self._deals(self) if callable(self._deals) else (self._deals or [])
        return list(deals)

    def orders_get(self, **kwargs):
        if not self._orders_ok and _entry_sends(self):
            return None
        pending = self._pending(self) if callable(self._pending) else (self._pending or [])
        return list(pending)


def _entry_sends(broker):
    return [r for r in broker.sent if r.get("action") == broker.TRADE_ACTION_DEAL and "position" not in r]


def _sent_comment(broker):
    """Comment of the first entry send, or None before any send (pre-send reads)."""
    sends = _entry_sends(broker)
    return sends[0]["comment"] if sends else None


class BrokerAckRejectionWiringTest(unittest.TestCase):
    def setUp(self):
        self._tmp_rt = Path(tempfile.mkdtemp(prefix="v6-ackwire-rt-"))
        self._env = patch.dict(os.environ, {"V6_RUNTIME_DIR": str(self._tmp_rt),
                                            "V6_BROKER_UTC_OFFSET_HOURS": "0"})
        self._env.start()
        self.addCleanup(self._env.stop)
        for name, value in {
            "RUNTIME_DIR": self._tmp_rt,
            "MANAGER_STATE_FILE": self._tmp_rt / "v6-position-tracker.json",
            "DAILY_RISK_STATE_FILE": self._tmp_rt / "v6-daily-risk-state.json",
            "REGIME_STATE_FILE": self._tmp_rt / "v6-regime-state.json",
        }.items():
            p = patch.object(engine, name, value)
            p.start()
            self.addCleanup(p.stop)
        # Isolate from the separately tested fail-closed G1 quarantine (#145);
        # this suite exercises post-send ACK handling only.
        gate = patch.object(engine, "_check_runtime_emergency_stop_latch", return_value=None)
        gate.start()
        self.addCleanup(gate.stop)
        self.addCleanup(shutil.rmtree, self._tmp_rt, True)

    def _state(self):
        return engine._read_uncertain_entry_state()

    def test_clean_rejection_releases_freeze_and_allows_next_attempt(self):
        broker = RejectingBroker(10006)  # TRADE_RETCODE_REJECT
        first = engine.execute_order(broker, "XAUUSD.G", CFG)
        self.assertFalse(first["ok"], first)
        self.assertTrue(first["submitted"])
        self.assertTrue(first["brokerRejected"])
        self.assertEqual(first["ackReconciliation"]["outcome"], "CONFIRMED_NO_FILL_REJECTED")
        self.assertFalse(first.get("uncertain", False))
        self.assertEqual(self._state(), {})
        self.assertEqual(len(_entry_sends(broker)), 1)

        second = engine.execute_order(broker, "XAUUSD.G", CFG)
        self.assertNotEqual(second.get("status"), "BLOCKED_UNCERTAIN_PREVIOUS_ENTRY")
        self.assertEqual(len(_entry_sends(broker)), 2)

    def test_unknown_retcode_keeps_freeze_and_blocks_resend(self):
        broker = RejectingBroker(10011)  # TRADE_RETCODE_ERROR (not a proven no-exposure code)
        first = engine.execute_order(broker, "XAUUSD.G", CFG)
        self.assertTrue(first["uncertain"])
        self.assertEqual(first["status"], "BLOCKED_REJECTION_EXPOSURE_UNVERIFIED")
        self.assertEqual(first["ackReconciliation"]["outcome"], "AMBIGUOUS_EXPOSURE_UNKNOWN")
        self.assertIn("5201362|MOCK-DEMO", self._state())
        again = engine.execute_order(broker, "XAUUSD.G", CFG)
        self.assertEqual(again["status"], "BLOCKED_UNCERTAIN_PREVIOUS_ENTRY")
        self.assertEqual(len(_entry_sends(broker)), 1)

    def test_rejection_with_matching_opening_deal_is_not_trusted(self):
        def deals(b):
            comment = _sent_comment(b)
            if comment is None:
                return []
            return [SimpleNamespace(ticket=777, symbol="XAUUSD.G", type=0, volume=0.02,
                                    magic=270715, comment=comment, entry=0, position_id=777)]

        broker = RejectingBroker(10006, deals=deals)
        first = engine.execute_order(broker, "XAUUSD.G", CFG)
        self.assertTrue(first["uncertain"])
        self.assertEqual(first["status"], "BLOCKED_REJECTION_EXPOSURE_UNVERIFIED")
        self.assertNotEqual(first["ackReconciliation"]["outcome"], "CONFIRMED_NO_FILL_REJECTED")
        again = engine.execute_order(broker, "XAUUSD.G", CFG)
        self.assertEqual(again["status"], "BLOCKED_UNCERTAIN_PREVIOUS_ENTRY")
        self.assertEqual(len(_entry_sends(broker)), 1)

    def test_rejection_with_partial_deal_keeps_freeze(self):
        def deals(b):
            comment = _sent_comment(b)
            if comment is None:
                return []
            return [SimpleNamespace(ticket=778, symbol="XAUUSD.G", type=0, volume=0.01,
                                    magic=270715, comment=comment, entry=0, position_id=778)]

        broker = RejectingBroker(10006, deals=deals)
        first = engine.execute_order(broker, "XAUUSD.G", CFG)
        self.assertTrue(first["uncertain"])
        self.assertEqual(first["ackReconciliation"]["outcome"], "CONFIRMED_PARTIAL_FILL")
        self.assertIn("5201362|MOCK-DEMO", self._state())

    def test_rejection_with_matching_pending_order_keeps_freeze(self):
        def pending(b):
            comment = _sent_comment(b)
            if comment is None:
                return []
            return [SimpleNamespace(ticket=900, symbol="XAUUSD.G", comment=comment)]

        broker = RejectingBroker(10006, pending=pending)
        first = engine.execute_order(broker, "XAUUSD.G", CFG)
        self.assertTrue(first["uncertain"])
        self.assertEqual(first["ackReconciliation"]["outcome"], "AMBIGUOUS_EXPOSURE_UNKNOWN")
        self.assertIn("5201362|MOCK-DEMO", self._state())

    def test_unreadable_history_or_orders_keeps_freeze(self):
        for kwargs, reason in [({"history_ok": False}, "DEAL_HISTORY_UNAVAILABLE"),
                               ({"orders_ok": False}, "PENDING_ORDERS_UNAVAILABLE")]:
            with self.subTest(reason=reason):
                engine._write_uncertain_entry_state({})
                broker = RejectingBroker(10006, **kwargs)
                first = engine.execute_order(broker, "XAUUSD.G", CFG)
                self.assertTrue(first["uncertain"])
                self.assertEqual(first["ackReconciliation"]["reason"], reason)
                self.assertIn("5201362|MOCK-DEMO", self._state())

    def test_exit_or_foreign_deals_do_not_block_clean_rejection(self):
        def deals(b):
            comment = _sent_comment(b)
            if comment is None:
                return []
            return [
                SimpleNamespace(ticket=1, symbol="XAUUSD.G", type=1, volume=0.02,
                                magic=270715, comment="other-intent", entry=0, position_id=1),
                SimpleNamespace(ticket=2, symbol="XAUUSD.G", type=0, volume=0.02,
                                magic=270715, comment=comment, entry=1, position_id=2),
            ]

        broker = RejectingBroker(10006, deals=deals)
        first = engine.execute_order(broker, "XAUUSD.G", CFG)
        self.assertEqual(first["ackReconciliation"]["outcome"], "CONFIRMED_NO_FILL_REJECTED")
        self.assertEqual(first["ackReconciliation"]["ignoredDealCount"], 1)
        self.assertEqual(self._state(), {})

    def test_account_switch_during_reconciliation_keeps_freeze(self):
        broker = RejectingBroker(10006)
        calls = {"n": 0}
        original = broker.account_info

        def switching():
            calls["n"] += 1
            acc = original()
            if calls["n"] > 3:
                return SimpleNamespace(**{**acc.__dict__, "login": 999999})
            return acc

        broker.account_info = switching
        first = engine.execute_order(broker, "XAUUSD.G", CFG)
        self.assertTrue(first.get("uncertain"), first)
        self.assertIn("5201362|MOCK-DEMO", self._state())

    def test_reconciliation_exception_fails_closed(self):
        with patch.object(engine, "_reconcile_broker_ack_and_fills", side_effect=RuntimeError("boom")):
            broker = RejectingBroker(10006)
            first = engine.execute_order(broker, "XAUUSD.G", CFG)
        self.assertTrue(first["uncertain"])
        self.assertTrue(first["ackReconciliation"]["reason"].startswith("RECONCILE_EXCEPTION"))
        self.assertIn("5201362|MOCK-DEMO", self._state())


if __name__ == "__main__":
    unittest.main()
