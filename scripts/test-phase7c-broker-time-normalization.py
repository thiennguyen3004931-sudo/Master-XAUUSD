from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import unittest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = (
    PROJECT_ROOT
    / "packages"
    / "mt5-broker"
    / "bridge"
    / "mt5_bridge"
    / "broker_time.py"
)

spec = importlib.util.spec_from_file_location("phase7c_broker_time", MODULE_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError(f"Could not load {MODULE_PATH}")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BrokerTimeNormalizationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.original = os.environ.get("MT5_BROKER_TIME_OFFSET_SECONDS")

    def tearDown(self) -> None:
        if self.original is None:
            os.environ.pop("MT5_BROKER_TIME_OFFSET_SECONDS", None)
        else:
            os.environ["MT5_BROKER_TIME_OFFSET_SECONDS"] = self.original

    def test_zero_is_default_and_preserves_timestamp(self) -> None:
        os.environ.pop("MT5_BROKER_TIME_OFFSET_SECONDS", None)
        self.assertEqual(module.broker_time_offset_seconds(), 0)
        self.assertEqual(module.normalize_timestamp_ms(1_787_532_747_932), 1_787_532_747_932)

    def test_measured_dbg_plus_three_hours_normalizes_to_utc(self) -> None:
        os.environ["MT5_BROKER_TIME_OFFSET_SECONDS"] = "10800"
        raw_quote = 1_787_543_547_862
        self.assertEqual(module.normalize_timestamp_ms(raw_quote), 1_787_532_747_862)

        quote = module.normalize_quote({"timestamp": raw_quote, "bid": 4614.66, "ask": 4615.22})
        self.assertEqual(quote["timestamp"], 1_787_532_747_862)

    def test_m15_close_no_longer_lands_in_future_after_plus_three_fix(self) -> None:
        os.environ["MT5_BROKER_TIME_OFFSET_SECONDS"] = "10800"
        rows = module.normalize_candles(
            [
                {
                    "openTime": 1_787_542_200_000,
                    "closeTime": 1_787_543_100_000,
                    "open": 4600.0,
                    "high": 4610.0,
                    "low": 4595.0,
                    "close": 4606.97,
                }
            ]
        )
        self.assertEqual(rows[0]["openTime"], 1_787_531_400_000)
        self.assertEqual(rows[0]["closeTime"], 1_787_532_300_000)
        observed_wall_clock = 1_787_532_747_932
        self.assertLessEqual(rows[0]["closeTime"], observed_wall_clock)

    def test_read_only_payload_helpers_normalize_without_mutating_input(self) -> None:
        os.environ["MT5_BROKER_TIME_OFFSET_SECONDS"] = "10800"
        position = {"ticket": "1", "openedAt": 1_787_543_100_000}
        deal = {"ticket": "2", "timestamp": 1_787_543_100_000}
        boundary = {
            "currentStartTime": 1_787_500_800_000,
            "previousStartTime": 1_787_414_400_000,
        }

        normalized_positions = module.normalize_positions([position])
        normalized_deals = module.normalize_deals([deal])
        normalized_boundary = module.normalize_trading_day_boundary(boundary)

        self.assertEqual(position["openedAt"], 1_787_543_100_000)
        self.assertEqual(deal["timestamp"], 1_787_543_100_000)
        self.assertEqual(normalized_positions[0]["openedAt"], 1_787_532_300_000)
        self.assertEqual(normalized_deals[0]["timestamp"], 1_787_532_300_000)
        self.assertEqual(
            normalized_boundary["currentStartTime"],
            1_787_490_000_000,
        )

    def test_offset_has_hard_safety_limit(self) -> None:
        os.environ["MT5_BROKER_TIME_OFFSET_SECONDS"] = str(15 * 60 * 60)
        with self.assertRaises(ValueError):
            module.broker_time_offset_seconds()


if __name__ == "__main__":
    unittest.main()
