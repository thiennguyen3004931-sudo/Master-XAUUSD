"""hardening/go-live: kill switch CLI, Telegram listener and healthcheck."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import v6_go_live_guard as guard
import v6_healthcheck as health
import v6_kill_switch as kill
import v6_offline_backtest as obt
import v6_emergency_stop_gate as gate
import v6_emergency_stop_release as release_cli
import v6_telegram_kill_listener as listener


class OfflineBacktestTests(unittest.TestCase):
    def test_resample_aligns_and_aggregates(self):
        m5 = [[1, 2, 0.5, 1.5, 0], [1.5, 3, 1, 2, 300_000], [2, 2.5, 1.8, 2.2, 600_000], [2.2, 2.3, 2, 2.1, 900_000]]
        m15 = obt.resample(m5, 15)
        self.assertEqual(m15, [[1, 3, 0.5, 2.2, 0], [2.2, 2.3, 2, 2.1, 900_000]])

    def test_synthetic_backtest_reports_required_metrics_with_costs(self):
        args = obt.argparse.Namespace(mode="AUTO_REGIME", min_confidence=85, spread=0.25, commission=0.07,
                                      slippage=0.10, swap=0.0, lot=0.02, balance=4000.0)
        res = obt.run(obt.synthetic_m5(3, 25), args)
        self.assertTrue(res["ok"], res.get("message"))
        for key in ("netPnlUsd", "maxDrawdownPct", "winRatePct", "profitFactor", "tradeCount"):
            self.assertIn(key, res)
        cheap = obt.run(obt.synthetic_m5(3, 25), obt.argparse.Namespace(**{**vars(args), "spread": 0.05,
                                                                            "commission": 0.0, "slippage": 0.0}))
        # Costs must never improve the result.
        self.assertLessEqual(res["netPnlUsd"], cheap["netPnlUsd"] + 1e-6)


class OpsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="v6-ops-"))
        self.env = {"XAUUSD_KILL_SWITCH_FILE": str(self.tmp / "KILL_SWITCH"),
                    "XAUUSD_GUARD_LOG_FILE": str(self.tmp / "g.jsonl"), "XAUUSD_ALERTS_DISABLED": "true"}
        self.s = guard.load_settings(self.env)

    def test_cli_on_off_status(self):
        with mock.patch.dict(os.environ, self.env):
            self.assertEqual(kill.main(["on", "--reason", "test"]), 0)
            self.assertTrue(guard.kill_switch_active(self.s)[0])
            self.assertEqual(kill.main(["status"]), 0)
            self.assertEqual(kill.main(["off"]), 0)
            self.assertFalse(guard.kill_switch_active(self.s)[0])

    def test_cli_flatten_requires_confirmation(self):
        with mock.patch.dict(os.environ, self.env), mock.patch.object(kill, "run_flatten") as rf:
            self.assertEqual(kill.main(["on", "--flatten"]), 2)
            rf.assert_not_called()
            self.assertTrue(guard.kill_switch_active(self.s)[0])  # still blocks entries

    def test_run_flatten_sends_confirmed_action_to_probe(self):
        seen = {}

        def runner(cmd, input, **kw):
            seen["cfg"] = json.loads(input)
            return SimpleNamespace(returncode=0, stdout=json.dumps({"actionResult": {"ok": True, "status": "KILL_SWITCH_FLATTENED"}}))
        res = kill.run_flatten("XAUUSD.G", None, None, runner=runner)
        self.assertEqual(seen["cfg"], {"action": "kill_switch_flatten", "confirmFlatten": True, "brokerSymbol": "XAUUSD.G"})
        self.assertTrue(res["ok"])
        bad = kill.run_flatten("XAUUSD.G", None, None, runner=lambda *a, **k: SimpleNamespace(returncode=1, stdout=""))
        self.assertFalse(bad["ok"])

    def test_telegram_listener_only_trusts_configured_chat(self):
        env = {"TELEGRAM_CHAT_ID": "42", "XAUUSD_TELEGRAM_FLATTEN_PIN": "9876"}
        self.assertEqual(listener.handle_command("/kill", "43", env, self.s), "")
        self.assertFalse(guard.kill_switch_active(self.s)[0])
        self.assertIn("ON", listener.handle_command("/kill news", "42", env, self.s))
        self.assertTrue(guard.kill_switch_active(self.s)[0])
        self.assertIn("Rejected", listener.handle_command("/resume 0000", "42", env, self.s))
        self.assertTrue(guard.kill_switch_active(self.s)[0])
        self.assertIn("OFF", listener.handle_command("/resume 9876", "42", env, self.s))
        flat = listener.handle_command("/kill_flatten 9876", "42", env, self.s,
                                       flatten_fn=lambda: {"status": "KILL_SWITCH_FLATTENED"})
        self.assertIn("KILL_SWITCH_FLATTENED", flat)

    def test_flatten_disabled_without_pin(self):
        env = {"TELEGRAM_CHAT_ID": "42"}
        called = []
        out = listener.handle_command("/kill_flatten x", "42", env, self.s, flatten_fn=lambda: called.append(1) or {})
        self.assertIn("Rejected", out)
        self.assertEqual(called, [])

    def test_dotenv_reader_takes_only_guard_keys(self):
        f = self.tmp / ".env"
        f.write_text("# c\nXAUUSD_DRY_RUN=false\nexport TELEGRAM_CHAT_ID='42'\nMT5_PASSWORD=secret\nbad line\n", encoding="utf-8")
        self.assertEqual(guard.read_dotenv(f), {"XAUUSD_DRY_RUN": "false", "TELEGRAM_CHAT_ID": "42"})
        self.assertEqual(guard.read_dotenv(self.tmp / "missing"), {})

    def test_healthcheck_codes(self):
        hb = self.tmp / "hb.json"
        self.assertEqual(health.evaluate(60, hb, now=1000, settings=self.s)[0], 1)
        guard.write_heartbeat({"connected": True}, path=hb, now=1000)
        self.assertEqual(health.evaluate(60, hb, now=1030, settings=self.s)[0], 0)
        self.assertEqual(health.evaluate(60, hb, now=1100, settings=self.s)[0], 1)
        guard.activate_kill_switch(self.s, "t")
        self.assertEqual(health.evaluate(60, hb, now=1030, settings=self.s)[0], 2)



class EmergencyStopReleaseTests(unittest.TestCase):
    LOGIN, SERVER = 123456, "Broker-Demo"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.rt = Path(self.tmp.name)
        self.latch, self.intent, self.uncertain = release_cli.paths(self.rt)
        gate.persist_operator_emergency_stop(self.latch, account_login=self.LOGIN, server=self.SERVER, operator_id="web")
        self.intent.write_text("stop", encoding="utf-8")
        self.log = mock.patch.dict(os.environ, {"XAUUSD_GUARD_LOG_FILE": str(self.rt / "g.jsonl")})
        self.log.start()

    def tearDown(self):
        self.log.stop()
        self.tmp.cleanup()

    def test_release_clears_latch_and_intent(self):
        out = release_cli.release(self.rt, self.LOGIN, self.SERVER, "op", "reconciled")
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["stopCategory"], "AUTHORIZED_CLEAR")
        self.assertFalse(out["blockNewOrders"])
        self.assertFalse(self.intent.exists())

    def test_release_refused_while_uncertain_entry_frozen(self):
        self.uncertain.write_text(json.dumps({f"{self.LOGIN}|{self.SERVER}": {
            "accountLogin": self.LOGIN, "server": self.SERVER, "status": "PENDING_SEND",
            "createdAtUtc": 1700000000, "requestId": "r1"}}), encoding="utf-8")
        out = release_cli.release(self.rt, self.LOGIN, self.SERVER, "op", "reconciled")
        self.assertFalse(out["ok"])
        self.assertTrue(self.intent.exists())

    def test_release_refused_for_other_account(self):
        out = release_cli.release(self.rt, 999999, self.SERVER, "op", "reconciled")
        self.assertFalse(out["ok"])
        self.assertTrue(self.intent.exists())

    def test_cli_requires_confirm_operator_and_reason(self):
        rc = release_cli.main(["release", "--login", str(self.LOGIN), "--server", self.SERVER,
                               "--runtime-dir", str(self.rt), "--operator", "op", "--reason", "x"])
        self.assertEqual(rc, 2)
        self.assertTrue(self.intent.exists())

if __name__ == "__main__":
    unittest.main()
