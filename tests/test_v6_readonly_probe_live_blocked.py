"""Read-only safety assertions: MT5 visibility is never permission to trade."""
import importlib.util
import io
import json
import sys
import types
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "verify-windows-mt5-readonly.py"


def load():
    spec = importlib.util.spec_from_file_location("v6_readonly_probe_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ReadonlyNeverAuthorizesLive(unittest.TestCase):
    def test_non_windows_blocks_without_asserting_disarmed(self):
        module = load()
        with patch.object(module.sys, "platform", "linux"), redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(module.main(), 0)
        state = json.loads(stdout.getvalue())
        self.assertEqual(state["readinessClassification"], "LIVE_BLOCKED")
        self.assertEqual(state["liveAuthorization"], "NOT_GRANTED")
        self.assertIsNone(state["liveArmed"])
        self.assertFalse(state["operatingProcessVerified"])

    def test_mock_mt5_readable_is_not_runtime_attestation(self):
        module = load()
        info = lambda **kwargs: types.SimpleNamespace(**kwargs)
        mt5 = types.SimpleNamespace(
            ACCOUNT_TRADE_MODE_REAL=2,
            initialize=lambda: True,
            shutdown=lambda: None,
            terminal_info=lambda: info(connected=True, trade_allowed=True),
            account_info=lambda: info(trade_mode=2, login=1234567, server="SIMULATED"),
            symbol_info=lambda symbol: info(trade_contract_size=100, volume_step=0.01) if symbol == "XAUUSD.G" else None,
            positions_get=lambda: (),
            orders_get=lambda: (),
        )
        with patch.object(module.sys, "platform", "win32"), patch.dict(sys.modules, {"MetaTrader5": mt5}), redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(module.main(), 0)
        state = json.loads(stdout.getvalue())
        self.assertTrue(state["mt5ReadOnlyVerified"])
        self.assertEqual(state["status"], "BROKER_READONLY_OBSERVED")
        self.assertEqual(state["readinessClassification"], "LIVE_BLOCKED")
        self.assertEqual(state["liveAuthorization"], "NOT_GRANTED")
        self.assertIsNone(state["liveArmed"])
        self.assertFalse(state["riskControlsVerified"])
        self.assertFalse(state["operatingProcessVerified"])


if __name__ == "__main__":
    unittest.main()
