"""Offline source regression for the mandatory pending-order broker inventory gate.

This test never imports the MT5 probe or connects to a broker.
"""
import ast
from pathlib import Path
import unittest


SOURCE = Path(__file__).resolve().parents[1] / "scripts" / "mt5-direct-probe.py"


class PendingOrdersFailClosedRegression(unittest.TestCase):
    def test_pending_orders_gate_is_unconditional(self):
        source = SOURCE.read_text(encoding="utf-8")
        ast.parse(source, filename=str(SOURCE))
        start = source.index("    pending_risk = 0.0\n")
        end = source.index("    total_portfolio_risk_usd =", start)
        gate = source[start:end]
        self.assertIn('orders_get = getattr(mt5, "orders_get", None)', gate)
        self.assertIn("if not callable(orders_get):", gate)
        self.assertIn('"BLOCKED_PENDING_ORDERS_UNVERIFIED"', gate)
        self.assertIn("pending_orders = orders_get()", gate)
        self.assertIn("if not isinstance(pending_orders, (list, tuple)):", gate)
        self.assertIn("for pend in pending_orders:", gate)
        self.assertNotIn('if callable(getattr(mt5, "orders_get", None)):', gate)
        self.assertLess(gate.index("if not callable(orders_get):"), gate.index("pending_orders = orders_get()"))
        self.assertLess(gate.index("if not isinstance(pending_orders, (list, tuple)):"), gate.index("for pend in pending_orders:"))


if __name__ == "__main__":
    unittest.main()
