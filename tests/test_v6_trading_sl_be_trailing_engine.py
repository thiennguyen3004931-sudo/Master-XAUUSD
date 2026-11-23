"""Unit tests for V6 Trading Entry, M5 Structural SL, BE & Trailing Engine (Stream D)."""

from __future__ import annotations

from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import v6_trading_sl_be_trailing_engine as eng


BOT_MAGIC = 600001


class TestTradingEntryAndInitialSl(unittest.TestCase):
    def test_valid_buy_and_sell_m5_structural_sl_6_to_8_usd(self) -> None:
        buy = eng.evaluate_entry_and_initial_sl(
            regime="TREND",
            buy_signal=True,
            sell_signal=False,
            candle_closed=True,
            entry_price=2650.0,
            m5_structural_sl=2643.0,
            take_profit=2664.0,
            nearby_obstacle_distance_usd=12.0,
        )
        self.assertEqual(buy["action"], "ADMIT_OFFLINE_CANDIDATE")
        self.assertEqual(buy["slDistanceUsd"], 7.0)
        self.assertFalse(buy["liveAuthorized"])

        sell = eng.evaluate_entry_and_initial_sl(
            regime="SIDEWAY",
            buy_signal=False,
            sell_signal=True,
            candle_closed=True,
            entry_price=2650.0,
            m5_structural_sl=2656.5,
            take_profit=2638.0,
            nearby_obstacle_distance_usd=10.0,
        )
        self.assertEqual(sell["action"], "ADMIT_OFFLINE_CANDIDATE")
        self.assertEqual(sell["slDistanceUsd"], 6.5)

    def test_wide_structural_sl_waits_pullback_never_tightens(self) -> None:
        res = eng.evaluate_entry_and_initial_sl(
            regime="TREND",
            buy_signal=True,
            sell_signal=False,
            candle_closed=True,
            entry_price=2650.0,
            m5_structural_sl=2638.0,
            take_profit=2670.0,
            nearby_obstacle_distance_usd=15.0,
        )
        self.assertEqual(res["action"], "WAIT_PULLBACK_OR_SKIP")
        self.assertEqual(res["reason"], "STRUCTURAL_SL_TOO_WIDE_DO_NOT_TIGHTEN")

    def test_conflicting_signals_unclosed_candle_and_nearby_obstacle_blocked(self) -> None:
        conflict = eng.evaluate_entry_and_initial_sl(
            regime="TREND",
            buy_signal=True,
            sell_signal=True,
            candle_closed=True,
            entry_price=2650.0,
            m5_structural_sl=2643.0,
            take_profit=2664.0,
            nearby_obstacle_distance_usd=12.0,
        )
        self.assertEqual(conflict["reason"], "CONFLICTING_BUY_SELL_SIGNAL")

        unclosed = eng.evaluate_entry_and_initial_sl(
            regime="TREND",
            buy_signal=True,
            sell_signal=False,
            candle_closed=False,
            entry_price=2650.0,
            m5_structural_sl=2643.0,
            take_profit=2664.0,
            nearby_obstacle_distance_usd=12.0,
        )
        self.assertEqual(unclosed["reason"], "UNCLOSED_CANDLE_REJECTED")

        obstacle = eng.evaluate_entry_and_initial_sl(
            regime="TREND",
            buy_signal=True,
            sell_signal=False,
            candle_closed=True,
            entry_price=2650.0,
            m5_structural_sl=2643.0,
            take_profit=2664.0,
            nearby_obstacle_distance_usd=2.0,
        )
        self.assertEqual(obstacle["reason"], "NEARBY_OBSTACLE_TOO_CLOSE")


class TestBreakEvenAndTrailingMonotonicity(unittest.TestCase):
    def test_buy_be_then_m5_trail_then_m15_fast_move_never_widens(self) -> None:
        pos = {"magic": BOT_MAGIC, "direction": "BUY", "entryPrice": 2650.0, "currentSl": 2643.0}
        r1 = eng.compute_next_protective_sl(
            position=pos, bot_magic=BOT_MAGIC, current_bid=2657.0, current_ask=2657.2
        )
        self.assertTrue(r1["shouldModify"])
        self.assertEqual(r1["nextSl"], 2650.2)
        self.assertEqual(r1["reason"], "BREAK_EVEN")

        pos["currentSl"] = r1["nextSl"]
        r2 = eng.compute_next_protective_sl(
            position=pos,
            bot_magic=BOT_MAGIC,
            current_bid=2661.0,
            current_ask=2661.2,
            m5_new_structure_sl=2654.0,
        )
        self.assertTrue(r2["shouldModify"])
        self.assertEqual(r2["nextSl"], 2654.0)
        self.assertEqual(r2["reason"], "M5_STRUCTURAL_TRAIL")

        pos["currentSl"] = r2["nextSl"]
        r3 = eng.compute_next_protective_sl(
            position=pos,
            bot_magic=BOT_MAGIC,
            current_bid=2671.0,
            current_ask=2671.2,
            m15_fast_move_active=True,
            favorable_extreme_price=2672.0,
        )
        self.assertTrue(r3["shouldModify"])
        self.assertEqual(r3["nextSl"], 2662.0)
        self.assertEqual(r3["reason"], "M15_FAST_MOVE_10USD_TRAIL")

        pos["currentSl"] = r3["nextSl"]
        r4 = eng.compute_next_protective_sl(
            position=pos,
            bot_magic=BOT_MAGIC,
            current_bid=2666.0,
            current_ask=2666.2,
            m5_new_structure_sl=2658.0,
        )
        self.assertFalse(r4["shouldModify"])
        self.assertEqual(r4["nextSl"], 2662.0)

    def test_sell_monotonic_and_foreign_magic_and_freeze_level_protected(self) -> None:
        foreign = {"magic": 999999, "direction": "SELL", "entryPrice": 2650.0, "currentSl": 2657.0}
        rf = eng.compute_next_protective_sl(
            position=foreign, bot_magic=BOT_MAGIC, current_bid=2640.0, current_ask=2640.2
        )
        self.assertFalse(rf["shouldModify"])
        self.assertEqual(rf["reason"], "POSITION_NOT_OWNED_BY_BOT")

        pos = {"magic": BOT_MAGIC, "direction": "SELL", "entryPrice": 2650.0, "currentSl": 2657.0}
        rs = eng.compute_next_protective_sl(
            position=pos,
            bot_magic=BOT_MAGIC,
            current_bid=2634.0,
            current_ask=2634.2,
            m15_fast_move_active=True,
            favorable_extreme_price=2633.0,
        )
        self.assertTrue(rs["shouldModify"])
        self.assertEqual(rs["nextSl"], 2643.0)

        frozen = {"magic": BOT_MAGIC, "direction": "SELL", "entryPrice": 2650.0, "currentSl": 2643.0}
        rz = eng.compute_next_protective_sl(
            position=frozen,
            bot_magic=BOT_MAGIC,
            current_bid=2642.6,
            current_ask=2642.8,
            m5_new_structure_sl=2640.0,
            broker_freeze_level_usd=0.3,
        )
        self.assertFalse(rz["shouldModify"])
        self.assertEqual(rz["reason"], "BLOCKED_BY_BROKER_FREEZE_LEVEL")


if __name__ == "__main__":
    unittest.main()
