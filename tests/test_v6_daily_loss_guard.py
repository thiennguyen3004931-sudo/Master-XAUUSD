"""Offline-only daily loss + emergency new-entry veto tests; never connect MT5."""
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from v6_daily_loss_guard import verify_daily_new_order_budget  # noqa: E402


class FakeMT5History:
    DEAL_TYPE_BUY = 0
    DEAL_TYPE_SELL = 1
    DEAL_ENTRY_IN = 0
    DEAL_ENTRY_OUT = 1
    DEAL_ENTRY_OUT_BY = 3

    def __init__(self, deals=None):
        self.deals = [] if deals is None else deals
        self.reads = 0

    def history_deals_get(self, start, end):
        self.reads += 1
        if self.deals is None:
            return None
        return self.deals


class DailyLossVetoTest(unittest.TestCase):
    # A fixed intraday UTC time keeps the tests independent of wall clock.
    NOW = 1_794_294_000  # 2026-11-10 UTC, safely away from midnight

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.halt_file = Path(self.tmp.name) / "v6-halt-new-orders.flag"

    def assess(self, mt5=None, equity=1000, positions=None, risk=5):
        with mock.patch.dict(os.environ, {"V6_HALT_NEW_ORDERS": ""}):
            return verify_daily_new_order_budget(
                mt5 or FakeMT5History(), SimpleNamespace(equity=equity),
                [] if positions is None else positions, risk,
                now_utc_seconds=self.NOW,
                emergency_halt_path=self.halt_file,
            )

    def _deal(self, entry, profit=0, kind=0, position_id=80, **extra):
        return SimpleNamespace(
            time=self.NOW - 600, entry=entry, position_id=position_id,
            type=kind, profit=profit, commission=0, swap=0, fee=0, **extra
        )

    def test_empty_verified_day_allows_new_risk_under_2_percent(self):
        broker = FakeMT5History()
        decision = self.assess(broker, equity=1000, risk=15)
        self.assertTrue(decision["allowed"], decision)
        self.assertEqual(broker.reads, 1)

    def test_projected_SL_loss_blocks_even_before_limit_is_reached(self):
        broker = FakeMT5History([self._deal(0), self._deal(1, -18)])
        decision = self.assess(broker, equity=982, risk=3)
        self.assertFalse(decision["allowed"])
        self.assertIn("could exceed daily", decision["message"])

    def test_realized_daily_loss_at_limit_blocks(self):
        broker = FakeMT5History([self._deal(0), self._deal(1, -20)])
        decision = self.assess(broker, equity=980, risk=1)
        self.assertFalse(decision["allowed"])
        self.assertIn("daily account loss limit reached", decision["message"])

    def test_history_unavailable_or_query_throws_fails_closed(self):
        broker = FakeMT5History()
        broker.deals = None
        self.assertFalse(self.assess(broker)["allowed"])
        class Broken:
            def history_deals_get(self, start, end):
                raise RuntimeError("could not load history")
        self.assertFalse(self.assess(Broken())["allowed"])

    def test_broker_without_history_method_fails_closed(self):
        self.assertFalse(self.assess(SimpleNamespace())["allowed"])

    def test_cash_flow_or_unknown_ledger_item_blocks(self):
        broker = FakeMT5History([self._deal(0, kind=2)])
        self.assertFalse(self.assess(broker)["allowed"])

    def test_overnight_close_without_same_day_entry_blocks(self):
        broker = FakeMT5History([self._deal(1, -15, position_id=80)])
        self.assertFalse(self.assess(broker)["allowed"])

    def test_overnight_open_position_blocks(self):
        prior_day = self.NOW - 90_000
        pos = SimpleNamespace(time=prior_day, profit=5, swap=0)
        self.assertFalse(self.assess(positions=[pos])["allowed"])

    def test_missing_or_invalid_position_pnl_blocks(self):
        pos = SimpleNamespace(time=self.NOW - 10, profit=None)
        self.assertFalse(self.assess(positions=[pos])["allowed"])

    def test_non_finite_deal_fee_blocks(self):
        deal = self._deal(0)
        deal.fee = float("nan")
        self.assertFalse(self.assess(FakeMT5History([deal]))["allowed"])

    def test_floating_losses_are_counted_account_wide(self):
        pos = SimpleNamespace(time=self.NOW - 100, profit=-17, swap=-1)
        decision = self.assess(equity=982, positions=[pos], risk=4)
        self.assertFalse(decision["allowed"])
        self.assertIn("could exceed daily", decision["message"])

    def test_entry_commissions_count_against_day_budget(self):
        entry = self._deal(0)
        entry.commission = -12
        decision = self.assess(FakeMT5History([entry]), equity=988, risk=9)
        self.assertFalse(decision["allowed"])

    def test_halt_marker_stops_new_risk_before_broker_history(self):
        self.halt_file.touch()
        broker = FakeMT5History()
        decision = self.assess(broker)
        self.assertFalse(decision["allowed"])
        self.assertIn("emergency halt marker", decision["message"])
        self.assertEqual(broker.reads, 0)

    def test_emergency_environment_flag_blocks_without_reading_history(self):
        broker = FakeMT5History()
        with mock.patch.dict(os.environ, {"V6_HALT_NEW_ORDERS": "TRUE"}):
            decision = verify_daily_new_order_budget(
                broker, SimpleNamespace(equity=1000), [], 2,
                now_utc_seconds=self.NOW, emergency_halt_path=self.halt_file
            )
        self.assertFalse(decision["allowed"])
        self.assertEqual(broker.reads, 0)

    def test_missing_portfolio_readback_blocks(self):
        self.assertTrue(self.assess(positions=[])["allowed"])
        decision = verify_daily_new_order_budget(
            FakeMT5History(), SimpleNamespace(equity=1000), None, 2,
            now_utc_seconds=self.NOW, emergency_halt_path=self.halt_file
        )
        self.assertFalse(decision["allowed"])

    def test_invalid_projected_risk_and_equity_block(self):
        self.assertFalse(self.assess(equity=float("nan"))["allowed"])
        self.assertFalse(self.assess(risk=float("inf"))["allowed"])
        self.assertFalse(self.assess(risk=0)["allowed"])

    def test_unknown_lifecycle_and_missing_commission_block(self):
        deal = self._deal(2, profit=-5)
        self.assertFalse(self.assess(FakeMT5History([deal]))["allowed"])
        valid_deal = self._deal(0)
        del valid_deal.commission
        self.assertFalse(self.assess(FakeMT5History([valid_deal]))["allowed"])


if __name__ == "__main__":
    unittest.main()
