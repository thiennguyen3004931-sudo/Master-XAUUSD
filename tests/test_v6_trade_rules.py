"""Offline contract tests for the V6 execution signal and stop rules."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from xauusd_v6_trade_rules import (
    evaluate_entry, structural_stop, trail_stop, peak_profit_stop, atr, evaluate_position_management_step
)


def candles(start, count=60, step=0.3, body=0.22, epoch=1794180000000, minutes=15):
    out = []
    for i in range(count):
        op = start + i * step
        cl = op + body
        out.append([round(op, 2), round(max(op, cl) + 0.12, 2),
                    round(min(op, cl) - 0.12, 2), round(cl, 2),
                    epoch + i * minutes * 60000])
    return out


class TradeRulesTest(unittest.TestCase):
    def fixtures(self):
        m15 = candles(4000)
        # Last CONFIRMED candle is strong bullish; last candle is still forming.
        m15[-2][0] = round(m15[-2][3] - 1.10, 2)
        m15[-2][1] = round(m15[-2][3] + 0.10, 2)
        m15[-2][2] = round(m15[-2][0] - 0.10, 2)
        m5 = candles(4010, step=0.15, minutes=5)
        h1 = candles(3910, minutes=60)
        h4 = candles(3910, minutes=240)
        return m5, m15, h1, h4

    def test_wait_on_incomplete_dataset(self):
        self.assertFalse(evaluate_entry([], [], [], [], 4000, 4000.2)["allowed"])

    def test_disallowed_mode_is_closed(self):
        m5, m15, h1, h4 = self.fixtures()
        self.assertFalse(evaluate_entry(m5, m15, h1, h4, 4018.5, 4018.7, "PAUSE")["allowed"])

    def test_structural_stop_no_invalid_clamp(self):
        m5, m15, _, _ = self.fixtures()
        self.assertIsNone(structural_stop("BUY", 4050, m5, m15))
        stop = structural_stop("BUY", 4019, m5, m15)
        self.assertIsNotNone(stop)
        self.assertLessEqual(6.0, 4019 - stop)
        self.assertLessEqual(4019 - stop, 10.0)

    def test_monotonic_trailing(self):
        bars = candles(4015, count=20, step=0.35)
        confirmed = bars[:-1]
        # Already-tight SL must not move backward.
        self.assertIsNone(trail_stop("BUY", 4000, 4023, 4022, confirmed, 4024))
        result = trail_stop("BUY", 4000, 4023, 4000.25, confirmed, 4024)
        if result is not None:
            self.assertGreater(result, 4000.25)
            self.assertLess(result, 4023 - 1.2)

    def test_peak_stop_never_crosses_market(self):
        self.assertEqual(peak_profit_stop("BUY", 4000, 4030, 4000.25, 4035, 10), 4025)
        self.assertIsNone(peak_profit_stop("BUY", 4000, 4020, 4018, 4035, 10))
        self.assertIsNone(peak_profit_stop("SELL", 4000, 3970, 3974, 3965, 10))

    def test_position_management_buy_sell_extreme_lock_preserves_tp(self):
        """Closed-candle position management only tightens SL; never exits by signal."""
        for side, entry, current, sl, tp, extreme, expected in [
            ("BUY", 4000.0, 4020.0, 3993.2, 4040.0, 4025.0, 4015.0),
            ("SELL", 4000.0, 3980.0, 4006.8, 3960.0, 3975.0, 3985.0),
        ]:
            with self.subTest(side=side):
                result = evaluate_position_management_step(
                    side=side, entry=entry, current_price=current,
                    current_sl=sl, current_tp=tp, initial_r=6.8,
                    favorable_extreme=extreme, confirmed_m5=[],
                    confirmed_m15=[], config={"enablePeakLock": True},
                )
                self.assertTrue(result["shouldModifySl"], result)
                self.assertEqual(result["newSl"], expected)
                self.assertEqual(result["newTp"], tp)
                self.assertFalse(result["tpModified"])
                self.assertEqual(result["actionCode"], "EXTREME_10_USD_LOCK")
                self.assertFalse(any("close" in key.lower() for key in result))

    def test_position_management_never_widens_stop_or_changes_tp(self):
        for side, entry, current, sl, tp, extreme in [
            ("BUY", 4000.0, 4020.0, 4018.5, 4040.0, 4025.0),
            ("SELL", 4000.0, 3980.0, 3981.5, 3960.0, 3975.0),
        ]:
            with self.subTest(side=side):
                result = evaluate_position_management_step(
                    side=side, entry=entry, current_price=current,
                    current_sl=sl, current_tp=tp, initial_r=6.8,
                    favorable_extreme=extreme, confirmed_m5=[],
                    confirmed_m15=[], config={"enablePeakLock": True},
                )
                self.assertFalse(result["shouldModifySl"], result)
                self.assertEqual(result["newSl"], sl)
                self.assertEqual(result["newTp"], tp)
                self.assertFalse(result["tpModified"])

    def test_management_sequence_pre_be_then_be_then_confirmed_m5_trail(self):
        """Offline BUY/SELL lifecycle: reduce risk, reach BE at 1R, then trail."""
        # Each M5 list contains ONLY closed candles with an actual 3-bar
        # confirmed local pivot; later swings cannot affect earlier steps.
        buy_early = [
            [3999, 4000, 3997, 3999],
            [3998, 3999, 3995, 3998],
            [3999, 4001, 3997, 4000],
            [4001, 4002, 3999, 4001],
            [4002, 4003, 4000, 4002],
        ]
        buy_late = [
            [4010, 4011, 4008, 4010],
            [4009, 4010, 4006, 4009],
            [4010, 4012, 4008, 4011],
            [4011, 4013, 4009, 4012],
            [4012, 4014, 4010, 4013],
        ]
        sell_early = [
            [4001, 4003, 4000, 4001],
            [4002, 4005, 4001, 4002],
            [4001, 4003, 3999, 4000],
            [3999, 4001, 3998, 3999],
            [3998, 4000, 3997, 3998],
        ]
        sell_late = [
            [3990, 3992, 3989, 3990],
            [3991, 3994, 3990, 3991],
            [3990, 3992, 3988, 3989],
            [3989, 3991, 3987, 3988],
            [3988, 3990, 3986, 3987],
        ]
        for side, initial_sl, tp, prices, early, late in [
            ("BUY", 3993.2, 4040.0, [4003.0, 4007.0, 4014.0], buy_early, buy_late),
            ("SELL", 4006.8, 3960.0, [3997.0, 3993.0, 3986.0], sell_early, sell_late),
        ]:
            with self.subTest(side=side):
                previous_sl = initial_sl
                favorable_extreme = 4000.0
                actions = []
                for index, price in enumerate(prices):
                    confirmed_m5 = early if index < 2 else late
                    result = evaluate_position_management_step(
                        side=side,
                        entry=4000.0,
                        current_price=price,
                        current_sl=previous_sl,
                        current_tp=tp,
                        initial_r=6.8,
                        favorable_extreme=favorable_extreme,
                        confirmed_m5=confirmed_m5,
                        confirmed_m15=[],
                        config={"enablePeakLock": False, "enableM5StructuralTrail": True},
                    )
                    self.assertTrue(result["shouldModifySl"], result)
                    self.assertEqual(result["newTp"], tp)
                    self.assertFalse(result["tpModified"])
                    self.assertEqual(result["initialR"], 6.8)
                    self.assertFalse(any("close" in key.lower() for key in result))
                    if side == "BUY":
                        self.assertGreater(result["newSl"], previous_sl)
                        self.assertLess(result["newSl"], price)
                    else:
                        self.assertLess(result["newSl"], previous_sl)
                        self.assertGreater(result["newSl"], price)
                    previous_sl = result["newSl"]
                    favorable_extreme = result["favorableExtreme"]
                    actions.append(result["actionCode"])
                self.assertEqual(actions, [
                    "M5_STRUCTURAL_TRAIL_PRE_BE",
                    "BE_1R",
                    "M5_STRUCTURAL_TRAIL_POST_BE",
                ])
                self.assertTrue(result["atBeAfter"])

    def test_wait_pullback_expiry_boundary_is_fail_closed(self):
        """Expired wide-stop setup must not be treated as an active entry."""
        from xauusd_v6_trade_rules import evaluate_wait_pullback_expiry
        created = 1795000000000
        expires = created + 900000
        state = {"createdAtTs": created, "expiresAtTs": expires}
        before = evaluate_wait_pullback_expiry(state, expires - 1)
        self.assertTrue(before["active"])
        self.assertFalse(before["expired"])
        self.assertEqual(before["remainingMs"], 1)
        after = evaluate_wait_pullback_expiry(state, expires + 1)
        self.assertFalse(after["active"])
        self.assertTrue(after["expired"])
        self.assertEqual(after["status"], "WAIT_PULLBACK_EXPIRED")
        missing = evaluate_wait_pullback_expiry(None, expires)
        self.assertFalse(missing["active"])
        self.assertTrue(missing["expired"])

    def test_wait_pullback_rejects_invalid_or_unbounded_timestamps(self):
        from xauusd_v6_trade_rules import evaluate_wait_pullback_expiry
        now = 1795000000000
        for state, current in [
            ({}, now),
            ({"createdAtTs": "bad"}, now),
            ({"createdAtTs": now, "expiresAtTs": "bad"}, now),
            ({"createdAtTs": now + 1}, now),
            ({"createdAtTs": now, "expiresAtTs": now + 3600001}, now),
            ({"createdAtTs": now, "expiresAtTs": now - 1}, now),
            ({"createdAtTs": now}, None),
        ]:
            with self.subTest(state=state, current=current):
                result = evaluate_wait_pullback_expiry(state, current)
                self.assertFalse(result["active"], result)
                self.assertTrue(result["expired"], result)
                self.assertEqual(result["status"], "WAIT_PULLBACK_INVALID")
        valid = evaluate_wait_pullback_expiry(
            {"createdAtTs": now, "expiresAtTs": now + 3600000}, now + 1800000
        )
        self.assertTrue(valid["active"])
        self.assertEqual(valid["remainingMs"], 1800000)

    def test_score_is_not_probabilistic_winrate(self):
        m5, m15, h1, h4 = self.fixtures()
        plan = evaluate_entry(m5, m15, h1, h4, 4018.5, 4018.7, "BOT_1_TREND", 95)
        self.assertFalse(plan["allowed"])

    def test_confirmed_trend_can_produce_broker_independent_plan(self):
        m5, m15, h1, h4 = self.fixtures()
        plan = evaluate_entry(m5, m15, h1, h4, 4018.5, 4018.7, "BOT_1_TREND")
        self.assertTrue(plan["allowed"], plan)
        self.assertEqual(plan["side"], "BUY")
        self.assertLess(plan["sl"], 4018.7)
        self.assertGreater(plan["tp"], 4018.7)
        self.assertGreaterEqual(plan["rewardRisk"], 1.6)

    def test_confirmed_sweep_must_breach_prior_swing_and_reclaim(self):
        m5, m15, h1, h4 = self.fixtures()
        m15[-2][0], m15[-2][1], m15[-2][2], m15[-2][3] = (4015.4, 4016.5, 4014.3, 4016.3)
        plan = evaluate_entry(m5, m15, h1, h4, 4016.4, 4016.5, "BOT_3_SWEEP")
        self.assertTrue(plan["allowed"], plan)
        self.assertEqual(plan["side"], "BUY")
        self.assertLess(plan["sl"], 4016.5)

    def test_sideway_range_edge_uses_opposite_boundary_target(self):
        epoch = 1794180000000
        m15 = []
        for i in range(60):
            op = 4004.0 + (i % 10 - 5) * 1.0
            m15.append([op, op + 1.0, op - 1.0, op + 0.2, epoch + i * 900000])
        m15[-2] = [3998.8, 3999.8, 3997.7, 3999.4, m15[-2][4]]
        m5 = []
        for i in range(60):
            op = 3998.3 + (i % 3) * 0.1
            m5.append([op, op + 0.7, op - 0.7, op + 0.15, epoch + i * 300000])
        m5[-3] = [3998.5, 3999.0, 3998.2, 3998.7, m5[-3][4]]
        m5[-2] = [3998.8, 3999.4, 3998.5, 3999.2, m5[-2][4]]
        h1 = [[4005, 4010, 4000, 4005 + (i % 2) * 0.1, epoch + i * 3600000] for i in range(60)]
        h4 = [[4005, 4010, 4000, 4005, epoch + i * 14400000] for i in range(60)]
        plan = evaluate_entry(m5, m15, h1, h4, 3998.9, 3999.0, "BOT_2_SIDEWAY")
        self.assertTrue(plan["allowed"], plan)
        self.assertEqual(plan["side"], "BUY")
        self.assertGreater(plan["tp"], 3999.0)
        self.assertLess(plan["sl"], 3999.0)

    def test_forming_candle_does_not_change_entry(self):
        m5, m15, h1, h4 = self.fixtures()
        before = evaluate_entry(m5, m15, h1, h4, 4018.5, 4018.7, "BOT_1_TREND")
        m15[-1] = [100, 9999, 1, 9000, m15[-1][4]]
        m5[-1] = [100, 9999, 1, 9000, m5[-1][4]]
        after = evaluate_entry(m5, m15, h1, h4, 4018.5, 4018.7, "BOT_1_TREND")
        self.assertEqual(before, after)

    def test_pinbar_without_swing_sweep_is_not_sweep_entry(self):
        m5, m15, h1, h4 = self.fixtures()
        last = m15[-2]
        last[0], last[1], last[2], last[3] = (4017.0, 4018.4, 4016.4, 4018.2)
        plan = evaluate_entry(m5, m15, h1, h4, 4018.5, 4018.7, "BOT_3_SWEEP")
        self.assertFalse(plan["allowed"])

    def test_true_range_includes_gap(self):
        bars = candles(4000, count=18, step=0.0)
        bars[-1][0] = 4015.0
        bars[-1][1] = 4015.5
        bars[-1][2] = 4014.5
        bars[-1][3] = 4015.0
        self.assertGreater(atr(bars), 1)


if __name__ == "__main__":
    unittest.main()
