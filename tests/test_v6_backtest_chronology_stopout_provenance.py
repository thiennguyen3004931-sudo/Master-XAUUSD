"""Unit tests for V6 Backtest Chronology, Broker Stop-Out & OOS Split Provenance (Stream E — #52)."""

from __future__ import annotations

import hashlib
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts import v6_backtest_chronology_stopout_provenance as mod


VALID_HASH = hashlib.sha256(b"xauusd-dataset-v6").hexdigest()


class TestBacktestChronologyStopOutProvenance(unittest.TestCase):
    def test_tick_chronology_detects_non_monotonic_and_inverted_spread(self) -> None:
        good = mod.verify_tick_quote_chronology(
            [
                {"timestampUtc": 1795400000, "bid": 2650.0, "ask": 2650.2},
                {"timestampUtc": 1795400060, "bid": 2650.5, "ask": 2650.7},
                {"timestampUtc": 1795405000, "bid": 2652.0, "ask": 2652.3},
            ],
            max_gap_seconds=3600,
        )
        self.assertTrue(good["passed"])
        self.assertEqual(good["gapCount"], 1)

        bad = mod.verify_tick_quote_chronology(
            [
                {"timestampUtc": 1795400100, "bid": 2650.0, "ask": 2650.2},
                {"timestampUtc": 1795400050, "bid": 2650.5, "ask": 2650.7},
                {"timestampUtc": 1795400200, "bid": 2651.0, "ask": 2650.5},
            ]
        )
        self.assertFalse(bad["passed"])
        self.assertEqual(len(bad["violations"]), 2)

    def test_oos_split_rejects_overlap_and_missing_dataset_hash(self) -> None:
        ok = mod.verify_oos_split_provenance(
            train_start_utc=1700000000,
            train_end_utc=1750000000,
            oos_start_utc=1750086400,
            oos_end_utc=1790000000,
            dataset_sha256=VALID_HASH,
            embargo_seconds=86400,
        )
        self.assertTrue(ok["passed"])

        overlap = mod.verify_oos_split_provenance(
            train_start_utc=1700000000,
            train_end_utc=1750000000,
            oos_start_utc=1749990000,
            oos_end_utc=1790000000,
            dataset_sha256="not-a-hash",
            embargo_seconds=3600,
        )
        self.assertFalse(overlap["passed"])
        self.assertIn("OOS_OVERLAPS_TRAIN_OR_VIOLATES_EMBARGO", overlap["reasons"])
        self.assertIn("DATASET_SHA256_MISSING_OR_INVALID", overlap["reasons"])

    def test_unverified_broker_stopout_reports_unverified_and_never_authorizes_live(self) -> None:
        chrono_ok = {"passed": True}
        oos_ok = {"passed": True}

        unver = mod.evaluate_backtest_provenance_and_stopout(
            chronology_result=chrono_ok,
            oos_result=oos_ok,
            broker_stopout_spec={"marginMode": "HEDGING", "marginSoMode": 0, "marginSoCall": 100.0, "marginSoSo": 50.0, "contractSize": 100.0},
            broker_spec_evidence_sha256=None,
        )
        self.assertEqual(unver["status"], "UNVERIFIED")
        self.assertFalse(unver["brokerStopOutVerified"])
        self.assertFalse(unver["liveAuthorized"])

        ver = mod.evaluate_backtest_provenance_and_stopout(
            chronology_result=chrono_ok,
            oos_result=oos_ok,
            broker_stopout_spec={"marginMode": "HEDGING", "marginSoMode": 0, "marginSoCall": 100.0, "marginSoSo": 50.0, "contractSize": 100.0},
            broker_spec_evidence_sha256=VALID_HASH,
        )
        self.assertEqual(ver["status"], "OFFLINE_BACKTEST_PROVENANCE_VERIFIED")
        self.assertTrue(ver["brokerStopOutVerified"])
        self.assertFalse(ver["liveAuthorized"])


if __name__ == "__main__":
    unittest.main()
