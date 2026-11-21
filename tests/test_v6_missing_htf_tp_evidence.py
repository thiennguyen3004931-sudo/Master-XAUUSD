"""Regression: no TP without H1/H4 evidence, while confirmed TP policy is unchanged."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from xauusd_v6_trade_rules import select_tp_with_near_obstacle_check


class MissingHtfTpEvidenceTests(unittest.TestCase):
    def test_both_htf_missing_must_block_for_buy_and_sell(self):
        for side, sl in (("BUY", 2643.0), ("SELL", 2657.0)):
            for h1, h4 in (([], []), (None, []), ([], None), (None, None)):
                with self.subTest(side=side, h1=h1, h4=h4):
                    result = select_tp_with_near_obstacle_check(side, 2650.0, sl, h1, h4)
                    self.assertIs(result["ok"], False)
                    self.assertIsNone(result["tp"])
                    self.assertEqual(result["tpSource"], "MISSING_HTF_DATA")

    def test_one_valid_htf_series_still_permits_explicit_open_air_fallback(self):
        # No H1/H4 opposing level ahead of 2650; this is different from
        # receiving no H1/H4 candles at all.
        h1 = [[2642.0, 2649.0, 2638.0, 2644.0, 1000]]
        result = select_tp_with_near_obstacle_check("BUY", 2650.0, 2643.0, h1, [])
        self.assertTrue(result["ok"])
        self.assertEqual(result["tpSource"], "FALLBACK_FIXED_RR_OPEN_AIR")
        self.assertGreater(result["tp"], 2650.0)

    def test_valid_h1_or_h4_opposing_obstacle_preserves_existing_tp_selection(self):
        h1_buy = [[2648.0, 2670.0, 2645.0, 2660.0, 1000]]
        buy = select_tp_with_near_obstacle_check("BUY", 2650.0, 2643.0, h1_buy, [])
        self.assertTrue(buy["ok"])
        self.assertEqual(buy["tp"], 2669.75)
        self.assertEqual(buy["tpSource"], "CONFIRMED_H1_H4_OBSTACLE")

        h4_sell = [[2650.0, 2652.0, 2635.0, 2645.0, 1000]]
        sell = select_tp_with_near_obstacle_check("SELL", 2650.0, 2657.0, [], h4_sell)
        self.assertTrue(sell["ok"])
        self.assertEqual(sell["tp"], 2635.25)
        self.assertEqual(sell["tpSource"], "CONFIRMED_H1_H4_OBSTACLE")

    def test_invalid_risk_still_precedes_missing_data(self):
        result = select_tp_with_near_obstacle_check("BUY", 2650.0, 2650.0, [], [])
        self.assertFalse(result["ok"])
        self.assertEqual(result["tpSource"], "INVALID_RISK")


if __name__ == "__main__":
    unittest.main()
