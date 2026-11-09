"""Offline contract tests for the V6 execution signal and stop rules."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from xauusd_v6_trade_rules import (
    evaluate_entry, structural_stop, trail_stop, peak_profit_stop, atr
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
