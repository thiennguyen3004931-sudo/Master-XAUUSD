"""Unit tests for V6 Backtest Anti-Lookahead Verifier & Stress Harness (Stream E — #52)."""

from __future__ import annotations

from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import v6_backtest_antilookahead_and_stress_harness as bt


def _all_stress_pass() -> dict:
    return {
        "spread_widening": {"failClosedHandled": True},
        "volatility_spike": {"failClosedHandled": True},
        "low_liquidity_gap": {"failClosedHandled": True},
        "missing_data_feed": {"failClosedHandled": True},
    }


class TestBacktestAntiLookaheadAndStress(unittest.TestCase):
    def test_no_lookahead_passes_and_future_or_unclosed_bar_fails(self) -> None:
        ok = bt.verify_no_lookahead(
            [
                {"decisionBarIndex": 10, "maxReadBarIndex": 10, "usesUnclosedCandle": False},
                {"decisionBarIndex": 11, "maxReadBarIndex": 10, "usesUnclosedCandle": False},
            ]
        )
        self.assertTrue(ok["passed"])

        bad = bt.verify_no_lookahead(
            [
                {"decisionBarIndex": 10, "maxReadBarIndex": 11, "usesUnclosedCandle": False},
                {"decisionBarIndex": 12, "maxReadBarIndex": 12, "usesUnclosedCandle": True},
            ]
        )
        self.assertFalse(bad["passed"])
        self.assertEqual(len(bad["violations"]), 2)

    def test_unverified_broker_stopout_always_reports_unverified(self) -> None:
        rep = bt.evaluate_stress_and_walkforward_report(
            in_sample_trades=[{"netPnlAfterCostsUsd": 120.0}, {"netPnlAfterCostsUsd": -40.0}],
            out_of_sample_trades=[{"netPnlAfterCostsUsd": 85.0}],
            stress_scenarios=_all_stress_pass(),
            broker_stopout_verified=False,
        )
        self.assertEqual(rep["status"], "UNVERIFIED")
        self.assertEqual(rep["reason"], "BROKER_STOPOUT_RULES_UNVERIFIED")
        self.assertFalse(rep["liveAuthorized"])

    def test_demo_data_cannot_contaminate_live_stats_ledger(self) -> None:
        rep = bt.evaluate_stress_and_walkforward_report(
            in_sample_trades=[{"netPnlAfterCostsUsd": 100.0}],
            out_of_sample_trades=[{"netPnlAfterCostsUsd": 50.0}],
            stress_scenarios=_all_stress_pass(),
            broker_stopout_verified=True,
            contains_demo_or_synthetic_data=True,
            target_live_stats_ledger=True,
        )
        self.assertEqual(rep["status"], "REJECTED")
        self.assertEqual(rep["reason"], "DEMO_OR_SYNTHETIC_CONTAMINATION_FORBIDDEN_IN_LIVE_STATS")
        self.assertFalse(rep["liveAuthorized"])

    def test_missing_stress_scenario_blocks_verification(self) -> None:
        partial = _all_stress_pass()
        del partial["missing_data_feed"]
        rep = bt.evaluate_stress_and_walkforward_report(
            in_sample_trades=[{"netPnlAfterCostsUsd": 100.0}],
            out_of_sample_trades=[{"netPnlAfterCostsUsd": 50.0}],
            stress_scenarios=partial,
            broker_stopout_verified=True,
        )
        self.assertEqual(rep["status"], "INCOMPLETE_STRESS_COVERAGE")
        self.assertIn("missing_data_feed", rep["missingStressScenarios"])


if __name__ == "__main__":
    unittest.main()
