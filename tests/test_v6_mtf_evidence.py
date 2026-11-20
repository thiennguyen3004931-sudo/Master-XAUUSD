"""Offline source-only MTF display provenance regressions; never contacts MetaTrader 5."""
import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("v6_direct_probe_mtf", SCRIPTS / "mt5-direct-probe.py")
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)


def make_candles(base, count=35):
    rows = []
    for i in range(count):
        op = base + i * 0.1
        cl = op + 0.2
        rows.append([op, cl + 0.4, op - 0.3, cl, 1_790_000_000 + i * 900])
    return rows


def analyze(h4=None, h1=None, m15=None, price=4000.0, signal=None, analysis=None):
    return engine.analyze_multi_timeframe_h4_h1_m15(
        h4 if h4 is not None else make_candles(4000, 35),
        h1 if h1 is not None else make_candles(3995, 35),
        m15 if m15 is not None else make_candles(3998, 35),
        analysis if analysis is not None else {},
        price, signal,
    )


class MtfEvidenceTests(unittest.TestCase):
    def assert_no_trade_levels(self, out):
        self.assertFalse(out.get("allowed", False))
        scenario = out["scenario15m"]
        self.assertEqual(scenario["recommendedBot"], "NO_TRADE")
        for field in ("entryZone", "stopLoss", "beTrigger", "tp1", "tp2"):
            self.assertIsNone(scenario[field], field)

    def test_no_quote_or_invalid_quote_returns_unavailable(self):
        for price in (None, 0, -1, float("nan"), float("inf"), "4000"):
            with self.subTest(price=price):
                out = analyze(price=price)
                self.assertEqual(out["status"], "DATA_UNAVAILABLE")
                self.assertIsNone(out["currentPrice"])
                self.assertIsNone(out["h4"]["ema34"])
                self.assertIsNone(out["h1"]["demandZone"])
                self.assertIsNone(out["m15"]["atr"])
                self.assert_no_trade_levels(out)

    def test_missing_or_incomplete_timeframes_cannot_synthesize_swing_or_tp(self):
        short = make_candles(4000, 10)
        for which in ("h4", "h1", "m15"):
            args = {which: short}
            with self.subTest(timeframe=which):
                out = analyze(**args)
                self.assertEqual(out["dataStatus"], "UNVERIFIED_MARKET_EVIDENCE")
                self.assertIsNone(out["h4"]["swingHigh"])
                self.assertIsNone(out["h1"]["supplyZone"])
                self.assert_no_trade_levels(out)

    def test_invalid_ohlc_is_not_a_derived_market_level(self):
        bad = make_candles(4000)
        bad[-1][1] = bad[-1][2] - 1
        out = analyze(h4=bad)
        self.assertEqual(out["status"], "DATA_UNAVAILABLE")
        self.assert_no_trade_levels(out)

    def test_verified_candles_but_no_valid_entry_never_invent_sl_or_tp(self):
        out = analyze(signal={"allowed": False, "side": "BUY", "marketRegime": "TREND_UP"})
        self.assertEqual(out["status"], "BROKER_CANDLE_BASIS")
        self.assert_no_trade_levels(out)
        self.assertEqual(out["m15"]["setupScore"], 0)
        self.assertGreater(out["m15"]["atr"], 0)
        self.assertIsNotNone(out["h4"]["swingHigh"])
        self.assertIn("ước lượng", out["h1"]["summary"])

    def test_partial_allowed_signal_without_canonical_sl_tp_is_not_a_plan(self):
        out = analyze(signal={"allowed": True, "side": "SELL", "setupScore": 90})
        self.assert_no_trade_levels(out)
        invalid = analyze(signal={"allowed": True, "side": "BUY", "sl": 4010, "tp": 4020})
        self.assert_no_trade_levels(invalid)

    def test_genuine_broker_based_entry_levels_can_be_displayed(self):
        sig = {"allowed": True, "side": "BUY", "sl": 3992.0, "tp": 4020.0,
               "marketRegime": "TREND_UP", "setupScore": 93}
        out = analyze(signal=sig, analysis={"atr": 4.2, "patternName": "ENGULFING"})
        self.assertTrue(out["allowed"])
        self.assertEqual(out["scenario15m"]["entryZone"], "4000.00")
        self.assertEqual(out["scenario15m"]["stopLoss"], 3992.0)
        self.assertEqual(out["scenario15m"]["tp2"], 4020.0)
        self.assertEqual(out["m15"]["setupScore"], 93)

    def test_payload_call_site_uses_only_fresh_broker_quote(self):
        source = (SCRIPTS / "mt5-direct-probe.py").read_text(encoding="utf-8")
        self.assertIn("bid if fresh_sig_ok and bid > 0 else None", source)
        self.assertNotIn("4678.96", source)


if __name__ == "__main__":
    unittest.main()
