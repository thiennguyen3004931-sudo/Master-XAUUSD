from __future__ import annotations

import importlib.util
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
spec = importlib.util.spec_from_file_location("v6_quote_offset_gate", SCRIPTS / "mt5-direct-probe.py")
engine = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = engine
spec.loader.exec_module(engine)


class QuoteOffsetEntryGateTests(unittest.TestCase):
    def test_missing_offset_is_not_treated_as_utc(self):
        ok, _, reason = engine.verify_tick_freshness_utc(
            SimpleNamespace(time=1_000), now_utc=1_000
        )
        self.assertFalse(ok)
        self.assertIn("offset", reason.lower())

    def test_invalid_offsets_fail_closed(self):
        for offset in (True, "2", float("nan"), float("inf"), 2.1, 15.0, -13.0):
            with self.subTest(offset=offset):
                ok, _, _ = engine.verify_tick_freshness_utc(
                    SimpleNamespace(time=10_000), now_utc=10_000,
                    broker_utc_offset_hours=offset,
                )
                self.assertFalse(ok)

    def test_explicit_gmt2_and_gmt3_offsets_are_accepted(self):
        for offset in (0.0, 2.0, 3.0, 5.5, 5.75):
            with self.subTest(offset=offset):
                now = 100_000
                tick = SimpleNamespace(time=now + offset * 3600 - 5)
                ok, age, reason = engine.verify_tick_freshness_utc(
                    tick, now_utc=now, broker_utc_offset_hours=offset
                )
                self.assertTrue(ok, reason)
                self.assertAlmostEqual(age, 5.0)

    def test_final_entry_path_blocks_when_offset_is_unverified(self):
        source = (SCRIPTS / "mt5-direct-probe.py").read_text(encoding="utf-8")
        self.assertIn("BLOCKED_BROKER_UTC_OFFSET_UNVERIFIED", source)
        self.assertIn("broker_utc_offset_hours=broker_offset_hours", source)

    def test_environment_offset_is_explicitly_consumed(self):
        with patch.dict(os.environ, {"V6_BROKER_UTC_OFFSET_HOURS": "3"}, clear=False):
            self.assertEqual(engine._verified_broker_utc_offset_hours({}), 3.0)


if __name__ == "__main__":
    unittest.main()
