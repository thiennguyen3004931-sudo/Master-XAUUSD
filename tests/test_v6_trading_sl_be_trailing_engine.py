"""Unit tests for V6 Trading Entry, M5 Structural SL, 1R BE & Trailing Engine (Stream D)."""

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
        self.assertEqual(buy["initialRiskUsd"], 7.0)
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
        self.assertEqual(sell["initialRiskUsd"], 6.5)

    def test_wide_structural_sl_waits_pullback_and_invalid_policy_fails_closed(self) -> None:
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

        bad_policy = eng.evaluate_entry_and_initial_sl(
            regime="TREND",
            buy_signal=True,
            sell_signal=False,
            candle_closed=True,
            entry_price=2650.0,
            m5_structural_sl=2643.0,
            take_profit=2664.0,
            nearby_obstacle_distance_usd=12.0,
            broker_stops_level_usd=float("nan"),
        )
        self.assertEqual(bad_policy["action"], "SKIP")
        self.assertEqual(bad_policy["reason"], "INVALID_STRATEGY_OR_BROKER_POLICY")


class TestBreakEvenAndTrailingMonotonicity(unittest.TestCase):
    def test_buy_and_sell_1r_be_for_r_6_7_8_and_restart_preservation(self) -> None:
        for r_val in (6.0, 7.0, 8.0):
            pos_buy = {
                "magic": BOT_MAGIC,
                "direction": "BUY",
                "entryPrice": 2650.0,
                "initialSl": 2650.0 - r_val,
                "initialRiskUsd": r_val,
                "currentSl": 2650.0 - r_val,
            }
            before_be = eng.compute_next_protective_sl(
                position=pos_buy, bot_magic=BOT_MAGIC, current_bid=2650.0 + r_val - 0.1, current_ask=2650.0 + r_val + 0.1
            )
            self.assertFalse(before_be["shouldModify"])
            at_be = eng.compute_next_protective_sl(
                position=pos_buy, bot_magic=BOT_MAGIC, current_bid=2650.0 + r_val, current_ask=2650.0 + r_val + 0.2
            )
            self.assertTrue(at_be["shouldModify"])
            self.assertEqual(at_be["nextSl"], 2650.2)
            self.assertEqual(at_be["reason"], "BREAK_EVEN")

            pos_sell = {
                "magic": BOT_MAGIC,
                "direction": "SELL",
                "entryPrice": 2650.0,
                "initialSl": 2650.0 + r_val,
                "currentSl": 2650.0 + r_val,
            }
            at_be_sell = eng.compute_next_protective_sl(
                position=pos_sell, bot_magic=BOT_MAGIC, current_bid=2650.0 - r_val - 0.2, current_ask=2650.0 - r_val
            )
            self.assertTrue(at_be_sell["shouldModify"])
            self.assertEqual(at_be_sell["nextSl"], 2649.8)
            self.assertEqual(at_be_sell["reason"], "BREAK_EVEN")

    def test_target_sl_inside_broker_freeze_level_is_rejected_for_buy_and_sell(self) -> None:
        pos_buy = {
            "magic": BOT_MAGIC,
            "direction": "BUY",
            "entryPrice": 2650.0,
            "initialSl": 2643.0,
            "currentSl": 2643.0,
        }
        rb = eng.compute_next_protective_sl(
            position=pos_buy,
            bot_magic=BOT_MAGIC,
            current_bid=2656.0,
            current_ask=2656.2,
            m5_new_structure_sl=2654.5,
            broker_stops_level_usd=0.5,
            broker_freeze_level_usd=2.0,
        )
        self.assertFalse(rb["shouldModify"])
        self.assertEqual(rb["nextSl"], 2643.0)

        pos_sell = {
            "magic": BOT_MAGIC,
            "direction": "SELL",
            "entryPrice": 2650.0,
            "initialSl": 2657.0,
            "currentSl": 2657.0,
        }
        rs = eng.compute_next_protective_sl(
            position=pos_sell,
            bot_magic=BOT_MAGIC,
            current_bid=2643.8,
            current_ask=2644.0,
            m5_new_structure_sl=2645.5,
            broker_stops_level_usd=0.5,
            broker_freeze_level_usd=2.0,
        )
        self.assertFalse(rs["shouldModify"])
        self.assertEqual(rs["nextSl"], 2657.0)

    def test_stale_or_unclosed_m5_m15_and_tampered_initial_risk_fail_closed(self) -> None:
        pos = {
            "magic": BOT_MAGIC,
            "direction": "BUY",
            "entryPrice": 2650.0,
            "initialSl": 2643.0,
            "initialRiskUsd": 4.0,
            "currentSl": 2643.0,
        }
        tampered = eng.compute_next_protective_sl(
            position=pos,
            bot_magic=BOT_MAGIC,
            current_bid=2658.0,
            current_ask=2658.2,
            m5_new_structure_sl=2654.0,
            m5_structure_stale=True,
            m15_fast_move_active=True,
            m15_candle_closed=False,
            favorable_extreme_price=2665.0,
        )
        self.assertFalse(tampered["shouldModify"])
        self.assertEqual(tampered["reason"], "IMMUTABLE_INITIAL_RISK_MISMATCH")
        self.assertIsNone(tampered["initialRiskUsd"])
        self.assertEqual(tampered["nextSl"], 2643.0)

    def test_inconsistent_entry_risk_blocks_even_fresh_m5_m15_proposals(self) -> None:
        # Regression: an invalid initial risk must not silently fall through
        # to another trailing candidate when the indicator inputs look valid.
        for direction in ("BUY", "SELL"):
            with self.subTest(direction=direction):
                buy = direction == "BUY"
                pos = {
                    "magic": BOT_MAGIC,
                    "direction": direction,
                    "entryPrice": 2650.0,
                    "initialSl": 2643.0 if buy else 2657.0,
                    "initialRiskUsd": 4.0,
                    "currentSl": 2643.0 if buy else 2657.0,
                }
                result = eng.compute_next_protective_sl(
                    position=pos,
                    bot_magic=BOT_MAGIC,
                    current_bid=2670.0 if buy else 2630.0,
                    current_ask=2670.2 if buy else 2630.2,
                    m5_new_structure_sl=2658.0 if buy else 2640.0,
                    m5_structure_candle_closed=True,
                    m5_structure_stale=False,
                    m15_fast_move_active=True,
                    m15_candle_closed=True,
                    m15_signal_stale=False,
                    favorable_extreme_price=2675.0 if buy else 2625.0,
                )
                self.assertFalse(result["shouldModify"])
                self.assertEqual(result["reason"], "IMMUTABLE_INITIAL_RISK_MISMATCH")
                self.assertEqual(result["nextSl"], pos["currentSl"])
                self.assertIsNone(result["initialRiskUsd"])
                self.assertFalse(result["liveAuthorized"])

    def test_foreign_magic_and_nan_freeze_fail_closed(self) -> None:
        foreign = {"magic": 999999, "direction": "SELL", "entryPrice": 2650.0, "currentSl": 2657.0}
        rf = eng.compute_next_protective_sl(
            position=foreign, bot_magic=BOT_MAGIC, current_bid=2640.0, current_ask=2640.2
        )
        self.assertFalse(rf["shouldModify"])
        self.assertEqual(rf["nextSl"], 2657.0)

        pos = {"magic": BOT_MAGIC, "direction": "BUY", "entryPrice": 2650.0, "initialSl": 2643.0, "currentSl": 2643.0}
        r_nan = eng.compute_next_protective_sl(
            position=pos,
            bot_magic=BOT_MAGIC,
            current_bid=2660.0,
            current_ask=2660.2,
            broker_freeze_level_usd=float("nan"),
        )
        self.assertFalse(r_nan["shouldModify"])
        self.assertEqual(r_nan["reason"], "BROKER_OR_TRAILING_POLICY_UNVERIFIED")


if __name__ == "__main__":
    unittest.main()
